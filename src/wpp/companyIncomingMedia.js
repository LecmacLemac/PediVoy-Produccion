import { createIncomingMediaHandler } from './incomingMedia.js';

const handlerByClient = new WeakMap();

export function registerCompanyIncomingMedia(client, {
  empresaId,
  generation,
  withActiveClient,
  query,
  lidByPhone = new Map(),
  handleIncomingComprobanteFromBotPg,
}) {
  if (!client || typeof client.on !== 'function') {
    throw new Error('registerCompanyIncomingMedia: cliente inválido');
  }
  const tenantId = Number(empresaId || 0);
  if (!tenantId) throw new Error('registerCompanyIncomingMedia: empresaId inválido');

  const existing = handlerByClient.get(client);
  if (existing) return existing;

  const handler = createIncomingMediaHandler({
    empresaId: tenantId,
    query,
    lidByPhone,
    handleIncomingComprobanteFromBotPg,
    // El callback completo ya está protegido por el gate exterior; exponer el
    // cliente aquí permite resolver de forma oficial LID -> PN sin abrir un
    // segundo lease ni usar los dígitos internos del LID como teléfono.
    withActiveClient: fn => fn({ client, generation }),
  });
  const guardedHandler = typeof withActiveClient === 'function'
    ? message => Promise.resolve(withActiveClient(({ client: activeClient, generation: activeGeneration }) => {
      if (activeClient !== client || activeGeneration !== generation) {
        throw Object.assign(new Error('WhatsApp Empresa media generation changed'), {
          code: 'WPP_COMPANY_NOT_OWNER',
        });
      }
      return handler(message);
    })).catch(error => {
      if (error?.code !== 'WPP_COMPANY_NOT_OWNER' && error?.code !== 'WPP_NOT_OWNER') {
        console.error('[WPP SERVER] Error en gate de media empresa:', error?.message || String(error));
      }
    })
    : handler;
  client.on('message', guardedHandler);
  handlerByClient.set(client, guardedHandler);
  return guardedHandler;
}
