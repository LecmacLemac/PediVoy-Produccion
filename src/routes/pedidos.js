// src/routes/pedidos.js
import express from 'express';

import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';
import { notificarEnRuta } from '../services/notificacionesPedidos.js';
import { awardPointsForDeliveredOrder } from '../services/puntosService.js';

export function createPedidosRouter() {
  const router = express.Router();

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

      const rows = await query(sql, params);
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
