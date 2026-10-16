// src/adm/pagosRouter.js
import { Router } from 'express';
import { withAuth, isSuper, checkLicencia, resolveEmpresaId } from '../services.js';
import { query } from '../db.js';
import { crearPagoParaPedido, listarPagosPorPedido } from '../qr/pagosService.js';
import { requireCanonicalBackofficeRole } from '../routes/canonicalBackofficeRole.js';
import { parsePagosListQuery, appendPagosSearch, appendPagosDates, appendPagosCursor, pagosCursorFechaSql } from '../pagosListFilters.js';

const router = Router();

// Todas estas rutas requieren auth + licencia activa
router.use(withAuth, requireCanonicalBackofficeRole, checkLicencia);

// Permisos mínimos: evitar que repartidores/roles limitados generen links de cobro
router.use((req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'repartidor') {
    return res.status(403).json({ error: 'No autorizado.' });
  }
  // Permitimos super + admins/usuarios de backoffice (por ahora cualquier no-repartidor)
  return next();
});

/**
 * Lista pagos QR/digitales registrados en pedido_pagos.
 *
 * GET /api/admin/qr/pagos
 */
export function createListQrPagosHandler({ queryFn = query } = {}) {
  return async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (!isSuper(req) && role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado.' });
    }

    const listFilters = parsePagosListQuery(req.query);
    const esSuperUser = isSuper(req);
    const empresaId = esSuperUser && !req.query?.empresa_id
      ? null
      : resolveEmpresaId(req);
    if (empresaId !== null && (!Number.isInteger(empresaId) || empresaId <= 0)) {
      return res.status(400).json({ error: 'empresa_id inválido' });
    }

    const estado = (req.query.estado || '').toString().trim().toLowerCase();
    const choferId = Number(req.query.chofer_id || 0) || null;
    const beforeId = listFilters.beforeId;
    const limitRaw = Number(req.query.limit || 0) || 0;
    const limit = Math.min(Math.max(limitRaw, 0), 1000);

    let sql = `
      SELECT
        pp.id,
        pp.id AS pago_id,
        pp.empresa_id,
        pp.pedido_id,
        pp.chofer_id,
        pp.metodo_pago,
        pp.canal,
        pp.descripcion,
        pp.proveedor,
        pp.provider_payment_id,
        pp.provider_order_id,
        pp.provider_status,
        pp.estado,
        pp.monto,
        pp.moneda,
        pp.checkout_url,
        pp.vence_at,
        pp.settlement_at,
        pp.created_at,
        pp.updated_at,
        ${pagosCursorFechaSql('COALESCE(pp.settlement_at, pp.updated_at, pp.created_at)')},
        pe.cliente,
        pe.telefono,
        z.nombre AS zona_nombre,
        c.nombre AS chofer_nombre
      FROM pedido_pagos pp
      LEFT JOIN pedidos p           ON p.id = pp.pedido_id AND p.empresa_id = pp.empresa_id
      LEFT JOIN puntos_entrega pe   ON pe.id = p.punto_entrega_id AND pe.empresa_id = pp.empresa_id
      LEFT JOIN zonas_geograficas z ON z.id = COALESCE(p.zona_id, pe.zona_id) AND z.empresa_id = pp.empresa_id
      LEFT JOIN choferes c          ON c.id = pp.chofer_id AND c.empresa_id = pp.empresa_id
      WHERE 1=1
    `;
    let params = [];
    let idx = 1;

    if (!esSuperUser || empresaId) {
      sql += ` AND pp.empresa_id = $${idx++}`;
      params.push(empresaId);
    }

    ({ sql, params, idx } = appendPagosDates({ sql, params, idx, filters: listFilters,
      date: 'COALESCE(pp.settlement_at, pp.updated_at, pp.created_at)' }));

    if (choferId) {
      sql += ` AND pp.chofer_id = $${idx++}`;
      params.push(choferId);
    }

    if (estado === 'verificado') {
      sql += ` AND pp.estado IN ('pagado', 'aprobado', 'acreditado', 'approved')`;
    } else if (estado === 'pendiente') {
      sql += ` AND pp.estado NOT IN ('pagado', 'aprobado', 'acreditado', 'approved')`;
    }

    ({ sql, params, idx } = appendPagosSearch({ sql, params, idx, q: listFilters.q,
      pedido: 'pp.pedido_id', references: ['pp.provider_payment_id', 'pp.provider_order_id'] }));

    ({ sql, params, idx } = appendPagosCursor({ sql, params, idx, filters: listFilters,
      date: 'COALESCE(pp.settlement_at, pp.updated_at, pp.created_at)', id: 'pp.id' }));

    sql += ` ORDER BY COALESCE(pp.settlement_at, pp.updated_at, pp.created_at, '-infinity'::timestamptz) DESC, pp.id DESC`;
    if (limit > 0) {
      sql += ` LIMIT $${idx++}`;
      params.push(limit);
    }

    const rows = await queryFn(sql, params, { sensitive: true });
    if (limit > 0) {
      res.setHeader('X-Page-Limit', String(limit));
      res.setHeader('X-Page-Count', String(rows.length));
      if (beforeId) res.setHeader('X-Page-Before-Id', String(beforeId));
    }
    return res.json(rows);
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error('Error listando pagos QR', { code: err.code || 'QUERY_FAILED' });
    return res.status(500).json({ error: 'Error interno' });
  }
  };
}
router.get('/pagos', createListQrPagosHandler());

