import { pool } from '../db.js';
import { enqueueWppOutbox, enqueueWppOutboxCorrelatedReply } from '../wpp/enqueue.js';

export async function enqueueWppMessage({
  phone, message, empresa_id = null,
}, transactionPool = pool) {
  return enqueueWppOutbox({ empresaId: empresa_id, phone, message }, transactionPool);
}

export async function enqueueCorrelatedWppMessage({
  phone, message, empresa_id = null, transport_origin,
}, transactionPool = pool) {
  return enqueueWppOutboxCorrelatedReply({
    empresaId: empresa_id,
    phone,
    message,
    transportOrigin: transport_origin,
  }, transactionPool);
}
