export function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

export function normalizePhone(s) {
  return digitsOnly(s).slice(-10);
}

export function moneyARS0(n) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(Math.round(Number(n || 0)));
  } catch {
    return '$' + String(Math.round(Number(n || 0)));
  }
}
