// src/routes/reportes.js
import express from 'express';
import { withAuth, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createReportesRouter() {
  const router = express.Router();

  // GET /api/reportes/entregados
  router.get('/entregados', withAuth, async (req, res) => {
    try {
      const { from, to, zona_id, chofer_id, metodo_pago, empresa_id } = req.query || {};
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const targetEmpresa = (esSuperUser && empresa_id) ? Number(empresa_id) : myEmpresa;

      if (!targetEmpresa) {
        return res.status(400).json({ error: 'Empresa no determinada' });
      }

      let sql = `
        SELECT 
          p.id,
          p.fecha,
          pe.cliente,
          pe.telefono,
          pe.direccion,
          p.metodo_pago,
          p.monto,
          p.cantidad_entregada,
          p.chofer_id,
          c.nombre AS chofer_nombre,
          pe.zona_id,
          (CASE WHEN t.id IS NOT NULL THEN true ELSE false END) as pagado 
        FROM pedidos p
        JOIN puntos_entrega pe ON p.punto_entrega_id = pe.id
        LEFT JOIN choferes c   ON p.chofer_id = c.id
        LEFT JOIN transferencias t ON t.pedido_id = p.id AND t.empresa_id = p.empresa_id
        WHERE p.estado = 'entregado'
          AND pe.empresa_id = $1
      `;

      const params = [targetEmpresa];
      let idx = 2;

      if (from) {
        sql += ` AND p.fecha >= $${idx++}::date`;
        params.push(from.toString().slice(0, 10));
      }
      if (to) {
        sql += ` AND p.fecha < ($${idx++}::date + INTERVAL '1 day')`;
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

      sql += ` ORDER BY p.fecha DESC, p.id DESC`;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/reportes/entregados', e);
      return res.status(500).json({ error: 'Error generando reporte de entregados' });
    }
  });

  return router;
}
