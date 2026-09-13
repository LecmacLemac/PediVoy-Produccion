export function parseEnterpriseId(rawValue) {
  const raw = String(rawValue ?? '');
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new TypeError('EMPRESA_ID debe ser un entero seguro mayor que cero');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('EMPRESA_ID debe ser un entero seguro mayor que cero');
  }
  return value;
}
