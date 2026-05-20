// src/services.js
// Compat layer: mantiene imports existentes mientras modularizamos el core.

export { withAuth, isSuper, isRepartidor, isReferente, isUser } from './core/auth.js';
export { getEmpresaIdFromToken, resolveEmpresaId } from './core/tenant.js';
export { checkLicencia } from './core/licencias.js';
export { geocodeIfNeeded, pointInAnyZone } from './core/geo.js';
export { digitsOnly, normalizePhone, moneyARS0 } from './core/format.js';
export { enqueueWppMessage } from './services/messaging.js';
export { sendSmsViaIfttt } from './services/sms.js';

export { query } from './db.js';
