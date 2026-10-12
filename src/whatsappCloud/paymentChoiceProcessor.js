import { validateMetaWamid } from './messageId.js';
import { parseProactiveNotificationCorrelationId } from '../wpp/proactiveCorrelation.js';
import { createNotificarPedidoTransferencia } from '../services/notificacionesPedidos.js';
import { enqueueTransferPaymentWppMessageInTransaction } from '../services/messaging.js';

const PAYMENT_METHOD_BY_PAYLOAD = Object.freeze({
  pedivoy_payment_cash_v1: 'efectivo',
  pedivoy_payment_transfer_v1: 'transferencia',
});
const TERMINAL_ORDER_STATES = new Set(['cancelado', 'entregado']);

function safeError(code) {
  return Object.assign(new Error(code), { code });
}

async function rows(client, text, values = [], sensitive = false) {
  const result = await client.query({ text, values, sensitive });
  return result?.rows || [];
}

function validateInput({ empresaId, messageId, contextMessageId, buttonPayload, assertLease }) {
  const tenantId = Number(empresaId);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || tenantId > 0x7fffffff) {
    throw safeError('PAYMENT_CHOICE_INVALID_INPUT');
  }
  if (!validateMetaWamid(messageId) || !validateMetaWamid(contextMessageId)
      || !Object.hasOwn(PAYMENT_METHOD_BY_PAYLOAD, buttonPayload)
      || typeof assertLease !== 'function') {
    throw safeError('PAYMENT_CHOICE_INVALID_INPUT');
  }
  return { tenantId, paymentMethod: PAYMENT_METHOD_BY_PAYLOAD[buttonPayload] };
}

async function defaultTransferNotifier({ client, pedidoId, empresaId }) {
  const notifier = createNotificarPedidoTransferencia({
    queryFn: async (sql, params = []) => rows(client, sql, params, true),
    enqueueWppMessageFn: input => enqueueTransferPaymentWppMessageInTransaction(input, {
      client,
      transactionOwner: 'caller',
    }, { requireCloud: true }),
  });
  return notifier(pedidoId, empresaId, { requireCloud: true });
}

function notificationOutcome(result) {
  if (result?.queued === true) {
    return { status: 'queued', outboxId: Number.isSafeInteger(result.id) ? result.id : null };
  }
  if (result?.queued === false && result?.reason === 'duplicate_notification') {
    if (['pending', 'sending', 'sent'].includes(result.status)) {
      return { status: 'queued', outboxId: Number.isSafeInteger(result.id) ? result.id : null };
    }
    if (['error', 'skipped'].includes(result.status)) {
      return { status: 'unavailable', outboxId: Number.isSafeInteger(result.id) ? result.id : null };
    }
  }
  if (result?.queued === false && result?.reason === 'transfer_notification_unavailable') {
    return { status: 'unavailable', outboxId: null };
  }
  throw safeError('PAYMENT_CHOICE_NOTIFICATION_FAILED');
}

