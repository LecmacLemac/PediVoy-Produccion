// src/routes/reportes.js
import express from 'express';
import {
  withAuth as defaultWithAuth,
  isSuper as defaultIsSuper,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken
} from '../services.js';
import { query as defaultQuery } from '../db.js';

export function createReportesRouter({
  query: queryFn = defaultQuery,
  withAuth: withAuthFn = defaultWithAuth,
  isSuper: isSuperFn = defaultIsSuper,
  getEmpresaIdFromToken: getEmpresaIdFromTokenFn = defaultGetEmpresaIdFromToken
} = {}) {
  const router = express.Router();
  const query = queryFn;
  const withAuth = withAuthFn;
  const isSuper = isSuperFn;
  const getEmpresaIdFromToken = getEmpresaIdFromTokenFn;

  async function tableExists(tableName) {
    const rows = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [tableName]
    );
    return !!rows?.length;
  }

  async function columnExists(tableName, columnName) {
    const rows = await query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
        LIMIT 1`,
      [tableName, columnName]
    );
    return !!rows?.length;
  }

  function getTargetEmpresa(req) {
    const { empresa_id } = req.query || {};
    const esSuperUser = isSuper(req);
    const myEmpresa = getEmpresaIdFromToken(req);
    return (esSuperUser && empresa_id) ? Number(empresa_id) : myEmpresa;
  }

  // GET /api/reportes/entregados
  router.get('/entregados', withAuth, async (req, res) => {
    try {
      const { from, to, zona_id, chofer_id, metodo_pago } = req.query || {};
      const targetEmpresa = getTargetEmpresa(req);

      if (!targetEmpresa) {
        return res.status(400).json({ error: 'Empresa no determinada' });
      }

      let sql = `
        SELECT 
          p.id,
          p.fecha,
          p.fecha_entrega,
          pe.cliente,
          pe.telefono,
          pe.direccion,
          p.metodo_pago,
          p.monto,
          p.cantidad_entregada,
          p.chofer_id,
          c.nombre AS chofer_nombre,
          e.nombre AS empresa_nombre,
          cta.alias AS transferencia_alias,
          cta.titular AS transferencia_titular,
          cta.cbu AS transferencia_cbu,
          cta.banco AS transferencia_banco,
          pe.zona_id,
          (CASE WHEN t.id IS NOT NULL THEN true ELSE false END) AS pagado,
          ct.id AS comprobante_transferencia_id,
          ct.validado AS transferencia_validado,
          ct.procesado AS transferencia_procesado,
          ct.estado_revision AS transferencia_estado_revision,
          ct.verified_reason AS transferencia_verified_reason,
          ct.verified_at AS transferencia_verified_at,
          (
            COALESCE(ct.procesado, FALSE) = TRUE
            OR lower(COALESCE(ct.verified_reason, '')) LIKE '%automat%'
            OR lower(COALESCE(ct.verified_reason, '')) LIKE '% por ia%'
            OR lower(COALESCE(ct.verified_reason, '')) LIKE '%desde whatsapp%'
          ) AS transferencia_ai_verificada
        FROM pedidos p
        JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
        LEFT JOIN empresas e ON e.id = p.empresa_id
        LEFT JOIN choferes c   ON p.chofer_id = c.id
        LEFT JOIN transferencias t ON t.pedido_id = p.id AND t.empresa_id = p.empresa_id
        LEFT JOIN LATERAL (
          SELECT
            ctab.alias,
            ctab.titular,
            ctab.cbu,
            ctab.banco
          FROM empresa_cuentas_bancarias ctab
          WHERE ctab.empresa_id = p.empresa_id
            AND ctab.activa = TRUE
          ORDER BY COALESCE(ctab.prioridad, 999), ctab.id ASC
          LIMIT 1
        ) cta ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            cti.id,
            cti.validado,
            cti.procesado,
            cti.estado_revision,
            cti.verified_reason,
            cti.verified_at
          FROM comprobantes_transferencia cti
          WHERE cti.pedido_id = p.id
            AND cti.empresa_id = p.empresa_id
          ORDER BY cti.fecha DESC NULLS LAST, cti.id DESC
          LIMIT 1
        ) ct ON TRUE
        WHERE p.estado = 'entregado'
          AND pe.empresa_id = $1
      `;

      const params = [targetEmpresa];
      let idx = 2;

      if (from) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) < ($${idx++}::date + INTERVAL '1 day')`;
        params.push(to.toString().slice(0, 10));
      }

      if (zona_id) {
        sql += ` AND pe.zona_id = $${idx++}`;
        params.push(Number(zona_id));
      }

      if (chofer_id) {
        sql += ` AND p.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      if (metodo_pago) {
        sql += ` AND p.metodo_pago = $${idx++}`;
        params.push(metodo_pago);
      }

      sql += ` ORDER BY COALESCE(p.fecha_entrega, p.fecha) DESC, p.id DESC`;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/reportes/entregados', e);
      return res.status(500).json({ error: 'Error generando reporte de entregados' });
    }
  });

  // GET /api/reportes/medios-pago
  router.get('/medios-pago', withAuth, async (req, res) => {
    try {
      const { from, to, chofer_id } = req.query || {};
      const targetEmpresa = getTargetEmpresa(req);
      if (!targetEmpresa) return res.status(400).json({ error: 'Empresa no determinada' });
      const hasPedidoPagos = await tableExists('pedido_pagos');
      const pagoDigitalConfirmadoSql = hasPedidoPagos
        ? `
            OR EXISTS (
              SELECT 1
              FROM pedido_pagos pp_pago
              WHERE pp_pago.pedido_id = p.id
                AND pp_pago.empresa_id = p.empresa_id
                AND lower(pp_pago.estado) IN ('pagado', 'aprobado', 'acreditado', 'approved')
            )`
        : '';

      let pedidosSql = `
        SELECT
          COALESCE(NULLIF(TRIM(p.metodo_pago), ''), 'sin_definir') AS metodo_pago,
          COUNT(*)::int AS cantidad,
          COALESCE(SUM(p.monto), 0)::numeric AS total,
          COALESCE(SUM(CASE
            WHEN EXISTS (
              SELECT 1
              FROM transferencias t_pago
              WHERE t_pago.pedido_id = p.id
                AND t_pago.empresa_id = p.empresa_id
            )${pagoDigitalConfirmadoSql}
            THEN p.monto ELSE 0
          END), 0)::numeric AS pagado_pedido,
          COALESCE(SUM(CASE WHEN EXISTS (
            SELECT 1
            FROM transferencias t_pago
            WHERE t_pago.pedido_id = p.id
              AND t_pago.empresa_id = p.empresa_id
          ) THEN p.monto ELSE 0 END), 0)::numeric AS pagado_transferencia
        FROM pedidos p
        JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
        WHERE p.estado = 'entregado'
          AND pe.empresa_id = $1
      `;
      const params = [targetEmpresa];
      let idx = 2;

      if (from) {
        pedidosSql += ` AND COALESCE(p.fecha_entrega, p.fecha) >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        pedidosSql += ` AND COALESCE(p.fecha_entrega, p.fecha) < ($${idx++}::date + INTERVAL '1 day')`;
        params.push(to.toString().slice(0, 10));
      }
      if (chofer_id) {
        pedidosSql += ` AND p.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      pedidosSql += ` GROUP BY 1 ORDER BY 1`;
      const pedidosRows = await query(pedidosSql, params);

      let qr = {
        cantidad: 0,
        aprobados: 0,
        pendientes: 0,
        rechazados: 0,
        total: 0,
        aprobado: 0,
        pendiente: 0,
        rechazado: 0,
        proveedores: [],
        estados: [],
      };

      if (hasPedidoPagos) {
        let qrSql = `
          SELECT
            COALESCE(NULLIF(TRIM(proveedor), ''), 'sin_proveedor') AS proveedor,
            COALESCE(NULLIF(TRIM(estado), ''), 'sin_estado') AS estado,
            COUNT(*)::int AS cantidad,
            COALESCE(SUM(monto), 0)::numeric AS total
          FROM pedido_pagos
          WHERE empresa_id = $1
        `;
        const qrParams = [targetEmpresa];
        let qrIdx = 2;

        if (from) {
          qrSql += ` AND COALESCE(settlement_at, updated_at, created_at) >= $${qrIdx++}::date`;
          qrParams.push(from.toString().slice(0, 10));
        }
        if (to) {
          qrSql += ` AND COALESCE(settlement_at, updated_at, created_at) < ($${qrIdx++}::date + INTERVAL '1 day')`;
          qrParams.push(to.toString().slice(0, 10));
        }
        if (chofer_id) {
          qrSql += ` AND chofer_id = $${qrIdx++}`;
          qrParams.push(Number(chofer_id));
        }

        qrSql += ` GROUP BY 1, 2 ORDER BY 1, 2`;
        const qrRows = await query(qrSql, qrParams);
        const approvedStates = new Set(['pagado', 'aprobado', 'acreditado', 'approved']);
        const rejectedStates = new Set([
          'rechazado',
          'rejected',
          'cancelado',
          'cancelled',
          'cancelled_by_user',
          'fallido',
          'failed',
          'error',
          'expired',
          'vencido',
          'anulado',
        ]);
        const byProvider = new Map();

        for (const row of qrRows || []) {
          const proveedor = row.proveedor || 'sin_proveedor';
          const estado = String(row.estado || 'sin_estado').toLowerCase();
          const cantidad = Number(row.cantidad) || 0;
          const total = Number(row.total) || 0;
          const bucket = approvedStates.has(estado) ? 'aprobado' : (rejectedStates.has(estado) ? 'rechazado' : 'pendiente');

          qr.cantidad += cantidad;
          qr.total += total;
          qr[`${bucket}s`] = Number(qr[`${bucket}s`] || 0) + cantidad;
          qr[bucket] = Number(qr[bucket] || 0) + total;
          qr.estados.push({ proveedor, estado, cantidad, total, bucket });

          const providerRow = byProvider.get(proveedor) || { proveedor, cantidad: 0, total: 0, aprobado: 0, pendiente: 0, rechazado: 0 };
          providerRow.cantidad += cantidad;
          providerRow.total += total;
          providerRow[bucket] += total;
          byProvider.set(proveedor, providerRow);
        }

        qr.proveedores = Array.from(byProvider.values()).sort((a, b) => b.total - a.total);
      }

      return res.json({
        pedidos: (pedidosRows || []).map(r => ({
          metodo_pago: r.metodo_pago,
          cantidad: Number(r.cantidad) || 0,
          total: Number(r.total) || 0,
          pagado_pedido: Number(r.pagado_pedido) || 0,
          pagado_transferencia: Number(r.pagado_transferencia) || 0,
        })),
        qr,
      });
    } catch (e) {
      console.error('ERROR /api/reportes/medios-pago', e);
      return res.status(500).json({ error: 'Error generando reporte de medios de pago' });
    }
  });

  // GET /api/reportes/sla-entrega
  router.get('/sla-entrega', withAuth, async (req, res) => {
    try {
      const { from, to, zona_id, chofer_id, sla_horas } = req.query || {};
      const targetEmpresa = getTargetEmpresa(req);
      if (!targetEmpresa) return res.status(400).json({ error: 'Empresa no determinada' });

      const slaHours = Math.max(1, Number(sla_horas) || 24);
      const slaMinutes = slaHours * 60;

      let sql = `
        WITH base AS (
          SELECT
            EXTRACT(EPOCH FROM (COALESCE(p.fecha_entrega, p.fecha) - p.fecha)) / 60.0 AS demora_min
          FROM pedidos p
          JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
          WHERE p.estado = 'entregado'
            AND pe.empresa_id = $1
            AND p.fecha IS NOT NULL
            AND COALESCE(p.fecha_entrega, p.fecha) IS NOT NULL
      `;
      const params = [targetEmpresa];
      let idx = 2;

      if (from) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) < ($${idx++}::date + INTERVAL '1 day')`;
        params.push(to.toString().slice(0, 10));
      }
      if (zona_id) {
        sql += ` AND pe.zona_id = $${idx++}`;
        params.push(Number(zona_id));
      }
      if (chofer_id) {
        sql += ` AND p.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      sql += `)
        SELECT
          COUNT(*)::int AS total,
          COALESCE(AVG(demora_min), 0)::float AS demora_prom_min,
          COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY demora_min), 0)::float AS demora_p90_min,
          COALESCE(SUM(CASE WHEN demora_min <= $${idx} THEN 1 ELSE 0 END), 0)::int AS en_sla
        FROM base
      `;
      params.push(slaMinutes);

      const row = (await query(sql, params))?.[0] || { total: 0, demora_prom_min: 0, demora_p90_min: 0, en_sla: 0 };
      const total = Number(row.total) || 0;
      const enSla = Number(row.en_sla) || 0;
      const pct = total ? (enSla / total) * 100 : 0;

      return res.json({
        total,
        en_sla: enSla,
        fuera_sla: Math.max(total - enSla, 0),
        pct_en_sla: pct,
        demora_prom_min: Number(row.demora_prom_min) || 0,
        demora_p90_min: Number(row.demora_p90_min) || 0,
        sla_horas: slaHours
      });
    } catch (e) {
      console.error('ERROR /api/reportes/sla-entrega', e);
      return res.status(500).json({ error: 'Error calculando SLA de entrega' });
    }
  });

  // GET /api/reportes/cancelaciones-motivo
  router.get('/cancelaciones-motivo', withAuth, async (req, res) => {
    try {
      const { from, to, zona_id, chofer_id } = req.query || {};
      const targetEmpresa = getTargetEmpresa(req);
      if (!targetEmpresa) return res.status(400).json({ error: 'Empresa no determinada' });

      const motivoExprs = [];
      if (await columnExists('pedidos', 'motivo_cancelacion')) motivoExprs.push('p.motivo_cancelacion');
      if (await columnExists('pedidos', 'motivo')) motivoExprs.push('p.motivo');
      if (await columnExists('pedidos', 'cancel_reason')) motivoExprs.push('p.cancel_reason');
      if (await columnExists('pedidos', 'observaciones')) motivoExprs.push('p.observaciones');
      const motivoExpr = motivoExprs.length ? motivoExprs.join(', ') : "''";

      let sql = `
        SELECT
          COALESCE(NULLIF(TRIM(COALESCE(${motivoExpr})), ''), 'Sin motivo') AS motivo,
          COUNT(*)::int AS cantidad
        FROM pedidos p
        JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE p.estado = 'cancelado'
          AND pe.empresa_id = $1
      `;
      const params = [targetEmpresa];
      let idx = 2;

      if (from) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) < ($${idx++}::date + INTERVAL '1 day')`;
        params.push(to.toString().slice(0, 10));
      }
      if (zona_id) {
        sql += ` AND pe.zona_id = $${idx++}`;
        params.push(Number(zona_id));
      }
      if (chofer_id) {
        sql += ` AND p.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      sql += `
        GROUP BY 1
        ORDER BY cantidad DESC, motivo ASC
      `;

      const rows = await query(sql, params);
      const total = rows.reduce((a, r) => a + Number(r.cantidad || 0), 0);
      return res.json({ total, motivos: rows.map(r => ({ motivo: r.motivo, cantidad: Number(r.cantidad) || 0 })) });
    } catch (e) {
      console.error('ERROR /api/reportes/cancelaciones-motivo', e);
      return res.status(500).json({ error: 'Error calculando cancelaciones por motivo' });
    }
  });

  // GET /api/reportes/productos-margen
  router.get('/productos-margen', withAuth, async (req, res) => {
    try {
      const { from, to, chofer_id } = req.query || {};
      const targetEmpresa = getTargetEmpresa(req);
      if (!targetEmpresa) return res.status(400).json({ error: 'Empresa no determinada' });

      const hasCostTable = await tableExists('empresa_productos_costos');
      const costJoin = hasCostTable
        ? `LEFT JOIN empresa_productos_costos epc
             ON epc.empresa_id = p.empresa_id
            AND epc.producto_id = pr.id`
        : '';
      const costExpr = hasCostTable
        ? 'COALESCE(epc.costo_base, 0) + COALESCE(epc.costo_packaging, 0)'
        : '0';

      let sql = `
        SELECT
          COALESCE(pr.nombre, ip.producto, 'Sin nombre') AS producto,
          SUM(COALESCE(ip.cantidad, 0))::float AS unidades,
          SUM(COALESCE(ip.cantidad, 0) * COALESCE(ip.precio_unitario, 0))::float AS ventas,
          SUM(COALESCE(ip.cantidad, 0) * (${costExpr}))::float AS costo_estimado
        FROM pedidos p
        JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        JOIN items_pedido ip ON ip.pedido_id = p.id
        LEFT JOIN productos pr
          ON pr.empresa_id = p.empresa_id
         AND (
              pr.id = ip.producto_id
              OR (ip.producto_id IS NULL AND LOWER(pr.nombre) = LOWER(ip.producto))
         )
        ${costJoin}
        WHERE p.estado = 'entregado'
          AND p.empresa_id = $1
      `;

      const params = [targetEmpresa];
      let idx = 2;

      if (from) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND COALESCE(p.fecha_entrega, p.fecha) < ($${idx++}::date + INTERVAL '1 day')`;
        params.push(to.toString().slice(0, 10));
      }
      if (chofer_id) {
        sql += ` AND p.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }

      sql += `
        GROUP BY 1
      `;

      const rows = await query(sql, params);
      const mapped = rows
        .map(r => {
          const ventas = Number(r.ventas) || 0;
          const costo = Number(r.costo_estimado) || 0;
          const margen = ventas - costo;
          return {
            producto: r.producto,
            unidades: Number(r.unidades) || 0,
            ventas,
            costo,
            margen,
            margen_pct: ventas ? (margen / ventas) * 100 : 0
          };
        })
        .sort((a, b) => b.margen - a.margen);

      return res.json({
        top: mapped.slice(0, 8),
        bottom: mapped.slice(-8).reverse(),
        total_productos: mapped.length
      });
    } catch (e) {
      console.error('ERROR /api/reportes/productos-margen', e);
      return res.status(500).json({ error: 'Error calculando margen por producto' });
    }
  });

  return router;
}
