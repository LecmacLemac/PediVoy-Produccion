import { createIncomingMediaHandler } from './incomingMedia.js';

const handlerByClient = new WeakMap();

export function registerCompanyIncomingMedia(client, {
  empresaId,
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
  });
  client.on('message', handler);
  handlerByClient.set(client, handler);
  return handler;
}