export function createWhatsAppPaymentChoiceProcessor({
  pool,
  notifyTransferInTransaction = defaultTransferNotifier,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof notifyTransferInTransaction !== 'function') {
    throw new TypeError('payment choice dependencies invalid');
  }

  return async function processPaymentChoice(input) {
    const { tenantId, paymentMethod } = validateInput(input);
    await input.assertLease();

    let client;
    try {
      client = await pool.connect();
    } catch {
      throw safeError('PAYMENT_CHOICE_FAILED');
    }
    let transactionOpen = false;
    let commitAttempted = false;
    let releaseError;
    const commitTransaction = async () => {
      commitAttempted = true;
      try {
        await client.query('COMMIT');
        transactionOpen = false;
      } catch {
        const unknown = safeError('PAYMENT_CHOICE_OUTCOME_UNKNOWN');
        releaseError = unknown;
        throw unknown;
      }
    };

    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const outboundRows = await rows(client, `
        SELECT id, notification_correlation_id, cloud_template_key, transport_origin
          FROM wpp_outbox
         WHERE empresa_id = $1
           AND meta_message_id = $2
         ORDER BY id
         LIMIT 2
         FOR UPDATE
      `, [tenantId, input.contextMessageId], true);
      if (outboundRows.length === 0) {
        await commitTransaction();
        return { handled: true, outcome: 'context_not_found' };
      }
      if (outboundRows.length !== 1) throw safeError('PAYMENT_CHOICE_CONTEXT_AMBIGUOUS');

      const outbound = outboundRows[0];
      const correlation = parseProactiveNotificationCorrelationId(outbound.notification_correlation_id);
      if (outbound.transport_origin !== 'cloud' || outbound.cloud_template_key !== 'order_confirmation'
          || correlation?.templateKey !== 'order_confirmation') {
        await commitTransaction();
        return { handled: true, outcome: 'context_not_order_confirmation' };
      }

      const orders = await rows(client, `
        SELECT id, empresa_id, estado, metodo_pago
          FROM pedidos
         WHERE id = $1
           AND empresa_id = $2
         FOR UPDATE
      `, [correlation.pedidoId, tenantId]);
      if (orders.length !== 1) {
        await commitTransaction();
        return { handled: true, outcome: 'order_not_found' };
      }
      const order = orders[0];

      const inboundEvents = await rows(client, `
        SELECT pedido_id, outbound_message_id, metodo_pago, resultado, notification_status
          FROM pedido_metodo_pago_eventos
         WHERE empresa_id = $1
           AND inbound_message_id = $2
         LIMIT 1
      `, [tenantId, input.messageId], true);
      if (inboundEvents.length) {
        const prior = inboundEvents[0];
        const exact = Number(prior.pedido_id) === Number(order.id)
          && prior.outbound_message_id === input.contextMessageId
          && prior.metodo_pago === paymentMethod;
        if (!exact) throw safeError('PAYMENT_CHOICE_INBOUND_CONFLICT');
        await commitTransaction();
        return {
          handled: true,
          outcome: 'idempotent',
          paymentMethod: prior.metodo_pago,
          notification: prior.notification_status,
        };
      }

      if (TERMINAL_ORDER_STATES.has(String(order.estado || '').toLowerCase())) {
        await commitTransaction();
        return { handled: true, outcome: 'order_terminal' };
      }

      const acceptedEvents = await rows(client, `
        SELECT metodo_pago, notification_status
          FROM pedido_metodo_pago_eventos
         WHERE empresa_id = $1
           AND outbound_message_id = $2
           AND resultado = 'accepted'
         LIMIT 1
      `, [tenantId, input.contextMessageId], true);
      if (acceptedEvents.length) {
        const accepted = acceptedEvents[0];
        if (accepted.metodo_pago !== paymentMethod) {
          await rows(client, `
            INSERT INTO pedido_metodo_pago_eventos
              (empresa_id,pedido_id,outbound_message_id,inbound_message_id,metodo_pago,origen,resultado,notification_status)
            VALUES ($1,$2,$3,$4,$5,'cliente_whatsapp','rejected_contradictory','not_required')
            RETURNING id
          `, [tenantId, order.id, input.contextMessageId, input.messageId, paymentMethod], true);
          await commitTransaction();
          return {
            handled: true,
            outcome: 'rejected_contradictory',
            paymentMethod: accepted.metodo_pago,
            notification: accepted.notification_status,
          };
        }
        await commitTransaction();
        return {
          handled: true,
          outcome: 'duplicate_same_choice',
          paymentMethod,
          notification: accepted.notification_status,
        };
      }

      const updated = await rows(client, `
        UPDATE pedidos
           SET metodo_pago = $1,
               metodo_pago_origen = 'cliente_whatsapp',
               metodo_pago_seleccionado_at = pg_catalog.NOW(),
               metodo_pago_outbound_message_id = $2,
               metodo_pago_inbound_message_id = $3
         WHERE id = $4
           AND empresa_id = $5
           AND estado NOT IN ('cancelado','entregado')
         RETURNING id
      `, [paymentMethod, input.contextMessageId, input.messageId, order.id, tenantId], true);
      if (updated.length !== 1) throw safeError('PAYMENT_CHOICE_ORDER_CHANGED');

      const inserted = await rows(client, `
        INSERT INTO pedido_metodo_pago_eventos
          (empresa_id,pedido_id,outbound_message_id,inbound_message_id,metodo_pago,origen,resultado,notification_status)
        VALUES ($1,$2,$3,$4,$5,'cliente_whatsapp','accepted','not_required')
        RETURNING id
      `, [tenantId, order.id, input.contextMessageId, input.messageId, paymentMethod], true);
      if (inserted.length !== 1) throw safeError('PAYMENT_CHOICE_AUDIT_FAILED');

      let notification = { status: 'not_required', outboxId: null };
      if (paymentMethod === 'transferencia') {
        notification = notificationOutcome(await notifyTransferInTransaction({
          client,
          pedidoId: Number(order.id),
          empresaId: tenantId,
        }));
        const auditUpdated = await rows(client, `
          UPDATE pedido_metodo_pago_eventos
             SET notification_status = $1,
                 notification_outbox_id = $2
           WHERE id = $3
           RETURNING id
        `, [notification.status, notification.outboxId, inserted[0].id], true);
        if (auditUpdated.length !== 1) throw safeError('PAYMENT_CHOICE_AUDIT_FAILED');
      }

      await input.assertLease();
      await commitTransaction();
      return {
        handled: true,
        outcome: 'accepted',
        paymentMethod,
        notification: notification.status,
      };
    } catch (error) {
      if (transactionOpen && !commitAttempted) {
        try { await client.query('ROLLBACK'); } catch { releaseError = safeError('PAYMENT_CHOICE_FAILED'); }
      }
      if (error?.code === 'PAYMENT_CHOICE_OUTCOME_UNKNOWN') throw error;
      if (error?.code && String(error.code).startsWith('PAYMENT_CHOICE_')) throw error;
      throw safeError('PAYMENT_CHOICE_FAILED');
    } finally {
      client.release(releaseError);
    }
  };
}
