// src/routes/stock.js
import express from 'express';
import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createStockRouter() {
  const router = express.Router();

  // GET /api/stock/summary
  router.get('/summary', withAuth, async (req, res) => {
    try {
      const empresaId = isSuper(req) && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      const sql = `
        SELECT 
          p.id,
          p.nombre,
          p.stock_min,
          p.stock_max,
          COALESCE(SUM(cs.cantidad), 0) AS stock_fisico
        FROM productos p
        LEFT JOIN chofer_stock cs
          ON cs.producto_id = p.id
         AND cs.empresa_id  = p.empresa_id
        WHERE p.empresa_id = $1
        GROUP BY p.id, p.nombre, p.stock_min, p.stock_max
        ORDER BY p.nombre
      `;

      const rows = await query(sql, [empresaId]);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/summary', e);
      return res.status(500).json({ error: 'Error stock' });
    }
  });

  // POST /api/stock/ajuste
  router.post('/ajuste', withAuth, async (req, res) => {
    try {
      const { producto_id, qty, tipo, motivo, chofer_id, empresa_id } = req.body;

      const esSuperUser = isSuper(req);
      const targetEmpresa = (esSuperUser && empresa_id)
        ? Number(empresa_id)
        : getEmpresaIdFromToken(req);

      if (!targetEmpresa) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      if (!chofer_id) {
        return res.status(400).json({ error: 'Se requiere chofer para asignar el stock' });
      }

      const cantidadNum = Number(qty);
      if (!Number.isFinite(cantidadNum) || cantidadNum <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

      const signo = tipo === 'ADJUST-' ? -1 : 1;
      const cantidadReal = Math.abs(cantidadNum) * signo;

      await query(
        `
        INSERT INTO chofer_stock_mov
          (empresa_id, chofer_id, producto_id, fecha, tipo, cantidad, motivo, created_at)
        VALUES
          ($1,        $2,        $3,          NOW(), 'ajuste', $4,      $5,    NOW())
        `,
        [targetEmpresa, chofer_id, producto_id, cantidadReal, motivo || 'Ajuste manual']
      );

      await query(
        `
        INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (empresa_id, chofer_id, producto_id)
        DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
        `,
        [targetEmpresa, chofer_id, producto_id, cantidadReal]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR /api/stock/ajuste', e);
      return res.status(500).json({ error: 'Error ajuste stock' });
    }
  });

  // GET /api/stock/kardex/:id
  router.get('/kardex/:id', withAuth, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      const productoId = Number(req.params.id);

      const rows = await query(
        `
        SELECT *,
               COALESCE(referencia, motivo) as notas
        FROM chofer_stock_mov
        WHERE producto_id = $1
          AND empresa_id  = $2
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [productoId, empresaId]
      );

      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/kardex', e);
      return res.status(500).json({ error: 'Error kardex' });
    }
  });

  // GET /api/stock/por-tipo
  router.get('/por-tipo', withAuth, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      const productoId = req.query.producto_id ? Number(req.query.producto_id) : null;
      const tipo = (req.query.tipo || '').toLowerCase();

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      let sql = `
        SELECT
          p.id              AS producto_id,
          p.nombre,
          p.stock_min,
          p.stock_max,
          ch.tipo           AS tipo_chofer,
          COALESCE(SUM(cs.cantidad), 0) AS stock
        FROM productos p
        LEFT JOIN chofer_stock cs
               ON cs.producto_id = p.id
              AND cs.empresa_id  = p.empresa_id
        LEFT JOIN choferes ch
               ON ch.id = cs.chofer_id
        WHERE p.empresa_id = $1
      `;

      const params = [empresaId];
      let idx = 2;

      if (productoId) {
        sql += ` AND p.id = $${idx++}`;
        params.push(productoId);
      }

      if (tipo === 'propio' || tipo === 'fletero') {
        sql += ` AND ch.tipo = $${idx++}`;
        params.push(tipo);
      }

      sql += `
        GROUP BY
          p.id, p.nombre, p.stock_min, p.stock_max, ch.tipo
        ORDER BY
          p.nombre, ch.tipo
      `;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/por-tipo', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // GET /api/stock/movimientos-por-tipo
  router.get('/movimientos-por-tipo', withAuth, checkLicencia, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const { from, to, producto_id, tipo } = req.query || {};

      const dateFrom = from ? from.toString().slice(0, 10) : '2000-01-01';
      const dateTo   = to   ? to.toString().slice(0, 10)   : '2100-12-31';

      let sql = `
        WITH 
        entradas AS (
          SELECT 
              csm.chofer_id, 
              csm.producto_id, 
              SUM(csm.cantidad) as total_cargado
          FROM chofer_stock_mov csm
          WHERE csm.empresa_id = $1
            AND csm.cantidad > 0 
            AND csm.tipo <> 'venta'
            AND (csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date 
            AND (csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
          GROUP BY 1, 2
        ),
        salidas_ventas AS (
          SELECT 
              p.chofer_id, 
              pr.id as producto_id, 
              SUM(ip.cantidad) as total_entregado
          FROM pedidos p
          JOIN items_pedido ip ON ip.pedido_id = p.id
          JOIN productos pr ON pr.nombre = ip.producto AND pr.empresa_id = p.empresa_id
          WHERE p.empresa_id = $1
            AND p.estado = 'entregado'
            AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date 
            AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
          GROUP BY 1, 2
        )

        SELECT
          p.id              AS producto_id,
          p.nombre,
          p.stock_min,
          p.stock_max,
          ch.tipo           AS tipo_chofer,
          COALESCE(e.total_cargado, 0)   AS cargado,
          COALESCE(s.total_entregado, 0) AS entregado,
          (COALESCE(e.total_cargado, 0) - COALESCE(s.total_entregado, 0)) AS neto
        
        FROM productos p
        CROSS JOIN choferes ch 
        LEFT JOIN entradas       e ON e.producto_id = p.id AND e.chofer_id = ch.id
        LEFT JOIN salidas_ventas s ON s.producto_id = p.id AND s.chofer_id = ch.id
        
        WHERE p.empresa_id = $1
          AND ch.empresa_id = $1
      `;

      const params = [empresaId, dateFrom, dateTo];
      let idx = 4;

      if (producto_id) {
        sql += ` AND p.id = $${idx++}`;
        params.push(Number(producto_id));
      }

      if (tipo && (tipo === 'propio' || tipo === 'fletero')) {
        sql += ` AND ch.tipo = $${idx++}`;
        params.push(tipo);
      }

      sql += `
        AND (COALESCE(e.total_cargado, 0) > 0 OR COALESCE(s.total_entregado, 0) > 0)
        ORDER BY p.nombre, ch.tipo
      `;

      const rows = await query(sql, params);
      return res.json(rows);

    } catch (e) {
      console.error('ERROR /api/stock/movimientos-por-tipo', e);
      return res.status(500).json({ error: 'Error calculando movimientos' });
    }
  });

  return router;
}
