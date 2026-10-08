// src/services/notificacionesPedidos.js
import crypto from 'node:crypto';
import { query } from '../db.js';
import {
  enqueueOrderEnRouteWppMessage,
  enqueueTransferPaymentWppMessage,
} from './messaging.js';

let pedidosNotificationSchemaReady = false;

const SAFE_NOTIFICATION_ERROR_CODES = new Set([
  'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN',
  'before_enqueue_invalido',
  'cloud_config_invalida',
  'cloud_template_payload_invalid',
  'config_integraciones_invalida',
  'config_whatsapp_invalida',
  'dedupe_window_invalida',
  'empresa_id_invalido',
  'empresa_no_encontrada',
  'enqueue_fallido',
  'enqueue_sin_resultado',
  'notification_correlation_id_invalido',
  'notification_correlation_id_requerido',
  'notification_enqueue_not_accepted',
  'query_requerida',
  'transaction_client_requerido',
  'transaction_pool_requerido',
  'transport_origin_correlacionado_no_permitido',
]);
const MAX_NOTIFICATION_ERROR_CODE_LENGTH = 64;

function sanitizedNotificationError(error) {
  const candidate = typeof error?.code === 'string' && error.code.length <= MAX_NOTIFICATION_ERROR_CODE_LENGTH
    ? error.code
    : '';
  const code = SAFE_NOTIFICATION_ERROR_CODES.has(candidate) ? candidate : 'notification_failed';
  return Object.assign(new Error(code), { code });
}

function isDurableEnqueueAcceptance(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Number.isSafeInteger(result.id) || result.id <= 0
      || !['general', 'company', 'cloud'].includes(result.transportOrigin)) return false;
  const keys = Object.keys(result).sort();
  if (result.queued === true) {
    return result.status === 'pending'
      && JSON.stringify(keys) === JSON.stringify(['id', 'queued', 'status', 'transportOrigin']);
  }
  return result.queued === false
    && result.skipped === true
    && result.reason === 'duplicate_notification'
    && ['pending', 'sending', 'sent', 'error', 'skipped'].includes(result.status)
    && JSON.stringify(keys) === JSON.stringify(['id', 'queued', 'reason', 'skipped', 'status', 'transportOrigin']);
}

async function ensurePedidosNotificationSchema(queryFn) {
  if (pedidosNotificationSchemaReady) return;
  await queryFn(
    `ALTER TABLE pedidos
       ADD COLUMN IF NOT EXISTS en_ruta_notificado_at TIMESTAMPTZ`
  );
  pedidosNotificationSchemaReady = true;
}

function buildTrackingUrl({ landingDomain, token }) {
  let host = String(landingDomain || 'https://www.pedivoy.com').trim();
  if (!host.startsWith('http')) host = 'https://' + host;
  host = host.replace(/\/+$/, '');
  return `${host}/pedidos/seguimiento.html?t=${encodeURIComponent(token)}`;
}

/**
 * Genera token (si no existe) y envía WPP de 'En Ruta' solo la primera vez.
 */
export function createNotificarEnRuta({
  queryFn = query,
  enqueueWppMessageFn = enqueueOrderEnRouteWppMessage,
  randomBytes = crypto.randomBytes,
} = {}) {
  return async function notificarEnRutaHandler(pedidoId, empresaId) {
    try {
      await ensurePedidosNotificationSchema(queryFn);

      const rows = await queryFn(
        `
      SELECT 
        p.id,
        p.monto,
        p.tracking_token,
        p.en_ruta_notificado_at,
        pe.cliente,
        pe.telefono,
        pe.direccion,
        e.landing_domain,
        e.landing_slug
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      JOIN empresas e        ON e.id = pe.empresa_id
      WHERE p.id = $1 AND pe.empresa_id = $2
      `,
        [pedidoId, empresaId]
      );

      if (!rows.length) return;
      const datos = rows[0];
      if (datos.en_ruta_notificado_at) return;
      if (!datos.telefono) return;

      let token = datos.tracking_token;

      if (!token) {
        token = randomBytes(16).toString('hex');
        const tokenRows = await queryFn(
          `UPDATE pedidos
            SET tracking_token = COALESCE(tracking_token, $1)
          WHERE id = $2 AND empresa_id = $3
          RETURNING tracking_token`,
          [token, pedidoId, empresaId]
        );
        token = tokenRows[0]?.tracking_token;
      }

      const trackingUrl = buildTrackingUrl({ landingDomain: datos.landing_domain, token });

      const mensaje = (
        `🚚 *¡Tu pedido está en camino!*\n\n` +
        `Hola ${datos.cliente}, tu pedido ya salió hacia ${datos.direccion}.\n\n` +
        `🗺️ *Seguí al repartidor en vivo aquí:*\n${trackingUrl}\n\n` +
        `¡Nos vemos pronto! 👋`
      );

      const enqueueResult = await enqueueWppMessageFn({
        phone: datos.telefono,
        message: mensaje,
        empresa_id: empresaId,
        utility_template: {
          key: 'order_en_route',
          parameters: {
            customer_name: String(datos.cliente || 'Cliente'),
            address: String(datos.direccion || 'No informada'),
            tracking_token: String(token ?? ''),
          },
        },
        pedido_id: datos.id,
      });
      if (!isDurableEnqueueAcceptance(enqueueResult)) {
        throw Object.assign(new Error('notification_enqueue_not_accepted'), {
          code: 'notification_enqueue_not_accepted',
        });
      }

      await queryFn(
        `UPDATE pedidos
          SET en_ruta_notificado_at = COALESCE(en_ruta_notificado_at, NOW())
        WHERE id = $1 AND empresa_id = $2`,
        [pedidoId, empresaId]
      );

    } catch (e) {
      const error = sanitizedNotificationError(e);
      console.error('Error enviando notificación en ruta:', error.code);
      throw error;
    }
  };
}

