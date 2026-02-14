import { query as defaultQuery } from '../services.js';

export const toNum = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const inRange = (n, a, b) => Number.isFinite(n) && n >= a && n <= b;
export const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

export const normalizeText = (v) => {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

function formatMoneyARS0(n) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Math.round(Number(n || 0)));
  } catch {
    return '$' + String(Math.round(Number(n || 0))).replace('.', ',');
  }
}

export function buildOrderSummary(normItems) {
  const totalCantidad = normItems.reduce((acc, it) => acc + it.cantidad, 0);
  const totalMonto = normItems.reduce((acc, it) => acc + (it.cantidad * it.precio_unitario), 0);

  if (normItems.length === 1) {
    const it = normItems[0];
    const sub = it.cantidad * it.precio_unitario;
    return `${it.cantidad} × ${it.producto} — ${formatMoneyARS0(sub)}`;
  }

  return `${totalCantidad} artículos — ${formatMoneyARS0(totalMonto)}`;
}

export async function getAliasEmpresa(empresa_id, query = defaultQuery) {
  try {
    const rows = await query(
      `SELECT alias
       FROM empresa_cuentas_bancarias
       WHERE empresa_id = $1
       ORDER BY COALESCE(activa, false) DESC,
                COALESCE(prioridad, 999),
                id
       LIMIT 1`,
      [empresa_id]
    );

    if (rows.length && rows[0].alias) return String(rows[0].alias).trim();
  } catch {}

  try {
    const rows = await query(
      `SELECT alias
       FROM empresas
       WHERE id = $1
       LIMIT 1`,
      [empresa_id]
    );
    if (rows.length && rows[0].alias) return String(rows[0].alias).trim();
  } catch {}

  return null;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

export async function getLocationFromIp(req) {
  let pais = 'Argentina';
  let provincia = 'Córdoba';

  const ip = getClientIp(req);
  if (!ip || ip === '::1' || ip.startsWith('127.')) return { pais, provincia };

  try {
    const resp = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!resp.ok) return { pais, provincia };

    const data = await resp.json();
    if (data.country_name) pais = data.country_name;
    if (data.region) provincia = data.region;

    return { pais, provincia };
  } catch {
    return { pais, provincia };
  }
}
