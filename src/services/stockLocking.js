// Protocolo canónico de serialización para todos los writers de chofer_stock/chofer_stock_mov.
// Orden global: referencia/idempotencia -> chofer -> producto -> depósitos -> saldos/movimientos.

function sortedPositiveIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(Number)
    .filter(value => Number.isSafeInteger(value) && value > 0))]
    .sort((a, b) => a - b);
}

function sortedReferences(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(value => String(value || '').trim())
    .filter(Boolean))]
    .sort();
}

export async function stockAdvisoryLock(query, empresaId, key) {
  const normalizedEmpresaId = Number(empresaId);
  if (!Number.isSafeInteger(normalizedEmpresaId) || normalizedEmpresaId <= 0) {
    throw new TypeError('empresaId inválido para lock de stock');
  }
  await query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked',
    [`stock:${normalizedEmpresaId}:${key}`]
  );
}

export async function lockStockContext(query, {
  empresaId,
  referencia = null,
  referencias = [],
  choferId = null,
  choferIds = [],
  productoId = null,
  productoIds = [],
  depositoIds = [],
} = {}) {
  const normalizedReferences = sortedReferences([referencia, ...referencias]);
  const normalizedChoferIds = sortedPositiveIds([choferId, ...choferIds]);
  const normalizedProductoIds = sortedPositiveIds([productoId, ...productoIds]);
  const normalizedDepositoIds = sortedPositiveIds(depositoIds);

  for (const value of normalizedReferences) {
    await stockAdvisoryLock(query, empresaId, `referencia:${value}`);
  }
  for (const value of normalizedChoferIds) {
    await stockAdvisoryLock(query, empresaId, `chofer:${value}`);
  }
  for (const value of normalizedProductoIds) {
    await stockAdvisoryLock(query, empresaId, `producto:${value}`);
  }
  for (const productId of normalizedProductoIds) {
    for (const depositoId of normalizedDepositoIds) {
      await stockAdvisoryLock(query, empresaId, `balance:${productId}:deposito:${depositoId}`);
    }
  }

  return {
    referencias: normalizedReferences,
    choferIds: normalizedChoferIds,
    productoIds: normalizedProductoIds,
    depositoIds: normalizedDepositoIds,
  };
}

export function normalizeStockResourceIds(values) {
  return sortedPositiveIds(values);
}
