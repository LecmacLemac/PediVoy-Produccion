// src/routes/stock.js
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  withAuth as defaultWithAuth,
  checkLicencia as defaultCheckLicencia,
  isSuper as defaultIsSuper,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken
} from '../services.js';
import { query, pool as defaultPool, withTransaction as defaultWithTransaction } from '../db.js';
import { resolveProductIdentityItems } from '../services/productIdentityNamespace.js';
import { lockStockContext, stockAdvisoryLock } from '../services/stockLocking.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';

export function createStockRouter({
  query: queryFn = query,
  pool: dbPool = defaultPool,
  withAuth: withAuthFn = defaultWithAuth,
  checkLicencia: checkLicenciaFn = defaultCheckLicencia,
  isSuper: isSuperFn = defaultIsSuper,
  getEmpresaIdFromToken: getEmpresaIdFromTokenFn = defaultGetEmpresaIdFromToken,
  withTransaction: withTransactionFn = defaultWithTransaction,
} = {}) {
  const router = express.Router();
  const dbQuery = queryFn;
  const authMiddleware = withAuthFn;
  const licenciaMiddleware = checkLicenciaFn;
  const runTransaction = work => withTransactionFn(work, { pool: dbPool });

  let depositosSchemaReady = false;
  let depositosSchemaAttempt = null;
  async function ensureDepositosSchema() {
    if (depositosSchemaReady) return;
    if (!depositosSchemaAttempt) {
      depositosSchemaAttempt = (async () => {
        await dbQuery(`
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
        await dbQuery(`CREATE INDEX IF NOT EXISTS idx_depositos_empresa_activo ON depositos (empresa_id, activo)`);
        await dbQuery(`ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS deposito_id INTEGER REFERENCES depositos(id) ON DELETE SET NULL`);
        await dbQuery(`CREATE INDEX IF NOT EXISTS idx_csm_deposito_id ON chofer_stock_mov (deposito_id)`);
        await dbQuery(`
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
        await dbQuery(`CREATE INDEX IF NOT EXISTS idx_deposito_chofer_chofer ON deposito_chofer (empresa_id, chofer_id, activo)`);
        depositosSchemaReady = true;
      })();
    }
    const currentAttempt = depositosSchemaAttempt;
    try {
      await currentAttempt;
    } finally {
      if (depositosSchemaAttempt === currentAttempt) depositosSchemaAttempt = null;
    }
  }

  function stockError(res, error, fallback, status = 500) {
    if (error?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
      return res.status(503).json({
        error: 'Resultado de operación de stock indeterminado',
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
    }
    if (error?.code === 'STOCK_SCHEMA_UNAVAILABLE') {
      return res.status(503).json({
        error: 'Stock temporalmente no disponible',
        code: 'STOCK_SCHEMA_UNAVAILABLE',
      });
    }
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return res.status(status).json({ error: fallback });
  }

  async function requireStockSchema() {
    try {
      await ensureDepositosSchema();
    } catch {
      const error = new Error('Stock schema unavailable');
      error.code = 'STOCK_SCHEMA_UNAVAILABLE';
      throw error;
    }
  }

  function businessError(message, statusCode) {
    return Object.assign(new Error(message), { statusCode });
  }


  async function lockEmpresa(txQuery, empresaId) {
    const rows = await txQuery('SELECT id FROM empresas WHERE id = $1 FOR SHARE', [empresaId]);
    if (rows.length !== 1) throw businessError('Empresa inválida', 400);
  }

  async function lockChofer(txQuery, empresaId, choferId) {
    const rows = await txQuery(
      'SELECT id FROM choferes WHERE id = $1 AND empresa_id = $2 AND activo = TRUE FOR SHARE',
      [choferId, empresaId]
    );
    if (rows.length !== 1) throw businessError('Chofer inválido para la empresa', 400);
  }

  async function lockProducto(txQuery, empresaId, productoId) {
    const rows = await txQuery(
      `SELECT id FROM productos
        WHERE id = $1 AND empresa_id = $2 AND deleted_at IS NULL
          AND COALESCE(activo, TRUE) IS TRUE
        FOR SHARE`,
      [productoId, empresaId]
    );
    if (rows.length !== 1) throw businessError('Producto inválido para la empresa', 400);
  }

  async function lockDepositos(txQuery, empresaId, depositoIds, { activos = true } = {}) {
    const ids = [...new Set(depositoIds.map(Number))].sort((a, b) => a - b);
    const rows = await txQuery(
      `SELECT id, nombre, direccion, activo FROM depositos
        WHERE empresa_id = $1 AND id = ANY($2::int[])
          AND ($3::boolean = FALSE OR activo = TRUE)
        ORDER BY id
        FOR SHARE`,
      [empresaId, ids, activos]
    );
    if (rows.length !== ids.length) throw businessError('Depósito inválido para la empresa', 400);
    return rows;
  }

  async function choferPuedeUsarDeposito({ empresaId, choferId, depositoId, queryFn = dbQuery }) {
    if (!empresaId || !choferId || !depositoId) return false;
    const rows = await queryFn(
      `SELECT 1 FROM deposito_chofer
        WHERE empresa_id = $1 AND chofer_id = $2 AND deposito_id = $3 AND activo = TRUE
        LIMIT 1`,
      [empresaId, choferId, depositoId]
    );
    return rows.length === 1;
  }

  async function isDepositoPermisosEstricto(empresaId, queryFn = dbQuery) {
    const rows = await queryFn(
      `SELECT COALESCE((config_operativa->>'deposito_permisos_estricto')::boolean, FALSE) AS estricto
         FROM empresas WHERE id = $1 LIMIT 1`,
      [empresaId]
    );
    return !!rows?.[0]?.estricto;
  }

  // GET /api/stock/depositos
  router.get('/depositos', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const includeInactivos = String(req.query?.include_inactivos || '') === '1';
      const role = String(req.user?.role || '').toLowerCase();
      const choferId = Number(req.user?.chofer_id || 0) || null;

      let rows = await dbQuery(
        `SELECT id, empresa_id, nombre, direccion, activo, created_at, updated_at
           FROM depositos
          WHERE empresa_id = $1
            AND ($2::boolean = TRUE OR activo = TRUE)
          ORDER BY activo DESC, nombre ASC`,
        [empresaId, includeInactivos]
      );

      if (role === 'repartidor' && choferId) {
        const cfgRows = await dbQuery(
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
        } else {
          rows = [];
        }
      }
      return res.json(rows || []);
    } catch (e) {
      return stockError(res, e, 'Error obteniendo depósitos');
    }
  });

  // POST /api/stock/depositos
  router.post('/depositos', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const nombre = String(req.body?.nombre || '').trim();
      const direccion = req.body?.direccion ? String(req.body.direccion).trim() : null;

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

      const rows = await runTransaction(async txQuery => {
        await stockAdvisoryLock(txQuery, empresaId, `deposito-nombre:${nombre.toLocaleLowerCase('es')}`);
        await lockEmpresa(txQuery, empresaId);
        return txQuery(
          `INSERT INTO depositos (empresa_id, nombre, direccion, activo)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (empresa_id, nombre)
           DO UPDATE SET direccion = EXCLUDED.direccion, activo = TRUE, updated_at = NOW()
           RETURNING id, empresa_id, nombre, direccion, activo, created_at, updated_at`,
          [empresaId, nombre, direccion]
        );
      });

      return res.json(rows?.[0] || { ok: true });
    } catch (e) {
      return stockError(res, e, 'Error guardando depósito');
    }
  });

  // PUT /api/stock/depositos/permisos-config debe declararse antes de /depositos/:id.
  router.put('/depositos/permisos-config', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const estricto = !!req.body?.deposito_permisos_estricto;
      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      await runTransaction(async txQuery => {
        await stockAdvisoryLock(txQuery, empresaId, 'permisos-config');
        const rows = await txQuery(
          `UPDATE empresas
              SET config_operativa = COALESCE(config_operativa, '{}'::jsonb)
                || jsonb_build_object('deposito_permisos_estricto', $2::boolean)
            WHERE id = $1
            RETURNING id`,
          [empresaId, estricto]
        );
        if (rows.length !== 1) throw businessError('Empresa inválida', 400);
      });
      return res.json({ ok: true, deposito_permisos_estricto: estricto });
    } catch (e) {
      return stockError(res, e, 'Error guardando configuración de permisos');
    }
  });

  // PUT /api/stock/depositos/:id
  router.put('/depositos/:id', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const depositoId = Number(req.params.id || 0);
      const nombre = req.body?.nombre != null ? String(req.body.nombre).trim() : null;
      const direccion = req.body?.direccion != null ? String(req.body.direccion).trim() : null;
      const activo = req.body?.activo;

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!depositoId) return res.status(400).json({ error: 'id inválido' });

      const rows = await runTransaction(async txQuery => {
        await lockStockContext(txQuery, { empresaId, depositoIds: [depositoId] });
        await lockEmpresa(txQuery, empresaId);
        const current = await txQuery(
          `SELECT id, empresa_id, nombre, direccion, activo
             FROM depositos
            WHERE id = $1 AND empresa_id = $2
            FOR UPDATE`,
          [depositoId, empresaId]
        );
        if (!current.length) throw businessError('Depósito no encontrado', 404);

        const targetNombre = nombre ?? current[0].nombre;
        const targetDireccion = direccion ?? current[0].direccion;
        const targetActivo = typeof activo === 'boolean' ? activo : current[0].activo;
        if (!String(targetNombre || '').trim()) throw businessError('Nombre requerido', 400);

        return txQuery(
          `UPDATE depositos
              SET nombre = $1, direccion = $2, activo = $3, updated_at = NOW()
            WHERE id = $4 AND empresa_id = $5
            RETURNING id, empresa_id, nombre, direccion, activo, created_at, updated_at`,
          [targetNombre, targetDireccion, targetActivo, depositoId, empresaId]
        );
      });

      return res.json(rows[0]);
    } catch (e) {
      return stockError(res, e, 'Error actualizando depósito');
    }
  });

  // DELETE /api/stock/depositos/:id (soft-delete por compat)
  router.delete('/depositos/:id', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const depositoId = Number(req.params.id || 0);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!depositoId) return res.status(400).json({ error: 'id inválido' });

      const rows = await runTransaction(async txQuery => {
        await lockStockContext(txQuery, { empresaId, depositoIds: [depositoId] });
        await lockEmpresa(txQuery, empresaId);
        return txQuery(
          `UPDATE depositos
              SET activo = FALSE, updated_at = NOW()
            WHERE id = $1 AND empresa_id = $2
            RETURNING id, empresa_id, nombre, direccion, activo, created_at, updated_at`,
          [depositoId, empresaId]
        );
      });

      if (!rows.length) return res.status(404).json({ error: 'Depósito no encontrado' });
      return res.json({ ok: true, deposito: rows[0] });
    } catch (e) {
      return stockError(res, e, 'Error desactivando depósito');
    }
  });

  // GET /api/stock/depositos/summary
  router.get('/depositos/summary', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);
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

      const rows = await dbQuery(
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
      return stockError(res, e, 'Error resumen de depósitos');
    }
  });

  // POST /api/stock/depositos/transferir
  router.post('/depositos/transferir', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromTokenFn(req);

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

      const ref = `TRANSFER:${randomUUID()}:${origenId}->${destinoId}`;

      await runTransaction(async txQuery => {
        await lockStockContext(txQuery, {
          empresaId,
          referencia: ref,
          choferId,
          productoId,
          depositoIds: [origenId, destinoId],
        });
        await lockEmpresa(txQuery, empresaId);
        await lockChofer(txQuery, empresaId, choferId);
        await lockProducto(txQuery, empresaId, productoId);
        await lockDepositos(txQuery, empresaId, [origenId, destinoId]);

        const permisos = await txQuery(
          `SELECT deposito_id FROM deposito_chofer
            WHERE empresa_id = $1 AND chofer_id = $2
              AND deposito_id = ANY($3::int[]) AND activo = TRUE
            ORDER BY deposito_id
            FOR SHARE`,
          [empresaId, choferId, [origenId, destinoId]]
        );
        if (new Set(permisos.map(row => Number(row.deposito_id))).size !== 2) {
          throw businessError('Chofer no habilitado para depósito origen/destino', 403);
        }

        const saldoRows = await txQuery(
          `SELECT COALESCE(SUM(cantidad),0) AS saldo
             FROM chofer_stock_mov
            WHERE empresa_id = $1 AND deposito_id = $2 AND producto_id = $3`,
          [empresaId, origenId, productoId]
        );
        const saldoOrigen = Number(saldoRows?.[0]?.saldo || 0);
        if (saldoOrigen < cantidad) {
          throw businessError(`Saldo insuficiente en depósito origen (disponible: ${saldoOrigen})`, 400);
        }

        const outRows = await txQuery(
          `INSERT INTO chofer_stock_mov
            (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
           VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_OUT', $5, $6, $7, NOW())
           RETURNING id`,
          [empresaId, choferId, productoId, origenId, -Math.abs(cantidad), motivo, ref]
        );
        const inRows = await txQuery(
          `INSERT INTO chofer_stock_mov
            (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
           VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_IN', $5, $6, $7, NOW())
           RETURNING id`,
          [empresaId, choferId, productoId, destinoId, Math.abs(cantidad), motivo, ref]
        );
        if (outRows.length !== 1 || inRows.length !== 1) throw new Error('stock transfer write failed');
      });

      return res.json({ ok: true, referencia: ref });
    } catch (e) {
      return stockError(res, e, 'Error transfiriendo stock entre depósitos');
    }
  });

  // GET /api/stock/depositos/transferencias
  router.get('/depositos/transferencias', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const from = String(req.query?.from || '').slice(0, 10);
      const to = String(req.query?.to || '').slice(0, 10);
      const depositoId = Number(req.query?.deposito_id || 0) || null;
      const productoId = Number(req.query?.producto_id || 0) || null;
      const choferId = Number(req.query?.chofer_id || 0) || null;
      const limit = Math.min(Math.max(Number(req.query?.limit || 100), 1), 500);
      const offset = Math.max(Number(req.query?.offset || 0), 0);

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
      if (productoId) {
        where.push(`mout.producto_id = $${idx++}`);
        params.push(productoId);
      }
      if (choferId) {
        where.push(`mout.chofer_id = $${idx++}`);
        params.push(choferId);
      }

      params.push(limit);
      const limitPos = `$${idx++}`;
      params.push(offset);
      const offsetPos = `$${idx}`;

      const rows = await dbQuery(
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
         LIMIT ${limitPos}
         OFFSET ${offsetPos}`,
        params
      );

      res.setHeader('X-Page-Limit', String(limit));
      res.setHeader('X-Page-Offset', String(offset));
      res.setHeader('X-Page-Count', String((rows || []).length));
      return res.json(rows || []);
    } catch (e) {
      return stockError(res, e, 'Error listando transferencias entre depósitos');
    }
  });

  // POST /api/stock/depositos/transferencias/revertir
  router.post('/depositos/transferencias/revertir', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const referencia = String(req.body?.referencia || '').trim();
      const choferId = Number(req.body?.chofer_id || 0);
      const motivoExtra = String(req.body?.motivo || '').trim();

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!referencia) return res.status(400).json({ error: 'referencia requerida' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });
      const baseRef = referencia.startsWith('REVERSA:') ? referencia.slice('REVERSA:'.length) : referencia;
      if (!baseRef.startsWith('TRANSFER:') || baseRef.length > 200) {
        return res.status(400).json({ error: 'referencia inválida' });
      }

      const refRev = `REVERSA:${baseRef}`;
      await runTransaction(async txQuery => {
        await lockStockContext(txQuery, { empresaId, referencia: refRev });

        const already = await txQuery(
          `SELECT id FROM chofer_stock_mov
            WHERE empresa_id = $1 AND referencia = $2
              AND tipo IN ('TRANSFER_REV_IN', 'TRANSFER_REV_OUT')
            LIMIT 1`,
          [empresaId, refRev]
        );
        if (already.length) throw businessError('La transferencia ya fue revertida', 409);

        const probe = await txQuery(
          `SELECT id, tipo, producto_id, deposito_id, cantidad
             FROM chofer_stock_mov
            WHERE empresa_id = $1 AND referencia = $2
              AND tipo IN ('TRANSFER_OUT', 'TRANSFER_IN')
            ORDER BY id`,
          [empresaId, baseRef]
        );
        const probeOut = probe.filter(row => row.tipo === 'TRANSFER_OUT');
        const probeIn = probe.filter(row => row.tipo === 'TRANSFER_IN');
        if (probeOut.length !== 1 || probeIn.length !== 1) {
          throw businessError(probe.length ? 'Transferencia inconsistente' : 'Transferencia no encontrada', probe.length ? 409 : 404);
        }

        const productoId = Number(probeOut[0].producto_id);
        const depositoIds = [Number(probeOut[0].deposito_id), Number(probeIn[0].deposito_id)];
        await lockStockContext(txQuery, { empresaId, choferId, productoId, depositoIds });
        await lockEmpresa(txQuery, empresaId);
        await lockChofer(txQuery, empresaId, choferId);
        await lockProducto(txQuery, empresaId, productoId);
        await lockDepositos(txQuery, empresaId, depositoIds);

        const original = await txQuery(
          `SELECT id, tipo, producto_id, deposito_id, cantidad
             FROM chofer_stock_mov
            WHERE empresa_id = $1 AND referencia = $2
              AND tipo IN ('TRANSFER_OUT', 'TRANSFER_IN')
            ORDER BY id
            FOR UPDATE`,
          [empresaId, baseRef]
        );
        const outRows = original.filter(row => row.tipo === 'TRANSFER_OUT');
        const inRows = original.filter(row => row.tipo === 'TRANSFER_IN');
        if (outRows.length !== 1 || inRows.length !== 1) throw businessError('Transferencia inconsistente', 409);
        const out = outRows[0];
        const inn = inRows[0];
        const cantidad = Math.abs(Number(out.cantidad));
        if (Number(out.producto_id) !== Number(inn.producto_id)
          || Number(out.cantidad) >= 0
          || Number(inn.cantidad) <= 0
          || cantidad !== Math.abs(Number(inn.cantidad))) {
          throw businessError('Transferencia inconsistente', 409);
        }

        const permisos = await txQuery(
          `SELECT deposito_id FROM deposito_chofer
            WHERE empresa_id = $1 AND chofer_id = $2
              AND deposito_id = ANY($3::int[]) AND activo = TRUE
            ORDER BY deposito_id
            FOR SHARE`,
          [empresaId, choferId, depositoIds]
        );
        if (new Set(permisos.map(row => Number(row.deposito_id))).size !== 2) {
          throw businessError('Chofer no habilitado para depósitos de la reversa', 403);
        }

        const saldoDestinoRows = await txQuery(
          `SELECT COALESCE(SUM(cantidad),0) AS saldo
             FROM chofer_stock_mov
            WHERE empresa_id = $1 AND deposito_id = $2 AND producto_id = $3`,
          [empresaId, inn.deposito_id, productoId]
        );
        const saldoDestino = Number(saldoDestinoRows?.[0]?.saldo || 0);
        if (saldoDestino < cantidad) {
          throw businessError(`No se puede revertir: saldo insuficiente en depósito destino (disponible ${saldoDestino})`, 400);
        }

        const motivo = ['Reversa transferencia', motivoExtra ? `- ${motivoExtra}` : '']
          .filter(Boolean).join(' ');
        const revOut = await txQuery(
          `INSERT INTO chofer_stock_mov
            (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
           VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_REV_OUT', $5, $6, $7, NOW())
           RETURNING id`,
          [empresaId, choferId, productoId, inn.deposito_id, -cantidad, motivo, refRev]
        );
        const revIn = await txQuery(
          `INSERT INTO chofer_stock_mov
            (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, referencia, created_at)
           VALUES ($1, $2, $3, $4, NOW(), 'TRANSFER_REV_IN', $5, $6, $7, NOW())
           RETURNING id`,
          [empresaId, choferId, productoId, out.deposito_id, cantidad, motivo, refRev]
        );
        if (revOut.length !== 1 || revIn.length !== 1) throw new Error('stock reversal write failed');
      });

      return res.json({ ok: true, referencia: refRev });
    } catch (e) {
      return stockError(res, e, 'Error revirtiendo transferencia');
    }
  });

  // GET /api/stock/depositos/choferes
  router.get('/depositos/choferes', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const choferId = Number(req.query?.chofer_id || 0);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });
      const choferRows = await dbQuery(
        'SELECT id FROM choferes WHERE id = $1 AND empresa_id = $2 AND activo = TRUE LIMIT 1',
        [choferId, empresaId]
      );
      if (choferRows.length !== 1) {
        return res.status(400).json({ error: 'Chofer inválido para la empresa' });
      }

      const rows = await dbQuery(
        `SELECT dc.deposito_id, d.nombre AS deposito_nombre, dc.activo
           FROM deposito_chofer dc
           JOIN depositos d ON d.id = dc.deposito_id
          WHERE dc.empresa_id = $1
            AND dc.chofer_id = $2`,
        [empresaId, choferId]
      );

      return res.json(rows || []);
    } catch (e) {
      return stockError(res, e, 'Error obteniendo permisos de depósitos por chofer');
    }
  });

  // POST /api/stock/depositos/choferes (set reemplaza lista)
  router.post('/depositos/choferes', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.body?.empresa_id
        ? Number(req.body.empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const choferId = Number(req.body?.chofer_id || 0);
      const depositoIds = Array.isArray(req.body?.deposito_ids)
        ? req.body.deposito_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : [];

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      if (!choferId) return res.status(400).json({ error: 'chofer_id requerido' });
      const finalIds = [...new Set(depositoIds)].sort((a, b) => a - b);
      if (finalIds.length === 0) {
        return res.status(400).json({ error: 'Se requiere al menos un depósito habilitado' });
      }

      await runTransaction(async txQuery => {
        await lockStockContext(txQuery, { empresaId, choferId, depositoIds: finalIds });
        await lockEmpresa(txQuery, empresaId);
        await lockChofer(txQuery, empresaId, choferId);
        await lockDepositos(txQuery, empresaId, finalIds);

        await txQuery(
          `UPDATE deposito_chofer
              SET activo = FALSE, updated_at = NOW()
            WHERE empresa_id = $1 AND chofer_id = $2`,
          [empresaId, choferId]
        );
        for (const depId of finalIds) {
          await txQuery(
            `INSERT INTO deposito_chofer (empresa_id, deposito_id, chofer_id, activo)
             VALUES ($1, $2, $3, TRUE)
             ON CONFLICT (empresa_id, deposito_id, chofer_id)
             DO UPDATE SET activo = TRUE, updated_at = NOW()`,
            [empresaId, depId, choferId]
          );
        }
      });

      return res.json({ ok: true, chofer_id: choferId, deposito_ids: finalIds });
    } catch (e) {
      return stockError(res, e, 'Error guardando permisos de depósito por chofer');
    }
  });

  // GET /api/stock/depositos/permisos-config
  router.get('/depositos/permisos-config', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });
      const estricto = await isDepositoPermisosEstricto(empresaId);
      return res.json({ deposito_permisos_estricto: estricto });
    } catch (e) {
      return stockError(res, e, 'Error obteniendo configuración de permisos');
    }
  });

  // GET /api/stock/depositos/choferes-sin-permisos
  router.get('/depositos/choferes-sin-permisos', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const strict = await isDepositoPermisosEstricto(empresaId);
      if (!strict) return res.json({ strict: false, items: [] });

      const rows = await dbQuery(
        `SELECT c.id AS chofer_id, c.nombre AS chofer_nombre
           FROM choferes c
          WHERE c.empresa_id = $1
            AND NOT EXISTS (
              SELECT 1
              FROM deposito_chofer dc
              WHERE dc.empresa_id = c.empresa_id
                AND dc.chofer_id = c.id
                AND dc.activo = TRUE
            )
          ORDER BY c.nombre ASC`,
        [empresaId]
      );

      return res.json({ strict: true, items: rows || [] });
    } catch (e) {
      return stockError(res, e, 'Error obteniendo choferes sin permisos de depósito');
    }
  });

  // GET /api/stock/depositos/transferencias/export.csv
  router.get('/depositos/transferencias/export.csv', authMiddleware, async (req, res) => {
    try {
      await requireStockSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query?.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!empresaId) return res.status(400).json({ error: 'empresa_id requerido' });

      const from = String(req.query?.from || '').slice(0, 10);
      const to = String(req.query?.to || '').slice(0, 10);
      const depositoId = Number(req.query?.deposito_id || 0) || null;
      const productoId = Number(req.query?.producto_id || 0) || null;
      const choferId = Number(req.query?.chofer_id || 0) || null;

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
      if (productoId) {
        where.push(`mout.producto_id = $${idx++}`);
        params.push(productoId);
      }
      if (choferId) {
        where.push(`mout.chofer_id = $${idx++}`);
        params.push(choferId);
      }

      const rows = await dbQuery(
        `SELECT
           mout.referencia,
           mout.fecha,
           p.nombre AS producto_nombre,
           ABS(mout.cantidad) AS cantidad,
           c.nombre AS chofer_nombre,
           mout.motivo,
           d1.nombre AS origen_deposito_nombre,
           d2.nombre AS destino_deposito_nombre,
           CASE
             WHEN EXISTS (
               SELECT 1
               FROM chofer_stock_mov rev
               WHERE rev.empresa_id = mout.empresa_id
                 AND rev.referencia = ('REVERSA:' || mout.referencia)
                 AND rev.tipo IN ('TRANSFER_REV_IN', 'TRANSFER_REV_OUT')
             ) THEN 'revertida'
             ELSE 'activa'
           END AS estado
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
         ORDER BY mout.fecha DESC, mout.id DESC`,
        params
      );

      const headers = ['referencia', 'fecha', 'producto', 'cantidad', 'chofer', 'origen', 'destino', 'estado', 'motivo'];
      const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const csv = [headers.map(csvCell).join(',')]
        .concat((rows || []).map((r) => [
          r.referencia,
          r.fecha,
          r.producto_nombre,
          r.cantidad,
          r.chofer_nombre,
          r.origen_deposito_nombre,
          r.destino_deposito_nombre,
          r.estado,
          r.motivo,
        ].map(csvCell).join(',')))
        .join('\n');

      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transferencias-depositos-${stamp}.csv"`);
      return res.status(200).send(csv);
    } catch (e) {
      return stockError(res, e, 'Error exportando transferencias de depósitos');
    }
  });

  // GET /api/stock/summary
  router.get('/summary', authMiddleware, async (req, res) => {
    try {
      const empresaId = isSuperFn(req) && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

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

      const rows = await dbQuery(sql, [empresaId]);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/summary', e);
      return res.status(500).json({ error: 'Error stock' });
    }
  });

  // POST /api/stock/ajuste
  router.post('/ajuste', authMiddleware, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await requireStockSchema();
      const { producto_id, qty, tipo, motivo, chofer_id, empresa_id, deposito_id } = req.body;

      const esSuperUser = isSuperFn(req);
      const targetEmpresa = (esSuperUser && empresa_id)
        ? Number(empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!targetEmpresa) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      if (!chofer_id) {
        return res.status(400).json({ error: 'Se requiere chofer para asignar el stock' });
      }
      const depositoId = Number(deposito_id || 0) || null;
      const cantidadNum = Number(qty);
      if (!Number.isFinite(cantidadNum) || cantidadNum <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

      const choferId = Number(chofer_id);
      const productoId = Number(producto_id);
      const signo = tipo === 'ADJUST-' ? -1 : 1;
      const cantidadReal = Math.abs(cantidadNum) * signo;

      await runTransaction(async txQuery => {
        await lockStockContext(txQuery, {
          empresaId: targetEmpresa,
          choferId,
          productoId,
          depositoIds: depositoId ? [depositoId] : [],
        });
        await lockEmpresa(txQuery, targetEmpresa);
        await lockChofer(txQuery, targetEmpresa, choferId);
        await lockProducto(txQuery, targetEmpresa, productoId);
        if (depositoId) {
          await lockDepositos(txQuery, targetEmpresa, [depositoId]);
          const allowed = await choferPuedeUsarDeposito({
            empresaId: targetEmpresa,
            choferId,
            depositoId,
            queryFn: txQuery,
          });
          if (!allowed) throw businessError('Chofer no habilitado para ese depósito', 403);
        } else if (await isDepositoPermisosEstricto(targetEmpresa, txQuery)) {
          throw businessError('Depósito requerido por modo estricto', 400);
        }

        const stockRows = await txQuery(
          `INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (empresa_id, chofer_id, producto_id)
           DO UPDATE SET cantidad = chofer_stock.cantidad + EXCLUDED.cantidad
           RETURNING empresa_id, chofer_id, producto_id`,
          [targetEmpresa, choferId, productoId, cantidadReal]
        );
        const movementRows = await txQuery(
          `INSERT INTO chofer_stock_mov
            (empresa_id, chofer_id, producto_id, deposito_id, fecha, tipo, cantidad, motivo, created_at)
           VALUES ($1, $2, $3, $4, NOW(), 'ajuste', $5, $6, NOW())
           RETURNING id`,
          [targetEmpresa, choferId, productoId, depositoId, cantidadReal, motivo || 'Ajuste manual']
        );
        if (stockRows.length !== 1 || movementRows.length !== 1) throw new Error('stock adjustment write failed');
      });

      return res.json({ ok: true });
    } catch (e) {
      return stockError(res, e, 'Error ajuste stock');
    }
  });

  // GET /api/stock/kardex/:id
  router.get('/kardex/:id', authMiddleware, async (req, res) => {
    try {
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      if (!empresaId) {
        return res.status(400).json({ error: 'empresa_id requerido' });
      }

      const productoId = Number(req.params.id);

      const rows = await dbQuery(
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
  router.get('/por-tipo', authMiddleware, async (req, res) => {
    try {
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

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

      const rows = await dbQuery(sql, params);
      return res.json(rows);
    } catch (e) {
      console.error('ERROR /api/stock/por-tipo', e);
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // GET /api/stock/movimientos-por-tipo
  router.get('/movimientos-por-tipo', authMiddleware, licenciaMiddleware, async (req, res) => {
    try {
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

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
          LEFT JOIN LATERAL (
            SELECT CASE WHEN COUNT(*) = 1 THEN MIN(px.id) END AS id
              FROM productos px
             WHERE ip.producto_id IS NULL
               AND px.empresa_id = p.empresa_id
               AND LOWER(TRIM(px.nombre)) = LOWER(TRIM(ip.producto))
          ) legacy ON TRUE
          JOIN productos pr
            ON pr.empresa_id = p.empresa_id
           AND pr.id = CASE WHEN ip.producto_id IS NOT NULL THEN ip.producto_id ELSE legacy.id END
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

      const rows = await runTransaction(async txQuery => {
        const identityItems = await txQuery(
          `SELECT ip.id, ip.producto_id, ip.producto
             FROM pedidos p
             JOIN items_pedido ip ON ip.pedido_id = p.id
            WHERE p.empresa_id = $1
              AND p.estado = 'entregado'
              AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $2::date
              AND (COALESCE(p.fecha_entrega, p.fecha) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $3::date
            ORDER BY ip.id`,
          [empresaId, dateFrom, dateTo]
        );
        await resolveProductIdentityItems(txQuery, { empresaId, items: identityItems });
        return txQuery(sql, params);
      });
      return res.json(rows);

    } catch (e) {
      if (e?.code === 'PRODUCT_IDENTITY_CONFLICT') {
        return res.status(409).json({ error: e.message, code: e.code });
      }
      console.error('ERROR /api/stock/movimientos-por-tipo', e);
      return res.status(500).json({ error: 'Error calculando movimientos' });
    }
  });

  return router;
}