export const notificarEnRuta = createNotificarEnRuta();

export function createNotificarPedidoTransferencia({
  queryFn = query,
  enqueueWppMessageFn = enqueueTransferPaymentWppMessage,
} = {}) {
  return async function notificarPedidoTransferenciaHandler(pedidoId, empresaId) {
    try {
      const rows = await queryFn(
      `
      SELECT 
        p.id,
        p.monto,
        pe.cliente,
        pe.telefono,
        pe.direccion,
        e.nombre AS empresa_nombre,
        e.id    AS empresa_id
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      JOIN empresas e        ON e.id = pe.empresa_id
      WHERE p.id = $1 AND pe.empresa_id = $2
      `,
        [pedidoId, empresaId]
      );

      if (!rows.length) return;

      const datos = rows[0];
      if (!datos.telefono) return;

      const cuentas = await queryFn(
        `
      SELECT alias, banco, tipo, cbu, titular, prioridad
      FROM empresa_cuentas_bancarias
      WHERE empresa_id = $1
        AND COALESCE(activa, TRUE) = TRUE
      ORDER BY COALESCE(prioridad, 999), id ASC
      LIMIT 1
      `,
        [empresaId]
      );

      const cuenta = cuentas[0];
      const alias = String(cuenta?.alias || '').trim();
      const banco = String(cuenta?.banco || '').trim();
      const cbu = String(cuenta?.cbu || '').trim();
      const titular = String(cuenta?.titular || '').trim();

      const montoNumber = Number(datos.monto || 0);
      const montoFmt = new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
        minimumFractionDigits: 2
      }).format(montoNumber);

      const empresaLabel = datos.empresa_nombre || 'Hidro';

      let mensaje =
        `🏦 *Pago por transferencia*\n\n` +
        `Hola ${datos.cliente || ''}, tu pedido fue marcado para pagar por *transferencia* (${montoFmt}).\n\n`;

      if (cuenta) {
        mensaje += `💳 *Datos para transferir:*\n`;
        if (alias) mensaje += `Alias: ${alias}\n`;
        if (cbu) mensaje += `CBU: ${cbu}\n`;
        if (banco) mensaje += `Banco: ${banco}\n`;
        if (titular) mensaje += `Titular: ${titular}\n`;
        mensaje += `\n`;
      }

      mensaje +=
        `Por favor, adjuntá el *comprobante de transferencia* respondiendo a este mensaje ` +
        `para poder acreditar el pago.\n\n` +
        `¡Muchas gracias!\n${empresaLabel}`;

      const utilityTemplate = alias && cbu && banco && titular
        ? {
            key: 'transfer_payment',
            parameters: {
              customer_name: String(datos.cliente || 'Cliente'),
              amount: montoFmt,
              alias,
              cbu,
              bank: banco,
              holder: titular,
              company_name: String(empresaLabel),
            },
          }
        : null;

      return await enqueueWppMessageFn({
        phone: datos.telefono,
        message: mensaje,
        empresa_id: empresaId,
        utility_template: utilityTemplate,
        pedido_id: datos.id,
      });

    } catch (e) {
      const error = sanitizedNotificationError(e);
      console.error('Error enviando notificación de pago por transferencia:', error.code);
      throw error;
    }
  };
}

/**
 * Notifica al cliente que su pedido se pagará por transferencia
 * con datos de empresa_cuentas_bancarias.
 */
export const notificarPedidoTransferencia = createNotificarPedidoTransferencia();
