const WA_ID_PATTERN = /^\d{6,15}$/;

export function normalizeWhatsAppWaId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return WA_ID_PATTERN.test(normalized) ? normalized : null;
}
