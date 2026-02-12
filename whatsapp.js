<<<<<<< HEAD
// whatsapp.js — Bot WhatsApp con PostgreSQL + outbox + pipeline transferencias (ESM)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import wwebjs from 'whatsapp-web.js';              // CJS interop
const { Client, LocalAuth, MessageMedia } = wwebjs;

import { query } from './src/db.js';               // ✅ PostgreSQL
import handlers from './src/handlers.js';
import {
  handleIncomingComprobanteFromBotPg as handleIncomingComprobanteFromBot
} from './src/transferenciasPipeline.js';         // ✅ pipeline PG

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV ---
const FLUSH_INTERVAL_MS = Number(process.env.WPP_FLUSH_INTERVAL_MS || 1500);
const PACE_MS           = Number(process.env.WPP_PACE_MS || 300);

// --- Helpers básicos ---
function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Normaliza un número argentino al formato internacional de WhatsApp.
 * Ejemplo: 3582451723 → 5493582451723 (sin +, WWebJS se encarga)
 */
function normalizarNumero(num) {
  let n = String(num || '').replace(/\D+/g, '');

  if (n.startsWith('549')) return n;
  if (n.startsWith('54'))  return '549' + n.slice(2);

  if (n.startsWith('0'))   n = n.slice(1); // quita 0 troncal
  if (n.startsWith('15'))  n = n.slice(2); // quita 15 local si viniera así

  return '549' + n;
}

const idCache = new Map();

/**
 * Convierte un número "crudo" al chatId válido para WhatsApp
 */
async function resolveChatId(phone) {
  const d = normalizarNumero(phone);
  if (!d) return null;
  if (idCache.has(d)) return idCache.get(d);

  const info = await client.getNumberId(d).catch(() => null); // { _serialized, user, server }
  const chatId = info?._serialized || `${d}@c.us`;
  idCache.set(d, chatId);
  return chatId;
}

// -----------------------------------------------------
// Outbox PostgreSQL (wpp_outbox)
// -----------------------------------------------------

// claimPending: toma N mensajes con status = 'pending' desde wpp_outbox
async function claimPendingWpp(limit = 30) {
  // CORRECCIÓN: Usamos 'telefono', 'mensaje' y 'status' para coincidir con backend.js
  const rows = await query(
    `
    SELECT id, telefono, mensaje
    FROM wpp_outbox
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT $1
    `,
    [limit]
  );

  return rows.map(r => ({
    id: r.id,
    phone: r.telefono, // Mapeamos DB(telefono) -> JS(phone)
    message: r.mensaje // Mapeamos DB(mensaje) -> JS(message)
  }));
}

// markWppResult: marca como 'sent' o 'error'
async function markWppResult(id, ok) {
  // CORRECCIÓN: Actualizamos la columna 'status' y 'error'
  await query(
    `
    UPDATE wpp_outbox
    SET status = $2,
        error = CASE WHEN $2 = 'sent' THEN NULL ELSE 'Error al enviar desde bot' END
    WHERE id = $1
    `,
    [id, ok ? 'sent' : 'error']
  );
}

