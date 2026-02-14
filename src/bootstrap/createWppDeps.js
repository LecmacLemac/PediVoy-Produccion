import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';

import { enqueueWppMessage, checkLicencia } from '../services.js';
import handlers from '../handlers.js';

const { Client, LocalAuth } = pkg;

export function createWppDeps() {
  const ENABLE_WPP = process.env.ENABLE_WPP === '1' || process.env.RENDER === 'true';

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
