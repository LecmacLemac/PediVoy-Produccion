import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fork } from 'child_process';
import { createRequire } from 'module';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
const require = createRequire(import.meta.url);
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
import { query } from './db.js';
import handlers from './handlers.js';
import { handleIncomingComprobanteFromBotPg } from './transferenciasPipeline.js';
import { ensureComprobantesTransferenciaSchema } from './transferenciasServices.js';
import { registerCompanyIncomingMedia } from './wpp/companyIncomingMedia.js';
import { parseEnterpriseId } from './wpp/enterpriseId.js';
import {
    confirmCompanyRuntime,
    createBackoffRecovery,
    createNonOverlappingTask,
    createPrerequisiteStartup,
    createSingleFlight,
    isRuntimeBridgeError,
    repairCompanyRuntimeBridge,
} from './wpp/companyRuntime.js';
import {
    claimWppOutboxRows,
    ensureWppDeliverySchema,
    finishWppOutboxClaim,
    releaseWppOutboxClaim,
    resolveWhatsappTarget,
} from './wpp/delivery.js';

/**
 * CONFIGURACIÓN DE ENTORNO
 * EMPRESA_ID: Define qué sesión maneja este contenedor.
 * SESSION_PATH: Ruta al disco persistente (/mnt/data/wpp_sessions en Render).
 */
const EMPRESA_ID = parseEnterpriseId(process.env.EMPRESA_ID);
const SESSION_PATH = process.env.DISK_PATH || './wpp_sessions';
const WPP_QR_ONLY = process.env.WPP_QR_ONLY === '1';
let client = null;
let isReady = false;
let isInitializing = false;
let isResetting = false;
let isProcessingOutbox = false;
let isShuttingDown = false;
let lastResetHandledAt = null;
const OUTBOX_CLAIM_OWNER = `empresa-${EMPRESA_ID}-${process.pid}-${randomUUID()}`;

// 1. LIMPIEZA DE "LOCKS" DE CHROME
// Evita que el contenedor falle al reiniciar si Chrome se cerró inesperadamente.
const sessionDir = path.join(SESSION_PATH, `session-empresa_${EMPRESA_ID}`);
const devToolsActivePortFile = path.join(sessionDir, 'DevToolsActivePort');
const lockFile = path.join(sessionDir, 'Default/SingletonLock');

if (fs.existsSync(lockFile)) {
    try {
        fs.unlinkSync(lockFile);
        console.log(`[Empresa ${EMPRESA_ID}] Archivo de bloqueo de Chrome eliminado para reinicio limpio.`);
    } catch (e) {
        console.warn(`[Empresa ${EMPRESA_ID}] No se pudo eliminar el lock (puede estar en uso):`, e.message);
    }
}

