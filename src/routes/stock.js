// src/routes/stock.js
import express from 'express';
import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken } from '../services.js';
import { query } from '../db.js';

export function createStockRouter() {
  const router = express.Router();

  const ensureDepositosSchemaPromise = (async () => {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS depositos (
          id SERIAL PRIMARY KEY,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          nombre TEXT NOT NULL,
          direccion TEXT,
          activo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (empresa_id, nombre)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_depositos_empresa_activo ON depositos (empresa_id, activo)`);
      await query(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS deposito_id INTEGER REFERENCES depositos(id) ON DELETE SET NULL`);
      await query(`CREATE INDEX IF NOT EXISTS idx_csm_deposito_id ON chofer_stock_mov (deposito_id)`);
      await query(`
        CREATE TABLE IF NOT EXISTS deposito_chofer (
          id SERIAL PRIMARY KEY,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE CASCADE,
          chofer_id INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
          activo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (empresa_id, deposito_id, chofer_id)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_deposito_chofer_chofer ON deposito_chofer (empresa_id, chofer_id, activo)`);
    } catch (e) {
      console.error('stock/depositos schema error:', e?.message || e);
    }
  })();

  async function choferPuedeUsarDeposito({ empresaId, choferId, depositoId }) {
    if (!empresaId || !choferId || !depositoId) return false;

    const depRows = await query(
      `SELECT id FROM depositos WHERE id = $1 AND empresa_id = $2 AND activo = TRUE LIMIT 1`,
      [depositoId, empresaId]
    );
    if (!depRows.length) return false;

    const cfgRows = await query(
      `SELECT COUNT(*)::int AS c
         FROM deposito_chofer
        WHERE empresa_id = $1
          AND chofer_id = $2
          AND activo = TRUE`,
      [empresaId, choferId]
    );
    const cfgCount = Number(cfgRows?.[0]?.c || 0);
    if (cfgCount === 0) return true; // compat: si no hay configuración, permitir todos.

    const okRows = await query(
      `SELECT 1
         FROM deposito_chofer
        WHERE empresa_id = $1
          AND chofer_id = $2
          AND deposito_id = $3
          AND activo = TRUE
        LIMIT 1`,
      [empresaId, choferId, depositoId]
    );
    return okRows.length > 0;
  }

  // GET /api/stock/depositos
  router.get('/depositos', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const includeInactivos = String(req.query?.include_inactivos || '') === '1';
      const role = String(req.user?.role || '').toLowerCase();
      const choferId = Number(req.user?.chofer_id || 0) || null;

      let rows = await query(
        `SELECT id, empresa_id, nombre, direccion, activo, created_at, updated_at
           FROM depositos
          WHERE empresa_id = $1
            AND ($2::boolean = TRUE OR activo = TRUE)
          ORDER BY activo DESC, nombre ASC`,
        [empresaId, includeInactivos]
      );

      if (role === 'repartidor' && choferId) {
        const cfgRows = await query(
          `SELECT deposito_id
             FROM deposito_chofer
            WHERE empresa_id = $1
              AND chofer_id = $2
              AND activo = TRUE`,
          [empresaId, choferId]
        );
        const allowed = new Set((cfgRows || []).map(r => Number(r.deposito_id)).filter(Boolean));
        if (allowed.size > 0) {
          rows = (rows || []).filter(r => allowed.has(Number(r.id)));
        }
      }
      return res.json(rows || []);
    } catch (e) {
      console.error('ERROR /api/stock/depositos', e);
      return res.status(500).json({ error: 'Error obteniendo depósitos' });
    }
  });

  // POST /api/stock/depositos
  router.post('/depositos', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromToken(req);
      const nombre = String(req.body?.nombre || '').trim();
      const direccion = req.body?.direccion ? String(req.body.direccion).trim() : null;

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

      const rows = await query(
        `INSERT INTO depositos (empresa_id, nombre, direccion, activo)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (empresa_id, nombre)
         DO UPDATE SET direccion = EXCLUDED.direccion, activo = TRUE, updated_at = NOW()
         RETURNING id, empresa_id, nombre, direccion, activo, created_at, updated_at`,
        [empresaId, nombre, direccion]
      );

      return res.json(rows?.[0] || { ok: true });
    } catch (e) {
      console.error('ERROR POST /api/stock/depositos', e);
      return res.status(500).json({ error: 'Error guardando depósito' });
    }
  });

  // PUT /api/stock/depositos/:id
  router.put('/depositos/:id', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromToken(req);
      const depositoId = Number(req.params.id || 0);
      const nombre = req.body?.nombre != null ? String(req.body.nombre).trim() : null;
      const direccion = req.body?.direccion != null ? String(req.body.direccion).trim() : null;
      const activo = req.body?.activo;

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!depositoId) return res.status(400).json({ error: 'id inválido' });

      const current = await query(
        `SELECT id, empresa_id, nombre, direccion, activo FROM depositos WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
        [depositoId, empresaId]
      );
      if (!current.length) return res.status(404).json({ error: 'Depósito no encontrado' });

      const targetNombre = nombre ?? current[0].nombre;
      const targetDireccion = direccion ?? current[0].direccion;
      const targetActivo = typeof activo === 'boolean' ? activo : current[0].activo;

      if (!String(targetNombre || '').trim()) return res.status(400).json({ error: 'Nombre requerido' });

      const rows = await query(
        `UPDATE depositos
            SET nombre = $1,
                direccion = $2,
                activo = $3,
                updated_at = NOW()
          WHERE id = $4
            AND empresa_id = $5
          RETURNING id, empresa_id, nombre, direccion, activo, created_at, updated_at`,
        [targetNombre, targetDireccion, targetActivo, depositoId, empresaId]
      );

      return res.json(rows?.[0] || { ok: true });
    } catch (e) {
      console.error('ERROR PUT /api/stock/depositos/:id', e);
      return res.status(500).json({ error: 'Error actualizando depósito' });
    }
  });

  // DELETE /api/stock/depositos/:id (soft-delete por compat)
  router.delete('/depositos/:id', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);
      const depositoId = Number(req.params.id || 0);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!depositoId) return res.status(400).json({ error: 'id inválido' });

      const rows = await query(
        `UPDATE depositos
            SET activo = FALSE,
                updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
          RETURNING id, empresa_id, nombre, direccion, activo, created_at, updated_at`,
        [depositoId, empresaId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Depósito no encontrado' });
      return res.json({ ok: true, deposito: rows[0] });
    } catch (e) {
      console.error('ERROR DELETE /api/stock/depositos/:id', e);
      return res.status(500).json({ error: 'Error desactivando depósito' });
    }
  });

  // GET /api/stock/depositos/summary
  router.get('/depositos/summary', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);
      const from = String(req.query?.from || '').slice(0, 10);
      const to = String(req.query?.to || '').slice(0, 10);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const params = [empresaId];
      let idx = 2;
      const where = ['csm.empresa_id = $1'];

      if (from) {
        where.push(`(csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $${idx++}::date`);
        params.push(from);
      }
      if (to) {
        where.push(`(csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $${idx++}::date`);
        params.push(to);
      }

      const rows = await query(
        `SELECT
           d.id AS deposito_id,
           d.nombre AS deposito_nombre,
           d.activo,
           csm.producto_id,
           p.nombre AS producto_nombre,
           COALESCE(SUM(CASE WHEN csm.cantidad > 0 THEN csm.cantidad ELSE 0 END), 0) AS total_ingresado,
           COALESCE(SUM(CASE WHEN csm.cantidad < 0 THEN ABS(csm.cantidad) ELSE 0 END), 0) AS total_egresado,
           COALESCE(SUM(csm.cantidad), 0) AS neto
         FROM chofer_stock_mov csm
         JOIN depositos d ON d.id = csm.deposito_id
         JOIN productos p ON p.id = csm.producto_id AND p.empresa_id = csm.empresa_id
         WHERE ${where.join(' AND ')}
         GROUP BY d.id, d.nombre, d.activo, csm.producto_id, p.nombre
         ORDER BY d.nombre ASC, p.nombre ASC`,
        params
      );

      return res.json(rows || []);
    } catch (e) {
      console.error('ERROR /api/stock/depositos/summary', e);
      return res.status(500).json({ error: 'Error resumen de depósitos' });
    }
  });

  // POST /api/stock/depositos/transferir
  router.post('/depositos/transferir', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromToken(req);

      const origenId = Number(req.body?.origen_deposito_id || 0);
      const destinoId = Number(req.body?.destino_deposito_id || 0);
      const productoId = Number(req.body?.producto_id || 0);
      const choferId = Number(req.body?.chofer_id || 0);
      const cantidad = Number(req.body?.cantidad || 0);
      const motivo = String(req.body?.motivo || 'Transferencia entre depósitos').trim();

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!origenId || !destinoId || origenId === destinoId) return res.status(400).json({ error: 'Depósitos origen/destino inválidos' });
      if (!productoId) return res.status(400).json({ error: 'producto_id requerido' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });
      if (!Number.isFinite(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'cantidad inválida' });

      const deps = await query(
        `SELECT id, nombre FROM depositos WHERE empresa_id = $1 AND activo = TRUE AND id = ANY($2::int[])`,
        [empresaId, [origenId, destinoId]]
      );
      if ((deps || []).length !== 2) return res.status(400).json({ error: 'Depósito origen o destino no válido para la empresa' });

      const canOrigen = await choferPuedeUsarDeposito({ empresaId, choferId, depositoId: origenId });
      const canDestino = await choferPuedeUsarDeposito({ empresaId, choferId, depositoId: destinoId });
      if (!canOrigen || !canDestino) {
        return res.status(403).json({ error: 'Chofer no habilitado para depósito origen/destino' });
      }

      const saldoRows = await query(
        `SELECT COALESCE(SUM(cantidad),0) AS saldo
           FROM chofer_stock_mov
          WHERE empresa_id = $1
            AND deposito_id = $2
            AND producto_id = $3`,
        [empresaId, origenId, productoId]
      );
      const saldoOrigen = Number(saldoRows?.[0]?.saldo || 0);
      if (saldoOrigen < cantidad) {
        return res.status(400).json({ error: `Saldo insuficiente en depósito origen (disponible: ${saldoOrigen})` });
      }

      const ref = `TRANSFER:${Date.now()}:${origenId}->${destinoId}`;

      await query(
        `INSERT INTO chofer_stock_mov
          (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
         VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_OUT', $5, $6, $7, NOW())`,
        [empresaId, choferId, productoId, origenId, -Math.abs(cantidad), motivo, ref]
      );
      await query(
        `INSERT INTO chofer_stock_mov
          (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
         VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_IN', $5, $6, $7, NOW())`,
        [empresaId, choferId, productoId, destinoId, Math.abs(cantidad), motivo, ref]
      );

      return res.json({ ok: true, referencia: ref });
    } catch (e) {
      console.error('ERROR /api/stock/depositos/transferir', e);
      return res.status(500).json({ error: 'Error transfiriendo stock entre depósitos' });
    }
  });

  // GET /api/stock/depositos/transferencias
  router.get('/depositos/transferencias', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const from = String(req.query?.from || '').slice(0, 10);
      const to = String(req.query?.to || '').slice(0, 10);
      const depositoId = Number(req.query?.deposito_id || 0) || null;
      const limit = Math.min(Math.max(Number(req.query?.limit || 100), 1), 500);

      const params = [empresaId];
      let idx = 2;
      const where = ["mout.empresa_id = $1"];

      if (from) {
        where.push(`(mout.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $${idx++}::date`);
        params.push(from);
      }
      if (to) {
        where.push(`(mout.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $${idx++}::date`);
        params.push(to);
      }
      if (depositoId) {
        where.push(`(mout.deposito_id = $${idx} OR min.deposito_id = $${idx})`);
        params.push(depositoId);
        idx += 1;
      }

      params.push(limit);
      const limitPos = `$${idx}`;

      const rows = await query(
        `SELECT
           mout.referencia,
           mout.fecha,
           mout.producto_id,
           p.nombre AS producto_nombre,
           ABS(mout.cantidad) AS cantidad,
           mout.chofer_id,
           c.nombre AS chofer_nombre,
           mout.motivo,
           mout.deposito_id AS origen_deposito_id,
           d1.nombre AS origen_deposito_nombre,
           min.deposito_id AS destino_deposito_id,
           d2.nombre AS destino_deposito_nombre,
           CASE
             WHEN EXISTS (
               SELECT 1
               FROM chofer_stock_mov rev
               WHERE rev.empresa_id = mout.empresa_id
                 AND rev.referencia = ('REVERSA:' || mout.referencia)
                 AND rev.tipo IN ('TRANSFER_REV_IN', 'TRANSFER_REV_OUT')
             ) THEN TRUE
             ELSE FALSE
           END AS revertida
         FROM chofer_stock_mov mout
         JOIN chofer_stock_mov min
           ON min.referencia = mout.referencia
          AND min.empresa_id = mout.empresa_id
          AND min.producto_id = mout.producto_id
          AND min.tipo = 'TRANSFER_IN'
         LEFT JOIN productos p ON p.id = mout.producto_id AND p.empresa_id = mout.empresa_id
         LEFT JOIN choferes c ON c.id = mout.chofer_id AND c.empresa_id = mout.empresa_id
         LEFT JOIN depositos d1 ON d1.id = mout.deposito_id
         LEFT JOIN depositos d2 ON d2.id = min.deposito_id
         WHERE mout.tipo = 'TRANSFER_OUT'
           AND ${where.join(' AND ')}
         ORDER BY mout.fecha DESC, mout.id DESC
         LIMIT ${limitPos}`,
        params
      );

      return res.json(rows || []);
    } catch (e) {
      console.error('ERROR /api/stock/depositos/transferencias', e);
      return res.status(500).json({ error: 'Error listando transferencias entre depósitos' });
    }
  });

  // POST /api/stock/depositos/transferencias/revertir
  router.post('/depositos/transferencias/revertir', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromToken(req);
      const referencia = String(req.body?.referencia || '').trim();
      const choferId = Number(req.body?.chofer_id || 0);
      const motivoExtra = String(req.body?.motivo || '').trim();

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!referencia) return res.status(400).json({ error: 'referencia requerida' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });

      const baseRef = referencia.startsWith('REVERSA:') ? referencia.slice('REVERSA:'.length) : referencia;

      const outRows = await query(
        `SELECT id, producto_id, deposito_id, ABS(cantidad) AS cantidad
           FROM chofer_stock_mov
          WHERE empresa_id = $1
            AND referencia = $2
            AND tipo = 'TRANSFER_OUT'
          LIMIT 1`,
        [empresaId, baseRef]
      );
      const inRows = await query(
        `SELECT id, producto_id, deposito_id, ABS(cantidad) AS cantidad
           FROM chofer_stock_mov
          WHERE empresa_id = $1
            AND referencia = $2
            AND tipo = 'TRANSFER_IN'
          LIMIT 1`,
        [empresaId, baseRef]
      );

      if (!outRows.length || !inRows.length) {
        return res.status(404).json({ error: 'Transferencia no encontrada' });
      }

      const out = outRows[0];
      const inn = inRows[0];
      if (Number(out.producto_id) !== Number(inn.producto_id)) {
        return res.status(400).json({ error: 'Transferencia inconsistente: producto distinto' });
      }
      if (Number(out.cantidad) !== Number(inn.cantidad)) {
        return res.status(400).json({ error: 'Transferencia inconsistente: cantidades distintas' });
      }

      const already = await query(
        `SELECT id
           FROM chofer_stock_mov
          WHERE empresa_id = $1
            AND referencia = $2
            AND tipo IN ('TRANSFER_REV_IN', 'TRANSFER_REV_OUT')
          LIMIT 1`,
        [empresaId, `REVERSA:${baseRef}`]
      );
      if (already.length) {
        return res.status(409).json({ error: 'La transferencia ya fue revertida' });
      }

      // Debe existir saldo en el depósito destino original para poder devolver
      const saldoDestinoRows = await query(
        `SELECT COALESCE(SUM(cantidad),0) AS saldo
           FROM chofer_stock_mov
          WHERE empresa_id = $1
            AND deposito_id = $2
            AND producto_id = $3`,
        [empresaId, inn.deposito_id, out.producto_id]
      );
      const saldoDestino = Number(saldoDestinoRows?.[0]?.saldo || 0);
      if (saldoDestino < Number(out.cantidad)) {
        return res.status(400).json({ error: `No se puede revertir: saldo insuficiente en depósito destino (disponible ${saldoDestino})` });
      }

      const canDestino = await choferPuedeUsarDeposito({ empresaId, choferId, depositoId: Number(inn.deposito_id) });
      const canOrigen = await choferPuedeUsarDeposito({ empresaId, choferId, depositoId: Number(out.deposito_id) });
      if (!canDestino || !canOrigen) {
        return res.status(403).json({ error: 'Chofer no habilitado para depósitos de la reversa' });
      }

      const refRev = `REVERSA:${baseRef}`;
      const motivo = [
        'Reversa transferencia',
        motivoExtra ? `- ${motivoExtra}` : ''
      ].filter(Boolean).join(' ');

      // Vuelve del destino al origen
      await query(
        `INSERT INTO chofer_stock_mov
          (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
         VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_REV_OUT', $5, $6, $7, NOW())`,
        [empresaId, choferId, out.producto_id, inn.deposito_id, -Math.abs(Number(out.cantidad)), motivo, refRev]
      );
      await query(
        `INSERT INTO chofer_stock_mov
          (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
         VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_REV_IN', $5, $6, $7, NOW())`,
        [empresaId, choferId, out.producto_id, out.deposito_id, Math.abs(Number(out.cantidad)), motivo, refRev]
      );

      return res.json({ ok: true, referencia: refRev });
    } catch (e) {
      console.error('ERROR /api/stock/depositos/transferencias/revertir', e);
      return res.status(500).json({ error: 'Error revirtiendo transferencia' });
    }
  });

  // GET /api/stock/depositos/choferes
  router.get('/depositos/choferes', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);
      const choferId = Number(req.query?.chofer_id || 0);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });

      const rows = await query(
        `SELECT dc.deposito_id, d.nombre AS deposito_nombre, dc.activo
           FROM deposito_chofer dc
           JOIN depositos d ON d.id = dc.deposito_id
          WHERE dc.empresa_id = $1
            AND dc.chofer_id = $2`,
        [empresaId, choferId]
      );

      return res.json(rows || []);
    } catch (e) {
      console.error('ERROR /api/stock/depositos/choferes', e);
      return res.status(500).json({ error: 'Error obteniendo permisos de depósitos por chofer' });
    }
  });

  // POST /api/stock/depositos/choferes (set reemplaza lista)
  router.post('/depositos/choferes', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromToken(req);
      const choferId = Number(req.body?.chofer_id || 0);
      const depositoIds = Array.isArray(req.body?.deposito_ids)
        ? req.body.deposito_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : [];

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });

      const validDeps = depositoIds.length
        ? await query(
          `SELECT id FROM depositos WHERE empresa_id = $1 AND activo = TRUE AND id = ANY($2::int[])`,
          [empresaId, depositoIds]
        )
        : [];
      const validSet = new Set((validDeps || []).map(r => Number(r.id)));
      const finalIds = depositoIds.filter(id => validSet.has(Number(id)));

      await query(
        `UPDATE deposito_chofer
            SET activo = FALSE,
                updated_at = NOW()
          WHERE empresa_id = $1
            AND chofer_id = $2`,
        [empresaId, choferId]
      );

      for (const depId of finalIds) {
        await query(
          `INSERT INTO deposito_chofer (empresa_id, deposito_id, chofer_id, activo)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (empresa_id, deposito_id, chofer_id)
           DO UPDATE SET activo = TRUE, updated_at = NOW()`,
          [empresaId, depId, choferId]
        );
      }

      return res.json({ ok: true, chofer_id: choferId, deposito_ids: finalIds });
    } catch (e) {
      console.error('ERROR POST /api/stock/depositos/choferes', e);
      return res.status(500).json({ error: 'Error guardando permisos de depósito por chofer' });
    }
  });

  // GET /api/stock/summary
  router.get('/summary', withAuth, async (req, res) => {
    try {
      const empresaId = isSuper(req) && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      const sql = `
        SELECT 
          p.id,
          p.nombre,
          p.stock_min,
          p.stock_max,
          COALESCE(SUM(cs.cantidad), 0) AS stock_fisico
        FROM productos p
        LEFT JOIN chofer_stock cs
          ON cs.producto_id = p.id
         AND cs.empresa_id  = p.empresa_id
        WHERE p.empresa_id = $1
        GROUP BY p.id, p.nombre, p.stock_min, p.stock_max
        ORDER BY p.nombre
      `;

      const rows = await query(sql, [empresaId]);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/summary', e);
      return res.status(500).json({ error: 'Error stock' });
    }
  });

  // POST /api/stock/ajuste
  router.post('/ajuste', withAuth, async (req, res) => {
    try {
      await ensureDepositosSchemaPromise;
      const { producto_id, qty, tipo, motivo, chofer_id, empresa_id, deposito_id } = req.body;

      const esSuperUser = isSuper(req);
      const targetEmpresa = (esSuperUser && empresa_id)
        ? Number(empresa_id)
        : getEmpresaIdFromToken(req);

      if (!targetEmpresa) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      if (!chofer_id) {
        return res.status(400).json({ error: 'Se requiere chofer para asignar el stock' });
      }

      const depositoId = Number(deposito_id || 0) || null;
      if (depositoId) {
        const allowed = await choferPuedeUsarDeposito({
          empresaId: targetEmpresa,
          choferId: Number(chofer_id),
          depositoId: depositoId,
        });
        if (!allowed) return res.status(403).json({ error: 'Chofer no habilitado para ese depósito' });
      }

      const cantidadNum = Number(qty);
      if (!Number.isFinite(cantidadNum) || cantidadNum <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

      const signo = tipo === 'ADJUST-' ? -1 : 1;
      const cantidadReal = Math.abs(cantidadNum) * signo;

      await query(
        `
        INSERT INTO chofer_stock_mov
          (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, created_at)
        VALUES
          ($1,        $2,        $3,          $4,         NOW(), 'ajuste', $5,      $6,    NOW())
        `,
        [targetEmpresa, chofer_id, producto_id, depositoId, cantidadReal, motivo || 'Ajuste manual']
      );

      await query(
        `
        INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (empresa_id, chofer_id, producto_id)
        DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
        `,
        [targetEmpresa, chofer_id, producto_id, cantidadReal]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR /api/stock/ajuste', e);
      return res.status(500).json({ error: 'Error ajuste stock' });
    }
  });

  // GET /api/stock/kardex/:id
  router.get('/kardex/:id', withAuth, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      const productoId = Number(req.params.id);

      const rows = await query(
        `
        SELECT csm.*, d.nombre AS deposito_nombre,
               COALESCE(csm.referencia, csm.motivo) as notas
        FROM chofer_stock_mov csm
        LEFT JOIN depositos d ON d.id = csm.deposito_id
        WHERE csm.producto_id = $1
          AND csm.empresa_id  = $2
        ORDER BY csm.created_at DESC
        LIMIT 50
        `,
        [productoId, empresaId]
      );

      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/kardex', e);
      return res.status(500).json({ error: 'Error kardex' });
    }
  });

  // GET /api/stock/por-tipo
  router.get('/por-tipo', withAuth, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      const productoId = req.query.producto_id ? Number(req.query.producto_id) : null;
      const tipo = (req.query.tipo || '').toLowerCase();

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      let sql = `
        SELECT
          p.id              AS producto_id,
          p.nombre,
          p.stock_min,
          p.stock_max,
          ch.tipo           AS tipo_chofer,
          COALESCE(SUM(cs.cantidad), 0) AS stock
        FROM productos p
        LEFT JOIN chofer_stock cs
               ON cs.producto_id = p.id
              AND cs.empresa_id  = p.empresa_id
        LEFT JOIN choferes ch
               ON ch.id = cs.chofer_id
        WHERE p.empresa_id = $1
      `;

      const params = [empresaId];
      let idx = 2;

      if (productoId) {
        sql += ` AND p.id = $${idx++}`;
        params.push(productoId);
      }

      if (tipo === 'propio' || tipo === 'fletero') {
        sql += ` AND ch.tipo = $${idx++}`;
        params.push(tipo);
      }

      sql += `
        GROUP BY
          p.id, p.nombre, p.stock_min, p.stock_max, ch.tipo
        ORDER BY
          p.nombre, ch.tipo
      `;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/por-tipo', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // GET /api/stock/movimientos-por-tipo
  router.get('/movimientos-por-tipo', withAuth, checkLicencia, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const { from, to, producto_id, tipo } = req.query || {};

      const dateFrom = from ? from.toString().slice(0, 10) : '2000-01-01';
      const dateTo   = to   ? to.toString().slice(0, 10)   : '2100-12-31';

      let sql = `
        WITH 
        entradas AS (
          SELECT 
              csm.chofer_id, 
              csm.producto_id, 
              SUM(csm.cantidad) as total_cargado
          FROM chofer_stock_mov csm
          WHERE csm.empresa_id = $1
            AND csm.cantidad > 0 
            AND csm.tipo <> 'venta'
            AND (csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date 
            AND (csm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
          GROUP BY 1, 2
        ),
        salidas_ventas AS (
          SELECT 
              p.chofer_id, 
              pr.id as producto_id, 
              SUM(ip.cantidad) as total_entregado
          FROM pedidos p
          JOIN items_pedido ip ON ip.pedido_id = p.id
          JOIN productos pr ON pr.nombre = ip.producto AND pr.empresa_id = p.empresa_id
          WHERE p.empresa_id = $1
            AND p.estado = 'entregado'
            AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date 
            AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
          GROUP BY 1, 2
        )

        SELECT
          p.id              AS producto_id,
          p.nombre,
          p.stock_min,
          p.stock_max,
          ch.tipo           AS tipo_chofer,
          COALESCE(e.total_cargado, 0)   AS cargado,
          COALESCE(s.total_entregado, 0) AS entregado,
          (COALESCE(e.total_cargado, 0) - COALESCE(s.total_entregado, 0)) AS neto
        
        FROM productos p
        CROSS JOIN choferes ch 
        LEFT JOIN entradas       e ON e.producto_id = p.id AND e.chofer_id = ch.id
        LEFT JOIN salidas_ventas s ON s.producto_id = p.id AND s.chofer_id = ch.id
        
        WHERE p.empresa_id = $1
          AND ch.empresa_id = $1
      `;

      const params = [empresaId, dateFrom, dateTo];
      let idx = 4;

      if (producto_id) {
        sql += ` AND p.id = $${idx++}`;
        params.push(Number(producto_id));
      }

      if (tipo && (tipo === 'propio' || tipo === 'fletero')) {
        sql += ` AND ch.tipo = $${idx++}`;
        params.push(tipo);
      }

      sql += `
        AND (COALESCE(e.total_cargado, 0) > 0 OR COALESCE(s.total_entregado, 0) > 0)
        ORDER BY p.nombre, ch.tipo
      `;

      const rows = await query(sql, params);
      return res.json(rows);

    } catch (e) {
      console.error('ERROR /api/stock/movimientos-por-tipo', e);
      return res.status(500).json({ error: 'Error calculando movimientos' });
    }
  });

  return router;
}
