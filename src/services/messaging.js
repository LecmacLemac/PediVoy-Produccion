import { pool } from '../db.js';
import { enqueueWppOutbox, enqueueWppOutboxCorrelatedReply } from '../wpp/enqueue.js';

export async function enqueueWppMessage({
  phone, message, empresa_id = null, utility_template = null, ...extra
}, transactionPool = pool) {
  return enqueueWppOutbox({ empresaId: empresa_id, phone, message, utility_template, ...extra }, transactionPool);
}

export async function enqueueCorrelatedWppMessage({
  phone, message, empresa_id = null, transport_origin, correlation_id = null,
}, transactionPool = pool) {
  return enqueueWppOutboxCorrelatedReply({
    empresaId: empresa_id,
    phone,
    message,
    transportOrigin: transport_origin,
    correlationId: correlation_id,
  }, transactionPool);
}
