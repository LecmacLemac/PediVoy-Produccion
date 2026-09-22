export function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

export function normalizePhone(s) {
  return digitsOnly(s).slice(-10);
}

function stripArgentinaMobileTrunk(digits) {
  for (const areaLen of [2, 3, 4]) {
    if (digits.length === 12 && digits.slice(areaLen, areaLen + 2) === '15') {
      return digits.slice(0, areaLen) + digits.slice(areaLen + 2);
    }
  }
  return digits;
}

export function normalizeWhatsappPhone(value) {
  let phone = digitsOnly(value);
  if (!phone) return '';

  if (phone.startsWith('00')) phone = phone.slice(2);

  if (phone.startsWith('54')) {
    let national = phone.slice(2);
    if (national.startsWith('9')) national = national.slice(1);
    national = national.replace(/^0+/, '');
    national = stripArgentinaMobileTrunk(national);
    return national.length === 10 ? `549${national}` : phone;
  }

  phone = phone.replace(/^0+/, '');
  if (phone.length === 11 && phone.startsWith('9')) phone = phone.slice(1);
  phone = stripArgentinaMobileTrunk(phone);

  if (phone.length === 10) return `549${phone}`;
  return phone;
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
