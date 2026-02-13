// src/routes/repartidorStats.js
import express from 'express';
import { withAuth, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createRepartidorStatsRouter() {
  const router = express.Router();

  // GET /api/repartidor/resumen-dia
  router.get('/resumen-dia', withAuth, async (req, res) => {
    try {
      const { chofer_id } = req.user || {};
      if (!chofer_id) {
        return res.json({ entregados: 0, pendientes: 0, dinero: 0 });
      }

      const sql = `
        SELECT 
          COUNT(*) FILTER (WHERE estado = 'entregado') AS entregados,
          COUNT(*) FILTER (WHERE estado IN ('pendiente','en_ruta','en_camino')) AS pendientes,
          COALESCE(SUM(monto) FILTER (WHERE estado = 'entregado'), 0) AS dinero
        FROM pedidos
        WHERE chofer_id = $1
          AND fecha >= CURRENT_DATE
          AND fecha < (CURRENT_DATE + INTERVAL '1 day')
      `;

      const rows = await query(sql, [chofer_id]);
      return res.json(rows[0] || { entregados: 0, pendientes: 0, dinero: 0 });
    } catch (e) {
      console.error('ERROR /api/repartidor/resumen-dia', e);
      return res.status(500).json({ error: 'Error resumen' });
    }
  });

  // GET /api/repartidor/pago-dia
  router.get('/pago-dia', withAuth, async (req, res) => {
    try {
      const user = req.user;
      if (!user || !user.chofer_id) {
        return res.status(400).json({ error: 'Usuario sin chofer asociado' });
      }

      const choferId = user.chofer_id;
      const fecha = (req.query.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);

      const empresaId = getEmpresaIdFromToken(req);
      if (!empresaId) {
        return res.status(400).json({ error: 'No se pudo determinar la empresa del chofer' });
      }

      const row = (
        await query(
          `
          WITH entregas AS (
            SELECT COALESCE(SUM(it.cantidad),0) AS q
            FROM items_pedido it
            JOIN pedidos p          ON p.id = it.pedido_id
            JOIN puntos_entrega pe  ON pe.id = p.punto_entrega_id
            WHERE pe.empresa_id = $1
              AND p.chofer_id  = $2
              AND p.fecha >= $3::date
              AND p.fecha < ($3::date + INTERVAL '1 day')
              AND LOWER(p.estado) = 'entregado'
          ),
          escala_sel AS (
            SELECT ce.id
            FROM chofer_escalas ce
            WHERE ce.empresa_id = $4
              AND (ce.chofer_id = $5 OR ce.chofer_id IS NULL)
              AND $6::date BETWEEN DATE(ce.vigente_desde)
                               AND DATE(COALESCE(ce.vigente_hasta,'9999-12-31'))
            ORDER BY (ce.chofer_id IS NOT NULL) DESC, ce.vigente_desde DESC
            LIMIT 1
          ),
          monto_sel AS (
            SELECT t.monto
            FROM chofer_escala_tramos t
            JOIN entregas e ON TRUE
            JOIN escala_sel s ON t.escala_id = s.id
            WHERE e.q BETWEEN t.rango_min AND COALESCE(t.rango_max, 999999)
            LIMIT 1
          )
          SELECT
            (SELECT q FROM entregas) AS cantidad,
            COALESCE((SELECT monto FROM monto_sel), 0) AS pago
        `,
          [empresaId, choferId, fecha, empresaId, choferId, fecha]
        )
      )[0] || {};

      return res.json({
        fecha,
        cantidad: Number(row.cantidad || 0),
        pago: Number(row.pago || 0),
      });
    } catch (e) {
      console.error('ERROR /api/repartidor/pago-dia', e);
      return res.status(500).json({ error: 'Error calculando pago del día' });
    }
  });

  return router;
}
