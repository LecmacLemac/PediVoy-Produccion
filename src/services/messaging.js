import { pool } from '../db.js';
import {
  enqueueWppOutbox,
  enqueueWppOutboxCorrelatedReply,
  enqueueWppOrderConfirmationNotification,
  enqueueWppOrderEnRouteNotification,
  enqueueWppTransferPaymentNotification,
  WppTransportConfigError,
} from '../wpp/enqueue.js';
import { buildProactiveNotificationCorrelationId } from '../wpp/proactiveCorrelation.js';

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

async function enqueueRequiredNotification(enqueue, requiredUtilityTemplateKey, {
  phone,
  message,
  empresa_id = null,
  utility_template = null,
  pedido_id = null,
  ...extra
}, transactionPool) {
  if (Object.keys(extra).length) throw new WppTransportConfigError('cloud_template_payload_invalid');
  const notificationCorrelationId = buildProactiveNotificationCorrelationId(requiredUtilityTemplateKey, pedido_id);
  if (pedido_id != null && !notificationCorrelationId) {
    throw new WppTransportConfigError('notification_correlation_id_invalido');
  }
  return enqueue({
    empresaId: empresa_id,
    phone,
    message,
    utility_template,
    notificationCorrelationId,
  }, transactionPool);
}

export function enqueueOrderConfirmationWppMessage(input, transactionPool = pool) {
  return enqueueRequiredNotification(enqueueWppOrderConfirmationNotification, 'order_confirmation', input, transactionPool);
}

export function enqueueOrderEnRouteWppMessage(input, transactionPool = pool) {
  return enqueueRequiredNotification(enqueueWppOrderEnRouteNotification, 'order_en_route', input, transactionPool);
}

export function enqueueTransferPaymentWppMessage(input, transactionPool = pool) {
  return enqueueRequiredNotification(enqueueWppTransferPaymentNotification, 'transfer_payment', input, transactionPool);
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
