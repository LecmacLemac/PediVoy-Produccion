// src/qr/pagosService.js
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
 *     "webhook_secret": "yyy"
 *   }
 * }
 */
async function getConfigPagosEmpresa(empresaId) {
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
    webhookSecret: pagosCfg.webhook_secret || null
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

/**
 * Crea (o reutiliza) un pago vinculado a un pedido y devuelve los datos
 * para mostrar el QR y el link.
 *
 * @param {{ pedidoId: number, empresaId: number }} params
 * @param {{ venceEnHoras?: number, canal?: string, metodoPago?: string }} options
 */
export async function crearPagoParaPedido({ pedidoId, empresaId }, options = {}) {
  const {
    venceEnHoras = 12,
    canal = 'admin_panel',
    metodoPago = 'qr_dinamico'
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

  // Si ya existe un pago pendiente para este pedido, lo reutilizamos
  const existente = await getPagoPendientePorPedido({ pedidoId, empresaId });
  if (existente) {
    return existente;
  }

  const proveedor = configPagos.proveedor;
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
      clienteNombre: pedido.cliente_nombre || ''
    },
    empresa: {
      id: pedido.empresa_id,
      nombre: pedido.empresa_nombre
    }
  });

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
        $8, $9,
        'pendiente',
        $10, $11, $12, $13, $14,
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
 * Variante más segura: ata el update por (proveedor, provider_payment_id)
 * para evitar colisiones cross-provider.
 */
export async function actualizarEstadoPagoScoped({ proveedor, providerPaymentId, nuevoEstado, providerStatus = null }) {
  const rows = await query(
    `
    UPDATE pedido_pagos
       SET estado = $1,
           settlement_at = CASE
             WHEN $1 = 'pagado' AND settlement_at IS NULL THEN NOW()
             ELSE settlement_at
           END,
           provider_status = COALESCE($4, provider_status),
           updated_at = NOW()
     WHERE proveedor = $2
       AND provider_payment_id = $3
     RETURNING *
    `,
    [nuevoEstado, proveedor, providerPaymentId, providerStatus]
  );

  return rows[0] || null;
}

