import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { query } from './db.js';
import handlers from './handlers.js';

/**
 * CONFIGURACIÓN DE ENTORNO
 * EMPRESA_ID: Define qué sesión maneja este contenedor.
 * SESSION_PATH: Ruta al disco persistente (/mnt/data/wpp_sessions en Render).
 */
const EMPRESA_ID = process.env.EMPRESA_ID;
const SESSION_PATH = process.env.DISK_PATH || './wpp_sessions';
const WPP_QR_ONLY = process.env.WPP_QR_ONLY === '1';
let client = null;
let isInitializing = false;
let isResetting = false;
let lastResetHandledAt = null;

if (!EMPRESA_ID) {
    console.error("❌ ERROR CRÍTICO: No se ha definido la variable de entorno EMPRESA_ID.");
    process.exit(1);
}

// 1. LIMPIEZA DE "LOCKS" DE CHROME
// Evita que el contenedor falle al reiniciar si Chrome se cerró inesperadamente.
const sessionDir = path.join(SESSION_PATH, `session-empresa_${EMPRESA_ID}`);
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
}

function createCompanyClient() {
    const isRender = process.env.RENDER === 'true';
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (isRender ? '/usr/bin/chromium' : undefined);
    const nextClient = new Client({
        authStrategy: new LocalAuth({
            clientId: `empresa_${EMPRESA_ID}`,
            dataPath: SESSION_PATH
        }),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.x.html',
        },
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
        console.log(`[Empresa ${EMPRESA_ID}] Nuevo QR generado. Esperando escaneo...`);
        await query(
            'UPDATE empresas SET wpp_qr_code = $1, wpp_status = $2, updated_at = NOW() WHERE id = $3',
            [qr, 'awaiting_scan', EMPRESA_ID]
        );
    });

    nextClient.on('ready', async () => {
        console.log(`[Empresa ${EMPRESA_ID}] ¡Conexión exitosa! El worker está operativo.`);
        await query(
            'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, updated_at = NOW() WHERE id = $2',
            ['connected', EMPRESA_ID]
        );
    });

    nextClient.on('auth_failure', async (msg) => {
        console.error(`[Empresa ${EMPRESA_ID}] Fallo de autenticación:`, msg);
        await query('UPDATE empresas SET wpp_status = $1 WHERE id = $2', ['disconnected', EMPRESA_ID]);
    });

    nextClient.on('disconnected', async (reason) => {
        console.warn(`[Empresa ${EMPRESA_ID}] Sesión cerrada:`, reason);
        await query('UPDATE empresas SET wpp_status = $1 WHERE id = $2', ['disconnected', EMPRESA_ID]);
    });

    if (!WPP_QR_ONLY) {
        handlers.start(nextClient, { empresaId: Number(EMPRESA_ID) });
    } else {
        console.log(`[Empresa ${EMPRESA_ID}] Modo solo QR activo: no se atienden mensajes entrantes.`);
    }

    return nextClient;
}

