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
    const nextClient = new Client({
        authStrategy: new LocalAuth({
            clientId: `empresa_${EMPRESA_ID}`,
            dataPath: SESSION_PATH
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Optimiza memoria en contenedores
                '--disable-gpu'
            ],
            // En Docker (Debian/Ubuntu), usamos el binario instalado por el Dockerfile
            executablePath: process.env.NODE_ENV === 'production' ? '/usr/bin/chromium' : undefined
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

    handlers.start(nextClient, { empresaId: Number(EMPRESA_ID) });

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
        await query('UPDATE empresas SET wpp_status = $1 WHERE id = $2', ['disconnected', EMPRESA_ID]);
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

// 4. PROCESADOR DE COLA DE MENSAJES (OUTBOX)
// Revisa mensajes pendientes cada 5 segundos para esta empresa específicamente.
setInterval(async () => {
    if (!client || isInitializing || isResetting) return;

    try {
        const filas = await query(
            "SELECT * FROM wpp_outbox WHERE empresa_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 5",
            [EMPRESA_ID]
        );

        for (const fila of filas) {
            try {
                // Validación básica de formato de teléfono
                const target = fila.telefono.includes('@c.us') ? fila.telefono : `${fila.telefono}@c.us`;
                
                await client.sendMessage(target, fila.mensaje);
                
                await query(
                    "UPDATE wpp_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1", 
                    [fila.id]
                );
                console.log(`[Empresa ${EMPRESA_ID}] Mensaje enviado a ${fila.telefono}`);
            } catch (err) {
                console.error(`[Empresa ${EMPRESA_ID}] Error al enviar ID ${fila.id}:`, err.message);
                await query("UPDATE wpp_outbox SET status = 'error' WHERE id = $1", [fila.id]);
            }
        }
    } catch (dbErr) {
        console.error(`[Empresa ${EMPRESA_ID}] Error consultando DB:`, dbErr.message);
    }
}, 5000);

// 5. ARRANQUE
console.log(`[Empresa ${EMPRESA_ID}] Iniciando cliente de WhatsApp...`);
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
