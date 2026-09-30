// src/routes/pedidosItems.js
import express from 'express';
import {
  withAuth as withAuthDefault,
  isSuper as isSuperDefault,
  getEmpresaIdFromToken as getEmpresaIdFromTokenDefault,
} from '../services.js';
import { query as queryDefault, withTransaction as withTransactionDefault } from '../db.js';
import {
  lockProductIdentityNamespaces,
  normalizeProductIdentityName,
  PRODUCT_NAME_IDENTITY_SQL,
} from '../services/productIdentityNamespace.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';

export function createPedidosItemsRouter(deps = {}) {
  const query = deps.query || queryDefault;
  const withTransaction = deps.withTransaction || withTransactionDefault;
  const withAuth = deps.withAuth || withAuthDefault;
  const isSuper = deps.isSuper || isSuperDefault;
  const getEmpresaIdFromToken = deps.getEmpresaIdFromToken || getEmpresaIdFromTokenDefault;
  const router = express.Router();

  function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function normalizeRequestedItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw httpError(400, 'Debe indicar al menos un ítem');
    }
    return rawItems.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw httpError(400, 'Ítem inválido');
      }
      const hasProductId = Object.hasOwn(raw, 'producto_id') && raw.producto_id != null;
      if (hasProductId && (!Number.isSafeInteger(raw.producto_id) || raw.producto_id <= 0)) {
        throw httpError(400, 'ID de producto inválido');
      }
      const productName = typeof raw.producto === 'string' ? raw.producto.trim() : '';
      if (!hasProductId && !productName) throw httpError(400, 'Producto inválido');
      if (!Number.isSafeInteger(raw.cantidad) || raw.cantidad <= 0) {
        throw httpError(400, 'Cantidad inválida');
      }
      if (typeof raw.precio_unitario !== 'number'
          || !Number.isFinite(raw.precio_unitario) || raw.precio_unitario < 0) {
        throw httpError(400, 'Precio unitario inválido');
      }
      return {
        productoId: hasProductId ? raw.producto_id : null,
        productName,
        normalizedName: normalizeProductIdentityName(productName),
        cantidad: raw.cantidad,
        precioUnitario: raw.precio_unitario,
      };
    });
  }

  async function resolveAndLockProducts(txQuery, { empresaId, requestedItems }) {
    const ids = Array.from(new Set(
      requestedItems.filter(item => item.productoId != null).map(item => item.productoId)
    )).sort((a, b) => a - b);
    const names = Array.from(new Set(
      requestedItems.filter(item => item.productoId == null).map(item => item.normalizedName)
    )).sort();
    const lockedNames = await lockProductIdentityNamespaces(txQuery, { empresaId, names });
    const rows = await txQuery(
      `SELECT id, nombre
         FROM productos
        WHERE empresa_id = $1
          AND deleted_at IS NULL
          AND activo IS TRUE
          AND (
               id = ANY($2::int[])
            OR ${PRODUCT_NAME_IDENTITY_SQL} = ANY($3::text[])
          )
        ORDER BY id
        FOR SHARE`,
      [empresaId, ids, lockedNames]
    );
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    const byName = new Map();
    for (const row of rows) {
      const key = normalizeProductIdentityName(row.nombre);
      const matches = byName.get(key) || [];
      matches.push(row);
      byName.set(key, matches);
    }
    return requestedItems.map(item => {
      if (item.productoId != null) {
        const product = byId.get(item.productoId);
        if (!product) throw httpError(400, 'Producto inválido para la empresa');
        return { ...item, productoId: Number(product.id), productName: product.nombre };
      }
      const matches = byName.get(item.normalizedName) || [];
      if (matches.length === 0) throw httpError(400, 'Producto no encontrado');
      if (matches.length !== 1) throw httpError(409, 'Nombre de producto ambiguo');
      return { ...item, productoId: Number(matches[0].id), productName: matches[0].nombre };
    });
  }

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
  router.put('/:id/items', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const rawPedidoId = req.params.id;
    const pedidoId = /^\d+$/.test(rawPedidoId) ? Number(rawPedidoId) : NaN;
    try {
      if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) throw httpError(400, 'ID de pedido inválido');
      const requestedItems = normalizeRequestedItems(req.body?.items);
      const tokenEmpresaId = getEmpresaIdFromToken(req);
      const empresaFilter = isSuper(req) ? null : tokenEmpresaId;
      if (empresaFilter != null && (!Number.isSafeInteger(empresaFilter) || empresaFilter <= 0)) {
        throw httpError(400, 'Empresa inválida');
      }

      await withTransaction(async txQuery => {
        const pedidos = await txQuery(
          `SELECT id, empresa_id, chofer_id, estado
             FROM pedidos
            WHERE id = $1
              AND ($2::int IS NULL OR empresa_id = $2)
            FOR UPDATE`,
          [pedidoId, empresaFilter]
        );
        if (pedidos.length !== 1) throw httpError(404, 'Pedido no encontrado');
        const pedido = pedidos[0];
        if (pedido.estado === 'entregado' || pedido.estado === 'cancelado') {
          throw httpError(409, 'El pedido finalizado no admite cambios de ítems');
        }

        const stockYaDescontado = pedido.estado === 'entregado';
        if (stockYaDescontado) throw httpError(409, 'El pedido finalizado no admite cambios de ítems');
        const canonicalItems = await resolveAndLockProducts(txQuery, {
          empresaId: Number(pedido.empresa_id),
          requestedItems,
        });

        await txQuery('DELETE FROM items_pedido WHERE pedido_id = $1', [pedidoId]);
        for (const item of canonicalItems) {
          const inserted = await txQuery(
            `INSERT INTO items_pedido
               (pedido_id, producto, producto_id, cantidad, precio_unitario)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [pedidoId, item.productName, item.productoId, item.cantidad, item.precioUnitario]
          );
          if (inserted.length !== 1) throw new Error('No se pudo insertar el ítem del pedido');
        }

        const updated = await txQuery(
          `UPDATE pedidos
              SET monto = (
                SELECT COALESCE(SUM(cantidad * precio_unitario), 0)
                  FROM items_pedido
                 WHERE pedido_id = $1
              )
            WHERE id = $1
              AND empresa_id = $2
          RETURNING id`,
          [pedidoId, pedido.empresa_id]
        );
        if (updated.length !== 1) throw httpError(409, 'El pedido cambió durante la actualización');
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
  });

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
