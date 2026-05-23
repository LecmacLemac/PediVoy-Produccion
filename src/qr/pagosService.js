// src/qr/pagosService.js
import crypto from 'node:crypto';
import { query } from '../db.js';
import { crearPagoProveedor } from './pagosProvider.js';

/**
 * Lee la config de pagos desde empresas.config_integraciones (JSONB).
 *
 * Esperamos algo así en la columna config_integraciones:
 *
 * {
 *   "pagos": {
 *     "proveedor": "fake" | "mercado_pago" | "banco_x",
 *     "access_token": "xxx",
 *     "webhook_secret": "yyy",
 *     "auto_confirmar": true
 *   }
 * }
 */
export async function getConfigPagosEmpresa(empresaId) {
  const rows = await query(
    `SELECT config_integraciones
       FROM empresas
      WHERE id = $1`,
    [empresaId]
  );

  if (!rows.length) {
    return null;
  }

  const cfg = rows[0].config_integraciones || {};
  const pagosCfg = cfg.pagos || {};

  // Permitimos proveedor "fake" por defecto para desarrollo
  const proveedor = pagosCfg.proveedor || 'fake';

  return {
    proveedor,
    accessToken: pagosCfg.access_token || null,
    webhookSecret: pagosCfg.webhook_secret || null,
    autoConfirmar: pagosCfg.auto_confirmar === true
  };
}

/**
 * Devuelve datos del pedido + empresa + cliente.
 * Valida también que el pedido pertenezca a la empresa indicada.
 */
async function getPedidoConEmpresa(pedidoId, empresaId) {
  const rows = await query(
    `
    SELECT
      p.id,
      p.empresa_id,
      p.punto_entrega_id,
      p.chofer_id,
      p.tracking_token,
      p.monto         AS total,
      e.nombre        AS empresa_nombre,
      pe.cliente      AS cliente_nombre
    FROM pedidos p
    JOIN empresas e
      ON e.id = p.empresa_id
    LEFT JOIN puntos_entrega pe
      ON pe.id = p.punto_entrega_id
    WHERE p.id = $1
      AND p.empresa_id = $2
    `,
    [pedidoId, empresaId]
  );

  return rows[0] || null;
}

async function ensurePedidoTrackingToken(pedido) {
  if (pedido.tracking_token) return pedido.tracking_token;

  const token = crypto.randomBytes(16).toString('hex');
  const rows = await query(
    `
    UPDATE pedidos
       SET tracking_token = COALESCE(tracking_token, $1)
     WHERE id = $2
       AND empresa_id = $3
     RETURNING tracking_token
    `,
    [token, pedido.id, pedido.empresa_id]
  );

  return rows[0]?.tracking_token || token;
}

/**
 * Busca un pago pendiente existente para ese pedido (para no duplicar).
 * Se limita a la empresa para respetar el multi-tenant.
 */
async function getPagoPendientePorPedido({ pedidoId, empresaId }) {
  const rows = await query(
    `
    SELECT *
      FROM pedido_pagos
     WHERE pedido_id = $1
       AND empresa_id = $2
       AND estado = 'pendiente'
     ORDER BY id DESC
     LIMIT 1
    `,
    [pedidoId, empresaId]
  );

  const pago = rows[0] || null;
  if (!pago) return null;

  // Si está vencido, lo marcamos como expired y devolvemos null para forzar creación nueva
  if (pago.vence_at && new Date(pago.vence_at).getTime() <= Date.now()) {
    await query(
      `UPDATE pedido_pagos
          SET estado = 'expired',
              updated_at = NOW()
        WHERE id = $1
          AND empresa_id = $2
          AND estado = 'pendiente'`,
      [pago.id, empresaId]
    );
    return null;
  }

  return pago;
}

async function getPagoPorPedidoProveedor({ pedidoId, empresaId, proveedor }) {
  const rows = await query(
    `
    SELECT *
      FROM pedido_pagos
     WHERE pedido_id = $1
       AND empresa_id = $2
       AND proveedor = $3
     ORDER BY id DESC
     LIMIT 1
    `,
    [pedidoId, empresaId, proveedor]
  );

  return rows[0] || null;
}

/**
 * Crea (o reutiliza) un pago vinculado a un pedido y devuelve los datos
 * para mostrar el QR y el link.
 *
 * @param {{ pedidoId: number, empresaId: number }} params
 * @param {{ venceEnHoras?: number, canal?: string, metodoPago?: string, forceRefresh?: boolean }} options
 */
