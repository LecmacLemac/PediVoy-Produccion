import express from 'express';
import {
  withAuth as defaultWithAuth,
  checkLicencia as defaultCheckLicencia,
  isSuper as defaultIsSuper,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken
} from '../services.js';
import { query, pool, withTransaction as dbWithTransaction } from '../db.js';

function canTogglePago(req) {
  const role = String(req.user?.role || '').toLowerCase();
  return role !== 'repartidor' && role !== 'referente';
}

export function createPedidosPagoRouter({
  query: queryFn = query,
  pool: poolFn = pool,
  withAuth: withAuthFn = defaultWithAuth,
  checkLicencia: checkLicenciaFn = defaultCheckLicencia,
  isSuper: isSuperFn = defaultIsSuper,
  getEmpresaIdFromToken: getEmpresaIdFromTokenFn = defaultGetEmpresaIdFromToken
} = {}) {
  const router = express.Router();
  const withTransaction = fn => poolFn?.connect
    ? dbWithTransaction(fn, { pool: poolFn })
    : fn(queryFn);

  // POST /api/pedidos/:id/toggle-pago
  router.post('/:id/toggle-pago', withAuthFn, checkLicenciaFn, async (req, res) => {
    try {
      const pedidoId = Number(req.params.id);
      const { marcado } = req.body;
      const esSuperUser = isSuperFn(req);
      const myEmpresa = getEmpresaIdFromTokenFn(req);

      if (!pedidoId) return res.status(400).json({ error: 'ID inválido' });
      if (!canTogglePago(req)) return res.status(403).json({ error: 'No autorizado para modificar pagos' });

      await withTransaction(async (txQuery) => {
        const pRows = await txQuery(
          `SELECT empresa_id, monto, chofer_id, fecha
             FROM pedidos
            WHERE id = $1
              AND ($2::int IS NULL OR empresa_id = $2)
            LIMIT 1
            FOR UPDATE`,
          [pedidoId, esSuperUser ? null : Number(myEmpresa)]
        );
        if (!pRows.length) {
          const err = new Error('Pedido no encontrado');
          err.statusCode = 404;
          throw err;
        }

        const p = pRows[0];
        const empresaId = Number(p.empresa_id);
        const marcadoBool = !!marcado;

        if (marcadoBool) {
          const existe = await txQuery(
            'SELECT id FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2 LIMIT 1',
            [pedidoId, empresaId]
          );

          if (!existe.length) {
            await txQuery(
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
        } else {
          await txQuery(
            'DELETE FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2',
            [pedidoId, empresaId]
          );
        }
      });

      res.json({ ok: true });
    } catch (e) {
      if (e?.statusCode === 404) return res.status(404).json({ error: e.message });
      console.error('ERROR TOGGLE PAGO:', e);
      res.status(500).json({ error: 'Error actualizando pago' });
    }
  });

  return router;
}
