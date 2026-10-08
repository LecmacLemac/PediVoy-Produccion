const PROACTIVE_TEMPLATE_KEYS = new Set([
  'order_confirmation',
  'order_en_route',
  'transfer_payment',
]);

export const MAX_PEDIDO_ID = 2_147_483_647;

const CANONICAL_PROACTIVE_CORRELATION = /^(order_confirmation|order_en_route|transfer_payment):([1-9][0-9]{0,9})$/;

export function parseProactiveNotificationCorrelationId(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return null;
  const match = CANONICAL_PROACTIVE_CORRELATION.exec(value);
  if (!match) return null;
  const pedidoId = Number(match[2]);
  if (!Number.isSafeInteger(pedidoId) || pedidoId > MAX_PEDIDO_ID) return null;
  return { templateKey: match[1], pedidoId, canonical: value };
}

export function buildProactiveNotificationCorrelationId(templateKey, pedidoId) {
  if (!PROACTIVE_TEMPLATE_KEYS.has(templateKey)) return null;
  if (typeof pedidoId !== 'number' && typeof pedidoId !== 'string') return null;
  const canonical = `${templateKey}:${pedidoId}`;
  const parsed = parseProactiveNotificationCorrelationId(canonical);
  return parsed?.templateKey === templateKey ? parsed.canonical : null;
}
