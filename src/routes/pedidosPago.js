// src/routes/pedidosPago.js
import express from 'express';
import { withAuth, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createPedidosPagoRouter() {
  const router = express.Router();

  // POST /api/pedidos/:id/toggle-pago
  router.post('/:id/toggle-pago', withAuth, async (req, res) => {
    try {
      const pedidoId = Number(req.params.id);
      const { marcado } = req.body;
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      if (!pedidoId) return res.status(400).json({ error: 'ID inválido' });

      const pRows = await query(
        'SELECT empresa_id, monto, chofer_id, fecha FROM pedidos WHERE id = $1 AND ($2::int IS NULL OR empresa_id = $2) LIMIT 1',
        [pedidoId, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!pRows.length) return res.status(404).json({ error: 'Pedido no encontrado' });

      const p = pRows[0];
      const empresaId = Number(p.empresa_id);
      const marcadoBool = !!marcado;

      if (marcadoBool) {
        const existe = await query(
          'SELECT id FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2',
          [pedidoId, empresaId]
        );

        if (!existe.length) {
          await query(
            `
            INSERT INTO transferencias (
              empresa_id, chofer_id, fecha, monto, metodo_pago,
              referencia, estado, tipo, pedido_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, 'transferencia',
              'Verificado manual desde Estadísticas', 'verificado', 'transferencia', $5, NOW(), NOW()
            )
            `,
            [empresaId, p.chofer_id, p.fecha, p.monto, pedidoId]
          );
        }

        await query(
          'UPDATE comprobantes_transferencia SET validado = 1 WHERE pedido_id = $1 AND empresa_id = $2',
          [pedidoId, empresaId]
        );
      } else {
        await query(
          'DELETE FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2',
          [pedidoId, empresaId]
        );

        await query(
          'UPDATE comprobantes_transferencia SET validado = 0 WHERE pedido_id = $1 AND empresa_id = $2',
          [pedidoId, empresaId]
        );
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('ERROR TOGGLE PAGO:', e);
      res.status(500).json({ error: 'Error actualizando pago' });
    }
  });

  return router;
}
