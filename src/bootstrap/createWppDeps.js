import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';

import { enqueueWppMessage, checkLicencia } from '../services.js';
import handlers from '../handlers.js';

const { Client, LocalAuth } = pkg;

export function createWppDeps() {
  // Solo habilitar WhatsApp cuando se pide explícitamente.
  // En Render puede no existir navegador, así que no se debe forzar por RENDER=true.
  const ENABLE_WPP = process.env.ENABLE_WPP === '1';

  return {
    ENABLE_WPP,
    wpp: {
      Client,
      LocalAuth,
      qrcode,
      handlers,
      enqueueWppMessage,
      checkLicencia,
    },
  };
}
