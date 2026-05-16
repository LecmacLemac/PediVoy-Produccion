import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { query } from './db.js';

/**
 * CONFIGURACIÓN DE ENTORNO
 * EMPRESA_ID: Define qué sesión maneja este contenedor.
 * SESSION_PATH: Ruta al disco persistente (/mnt/data/wpp_sessions en Render).
 */
const EMPRESA_ID = process.env.EMPRESA_ID;
const SESSION_PATH = process.env.DISK_PATH || './wpp_sessions';

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

// 2. INICIALIZACIÓN DEL CLIENTE
const client = new Client({
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

// 3. EVENTOS DE WHATSAPP
client.on('qr', async (qr) => {
    console.log(`[Empresa ${EMPRESA_ID}] Nuevo QR generado. Esperando escaneo...`);
    await query(
        'UPDATE empresas SET wpp_qr_code = $1, wpp_status = $2, updated_at = NOW() WHERE id = $3', 
        [qr, 'awaiting_scan', EMPRESA_ID]
    );
});

client.on('ready', async () => {
    console.log(`[Empresa ${EMPRESA_ID}] ¡Conexión exitosa! El worker está operativo.`);
    await query(
        'UPDATE empresas SET wpp_status = $1, wpp_qr_code = NULL, updated_at = NOW() WHERE id = $2', 
        ['connected', EMPRESA_ID]
    );
});

client.on('auth_failure', async (msg) => {
    console.error(`[Empresa ${EMPRESA_ID}] Fallo de autenticación:`, msg);
    await query('UPDATE empresas SET wpp_status = $1 WHERE id = $2', ['disconnected', EMPRESA_ID]);
});

client.on('disconnected', async (reason) => {
    console.warn(`[Empresa ${EMPRESA_ID}] Sesión cerrada:`, reason);
    await query('UPDATE empresas SET wpp_status = $1 WHERE id = $2', ['disconnected', EMPRESA_ID]);
});

// 4. PROCESADOR DE COLA DE MENSAJES (OUTBOX)
// Revisa mensajes pendientes cada 5 segundos para esta empresa específicamente.
setInterval(async () => {
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
client.initialize();