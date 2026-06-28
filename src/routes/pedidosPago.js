import express from 'express';
import {
  withAuth as defaultWithAuth,
  checkLicencia as defaultCheckLicencia,
  isSuper as defaultIsSuper,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken
} from '../services.js';
import { query, pool } from '../db.js';

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
  const dbQuery = queryFn;

  async function withTransaction(fn) {
    if (!poolFn?.connect) return fn(dbQuery);

    const client = await poolFn.connect();
    const txQuery = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return result.rows || [];
    };

    try {
      await client.query('BEGIN');
      const result = await fn(txQuery);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  // POST /api/pedidos/:id/toggle-pago
  router.post('/:id/toggle-pago', withAuthFn, checkLicenciaFn, async (req, res) => {
    try {
      const pedidoId = Number(req.params.id);
      const { marcado } = req.body;
      const esSuperUser = isSuperFn(req);
      const myEmpresa = getEmpresaIdFromTokenFn(req);
      const userId = Number(req.user?.uid || req.user?.id || 0) || null;

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

          await txQuery(
            `UPDATE comprobantes_transferencia
                SET validado = 1,
                    estado_revision = 'aprobado',
                    verified_by = COALESCE($3::int, verified_by),
                    verified_at = NOW(),
                    verified_reason = COALESCE(verified_reason, 'Verificado manual desde Estadísticas')
              WHERE pedido_id = $1
                AND empresa_id = $2`,
            [pedidoId, empresaId, userId]
          );
        } else {
          await txQuery(
            'DELETE FROM transferencias WHERE pedido_id = $1 AND empresa_id = $2',
            [pedidoId, empresaId]
          );

          await txQuery(
            `UPDATE comprobantes_transferencia
                SET validado = 0,
                    estado_revision = 'en_revision',
                    verified_by = COALESCE($3::int, verified_by),
                    verified_at = NOW(),
                    verified_reason = 'Desmarcado manual desde Estadísticas'
              WHERE pedido_id = $1
                AND empresa_id = $2`,
            [pedidoId, empresaId, userId]
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
