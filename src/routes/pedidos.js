// src/routes/pedidos.js
import express from 'express';

import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';
import { notificarEnRuta } from '../services/notificacionesPedidos.js';
import { awardPointsForDeliveredOrder } from '../services/puntosService.js';

export function createPedidosRouter() {
  const router = express.Router();

  function buildDashboardBase({ targetEmpresa, esSuperUser, onlyOrphanEmpresa, onlyOrphanChofer, chofer_id, estado, from, to, q }) {
    let whereSql = ' WHERE 1=1 ';
    const params = [];
    let idx = 1;

    if (targetEmpresa) {
      whereSql += ` AND p.empresa_id = $${idx}`;
      params.push(targetEmpresa);
      idx++;
    }

    if (esSuperUser && onlyOrphanEmpresa) {
      whereSql += ` AND (
        p.empresa_id IS NULL
        OR p.empresa_id = 0
        OR e.id IS NULL
        OR pe.id IS NULL
        OR (pe.empresa_id IS NOT NULL AND p.empresa_id IS NOT NULL AND pe.empresa_id <> p.empresa_id)
      )`;
    }

    if (onlyOrphanChofer) {
      whereSql += ` AND (
        p.chofer_id IS NULL
        OR p.chofer_id = 0
        OR c.id IS NULL
      )`;
    } else if (chofer_id) {
      whereSql += ` AND p.chofer_id = $${idx++}`;
      params.push(Number(chofer_id));
    }

    if (estado) {
      whereSql += ` AND p.estado = $${idx++}`;
      params.push(estado);
    }

    if (from) {
      whereSql += ` AND p.fecha >= $${idx++}::date`;
      params.push(from.toString().slice(0, 10));
    }
    if (to) {
      whereSql += ` AND p.fecha < ($${idx++}::date + INTERVAL '1 day')`;
      params.push(to.toString().slice(0, 10));
    }

    if (q) {
      whereSql += ` AND (
        pe.cliente ILIKE $${idx}
        OR pe.telefono ILIKE $${idx}
        OR pe.direccion ILIKE $${idx}
        OR COALESCE(c.nombre, '') ILIKE $${idx}
        OR CAST(p.id AS text) ILIKE $${idx}
      )`;
      params.push(`%${String(q).trim()}%`);
      idx++;
    }

    return { whereSql, params, idx };
  }

  function getDashboardSort(sortKey, sortDir) {
    const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const keyMap = {
      id: 'p.id',
      fecha: 'p.fecha',
      cliente: 'pe.cliente',
      chofer: 'c.nombre',
      estado: 'p.estado',
      pago: 'p.metodo_pago',
      monto: 'p.monto',
    };
    const field = keyMap[String(sortKey || '').toLowerCase()] || 'p.fecha';
    return ` ORDER BY ${field} ${dir}, p.id DESC `;
  }

  // --------------------------------------------------
  // GET /api/pedidos/dashboard-data (admin dashboard server-side)
  // --------------------------------------------------
  router.get('/dashboard-data', withAuth, checkLicencia, async (req, res) => {
    try {
      const {
        from, to, estado, chofer_id, empresa_id, orphan_empresa, orphan_chofer,
        q, page = '1', pageSize = '30', sortKey = 'fecha', sortDir = 'desc'
      } = req.query || {};

      const esSuperUser = isSuper(req);
      const targetEmpresa = esSuperUser
        ? (empresa_id ? Number(empresa_id) : null)
        : getEmpresaIdFromToken(req);

      const onlyOrphanEmpresa = String(orphan_empresa || '') === '1';
      const onlyOrphanChofer = String(orphan_chofer || '') === '1';
      const safePage = Math.max(1, Number(page) || 1);
      const safePageSize = Math.min(100, Math.max(15, Number(pageSize) || 30));
      const offset = (safePage - 1) * safePageSize;

      const selectBase = `
        FROM pedidos p
        LEFT JOIN empresas e ON e.id = p.empresa_id
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        LEFT JOIN choferes c
          ON c.id = p.chofer_id
         AND (
           p.empresa_id IS NULL
           OR p.empresa_id = 0
           OR c.empresa_id = p.empresa_id
         )
      `;

      const { whereSql, params, idx } = buildDashboardBase({
        targetEmpresa, esSuperUser, onlyOrphanEmpresa, onlyOrphanChofer, chofer_id, estado, from, to, q
      });

      const sortSql = getDashboardSort(sortKey, sortDir);

      const rowsSql = `
        SELECT
          p.id,
          p.fecha,
          p.estado,
          p.monto,
          p.metodo_pago,
          pe.cliente,
          pe.telefono,
          pe.direccion,
          p.empresa_id,
          p.zona_id,
          p.chofer_id,
          c.nombre AS chofer_nombre,
          (
            p.empresa_id IS NULL
            OR p.empresa_id = 0
            OR e.id IS NULL
            OR pe.id IS NULL
            OR (pe.empresa_id IS NOT NULL AND p.empresa_id IS NOT NULL AND pe.empresa_id <> p.empresa_id)
          ) AS orphan_empresa,
          (
            p.chofer_id IS NULL
            OR p.chofer_id = 0
            OR c.id IS NULL
          ) AS orphan_chofer
        ${selectBase}
        ${whereSql}
        ${sortSql}
        LIMIT $${idx} OFFSET $${idx + 1}
      `;

      const countSql = `SELECT COUNT(*)::int AS total ${selectBase} ${whereSql}`;

      const kpiSql = `
        SELECT
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE p.estado = 'pendiente')::int AS pendientes,
          COUNT(*) FILTER (WHERE p.estado = 'en_ruta')::int AS en_ruta,
          COUNT(*) FILTER (WHERE p.estado = 'entregado')::int AS entregados,
          COUNT(*) FILTER (WHERE p.estado = 'cancelado')::int AS cancelados,
          COUNT(*) FILTER (WHERE p.chofer_id IS NULL OR p.chofer_id = 0 OR c.id IS NULL)::int AS sin_chofer,
          COALESCE(SUM(COALESCE(p.monto, 0)), 0)::numeric AS total_monto
        ${selectBase}
        ${whereSql}
      `;

      const resumenSql = `
        SELECT
          COALESCE(NULLIF(BTRIM(ip.producto), ''), 'Sin nombre') AS producto,
          SUM(COALESCE(ip.cantidad, 0))::int AS cantidad
        FROM items_pedido ip
        JOIN pedidos p ON p.id = ip.pedido_id
        LEFT JOIN empresas e ON e.id = p.empresa_id
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        LEFT JOIN choferes c
          ON c.id = p.chofer_id
         AND (
           p.empresa_id IS NULL
           OR p.empresa_id = 0
           OR c.empresa_id = p.empresa_id
         )
        ${whereSql.replace(/WHERE 1=1/, "WHERE 1=1 AND p.estado = 'entregado'")}
        GROUP BY 1
        HAVING SUM(COALESCE(ip.cantidad, 0)) > 0
        ORDER BY cantidad DESC, producto ASC
        LIMIT 12
      `;

      const [rows, countRows, kpiRows, resumenRows] = await Promise.all([
        query(rowsSql, [...params, safePageSize, offset]),
        query(countSql, params),
        query(kpiSql, params),
        query(resumenSql, params),
      ]);

      const totalCount = Number(countRows?.[0]?.total) || 0;
      const kpi = kpiRows?.[0] || {};
      const totalMonto = Number(kpi.total_monto) || 0;
      const topProductos = (resumenRows || []).map((row) => ({
        producto: row.producto,
        cantidad: Number(row.cantidad) || 0,
      }));
      const totalUnidades = topProductos.reduce((acc, it) => acc + (Number(it.cantidad) || 0), 0);

      return res.json({
        ok: true,
        rows,
        page: safePage,
        pageSize: safePageSize,
        total_count: totalCount,
        total_pages: Math.max(1, Math.ceil(totalCount / safePageSize)),
        kpis: {
          pendientes: Number(kpi.pendientes) || 0,
          en_ruta: Number(kpi.en_ruta) || 0,
          entregados: Number(kpi.entregados) || 0,
          cancelados: Number(kpi.cancelados) || 0,
          sin_chofer: Number(kpi.sin_chofer) || 0,
          total_monto: totalMonto,
          ticket_promedio: totalCount ? totalMonto / totalCount : 0,
        },
        resumen_articulos: {
          total_unidades: totalUnidades,
          productos_count: topProductos.length,
          top_productos: topProductos,
        },
      });
    } catch (e) {
      console.error('ERROR GET PEDIDOS DASHBOARD DATA:', e);
      return res.status(500).json({ error: 'Error cargando dashboard de pedidos' });
    }
  });

  // --------------------------------------------------
  // GET /api/pedidos/export.csv
  // --------------------------------------------------
  router.get('/export.csv', withAuth, checkLicencia, async (req, res) => {
    try {
      const {
        from, to, estado, chofer_id, empresa_id, orphan_empresa, orphan_chofer,
        q, sortKey = 'fecha', sortDir = 'desc'
      } = req.query || {};

      const esSuperUser = isSuper(req);
      const targetEmpresa = esSuperUser
        ? (empresa_id ? Number(empresa_id) : null)
        : getEmpresaIdFromToken(req);

      const onlyOrphanEmpresa = String(orphan_empresa || '') === '1';
      const onlyOrphanChofer = String(orphan_chofer || '') === '1';

      const selectBase = `
        FROM pedidos p
        LEFT JOIN empresas e ON e.id = p.empresa_id
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        LEFT JOIN choferes c
          ON c.id = p.chofer_id
         AND (
           p.empresa_id IS NULL
           OR p.empresa_id = 0
           OR c.empresa_id = p.empresa_id
         )
      `;

      const { whereSql, params } = buildDashboardBase({
        targetEmpresa, esSuperUser, onlyOrphanEmpresa, onlyOrphanChofer, chofer_id, estado, from, to, q
      });

      const rowsSql = `
        SELECT
          p.id,
          p.fecha,
          pe.cliente,
          pe.telefono,
          pe.direccion,
          COALESCE(c.nombre, CASE WHEN p.chofer_id IS NOT NULL AND p.chofer_id <> 0 THEN '#' || p.chofer_id::text ELSE 'Sin asignar' END) AS chofer_nombre,
          p.estado,
          p.metodo_pago,
          p.monto
        ${selectBase}
        ${whereSql}
        ${getDashboardSort(sortKey, sortDir)}
        LIMIT 10000
      `;

      const rows = await query(rowsSql, params);
      const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['ID','Fecha','Cliente','Telefono','Direccion','Chofer','Estado','Pago','Monto'];
      const body = rows.map((p) => ([
        p.id,
        p.fecha ? new Date(p.fecha).toISOString() : '',
        p.cliente,
        p.telefono,
        p.direccion,
        p.chofer_nombre,
        p.estado,
        p.metodo_pago,
        p.monto,
      ].map(escapeCsv).join(',')));

      const csv = [header.map(escapeCsv).join(','), ...body].join('\n');
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pedidos-${stamp}.csv"`);
      return res.send(csv);
    } catch (e) {
      console.error('ERROR EXPORT PEDIDOS CSV:', e);
      return res.status(500).json({ error: 'Error exportando pedidos' });
    }
  });

  // --------------------------------------------------
  // GET /api/pedidos (admin dashboard)
  // --------------------------------------------------
  router.get('/', withAuth, checkLicencia, async (req, res) => {
    try {
      const { from, to, estado, chofer_id, empresa_id, orphan_empresa, orphan_chofer } = req.query || {};
      const esSuperUser = isSuper(req);

      const targetEmpresa = esSuperUser
        ? (empresa_id ? Number(empresa_id) : null)
        : getEmpresaIdFromToken(req);

      const onlyOrphanEmpresa = String(orphan_empresa || '') === '1';
      const onlyOrphanChofer = String(orphan_chofer || '') === '1';

      let sql = `
        SELECT
          p.id,
          p.fecha,
          p.estado,
          p.monto,
          p.metodo_pago,
          pe.cliente,
          pe.telefono,
          pe.direccion,
          p.empresa_id,
          p.zona_id,
          p.chofer_id,
          c.nombre AS chofer_nombre,
          (
            p.empresa_id IS NULL
            OR p.empresa_id = 0
            OR e.id IS NULL
            OR pe.id IS NULL
            OR (pe.empresa_id IS NOT NULL AND p.empresa_id IS NOT NULL AND pe.empresa_id <> p.empresa_id)
          ) AS orphan_empresa,
          (
            p.chofer_id IS NULL
            OR p.chofer_id = 0
            OR c.id IS NULL
          ) AS orphan_chofer
        FROM pedidos p
        LEFT JOIN empresas e
          ON e.id = p.empresa_id
        LEFT JOIN puntos_entrega pe
          ON pe.id = p.punto_entrega_id
        LEFT JOIN choferes c
          ON c.id = p.chofer_id
         AND (
           p.empresa_id IS NULL
           OR p.empresa_id = 0
           OR c.empresa_id = p.empresa_id
         )
        WHERE 1=1
      `;

      const params = [];
      let idx = 1;

      if (targetEmpresa) {
        sql += ` AND p.empresa_id = $${idx}`;
        params.push(targetEmpresa);
        idx++;
      }

      if (esSuperUser && onlyOrphanEmpresa) {
        sql += ` AND (
          p.empresa_id IS NULL
          OR p.empresa_id = 0
          OR e.id IS NULL
          OR pe.id IS NULL
          OR (pe.empresa_id IS NOT NULL AND p.empresa_id IS NOT NULL AND pe.empresa_id <> p.empresa_id)
        )`;
      }

      if (onlyOrphanChofer) {
        sql += ` AND (
          p.chofer_id IS NULL
          OR p.chofer_id = 0
          OR c.id IS NULL
        )`;
      } else if (chofer_id) {
        sql += ` AND p.chofer_id = $${idx++}`;
        params.push(Number(chofer_id));
      }
      if (estado) {
        sql += ` AND p.estado = $${idx++}`;
        params.push(estado);
      }

      if (from) {
        sql += ` AND p.fecha >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND p.fecha < ($${idx++}::date + INTERVAL '1 day')`;
        params.push(to.toString().slice(0, 10));
      }

      sql += ` ORDER BY p.fecha DESC, p.id DESC LIMIT 500`;

      let rows = [];
      try {
        rows = await query(sql, params);
      } catch (primaryErr) {
        console.error('GET /api/pedidos fallback por query principal:', primaryErr?.message || primaryErr);

        // Fallback seguro/compatibilidad: query base sin joins extra de validación.
        let fallbackSql = `
          SELECT
            p.id,
            p.fecha,
            p.estado,
            p.monto,
            p.metodo_pago,
            pe.cliente,
            pe.telefono,
            pe.direccion,
            p.empresa_id,
            p.zona_id,
            p.chofer_id,
            c.nombre AS chofer_nombre,
            (p.empresa_id IS NULL OR p.empresa_id = 0 OR pe.id IS NULL) AS orphan_empresa,
            (p.chofer_id IS NULL OR p.chofer_id = 0 OR c.id IS NULL) AS orphan_chofer
          FROM pedidos p
          LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
          LEFT JOIN choferes c ON c.id = p.chofer_id
          WHERE 1=1
        `;
        const fallbackParams = [];
        let fIdx = 1;

        if (targetEmpresa) {
          fallbackSql += ` AND p.empresa_id = $${fIdx++}`;
          fallbackParams.push(targetEmpresa);
        }
        if (onlyOrphanChofer) {
          fallbackSql += ` AND (p.chofer_id IS NULL OR p.chofer_id = 0 OR c.id IS NULL)`;
        } else if (chofer_id) {
          fallbackSql += ` AND p.chofer_id = $${fIdx++}`;
          fallbackParams.push(Number(chofer_id));
        }
        if (estado) {
          fallbackSql += ` AND p.estado = $${fIdx++}`;
          fallbackParams.push(estado);
        }
        if (from) {
          fallbackSql += ` AND p.fecha >= $${fIdx++}::date`;
          fallbackParams.push(from.toString().slice(0, 10));
        }
        if (to) {
          fallbackSql += ` AND p.fecha < ($${fIdx++}::date + INTERVAL '1 day')`;
          fallbackParams.push(to.toString().slice(0, 10));
        }

        fallbackSql += ` ORDER BY p.fecha DESC, p.id DESC LIMIT 500`;

        rows = await query(fallbackSql, fallbackParams);

        if (esSuperUser && onlyOrphanEmpresa) {
          rows = rows.filter((r) => {
            const empId = Number(r?.empresa_id || 0);
            return !empId;
          });
        }
      }

      res.json(rows);

    } catch (e) {
      console.error('ERROR GET PEDIDOS:', e);
      res.status(500).json({ error: 'Error cargando pedidos' });
    }
  });

  // --------------------------------------------------
  // PUT /api/pedidos/:id
  // --------------------------------------------------
  router.put('/:id', withAuth, async (req, res) => {
    try {
      const { estado, metodo_pago, empresa_id, chofer_id, zona_id } = req.body;
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const targetEmpresa = esSuperUser
        ? (empresa_id != null ? Number(empresa_id) : null)
        : Number(myEmpresa);

      if (!esSuperUser && !targetEmpresa) {
        return res.status(400).json({ error: 'Falta empresa.' });
      }

      const sets = [];
      const vals = [];
      let idx = 1;

      if (estado) {
        sets.push(`estado = $${idx++}`);
        vals.push(estado);
      }
      if (metodo_pago) {
        sets.push(`metodo_pago = $${idx++}`);
        vals.push(metodo_pago);
      }

      if (esSuperUser && empresa_id != null) {
        sets.push(`empresa_id = $${idx++}`);
        vals.push(Number(empresa_id));
      }

      if (chofer_id != null) {
        sets.push(`chofer_id = $${idx++}`);
        vals.push(chofer_id);
      }
      if (zona_id != null) {
        sets.push(`zona_id = $${idx++}`);
        vals.push(zona_id);
      }

      if (sets.length) {
        vals.push(req.params.id);
        const idPos = idx++;
        vals.push(targetEmpresa);
        const empPos = idx++;

        const r = await query(
          `UPDATE pedidos SET ${sets.join(', ')}
           WHERE id = $${idPos}
             AND ($${empPos}::int IS NULL OR empresa_id = $${empPos})
           RETURNING id, empresa_id, punto_entrega_id, monto, estado`,
          vals
        );

        if (!r.length) {
          return res.status(404).json({ error: 'Pedido no encontrado o sin permiso' });
        }

        if (estado === 'en_ruta') {
          const emp = Number(r[0].empresa_id);
          notificarEnRuta(req.params.id, emp).catch((err) =>
            console.error('Error en notificación background:', err)
          );
        }

        if (estado === 'entregado' && process.env.TRACK_CLEAR_ON_DELIVER === '1') {
          const emp = Number(r[0].empresa_id);
          await query(
            'UPDATE pedidos SET tracking_token = NULL WHERE id = $1 AND empresa_id = $2',
            [req.params.id, emp]
          );
        }

        if (estado === 'entregado') {
          const row = r[0];
          awardPointsForDeliveredOrder({
            queryFn: query,
            empresaId: row.empresa_id,
            puntoEntregaId: row.punto_entrega_id,
            pedidoId: row.id,
            monto: row.monto,
          }).catch((err) => console.error('POINTS.AWARD.ERROR', err?.message || err));
        }
      }

      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error actualizando pedido' });
    }
  });

  // --------------------------------------------------
  // DELETE /api/pedidos/:id
  // --------------------------------------------------
  router.delete('/:id', withAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const rows = await query(
        'SELECT id, empresa_id FROM pedidos WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [id, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const pedido = rows[0];
      const targetEmpresa = Number(pedido.empresa_id);

      // Cascadas (tablas sin empresa_id se borran por pedido_id)
      await query('DELETE FROM items_pedido WHERE pedido_id=$1', [id]);
      await query('DELETE FROM pedido_track_points WHERE pedido_id=$1', [id]);
      await query('DELETE FROM comprobantes_transferencia WHERE pedido_id=$1 AND empresa_id=$2', [id, targetEmpresa]);

      await query('DELETE FROM pedidos WHERE id=$1 AND empresa_id=$2', [id, targetEmpresa]);

      res.json({ ok: true });

    } catch (e) {
      console.error('ERROR DELETE PEDIDO:', e);
      res.status(500).json({ error: 'Error interno al eliminar el pedido' });
    }
  });

  return router;
}