// -----------------------------------------------------
// Cliente WWebJS
// -----------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: (process.env.WPP_SESSION || 'multiempresa')
  }),
  puppeteer: {
    // headless: true, // en servidor/VPS
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

// --- Loop de envío (outbox) ---
let loopTimer = null;
let isFlushing = false;

async function flushOnce() {
  const batchSize = Number(process.env.WPP_SEND_BATCH_SIZE || 30);
  const batch = await claimPendingWpp(batchSize);
  if (!batch.length) return;

  for (const msg of batch) {
    try {
      const chatId = await resolveChatId(msg.phone);
      const text   = (msg.message ?? '').toString().trim();
      if (!chatId || !text) {
        await markWppResult(msg.id, true);
        continue;
      }
      await client.sendMessage(chatId, text);
      await markWppResult(msg.id, true);
      await delay(PACE_MS);
    } catch (e) {
      console.error('[WPP] Error enviando mensaje id', msg.id, e?.message || e);
      await markWppResult(msg.id, false);
      // seguimos con el próximo
    }
  }
}

// -----------------------------------------------------
// Eventos de sesión
// -----------------------------------------------------
client.on('qr', (qr) => {
  console.clear();
  console.log('[WPP] Escaneá este QR: WhatsApp > Dispositivos vinculados > Vincular dispositivo');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('[WPP] Cliente listo ✓');

  // Delegar inbound COMPLETO a handlers (ventas, pedidos, etc.)
  try {
    await handlers.start(client);
    console.log('[WPP] handlers.start conectado ✓');
  } catch (e) {
    console.error('[WPP] No se pudo iniciar handlers.start:', e?.message || e);
  }

  // Iniciar loop outbox
  if (!loopTimer) {
    loopTimer = setInterval(async () => {
      if (isFlushing) return;
      isFlushing = true;
      try { await flushOnce(); }
      catch (e) { console.error('[WPP] flushOnce error', e?.message || e); }
      finally { isFlushing = false; }
    }, FLUSH_INTERVAL_MS);
  }
});

client.on('authenticated', () => console.log('[WPP] Autenticado ✓'));
client.on('auth_failure', (m) => console.error('[WPP] Falló autenticación:', m));
client.on('disconnected', (r) => console.warn('[WPP] Desconectado:', r));

// -----------------------------------------------------
// Inbound: mensajes con media → pipeline de transferencias (PG)
// -----------------------------------------------------
client.on('message', async (msg) => {
  try {
    const t = String(msg?.type || '').toLowerCase();
    const isMedia = (msg?.hasMedia === true || t === 'image' || t === 'document');
    if (!isMedia) return;

    const media = await msg.downloadMedia().catch(() => null);
    if (!media) return;

    const buffer   = Buffer.from(media.data, 'base64');
    const mimetype = media.mimetype || '';
    const filename = media.filename || msg?.body?.slice(0, 30) || 'comprobante';

    await handleIncomingComprobanteFromBot({
      type: t,
      telefono: msg.from,
      buffer,
      mimetype,
      filename
    });
  } catch (e) {
    console.error('[WPP] Error procesando media:', e?.message || e);
  }
});

// -----------------------------------------------------
// Init / shutdown
// -----------------------------------------------------
client.initialize().catch((e) => {
  console.error('[WPP] Fatal init', e);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[WPP] SIGINT. Saliendo...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[WPP] SIGTERM. Saliendo...');
  process.exit(0);
=======
// whatsapp.js — Bot WhatsApp con PostgreSQL + outbox + pipeline transferencias (ESM)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import wwebjs from 'whatsapp-web.js';              // CJS interop
const { Client, LocalAuth, MessageMedia } = wwebjs;

import { query } from './src/db.js';               // ✅ PostgreSQL
import handlers from './src/handlers.js';
import {
  handleIncomingComprobanteFromBotPg as handleIncomingComprobanteFromBot
} from './src/transferenciasPipeline.js';         // ✅ pipeline PG

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV ---
const FLUSH_INTERVAL_MS = Number(process.env.WPP_FLUSH_INTERVAL_MS || 1500);
const PACE_MS           = Number(process.env.WPP_PACE_MS || 300);

// --- Helpers básicos ---
function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Normaliza un número argentino al formato internacional de WhatsApp.
 * Ejemplo: 3582451723 → 5493582451723 (sin +, WWebJS se encarga)
 */
function normalizarNumero(num) {
  let n = String(num || '').replace(/\D+/g, '');

  if (n.startsWith('549')) return n;
  if (n.startsWith('54'))  return '549' + n.slice(2);

  if (n.startsWith('0'))   n = n.slice(1); // quita 0 troncal
  if (n.startsWith('15'))  n = n.slice(2); // quita 15 local si viniera así

  return '549' + n;
}

const idCache = new Map();

/**
 * Convierte un número "crudo" al chatId válido para WhatsApp
 */
async function resolveChatId(phone) {
  const d = normalizarNumero(phone);
  if (!d) return null;
  if (idCache.has(d)) return idCache.get(d);

  const info = await client.getNumberId(d).catch(() => null); // { _serialized, user, server }
  const chatId = info?._serialized || `${d}@c.us`;
  idCache.set(d, chatId);
  return chatId;
}

// -----------------------------------------------------
// Outbox PostgreSQL (wpp_outbox)
// -----------------------------------------------------

// claimPending: toma N mensajes con status = 'pending' desde wpp_outbox
async function claimPendingWpp(limit = 30) {
  // CORRECCIÓN: Usamos 'telefono', 'mensaje' y 'status' para coincidir con backend.js
  const rows = await query(
    `
    SELECT id, telefono, mensaje
    FROM wpp_outbox
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT $1
    `,
    [limit]
  );

  return rows.map(r => ({
    id: r.id,
    phone: r.telefono, // Mapeamos DB(telefono) -> JS(phone)
    message: r.mensaje // Mapeamos DB(mensaje) -> JS(message)
  }));
}

// markWppResult: marca como 'sent' o 'error'
async function markWppResult(id, ok) {
  // CORRECCIÓN: Actualizamos la columna 'status' y 'error'
  await query(
    `
    UPDATE wpp_outbox
    SET status = $2,
        error = CASE WHEN $2 = 'sent' THEN NULL ELSE 'Error al enviar desde bot' END
    WHERE id = $1
    `,
    [id, ok ? 'sent' : 'error']
  );
}

// -----------------------------------------------------
// Cliente WWebJS
// -----------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: (process.env.WPP_SESSION || 'multiempresa')
  }),
  puppeteer: {
    // headless: true, // en servidor/VPS
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

// --- Loop de envío (outbox) ---
let loopTimer = null;
let isFlushing = false;

async function flushOnce() {
  const batchSize = Number(process.env.WPP_SEND_BATCH_SIZE || 30);
  const batch = await claimPendingWpp(batchSize);
  if (!batch.length) return;

  for (const msg of batch) {
    try {
      const chatId = await resolveChatId(msg.phone);
      const text   = (msg.message ?? '').toString().trim();
      if (!chatId || !text) {
        await markWppResult(msg.id, true);
        continue;
      }
      await client.sendMessage(chatId, text);
      await markWppResult(msg.id, true);
      await delay(PACE_MS);
    } catch (e) {
      console.error('[WPP] Error enviando mensaje id', msg.id, e?.message || e);
      await markWppResult(msg.id, false);
      // seguimos con el próximo
    }
  }
}

// -----------------------------------------------------
// Eventos de sesión
// -----------------------------------------------------
client.on('qr', (qr) => {
  console.clear();
  console.log('[WPP] Escaneá este QR: WhatsApp > Dispositivos vinculados > Vincular dispositivo');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('[WPP] Cliente listo ✓');

  // Delegar inbound COMPLETO a handlers (ventas, pedidos, etc.)
  try {
    await handlers.start(client);
    console.log('[WPP] handlers.start conectado ✓');
  } catch (e) {
    console.error('[WPP] No se pudo iniciar handlers.start:', e?.message || e);
  }

  // Iniciar loop outbox
  if (!loopTimer) {
    loopTimer = setInterval(async () => {
      if (isFlushing) return;
      isFlushing = true;
      try { await flushOnce(); }
      catch (e) { console.error('[WPP] flushOnce error', e?.message || e); }
      finally { isFlushing = false; }
    }, FLUSH_INTERVAL_MS);
  }
});

client.on('authenticated', () => console.log('[WPP] Autenticado ✓'));
client.on('auth_failure', (m) => console.error('[WPP] Falló autenticación:', m));
client.on('disconnected', (r) => console.warn('[WPP] Desconectado:', r));

// -----------------------------------------------------
// Inbound: mensajes con media → pipeline de transferencias (PG)
// -----------------------------------------------------
client.on('message', async (msg) => {
  try {
    const t = String(msg?.type || '').toLowerCase();
    const isMedia = (msg?.hasMedia === true || t === 'image' || t === 'document');
    if (!isMedia) return;

    const media = await msg.downloadMedia().catch(() => null);
    if (!media) return;

    const buffer   = Buffer.from(media.data, 'base64');
    const mimetype = media.mimetype || '';
    const filename = media.filename || msg?.body?.slice(0, 30) || 'comprobante';

    await handleIncomingComprobanteFromBot({
      type: t,
      telefono: msg.from,
      buffer,
      mimetype,
      filename
    });
  } catch (e) {
    console.error('[WPP] Error procesando media:', e?.message || e);
  }
});

// -----------------------------------------------------
// Init / shutdown
// -----------------------------------------------------
client.initialize().catch((e) => {
  console.error('[WPP] Fatal init', e);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[WPP] SIGINT. Saliendo...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[WPP] SIGTERM. Saliendo...');
  process.exit(0);
>>>>>>> origin/main
});