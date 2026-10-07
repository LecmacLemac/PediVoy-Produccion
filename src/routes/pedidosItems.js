// src/routes/pedidosItems.js
import express from 'express';
import {
  withAuth as withAuthDefault,
  isSuper as isSuperDefault,
  getEmpresaIdFromToken as getEmpresaIdFromTokenDefault,
} from '../services.js';
import { query as queryDefault, withTransaction as withTransactionDefault } from '../db.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import {
  backofficeMutationError,
  lockCanonicalBackofficeActor,
  parseCanonicalPositiveInt4,
  POSTGRES_INT4_MAX,
  requireCanonicalActorUid,
} from './pedidoBackofficeMutation.js';
import {
  normalizeRequestedPedidoItems,
  replacePedidoItems,
  resolveAndLockPedidoProducts,
} from './pedidoItemsMutation.js';

function httpError(statusCode, message) {
  return backofficeMutationError(statusCode, message);
}

export function createUpdatePedidoItemsHandler({ withTransaction = withTransactionDefault } = {}) {
  return async function updatePedidoItems(req, res) {
    try {
      const pedidoId = parseCanonicalPositiveInt4(req.params.id, 'ID de pedido inválido');
      const actorUid = requireCanonicalActorUid(req.user);
      const requestedItems = normalizeRequestedPedidoItems(req.body?.items);

      await withTransaction(async txQuery => {
        const { tenantEmpresa } = await lockCanonicalBackofficeActor(txQuery, req.user, actorUid);
        const pedidos = await txQuery(
          `SELECT id, empresa_id, chofer_id, estado
             FROM pedidos
            WHERE id = $1
              AND ($2::int IS NULL OR empresa_id = $2)
            FOR UPDATE`,
          [pedidoId, tenantEmpresa]
        );
        if (pedidos.length !== 1) throw httpError(404, 'Pedido no encontrado');
        const pedido = pedidos[0];
        const pedidoEmpresaId = Number(pedido.empresa_id);
        if (!Number.isSafeInteger(pedidoEmpresaId) || pedidoEmpresaId <= 0
            || pedidoEmpresaId > POSTGRES_INT4_MAX) {
          throw httpError(409, 'El pedido no tiene un tenant canónico');
        }
        if (pedido.estado === 'entregado' || pedido.estado === 'cancelado') {
          throw httpError(409, 'El pedido finalizado no admite cambios de ítems');
        }

        const canonicalItems = await resolveAndLockPedidoProducts(txQuery, {
          empresaId: pedidoEmpresaId,
          requestedItems,
        });

        await replacePedidoItems(txQuery, {
          pedidoId,
          empresaId: pedidoEmpresaId,
          canonicalItems,
        });
      });
      return res.json({ ok: true });
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de actualización de ítems indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      const statusCode = Number(e?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({ error: e.message });
      }
      console.error('Error editando ítems y stock:', e);
      return res.status(500).json({ error: 'Error procesando cambios y stock' });
    }
  };
}

export function createPedidosItemsRouter(deps = {}) {
  const query = deps.query || queryDefault;
  const withTransaction = deps.withTransaction || withTransactionDefault;
  const withAuth = deps.withAuth || withAuthDefault;
  const isSuper = deps.isSuper || isSuperDefault;
  const getEmpresaIdFromToken = deps.getEmpresaIdFromToken || getEmpresaIdFromTokenDefault;
  const router = express.Router();


  // GET /api/pedidos/resumen-articulos?ids=1,2,3
  router.get('/resumen-articulos', withAuth, async (req, res) => {
    try {
      const rawIds = String(req.query?.ids || '');
      const ids = Array.from(new Set(
        rawIds
          .split(',')
          .map((v) => Number(String(v).trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      ));

      if (!ids.length) {
        return res.json({ ok: true, total_unidades: 0, productos_count: 0, top_productos: [] });
      }
      if (ids.length > 500) {
        return res.status(400).json({ error: 'Demasiados pedidos para resumir' });
      }

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const empresaFilter = esSuperUser ? null : Number(myEmpresa);

      const rows = await query(
        `SELECT
           COALESCE(NULLIF(BTRIM(ip.producto), ''), 'Sin nombre') AS producto,
           SUM(COALESCE(ip.cantidad, 0))::int AS cantidad
         FROM items_pedido ip
         JOIN pedidos p ON p.id = ip.pedido_id
         WHERE ip.pedido_id = ANY($1::int[])
           AND ($2::int IS NULL OR p.empresa_id = $2)
         GROUP BY 1
         HAVING SUM(COALESCE(ip.cantidad, 0)) > 0
         ORDER BY cantidad DESC, producto ASC`,
        [ids, empresaFilter]
      );

      const totalUnidades = rows.reduce((acc, row) => acc + (Number(row?.cantidad) || 0), 0);
      return res.json({
        ok: true,
        total_unidades: totalUnidades,
        productos_count: rows.length,
        top_productos: rows.slice(0, 12).map((row) => ({
          producto: row.producto,
          cantidad: Number(row.cantidad) || 0,
        })),
      });
    } catch (e) {
      console.error('ERROR GET RESUMEN ARTICULOS PEDIDOS:', e);
      return res.status(500).json({ error: 'Error cargando resumen de artículos' });
    }
  });

  // PUT /api/pedidos/:id/items
  router.put('/:id/items', withAuth, requireCanonicalBackofficeRole, createUpdatePedidoItemsHandler({ withTransaction }));

  // GET /api/pedidos/:id/items
  router.get('/:id/items', withAuth, async (req, res) => {
    try {
      const pedidoId = Number(req.params.id);
      if (!Number.isInteger(pedidoId)) {
        return res.status(400).json({ error: 'ID de pedido inválido' });
      }

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const ped = await query(
        'SELECT empresa_id FROM pedidos WHERE id=$1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [pedidoId, esSuperUser ? null : Number(myEmpresa)]
      );
      if (!ped.length) return res.status(404).json({ error: 'Pedido no encontrado' });

      const items = await query(
        `SELECT id, producto, cantidad, precio_unitario
           FROM items_pedido
          WHERE pedido_id=$1
          ORDER BY id`,
        [pedidoId]
      );

      return res.json(items);
    } catch (e) {
      console.error('ERROR GET ITEMS PEDIDO:', e);
      return res.status(500).json({ error: 'Error cargando ítems' });
    }
  });

  return router;
}