export async function crearPagoParaPedido({ pedidoId, empresaId }, options = {}) {
  const {
    venceEnHoras = 12,
    canal = 'admin_panel',
    metodoPago = 'qr_dinamico',
    forceRefresh = false
  } = options;

  const pedido = await getPedidoConEmpresa(pedidoId, empresaId);
  if (!pedido) {
    const err = new Error('Pedido no encontrado');
    err.statusCode = 404;
    throw err;
  }

  const configPagos = await getConfigPagosEmpresa(empresaId);
  if (!configPagos) {
    const err = new Error('La empresa no tiene configurado config_integraciones.pagos');
    err.statusCode = 400;
    throw err;
  }

  const proveedor = configPagos.proveedor;
  const trackingToken = await ensurePedidoTrackingToken(pedido);
  pedido.tracking_token = trackingToken;

  // Si ya existe un pago pendiente para este pedido, lo reutilizamos
  const existente = await getPagoPendientePorPedido({ pedidoId, empresaId });
  if (existente && !forceRefresh) {
    return existente;
  }

  const pagoProveedorExistente = forceRefresh
    ? await getPagoPorPedidoProveedor({ pedidoId, empresaId, proveedor })
    : null;
  const monto = Number(pedido.total || 0);
  if (!monto || Number.isNaN(monto) || monto <= 0) {
    const err = new Error('El pedido no tiene un monto válido');
    err.statusCode = 400;
    throw err;
  }

  const ahora = new Date();
  const venceAt = new Date(ahora.getTime() + venceEnHoras * 60 * 60 * 1000);

  // Llamamos al proveedor genérico (stub por ahora)
  const proveedorResp = await crearPagoProveedor({
    proveedor,
    credenciales: {
      accessToken: configPagos.accessToken,
      webhookSecret: configPagos.webhookSecret
    },
    pedido: {
      id: pedido.id,
      total: monto,
      clienteNombre: pedido.cliente_nombre || '',
      trackingToken
    },
    empresa: {
      id: pedido.empresa_id,
      nombre: pedido.empresa_nombre
    }
  });

  if (pagoProveedorExistente) {
    const rows = await query(
      `
      UPDATE pedido_pagos
         SET cliente_id = $3,
             chofer_id = $4,
             metodo_pago = $5,
             canal = $6,
             descripcion = $7,
             provider_payment_id = $8,
             provider_order_id = $9,
             provider_status = NULL,
             estado = 'pendiente',
             monto = $10,
             moneda = $11,
             checkout_url = $12,
             qr_payload = $13,
             vence_at = $14,
             updated_at = NOW()
       WHERE id = $1
         AND empresa_id = $2
       RETURNING *
      `,
      [
        pagoProveedorExistente.id,
        pedido.empresa_id,
        pedido.punto_entrega_id,
        pedido.chofer_id,
        metodoPago,
        canal,
        proveedorResp.descripcion,
        proveedorResp.providerPaymentId,
        proveedorResp.providerOrderId || proveedorResp.providerPaymentId,
        monto,
        proveedorResp.moneda || 'ARS',
        proveedorResp.checkoutUrl,
        proveedorResp.qrPayload,
        venceAt
      ]
    );

    return rows[0];
  }

  try {
    const rows = await query(
      `
      INSERT INTO pedido_pagos (
        empresa_id,
        pedido_id,
        cliente_id,
        chofer_id,
        metodo_pago,
        canal,
        descripcion,
        proveedor,
        provider_payment_id,
        provider_order_id,
        estado,
        monto,
        moneda,
        checkout_url,
        qr_payload,
        vence_at,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        'pendiente',
        $11, $12, $13, $14, $15,
        NOW(), NOW()
      )
      RETURNING *
      `,
      [
        pedido.empresa_id,
        pedido.id,
        pedido.punto_entrega_id,
        pedido.chofer_id,
        metodoPago,
        canal,
        proveedorResp.descripcion,
        proveedor,
        proveedorResp.providerPaymentId,
        proveedorResp.providerOrderId || proveedorResp.providerPaymentId,
        monto,
        proveedorResp.moneda || 'ARS',
        proveedorResp.checkoutUrl,
        proveedorResp.qrPayload,
        venceAt
      ]
    );

    return rows[0];
  } catch (e) {
    // Si dos requests corren en paralelo, el índice parcial (1 pendiente por pedido/empresa)
    // puede disparar unique violation. En ese caso, re-fetch y devolvemos el pendiente vigente.
    if (e?.code === '23505') {
      const existente2 = await getPagoPendientePorPedido({ pedidoId, empresaId });
      if (existente2) return existente2;
    }
    throw e;
  }
}

