export const PRODUCT_NAME_IDENTITY_SQL = 'LOWER(TRIM(nombre))';

export function normalizeProductIdentityName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function canonicalProductIdentityNames(names) {
  return Array.from(new Set(
    (Array.isArray(names) ? names : [])
      .map(normalizeProductIdentityName)
      .filter(Boolean)
  )).sort();
}

export async function lockProductIdentityNamespaces(query, { empresaId, names }) {
  if (typeof query !== 'function') throw new TypeError('query inválida para namespace de producto');
  if (!Number.isSafeInteger(empresaId) || empresaId <= 0 || empresaId > 2147483647) {
    throw new TypeError('empresaId inválido para namespace de producto');
  }
  const canonicalNames = canonicalProductIdentityNames(names);
  for (const canonicalName of canonicalNames) {
    await query(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
      [empresaId, canonicalName]
    );
  }
  return canonicalNames;
}

export function productIdentityConflict(message = 'Identidad de producto inválida', statusCode = 409) {
  const error = new Error(message);
  error.code = 'PRODUCT_IDENTITY_CONFLICT';
  error.statusCode = statusCode;
  return error;
}

export async function resolveProductIdentityItems(query, {
  empresaId,
  items,
  lockNamespaces = true,
  lockProducts = true,
  includePrice = false,
  includePromoConfig = false,
  requirePublicActive = false,
}) {
  if (typeof query !== 'function') throw new TypeError('query inválida para resolver productos');
  if (!Number.isSafeInteger(empresaId) || empresaId <= 0 || empresaId > 2147483647) {
    throw new TypeError('empresaId inválido para resolver productos');
  }

  const sourceItems = Array.isArray(items) ? items : [];
  const canonicalIds = [];
  const legacyNames = [];
  for (const item of sourceItems) {
    const productoId = item?.producto_id == null ? null : Number(item.producto_id);
    if (productoId != null) {
      if (!Number.isSafeInteger(productoId) || productoId <= 0) {
        throw productIdentityConflict('Producto canónico inválido', 400);
      }
      canonicalIds.push(productoId);
      continue;
    }
    const name = normalizeProductIdentityName(item?.producto);
    if (!name) throw productIdentityConflict('Producto legacy sin identidad');
    legacyNames.push(name);
  }

  const names = canonicalProductIdentityNames(legacyNames);
  if (lockNamespaces && names.length) {
    await lockProductIdentityNamespaces(query, { empresaId, names });
  }

  const ids = Array.from(new Set(canonicalIds)).sort((a, b) => a - b);
  const products = (ids.length || names.length)
    ? await query(
      `SELECT id, nombre${includePrice ? ', precio' : ''}${includePromoConfig ? ', promo_config' : ''}, config_activo, retornable
         FROM productos
        WHERE empresa_id = $1
          ${requirePublicActive ? 'AND deleted_at IS NULL AND COALESCE(activo, TRUE) IS TRUE' : ''}
          AND (
            id = ANY($2::int[])
            OR LOWER(TRIM(nombre)) = ANY($3::text[])
          )
        ORDER BY id
        ${lockProducts ? 'FOR SHARE' : ''}`,
      [empresaId, ids, names]
    )
    : [];

  const byId = new Map(products.map(product => [Number(product.id), product]));
  const byName = new Map();
  for (const product of products) {
    const name = normalizeProductIdentityName(product.nombre);
    const rows = byName.get(name) || [];
    rows.push(product);
    byName.set(name, rows);
  }

  return sourceItems.map(item => {
    if (item.producto_id != null) {
      const product = byId.get(Number(item.producto_id));
      if (!product) throw productIdentityConflict('Producto canónico inválido para la empresa', 400);
      return { ...item, producto_resuelto_id: Number(product.id), producto_resuelto: product };
    }
    const matches = byName.get(normalizeProductIdentityName(item.producto)) || [];
    if (matches.length !== 1) {
      throw productIdentityConflict(
        matches.length === 0 ? 'Producto legacy no encontrado' : 'Producto legacy ambiguo',
        matches.length === 0 ? 400 : 409
      );
    }
    return { ...item, producto_resuelto_id: Number(matches[0].id), producto_resuelto: matches[0] };
  });
}