async function ensureEmpresaWhatsappSchema() {
    await query(`
        ALTER TABLE empresas
          ADD COLUMN IF NOT EXISTS wpp_qr_code TEXT,
          ADD COLUMN IF NOT EXISTS wpp_status TEXT DEFAULT 'disconnected',
          ADD COLUMN IF NOT EXISTS wpp_reset_requested_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    await ensureWppDeliverySchema(query);
    await ensureComprobantesTransferenciaSchema(query);
}

function createCompanyClient() {
    const isRender = process.env.RENDER === 'true';
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isRender ? '/usr/bin/chromium' : undefined);
    const nextClient = new Client({
        authStrategy: new LocalAuth({
            clientId: `empresa_${EMPRESA_ID}`,
            dataPath: SESSION_PATH
        }),
        puppeteer: {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=VizDisplayCompositor',
                '--window-size=1920,1080',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-software-rasterizer',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
            ],
            executablePath,
            ignoreHTTPSErrors: true,
            timeout: 60000,
        }
    });

    nextClient.on('qr', async (qr) => {
        if (client !== nextClient) return;
        isReady = false;
        console.log(`[Empresa ${EMPRESA_ID}] Nuevo QR generado. Esperando escaneo...`);
        await query(
            'UPDATE empresas SET wpp_qr_code = $1, wpp_status = $2, updated_at = NOW() WHERE id = $3',
            [qr, 'awaiting_scan', EMPRESA_ID]
        );
    });

    nextClient.on('ready', async () => {
        if (client !== nextClient) return;
        isReady = false;
        try {
            await query(
                `UPDATE empresas
                    SET wpp_status = $1, wpp_qr_code = NULL,
                        wpp_heartbeat_at = NOW(), updated_at = NOW()
                  WHERE id = $2`,
                ['connected', EMPRESA_ID]
            );
            if (client !== nextClient) return;
            isReady = true;
            console.log(`[Empresa ${EMPRESA_ID}] ¡Conexión exitosa! El worker está operativo.`);
        } catch (err) {
            isReady = false;
            console.error(`[Empresa ${EMPRESA_ID}] No se pudo persistir estado connected:`, err.message);
            workerRecovery.trigger('persist_connected_failed');
        }
    });

    async function handleUnavailable(event, detail) {
        if (client !== nextClient) return;
        isReady = false;
        console.warn(`[Empresa ${EMPRESA_ID}] ${event}:`, detail);
        try {
            await query(
                'UPDATE empresas SET wpp_status = $1, wpp_heartbeat_at = NULL, updated_at = NOW() WHERE id = $2',
                ['disconnected', EMPRESA_ID]
            );
        } catch (err) {
            console.error(`[Empresa ${EMPRESA_ID}] No se pudo persistir desconexión:`, err.message);
        } finally {
            workerRecovery.trigger(event);
        }
    }

    nextClient.on('auth_failure', msg => {
        void handleUnavailable('auth_failure', msg);
    });

    nextClient.on('disconnected', reason => {
        void handleUnavailable('disconnected', reason);
    });

    if (!WPP_QR_ONLY) {
        handlers.start(nextClient, { empresaId: Number(EMPRESA_ID) });
        registerCompanyIncomingMedia(nextClient, {
            empresaId: Number(EMPRESA_ID),
            query,
            handleIncomingComprobanteFromBotPg,
        });
    } else {
        console.log(`[Empresa ${EMPRESA_ID}] Modo solo QR activo: no se atienden mensajes entrantes.`);
    }

    return nextClient;
}

async function clearCompanySessionDir() {
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

async function initializeClient() {
    if (isInitializing || isShuttingDown) return false;
    isInitializing = true;
    let startupSyncAssistant = null;
    let nextClient = null;

    try {
        isReady = false;
        nextClient = createCompanyClient();
        client = nextClient;
        await query(
            `UPDATE empresas
                SET wpp_status = $1, wpp_qr_code = NULL,
                    wpp_heartbeat_at = NULL, updated_at = NOW()
              WHERE id = $2`,
            ['initializing', EMPRESA_ID]
        );

        startupSyncAssistant = fork(
            new URL('./wpp/startupSyncAssistant.js', import.meta.url),
            [devToolsActivePortFile],
            { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }
        );
        startupSyncAssistant.on('message', message => {
            if (message?.type === 'startup-sync-assistant' && message.resumed) {
                console.log(`[Empresa ${EMPRESA_ID}] Inicialización reanudada por asistente DevTools independiente.`);
            }
        });
        startupSyncAssistant.on('error', err => {
            console.warn(`[Empresa ${EMPRESA_ID}] Asistente DevTools no pudo iniciar:`, err.message);
        });

        await nextClient.initialize();
        return true;
    } catch (err) {
        isReady = false;
        if (client === nextClient) client = null;
        nextClient?.removeAllListeners();
        try {
            await nextClient?.destroy();
        } catch (destroyErr) {
            console.warn(`[Empresa ${EMPRESA_ID}] No se pudo cerrar cliente tras initialize fallido:`, destroyErr.message);
        }
        throw err;
    } finally {
        if (startupSyncAssistant?.connected) startupSyncAssistant.disconnect();
        if (startupSyncAssistant && startupSyncAssistant.exitCode === null) startupSyncAssistant.kill('SIGTERM');
        isInitializing = false;
    }
}

const recoverCompanyRuntime = createSingleFlight(async (reason) => {
    if (isResetting || isShuttingDown) return false;

    isReady = false;
    console.warn(`[Empresa ${EMPRESA_ID}] Runtime WhatsApp no operativo (${reason}). Intentando recuperar bridge...`);

    try {
        const activeClient = client;
        const repaired = await repairCompanyRuntimeBridge(activeClient, LoadUtils);
        if (activeClient === client && repaired.healthy) {
            await query(
                `UPDATE empresas
                    SET wpp_status = $1, wpp_qr_code = NULL,
                        wpp_heartbeat_at = NOW(), updated_at = NOW()
                  WHERE id = $2`,
                ['connected', EMPRESA_ID]
            );
            if (activeClient !== client) return false;
            isReady = true;
            console.log(`[Empresa ${EMPRESA_ID}] Bridge WWebJS reinyectado sin reiniciar sesión.`);
            return true;
        }

        console.warn(`[Empresa ${EMPRESA_ID}] Reiniciando cliente sin borrar sesión; reparación directa no alcanzó (${repaired.reason}).`);
        await query(
            'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, updated_at = NOW() WHERE id = $2',
            ['initializing', EMPRESA_ID]
        );

        const previousClient = client;
        client = null;

        if (previousClient) {
            previousClient.removeAllListeners();
            try {
                await previousClient.destroy();
            } catch (destroyErr) {
                console.warn(`[Empresa ${EMPRESA_ID}] No se pudo destruir el cliente con runtime dañado:`, destroyErr.message);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
        await initializeClient();
        return true;
    } catch (err) {
        console.error(`[Empresa ${EMPRESA_ID}] Error recuperando runtime WhatsApp:`, err.message);
        await query(
            'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, wpp_heartbeat_at = NULL, updated_at = NOW() WHERE id = $2',
            ['disconnected', EMPRESA_ID]
        ).catch(() => {});
        return false;
    }
});

const workerRecovery = createBackoffRecovery({
    task: async reason => {
        if (isShuttingDown) return true;
        await ensureEmpresaWhatsappSchema();
        return recoverCompanyRuntime(reason);
    },
    onError: (err, state) => {
        console.error(
            `[Empresa ${EMPRESA_ID}] Recuperación falló (intento ${state.attempt + 1}); se reintentará con backoff:`,
            err.message
        );
    },
});

const workerStartup = createPrerequisiteStartup({
    ensurePrerequisites: ensureEmpresaWhatsappSchema,
    start: async reason => {
        lastResetHandledAt = await loadResetMarker();
        return recoverCompanyRuntime(reason);
    },
    onError: (err, state) => {
        console.error(
            `[Empresa ${EMPRESA_ID}] Preparación inicial falló (intento ${state.attempt + 1}); se reintentará con backoff:`,
            err.message
        );
    },
});

async function ensureCompanyRuntimeReady() {
    const checkedClient = client;
    const health = await confirmCompanyRuntime(checkedClient);

    if (checkedClient !== client) return false;
    if (health.healthy) {
        await persistWorkerHeartbeat();
        return true;
    }

    await recoverCompanyRuntime(health.reason);
    return false;
}

async function checkCompanyRuntimeHealth() {
    if (!client || !isReady || isInitializing || isResetting) return;
    await ensureCompanyRuntimeReady();
}

async function persistWorkerHeartbeat() {
    if (!client || !isReady || isInitializing || isResetting) return;
    try {
        await query(
            `UPDATE empresas
                SET wpp_heartbeat_at = NOW()
              WHERE id = $1 AND wpp_status = 'connected'`,
            [EMPRESA_ID]
        );
    } catch (err) {
        console.error(`[Empresa ${EMPRESA_ID}] No se pudo persistir heartbeat:`, err.message);
    }
}

const checkCompanyRuntimeHealthTick = createNonOverlappingTask(checkCompanyRuntimeHealth);

async function loadResetMarker() {
    const rows = await query('SELECT wpp_reset_requested_at FROM empresas WHERE id = $1 LIMIT 1', [EMPRESA_ID]);
    return rows[0]?.wpp_reset_requested_at ? new Date(rows[0].wpp_reset_requested_at).toISOString() : null;
}

async function resetAndRestartClient() {
    if (isResetting) return;
    isResetting = true;

    try {
        console.log(`[Empresa ${EMPRESA_ID}] Reset solicitado. Reiniciando sesión WhatsApp...`);
        isReady = false;
        try {
            if (client) {
                const previousClient = client;
                client = null;
                previousClient.removeAllListeners();
                await previousClient.destroy();
            }
        } catch (e) {
            console.warn(`[Empresa ${EMPRESA_ID}] No se pudo destruir cliente previo:`, e.message);
        }

        await clearCompanySessionDir();
        await query(
            'UPDATE empresas SET wpp_qr_code = NULL, wpp_status = $1 WHERE id = $2',
            ['initializing', EMPRESA_ID]
        );

        await new Promise(resolve => setTimeout(resolve, 1500));
        await initializeClient();
    } catch (err) {
        console.error(`[Empresa ${EMPRESA_ID}] Error reseteando cliente:`, err.message);
        await query(
            'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, wpp_heartbeat_at = NULL, updated_at = NOW() WHERE id = $2',
            ['disconnected', EMPRESA_ID]
        ).catch(() => {});
        workerRecovery.trigger('reset_failed');
    } finally {
        isResetting = false;
    }
}

async function checkResetRequest() {
    if (!workerStartup.getState().started) return;
    try {
        const marker = await loadResetMarker();
        if (marker && marker !== lastResetHandledAt) {
            lastResetHandledAt = marker;
            await resetAndRestartClient();
        }
    } catch (err) {
        console.error(`[Empresa ${EMPRESA_ID}] Error revisando reset:`, err.message);
    }
}

function isConnectionSendError(err) {
    const errorLower = String(err?.message || err || '').toLowerCase();
    return (
        errorLower.includes('not connected') ||
        errorLower.includes('disconnected') ||
        errorLower.includes('closed') ||
        errorLower.includes('websocket') ||
        errorLower.includes('target closed') ||
        errorLower.includes('session closed') ||
        errorLower.includes('protocol error') ||
        errorLower.includes('execution context was destroyed')
    );
}

function isInvalidPhoneError(err) {
    const errorLower = String(err?.message || err || '').toLowerCase();
    return (
        errorLower.includes('telefono_invalido') ||
        errorLower.includes('invalid') ||
        errorLower.includes('phone') ||
        errorLower.includes('number')
    );
}

// 4. PROCESADOR DE COLA DE MENSAJES (OUTBOX)
// Revisa mensajes pendientes cada 5 segundos para esta empresa específicamente.
const outboxInterval = setInterval(async () => {
    if (WPP_QR_ONLY) return;
    if (!client || !isReady || isInitializing || isResetting || isProcessingOutbox) return;

    isProcessingOutbox = true;

    try {
        if (!await ensureCompanyRuntimeReady()) return;

        const filas = await claimWppOutboxRows({
            query,
            owner: OUTBOX_CLAIM_OWNER,
            limit: 5,
            whereSql: 'AND o.empresa_id = $4',
            whereParams: [EMPRESA_ID],
        });

        for (const [index, fila] of filas.entries()) {
            let sendStarted = false;
            try {
                const activeClient = client;
                const target = await resolveWhatsappTarget(activeClient, fila.telefono);
                if (activeClient !== client || !isReady) {
                    await releaseWppOutboxClaim({
                        query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                        error: 'Worker cambió antes del envío',
                    });
                    continue;
                }

                sendStarted = true;
                await activeClient.sendMessage(target, fila.mensaje);

                await finishWppOutboxClaim({
                    query, id: fila.id, owner: OUTBOX_CLAIM_OWNER, status: 'sent', sent: true,
                });
                await persistWorkerHeartbeat();
                console.log(`[Empresa ${EMPRESA_ID}] Mensaje enviado a ${fila.telefono}`);
            } catch (err) {
                console.error(`[Empresa ${EMPRESA_ID}] Error al enviar ID ${fila.id}:`, err.message);

                if (!sendStarted) {
                    if (isInvalidPhoneError(err)) {
                        await finishWppOutboxClaim({
                            query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                            status: 'error', error: 'Número de teléfono inválido',
                        });
                    } else {
                        await releaseWppOutboxClaim({
                            query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                            error: 'Reintento por error previo al envío',
                        });
                    }
                    continue;
                }

                if (isRuntimeBridgeError(err)) {
                    await releaseWppOutboxClaim({
                        query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                        error: 'Runtime WhatsApp empresa no disponible; reinicializando worker',
                    });
                    for (const remaining of filas.slice(index + 1)) {
                        await releaseWppOutboxClaim({ query, id: remaining.id, owner: OUTBOX_CLAIM_OWNER, error: null });
                    }
                    workerRecovery.trigger('runtime_bridge_send_error');
                    break;
                }

                if (isConnectionSendError(err)) {
                    await query(
                        "UPDATE empresas SET wpp_status = 'disconnected', wpp_heartbeat_at = NULL, updated_at = NOW() WHERE id = $1",
                        [EMPRESA_ID]
                    );
                    await releaseWppOutboxClaim({
                        query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                        error: 'Fallback a WhatsApp general: conexión de empresa no disponible',
                    });
                    for (const remaining of filas.slice(index + 1)) {
                        await releaseWppOutboxClaim({ query, id: remaining.id, owner: OUTBOX_CLAIM_OWNER, error: null });
                    }
                    workerRecovery.trigger('connection_send_error');
                    break;
                }

                if (isInvalidPhoneError(err)) {
                    await finishWppOutboxClaim({
                        query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                        status: 'error', error: 'Número de teléfono inválido',
                    });
                } else {
                    await releaseWppOutboxClaim({
                        query, id: fila.id, owner: OUTBOX_CLAIM_OWNER,
                        error: 'Reintento por error temporal en WhatsApp empresa',
                    });
                }
            }
        }
    } catch (dbErr) {
        console.error(`[Empresa ${EMPRESA_ID}] Error consultando DB:`, dbErr.message);
    } finally {
        isProcessingOutbox = false;
    }
}, 5000);

// 5. ARRANQUE
console.log(`[Empresa ${EMPRESA_ID}] Iniciando cliente de WhatsApp${WPP_QR_ONLY ? ' en modo solo QR' : ''}...`);
const resetInterval = setInterval(checkResetRequest, 5000);
const healthInterval = setInterval(() => {
    checkCompanyRuntimeHealthTick().catch(err => {
        console.warn(`[Empresa ${EMPRESA_ID}] Error en health-check WhatsApp:`, err?.message || err);
    });
}, 15000);

async function shutdownWorker() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(outboxInterval);
    clearInterval(resetInterval);
    clearInterval(healthInterval);
    workerStartup.stop();
    workerRecovery.stop();
    const activeClient = client;
    client = null;
    isReady = false;
    activeClient?.removeAllListeners();
    try {
        await activeClient?.destroy();
    } catch (err) {
        console.warn(`[Empresa ${EMPRESA_ID}] No se pudo cerrar cliente durante shutdown:`, err.message);
    }
}

process.once('SIGTERM', () => { void shutdownWorker(); });
process.once('SIGINT', () => { void shutdownWorker(); });
void workerStartup.trigger('startup');
