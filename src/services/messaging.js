import { pool } from '../db.js';
import {
  enqueueWppOutbox,
  enqueueWppOutboxCorrelatedReply,
  enqueueWppOrderConfirmationNotification,
  enqueueWppOrderEnRouteNotification,
  enqueueWppTransferPaymentNotification,
  WppTransportConfigError,
} from '../wpp/enqueue.js';

export async function enqueueWppMessage({
  phone, message, empresa_id = null, utility_template = null, ...extra
}, transactionPool = pool) {
  if (Object.keys(extra).length) throw new WppTransportConfigError('cloud_template_payload_invalid');
  return enqueueWppOutbox({
    empresaId: empresa_id,
    phone,
    message,
    utility_template,
  }, transactionPool);
}

function enqueueRequiredNotification(enqueue, {
  phone, message, empresa_id = null, utility_template = null, ...extra
}, transactionPool) {
  if (Object.keys(extra).length) throw new WppTransportConfigError('cloud_template_payload_invalid');
  return enqueue({ empresaId: empresa_id, phone, message, utility_template }, transactionPool);
}

export function enqueueOrderConfirmationWppMessage(input, transactionPool = pool) {
  return enqueueRequiredNotification(enqueueWppOrderConfirmationNotification, input, transactionPool);
}

export function enqueueOrderEnRouteWppMessage(input, transactionPool = pool) {
  return enqueueRequiredNotification(enqueueWppOrderEnRouteNotification, input, transactionPool);
}

export function enqueueTransferPaymentWppMessage(input, transactionPool = pool) {
  return enqueueRequiredNotification(enqueueWppTransferPaymentNotification, input, transactionPool);
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
