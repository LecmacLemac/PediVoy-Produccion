export function normalizePhone(input, defaultPrefix = '+54') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('phone requerido');

  if (raw.startsWith('+')) return raw;

  const digits = raw.replace(/\D+/g, '');
  if (!digits) throw new Error('phone inválido');

  if (digits.startsWith('54')) return `+${digits}`;
  return `${defaultPrefix}${digits}`;
}
