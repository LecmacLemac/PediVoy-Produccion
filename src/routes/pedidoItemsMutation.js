import {
  lockProductIdentityNamespaces,
  normalizeProductIdentityName,
  PRODUCT_NAME_IDENTITY_SQL,
} from '../services/productIdentityNamespace.js';
import {
  backofficeMutationError,
  POSTGRES_INT4_MAX,
} from './pedidoBackofficeMutation.js';

function itemsError(statusCode, message) {
  return backofficeMutationError(statusCode, message);
}

export function normalizeRequestedPedidoItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw itemsError(400, 'Debe indicar al menos un ítem');
  }
  return rawItems.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw itemsError(400, 'Ítem inválido');
    }
    const hasProductId = Object.hasOwn(raw, 'producto_id') && raw.producto_id != null;
    if (hasProductId && (!Number.isSafeInteger(raw.producto_id)
        || raw.producto_id <= 0 || raw.producto_id > POSTGRES_INT4_MAX)) {
      throw itemsError(400, 'ID de producto inválido');
    }
    const productName = typeof raw.producto === 'string' ? raw.producto.trim() : '';
    if (!hasProductId && !productName) throw itemsError(400, 'Producto inválido');
    if (!Number.isSafeInteger(raw.cantidad) || raw.cantidad <= 0) {
      throw itemsError(400, 'Cantidad inválida');
    }
    if (typeof raw.precio_unitario !== 'number'
        || !Number.isFinite(raw.precio_unitario) || raw.precio_unitario < 0) {
      throw itemsError(400, 'Precio unitario inválido');
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

export async function resolveAndLockPedidoProducts(txQuery, { empresaId, requestedItems }) {
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
      if (!product) throw itemsError(400, 'Producto inválido para la empresa');
      return { ...item, productoId: Number(product.id), productName: product.nombre };
    }
    const matches = byName.get(item.normalizedName) || [];
    if (matches.length === 0) throw itemsError(400, 'Producto no encontrado');
    if (matches.length !== 1) throw itemsError(409, 'Nombre de producto ambiguo');
    return { ...item, productoId: Number(matches[0].id), productName: matches[0].nombre };
  });
}

export async function replacePedidoItems(txQuery, { pedidoId, empresaId, canonicalItems }) {
  await txQuery('DELETE FROM items_pedido WHERE pedido_id = $1', [pedidoId]);
  for (const item of canonicalItems) {
    const inserted = await txQuery(
      `INSERT INTO items_pedido
         (pedido_id, producto, producto_id, cantidad, precio_unitario)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [pedidoId, item.productName, item.productoId, item.cantidad, item.precioUnitario]
    );
    if (inserted.length !== 1) throw itemsError(409, 'No se pudo insertar el ítem del pedido');
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
    RETURNING id, empresa_id, punto_entrega_id, monto, estado`,
    [pedidoId, empresaId]
  );
  if (updated.length !== 1) throw itemsError(409, 'El pedido cambió durante la actualización');
  return updated[0];
}