/**
 * Lista pagos para un pedido.
 *
 * GET /api/admin/qr/pedidos/:pedidoId/pagos
 */
router.get('/pedidos/:pedidoId/pagos', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (!isSuper(req) && role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado.' });
    }

    const pedidoId = Number(req.params.pedidoId);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ error: 'pedidoId inválido' });
    }

    const empresaId = resolveEmpresaId(req);
    if (!empresaId || !Number.isInteger(empresaId) || empresaId <= 0) {
      return res.status(400).json({ error: 'empresa_id inválido' });
    }

    const pagos = await listarPagosPorPedido({ pedidoId, empresaId });
    return res.json(pagos);
  } catch (err) {
    console.error('Error listando pagos de pedido', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

/**
 * Crea (o reutiliza) un link de pago + QR para un pedido.
 *
 * POST /api/admin/qr/pedidos/:pedidoId/link
 */
router.post('/pedidos/:pedidoId/link', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (!isSuper(req) && role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado.' });
    }

    const pedidoId = Number(req.params.pedidoId);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ error: 'pedidoId inválido' });
    }

    // Empresa del usuario autenticado:
    // - Si es súper admin puede pasar ?empresa_id o body.empresa_id
    // - Si no, se toma la empresa del token
    const empresaId = resolveEmpresaId(req);
    if (!empresaId || !Number.isInteger(empresaId) || empresaId <= 0) {
      return res.status(400).json({ error: 'empresa_id inválido' });
    }

    const venceRaw = Number(req.body?.venceEnHoras);
    const venceEnHoras = Number.isFinite(venceRaw)
      ? Math.min(72, Math.max(1, venceRaw))
      : undefined;

    const pago = await crearPagoParaPedido(
      { pedidoId, empresaId },
      {
        venceEnHoras,
        canal: 'admin_panel',
        metodoPago: 'qr_dinamico'
      }
    );

    return res.json({
      id: pago.id,
      estado: pago.estado,
      monto: pago.monto,
      moneda: pago.moneda,
      checkout_url: pago.checkout_url,
      qr_payload: pago.qr_payload,
      vence_at: pago.vence_at,
      proveedor: pago.proveedor
    });
  } catch (err) {
    console.error('Error creando pago para pedido', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'Error interno' });
  }
});

export default router;