/**
 * Actualiza el estado interno de un pago a partir del id del proveedor.
 * Pensado para usar desde webhooks.
 */
export async function actualizarEstadoPago({ providerPaymentId, nuevoEstado, providerStatus = null }) {
  const rows = await query(
    `
    UPDATE pedido_pagos
       SET estado = $1,
           provider_status = COALESCE($3, provider_status),
           updated_at = NOW()
     WHERE provider_payment_id = $2
     RETURNING *
    `,
    [nuevoEstado, providerPaymentId, providerStatus]
  );

  return rows[0] || null;
}

/**
 * Lista pagos (historial) para un pedido dentro de una empresa.
 */
export async function listarPagosPorPedido({ pedidoId, empresaId }) {
  const rows = await query(
    `
    SELECT
      id,
      empresa_id,
      pedido_id,
      metodo_pago,
      canal,
      descripcion,
      proveedor,
      provider_payment_id,
      provider_status,
      estado,
      monto,
      moneda,
      checkout_url,
      qr_payload,
      vence_at,
      settlement_at,
      conciliado,
      metadata,
      created_at,
      updated_at
    FROM pedido_pagos
    WHERE pedido_id = $1
      AND empresa_id = $2
    ORDER BY id DESC
    `,
    [pedidoId, empresaId]
  );

  return rows;
}

/**
 * Variante más segura: ata el update por (proveedor, provider_payment_id)
 * para evitar colisiones cross-provider.
 */
export async function actualizarEstadoPagoScoped({ proveedor, providerPaymentId, nuevoEstado, providerStatus = null, providerPayload = null }) {
  const rows = await query(
    `
    UPDATE pedido_pagos
       SET estado = $1,
           settlement_at = CASE
             WHEN $1 = 'pagado' AND settlement_at IS NULL THEN NOW()
             ELSE settlement_at
           END,
           provider_status = COALESCE($4, provider_status),
           provider_payload = CASE
             WHEN $5::jsonb IS NULL THEN provider_payload
             ELSE COALESCE(provider_payload, '{}'::jsonb) || $5::jsonb
           END,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'last_webhook_at', NOW(),
                  'webhook_count', COALESCE((metadata->>'webhook_count')::int, 0) + 1,
                  'last_canonical_estado', $1
                ),
           updated_at = NOW()
     WHERE proveedor = $2
       AND provider_payment_id = $3
     RETURNING *
    `,
    [nuevoEstado, proveedor, providerPaymentId, providerStatus, providerPayload]
  );

  return rows[0] || null;
}

/**
 * Actualiza un pago de pedido confirmado por proveedor. Permite registrar el
 * evento sin mover el estado a "pagado" cuando la empresa no habilitó
 * auto_confirmar.
 */
export async function actualizarEstadoPagoPedido({
  empresaId,
  pedidoId,
  proveedor,
  providerPaymentId,
  providerOrderId = null,
  nuevoEstado,
  providerStatus = null,
  providerPayload = null,
  aplicarEstado = true
}) {
  const rows = await query(
    `
    UPDATE pedido_pagos
       SET provider_payment_id = COALESCE($4, provider_payment_id),
           provider_order_id = COALESCE($5, provider_order_id),
           estado = CASE
             WHEN $9::boolean THEN $6
             ELSE estado
           END,
           settlement_at = CASE
             WHEN $9::boolean AND $6 = 'pagado' AND settlement_at IS NULL THEN NOW()
             ELSE settlement_at
           END,
           provider_status = COALESCE($7, provider_status),
           provider_payload = CASE
             WHEN $8::jsonb IS NULL THEN provider_payload
             ELSE COALESCE(provider_payload, '{}'::jsonb) || $8::jsonb
           END,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'last_webhook_at', NOW(),
                  'webhook_count', COALESCE((metadata->>'webhook_count')::int, 0) + 1,
                  'last_canonical_estado', $6,
                  'auto_confirm_applied', $9::boolean
                ),
           updated_at = NOW()
     WHERE empresa_id = $1
       AND pedido_id = $2
       AND proveedor = $3
     RETURNING *
    `,
    [
      empresaId,
      pedidoId,
      proveedor,
      providerPaymentId,
      providerOrderId,
      nuevoEstado,
      providerStatus,
      providerPayload,
      aplicarEstado
    ]
  );

  return rows[0] || null;
}
