// index.venom.js — Venom ESM + adapter para usar src/handlers.js tal cual
import 'dotenv/config';
import venomPkg from 'venom-bot';
import start from './src/handlers.js';

// venom-bot es CJS; en ESM a veces viene como default o namespace
const venom = venomPkg?.default ?? venomPkg;

// Cargar historial si existe (no rompe si no está)
let cargarHistorialConversacion = null;
try {
  const utils = await import('./src/utils.js');
  cargarHistorialConversacion = utils.cargarHistorialConversacion;
} catch {
  // ok, no existe en este repo
}

// Adapter: mapea la API de venom a la que esperan tus handlers
function makeClientAdapter(vClient) {
  return {
    // handlers.js usa client.on('message', cb)
    on(event, cb) {
      if (event !== 'message') return;
      vClient.onMessage(async (msg) => {
        // Adaptamos a un shape parecido al de whatsapp-web.js
        const adapted = {
          from: msg.from,
          body: msg.body || msg.content || '',
          hasMedia: msg.isMedia === true || !!msg.body?.includes?.('data:'),
          fromMe: msg.fromMe === true,
          id: { fromMe: msg.fromMe === true },
          _data: { id: { fromMe: msg.fromMe === true } },
          // si querés, podés ir agregando campos acá
        };
        cb(adapted);
      });
    },

    // handlers.js usa client.sendMessage(numero, texto)
    async sendMessage(to, text) {
      // venom espera el chatId tipo '549...@c.us' o número.
      // Si viene con @c.us, lo dejamos. Si no, lo usa igual.
      return vClient.sendText(to, String(text || ''));
    },

    // opcional: por si algo llama getNumberId (en whatsapp.js sí existe)
    async getNumberId(num) {
      // venom no tiene algo igual; devolvemos un objeto compatible
      const user = String(num || '').replace(/\D/g, '');
      return { _serialized: `${user}@c.us`, user, server: 'c.us' };
    }
  };
}

(async () => {
  try {
    if (typeof cargarHistorialConversacion === 'function') {
      cargarHistorialConversacion();
      console.log('📂 Historial de conversaciones cargado.');
    }
  } catch (err) {
    console.warn('⚠️ No se pudo cargar historial:', err?.message || err);
  }

  venom.create({
    session: process.env.VENOM_SESSION_NAME || 'session-name',
    multidevice: true,
    headless: true,
    waitForLogin: true,
    debug: false,
    logQR: true,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    autoClose: 0,
  })
  .then((client) => {
    console.log('✅ Venom Bot iniciado correctamente.');

    const adapter = makeClientAdapter(client);

    // Reutiliza tus handlers actuales
    start(adapter);
  })
  .catch((error) => {
    console.error('❗ Error fatal al iniciar Venom:', error);
  });
})();
