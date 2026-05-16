// src/services/notificacionesPedidos.js
import crypto from 'node:crypto';
import { query } from '../db.js';
import { enqueueWppMessage } from '../services.js';

/**
 * Genera token (si no existe) y envía WPP de 'En Ruta' solo la primera vez.
 */
export async function notificarEnRuta(pedidoId, empresaId) {
  try {
    const rows = await query(
      `
      SELECT 
        p.id,
        p.monto,
        p.tracking_token,
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

    let token = datos.tracking_token;
    const yaTeniaToken = !!token;

    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      await query(
        `UPDATE pedidos SET tracking_token = $1 WHERE id = $2 AND empresa_id = $3`,
        [token, pedidoId, empresaId]
      );
    }

    let host = datos.landing_domain || 'https://aguahidro.com.ar';
    if (!host.startsWith('http')) host = 'https://' + host;

    const trackingUrl = `${host}/pedidos/seguimiento.html?t=${token}`;

    if (yaTeniaToken) return;

    const mensaje = (
      `🚚 *¡Tu pedido está en camino!*\n\n` +
      `Hola ${datos.cliente}, tu pedido ya salió hacia ${datos.direccion}.\n\n` +
      `🗺️ *Seguí al repartidor en vivo aquí:*\n${trackingUrl}\n\n` +
      `¡Nos vemos pronto! 👋`
    );

    await enqueueWppMessage({
      phone: datos.telefono,
      message: mensaje,
      empresa_id: empresaId
    });

  } catch (e) {
    console.error('Error enviando notificación en ruta:', e);
  }
}

/**
 * Notifica al cliente que su pedido se pagará por transferencia
 * con datos de empresa_cuentas_bancarias.
 */
export async function notificarPedidoTransferencia(pedidoId, empresaId) {
  try {
    const rows = await query(
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

    const cuentas = await query(
      `
      SELECT alias, banco, tipo, cbu, titular
      FROM empresa_cuentas_bancarias
      WHERE empresa_id = $1
        AND activa = TRUE
      ORDER BY prioridad DESC, id ASC
      LIMIT 1
      `,
      [empresaId]
    );

    const cuenta = cuentas[0];

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
      const alias = (cuenta.alias || '').trim();
      const banco = (cuenta.banco || '').trim();
      const cbu = (cuenta.cbu || '').trim();
      const titular = (cuenta.titular || '').trim();

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

    await enqueueWppMessage({
      phone: datos.telefono,
      message: mensaje,
      empresa_id: empresaId
    });

  } catch (e) {
    console.error('Error enviando notificación de pago por transferencia:', e);
  }
}
