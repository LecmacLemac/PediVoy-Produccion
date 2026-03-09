#!/usr/bin/env node
import { query } from '../src/db.js';

function toNum(v) { return Number(v || 0); }

async function count(sql, params = []) {
  const rows = await query(sql, params);
  return toNum(rows?.[0]?.c);
}

async function run() {
  const empresaId = Number(process.argv[2] || 0) || null;
  const p = [];
  let i = 1;
  const scope = empresaId ? ` AND empresa_id = $${i++}` : '';
  if (empresaId) p.push(empresaId);

  const incidencias = await count(`SELECT COUNT(*)::int AS c FROM incidencias_operativas WHERE 1=1${scope}`, p);
  const tesoreria = await count(`SELECT COUNT(*)::int AS c FROM tesoreria_movimientos WHERE 1=1${scope}`, p);
  const compras = await count(`SELECT COUNT(*)::int AS c FROM compras_ordenes WHERE 1=1${scope}`, p);
  const crm = await count(`SELECT COUNT(*)::int AS c FROM crm_oportunidades WHERE 1=1${scope}`, p);

  const alerts = [];
  if (incidencias === 0) alerts.push('Sin datos de incidencias_operativas');
  if (tesoreria === 0) alerts.push('Sin datos de tesoreria_movimientos');
  if (compras === 0) alerts.push('Sin datos de compras_ordenes');
  if (crm === 0) alerts.push('Sin datos de crm_oportunidades');

  const out = {
    ok: alerts.length === 0,
    empresa_id: empresaId,
    metrics: { incidencias, tesoreria, compras, crm },
    alerts,
    generated_at: new Date().toISOString(),
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 2);
}

run().catch((e) => {
  console.error('[ops-data-health] error:', e?.message || e);
  process.exit(1);
});
