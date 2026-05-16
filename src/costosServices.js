// costosServices.js (ESM)
import express from 'express';
import Database from 'better-sqlite3';

const db = new Database('data.db');

function rowsActiveBetween(rows, from, to) {
  const f = from ? new Date(from) : null;
  const t = to ? new Date(to) : null;
  const inRange = (dFrom, dTo) => {
    const a = dFrom ? new Date(dFrom) : null;
    const b = dTo ? new Date(dTo)   : null;
    if (f && b && b < f) return false;
    if (t && a && a > t) return false;
    return true;
  };
  return rows.filter(r => inRange(r.desde, r.hasta));
}

function prorrateFixed(row, from, to) {
  if (!from || !to) return Number(row.monto || 0);
  const f = new Date(from + 'T00:00:00');
  const t = new Date(to   + 'T23:59:59');

  const start = row.desde ? new Date(row.desde + 'T00:00:00') : null;
  const end   = row.hasta ? new Date(row.hasta + 'T23:59:59') : null;
  const effStart = start && start > f ? start : f;
  const effEnd   = end && end < t ? end : t;

  if (effEnd < effStart) return 0;

  const days = Math.floor((effEnd - effStart) / 86400000) + 1;
  const per = String(row.periodicidad || 'mensual').toLowerCase();
  const monto = Number(row.monto || 0);
  if (monto <= 0 || days <= 0) return 0;

  let perDays = 30;
  if (per === 'diaria') perDays = 1;
  else if (per === 'semanal') perDays = 7;
  else if (per === 'anual') perDays = 365;

  return (monto / perDays) * days;
}

export function createCostosRouter() {
  const router = express.Router();

  // ----- COSTOS FIJOS -----
  router.get('/costos/fijos', (req, res) => {
    const { empresa_id, from, to } = req.query;
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });
    const rows = db.prepare(`
      SELECT id, empresa_id, concepto, monto, periodicidad, desde, hasta, notas
      FROM empresa_costos_fijos
      WHERE empresa_id = ?
    `).all(empresa_id);
    const active = rowsActiveBetween(rows, from, to);
    const out = active.map(r => ({
      ...r,
      monto_prorrateado: prorrateFixed(r, from, to)
    }));
    res.json(out);
  });

  router.post('/costos/fijos', (req, res) => {
    const { empresa_id, concepto, monto, periodicidad, desde, hasta, notas } = req.body || {};
    if (!empresa_id || !concepto || !monto || !periodicidad || !desde) {
      return res.status(400).json({ error: 'empresa_id, concepto, monto, periodicidad, desde requeridos' });
    }
    const st = db.prepare(`
      INSERT INTO empresa_costos_fijos (empresa_id, concepto, monto, periodicidad, desde, hasta, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = st.run(empresa_id, concepto, Number(monto), String(periodicidad).toLowerCase(), desde, hasta || null, notas || null);
    res.json({ id: info.lastInsertRowid });
  });

  router.put('/costos/fijos/:id', (req, res) => {
    const id = req.params.id;
    const { concepto, monto, periodicidad, desde, hasta, notas } = req.body || {};
    const st = db.prepare(`
      UPDATE empresa_costos_fijos
      SET concepto = COALESCE(?, concepto),
          monto = COALESCE(?, monto),
          periodicidad = COALESCE(?, periodicidad),
          desde = COALESCE(?, desde),
          hasta = COALESCE(?, hasta),
          notas = COALESCE(?, notas)
      WHERE id = ?
    `);
    const info = st.run(concepto, monto, periodicidad, desde, hasta, notas, id);
    res.json({ changes: info.changes });
  });

  router.delete('/costos/fijos/:id', (req, res) => {
    const info = db.prepare(`DELETE FROM empresa_costos_fijos WHERE id = ?`).run(req.params.id);
    res.json({ changes: info.changes });
  });

  // ----- COSTOS VARIABLES POR PRODUCTO -----
  router.get('/productos/:id/costos_empresa', (req, res) => {
    const { empresa_id, fecha } = req.query;
    const pid = req.params.id;
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });
    const rows = db.prepare(`
      SELECT id, empresa_id, producto_id, concepto, costo_unitario, desde, hasta
      FROM empresa_productos_costos
      WHERE empresa_id = ? AND producto_id = ?
    `).all(empresa_id, pid);

    const xfecha = fecha ? new Date(fecha + 'T12:00:00') : null;
    const out = rows.filter(r => {
      if (!xfecha) return true;
      const a = r.desde ? new Date(r.desde + 'T00:00:00') : null;
      const b = r.hasta ? new Date(r.hasta + 'T23:59:59') : null;
      if (a && xfecha < a) return false;
      if (b && xfecha > b) return false;
      return true;
    });
    res.json(out);
  });

  router.post('/productos/:id/costos_empresa', (req, res) => {
    const pid = req.params.id;
    const { empresa_id, concepto, costo_unitario, desde, hasta } = req.body || {};
    if (!empresa_id || !concepto || !costo_unitario || !desde) {
      return res.status(400).json({ error: 'empresa_id, concepto, costo_unitario, desde requeridos' });
    }
    const st = db.prepare(`
      INSERT INTO empresa_productos_costos (empresa_id, producto_id, concepto, costo_unitario, desde, hasta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = st.run(empresa_id, pid, concepto, Number(costo_unitario), desde, hasta || null);
    res.json({ id: info.lastInsertRowid });
  });

  router.put('/productos/:id/costos_empresa/:cid', (req, res) => {
    const cid = req.params.cid;
    const { concepto, costo_unitario, desde, hasta } = req.body || {};
    const st = db.prepare(`
      UPDATE empresa_productos_costos
      SET concepto = COALESCE(?, concepto),
          costo_unitario = COALESCE(?, costo_unitario),
          desde = COALESCE(?, desde),
          hasta = COALESCE(?, hasta)
      WHERE id = ?
    `);
    const info = st.run(concepto, costo_unitario, desde, hasta, cid);
    res.json({ changes: info.changes });
  });

  router.delete('/productos/:id/costos_empresa/:cid', (req, res) => {
    const cid = req.params.cid;
    const info = db.prepare(`DELETE FROM empresa_productos_costos WHERE id = ?`).run(cid);
    res.json({ changes: info.changes });
  });

  return router;
}