async function clearCompanySessionDir() {
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

async function initializeClient() {
    if (isInitializing) return;
    isInitializing = true;

    try {
        client = createCompanyClient();
        await query('UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL WHERE id = $2', ['initializing', EMPRESA_ID]);
        await client.initialize();
    } finally {
        isInitializing = false;
    }
}

async function loadResetMarker() {
    const rows = await query('SELECT wpp_reset_requested_at FROM empresas WHERE id = $1 LIMIT 1', [EMPRESA_ID]);
    return rows[0]?.wpp_reset_requested_at ? new Date(rows[0].wpp_reset_requested_at).toISOString() : null;
}

async function resetAndRestartClient() {
    if (isResetting) return;
    isResetting = true;

    try {
        console.log(`[Empresa ${EMPRESA_ID}] Reset solicitado. Reiniciando sesión WhatsApp...`);
        try {
            if (client) await client.destroy();
        } catch (e) {
            console.warn(`[Empresa ${EMPRESA_ID}] No se pudo destruir cliente previo:`, e.message);
        }

        client = null;
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
            'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, updated_at = NOW() WHERE id = $2',
            ['disconnected', EMPRESA_ID]
        );
        try {
            console.log(`[Empresa ${EMPRESA_ID}] Reintentando inicialización luego del error de reset...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            await initializeClient();
        } catch (retryErr) {
            console.error(`[Empresa ${EMPRESA_ID}] Reintento tras reset falló:`, retryErr.message);
            await query(
                'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, updated_at = NOW() WHERE id = $2',
                ['disconnected', EMPRESA_ID]
            );
        }
    } finally {
        isResetting = false;
    }
}

async function checkResetRequest() {
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

function normalizeWhatsappTarget(phone) {
    let rawPhone = String(phone || '').trim();
    if (rawPhone.includes('@')) rawPhone = rawPhone.split('@')[0];

    const numeroBase = rawPhone.replace(/\D+/g, '');
    if (!numeroBase) throw new Error('telefono_invalido');

    const phoneToUse = numeroBase.length === 10 ? `549${numeroBase}` : numeroBase;
    return `${phoneToUse}@c.us`;
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
setInterval(async () => {
    if (WPP_QR_ONLY) return;
    if (!client || isInitializing || isResetting) return;

    try {
        const filas = await query(
            "SELECT * FROM wpp_outbox WHERE empresa_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 5",
            [EMPRESA_ID]
        );

        for (const fila of filas) {
            try {
                const target = normalizeWhatsappTarget(fila.telefono);
                
                await client.sendMessage(target, fila.mensaje);
                
                await query(
                    "UPDATE wpp_outbox SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = $1",
                    [fila.id]
                );
                console.log(`[Empresa ${EMPRESA_ID}] Mensaje enviado a ${fila.telefono}`);
            } catch (err) {
                console.error(`[Empresa ${EMPRESA_ID}] Error al enviar ID ${fila.id}:`, err.message);

                if (isConnectionSendError(err)) {
                    await query(
                        "UPDATE empresas SET wpp_status = 'disconnected', updated_at = NOW() WHERE id = $1",
                        [EMPRESA_ID]
                    );
                    await query(
                        "UPDATE wpp_outbox SET status = 'pending', error = $1 WHERE id = $2",
                        ['Fallback a WhatsApp general: conexión de empresa no disponible', fila.id]
                    );
                    console.warn(`[Empresa ${EMPRESA_ID}] Mensaje ID:${fila.id} queda pendiente para fallback general.`);
                    break;
                }

                if (isInvalidPhoneError(err)) {
                    await query(
                        "UPDATE wpp_outbox SET status = 'error', error = $1 WHERE id = $2",
                        ['Número de teléfono inválido', fila.id]
                    );
                } else {
                    await query(
                        "UPDATE wpp_outbox SET status = 'pending', error = $1 WHERE id = $2",
                        ['Reintento por error temporal en WhatsApp empresa', fila.id]
                    );
                }
            }
        }
    } catch (dbErr) {
        console.error(`[Empresa ${EMPRESA_ID}] Error consultando DB:`, dbErr.message);
    }
}, 5000);

// 5. ARRANQUE
console.log(`[Empresa ${EMPRESA_ID}] Iniciando cliente de WhatsApp${WPP_QR_ONLY ? ' en modo solo QR' : ''}...`);
try {
    await ensureEmpresaWhatsappSchema();
    lastResetHandledAt = await loadResetMarker();
    await initializeClient();
    setInterval(checkResetRequest, 5000);
} catch (err) {
    console.error(`[Empresa ${EMPRESA_ID}] Error iniciando cliente de WhatsApp:`, err.message);
    try {
        await query(
            'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, updated_at = NOW() WHERE id = $2',
            ['disconnected', EMPRESA_ID]
        );
    } catch (dbErr) {
        console.error(`[Empresa ${EMPRESA_ID}] Error actualizando estado tras fallo:`, dbErr.message);
    }
    process.exit(1);
}
