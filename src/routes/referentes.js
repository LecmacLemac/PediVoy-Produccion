import express from 'express';
import bcrypt from 'bcryptjs';

import { normalizeReferenteCode } from '../services/referentesService.js';
import { createComisionLiquidadaNotifications } from '../services/referenteNotifications.js';
import { lockProductIdentityNamespaces } from '../services/productIdentityNamespace.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import {
  deliveryPointConflict,
  deliveryPointIdentity,
  findDeliveryPointsByIdentity,
  lockDeliveryPointIdentities,
} from '../services/deliveryPointIdentity.js';

let referentesAccessSchemaReady = false;
let referentesLiquidacionesSchemaReady = false;
let referentesProfileSchemaReady = false;
let referentesClientesPropuestosSchemaReady = false;
let referentesClienteVinculosSchemaReady = false;

function cleanText(value, max = 280) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

export function createReferentesRouter(deps) {
  const { query, withTransaction, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createReferentesRouter: falta query(fn)');
  const runTransaction = typeof withTransaction === 'function' ? withTransaction : async work => work(query);
  if (typeof withAuth !== 'function') throw new Error('createReferentesRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createReferentesRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createReferentesRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  async function ensureReferenteAccessSchema() {
    if (referentesAccessSchemaReady) return;
    await query(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS referente_id INTEGER REFERENCES referentes(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
    `);
    referentesAccessSchemaReady = true;
  }

  async function ensureReferenteProfileSchema() {
    if (referentesProfileSchemaReady) return;
    await query(`
      ALTER TABLE referentes
        ADD COLUMN IF NOT EXISTS direccion TEXT
    `);
    referentesProfileSchemaReady = true;
  }

  async function ensureReferenteLiquidacionesSchema() {
    if (referentesLiquidacionesSchemaReady) return;
    await query(`
      CREATE TABLE IF NOT EXISTS referente_liquidaciones (
        id                    SERIAL PRIMARY KEY,
        empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        referencia             TEXT,
        nota                   TEXT,
        comisiones_count       INTEGER NOT NULL DEFAULT 0,
        total                  NUMERIC(12,2) NOT NULL DEFAULT 0,
        liquidada_por          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS referente_liquidaciones_empresa_created_idx
        ON referente_liquidaciones (empresa_id, created_at DESC)
    `);
    await query(`
      ALTER TABLE referente_comisiones
        ADD COLUMN IF NOT EXISTS liquidacion_referencia TEXT,
        ADD COLUMN IF NOT EXISTS liquidacion_nota TEXT,
        ADD COLUMN IF NOT EXISTS liquidada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS liquidacion_lote_id INTEGER REFERENCES referente_liquidaciones(id) ON DELETE SET NULL
    `);
    referentesLiquidacionesSchemaReady = true;
  }

  async function ensureReferenteClientesPropuestosSchema() {
    if (referentesClientesPropuestosSchemaReady) return;
    await query(`
      CREATE TABLE IF NOT EXISTS referente_clientes_propuestos (
        id                    SERIAL PRIMARY KEY,
        empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
        cliente                TEXT NOT NULL,
        telefono               TEXT,
        direccion              TEXT,
        ciudad                 TEXT,
        provincia              TEXT,
        pais                   TEXT,
        email                  TEXT,
        notas                  TEXT,
        estado                 TEXT NOT NULL DEFAULT 'pendiente',
        punto_entrega_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
        reviewed_at            TIMESTAMPTZ,
        reviewed_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        rechazo_motivo         TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_empresa_estado_idx
        ON referente_clientes_propuestos (empresa_id, estado, created_at DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_referente_idx
        ON referente_clientes_propuestos (empresa_id, referente_id, estado)
    `);
    referentesClientesPropuestosSchemaReady = true;
  }

  async function ensureReferenteClienteVinculosSchema() {
    if (referentesClienteVinculosSchemaReady) return;
    await query(`
      ALTER TABLE cliente_referentes
        ADD COLUMN IF NOT EXISTS desvinculado_motivo TEXT
    `);
    referentesClienteVinculosSchemaReady = true;
  }

  function resolveEmpresa(req, source = req.query || {}) {
    const superAdmin = isSuper(req);
    const empresaId = superAdmin && source?.empresa_id
      ? Number(source.empresa_id)
      : Number(getEmpresaIdFromToken(req));
    return Number.isFinite(empresaId) && empresaId > 0 ? empresaId : null;
  }

  function parsePercent(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }

  function isPositivePgInteger(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  }

  function parsePathPgInteger(value) {
    if (!/^\d+$/.test(String(value || ''))) return null;
    const parsed = Number(value);
    return isPositivePgInteger(parsed) ? parsed : null;
  }

  function resolveMutationEmpresa(req, source = {}) {
    if (isSuper(req)) {
      return isPositivePgInteger(source?.empresa_id) ? source.empresa_id : null;
    }
    const tokenEmpresa = Number(getEmpresaIdFromToken(req));
    return isPositivePgInteger(tokenEmpresa) ? tokenEmpresa : null;
  }

  function referenteMutationError(statusCode, message, code) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (code) error.code = code;
    return error;
  }

  function normalizeOptionalDate(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      ? value
      : false;
  }

  router.get('/resumen', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteLiquidacionesSchema();
      await ensureReferenteClientesPropuestosSchema();
      await ensureReferenteClienteVinculosSchema();
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const [summary] = await query(
        `SELECT
           COALESCE((SELECT COUNT(*)::int
                       FROM referentes
                      WHERE empresa_id = $1
                        AND deleted_at IS NULL
                        AND activo = TRUE), 0) AS referentes_activos,
           COALESCE((SELECT COUNT(*)::int
                       FROM referentes
                      WHERE empresa_id = $1
                        AND deleted_at IS NULL
                        AND activo = FALSE), 0) AS referentes_inactivos,
           COALESCE((SELECT COUNT(*)::int
                       FROM referentes r
                      WHERE r.empresa_id = $1
                        AND r.deleted_at IS NULL
                        AND r.activo = TRUE
                        AND NOT EXISTS (
                          SELECT 1
                            FROM usuarios u
                           WHERE u.empresa_id = r.empresa_id
                             AND u.referente_id = r.id
                             AND LOWER(u.role) = 'referente'
                             AND COALESCE(u.activo, TRUE) = TRUE
                        )), 0) AS referentes_sin_acceso,
           COALESCE((SELECT COUNT(*)::int
                       FROM cliente_referentes
                      WHERE empresa_id = $1
                        AND estado = 'activo'), 0) AS clientes_vinculados,
           COALESCE((SELECT COUNT(*)::int
                       FROM referente_clientes_propuestos
                      WHERE empresa_id = $1
                        AND estado = 'pendiente'), 0) AS clientes_pendientes,
           COALESCE((SELECT COUNT(*)::int
                       FROM referente_comisiones
                      WHERE empresa_id = $1
                        AND estado = 'validada'), 0) AS comisiones_pendientes_count,
           COALESCE((SELECT SUM(monto_comision)
                       FROM referente_comisiones
                      WHERE empresa_id = $1
                        AND estado = 'validada'), 0)::numeric AS comisiones_pendientes_total,
           COALESCE((SELECT COUNT(*)::int
                       FROM referente_comisiones
                      WHERE empresa_id = $1
                        AND estado = 'liquidada'
                        AND liquidada_at >= date_trunc('month', NOW())), 0) AS comisiones_liquidadas_mes_count,
           COALESCE((SELECT SUM(monto_comision)
                       FROM referente_comisiones
                      WHERE empresa_id = $1
                        AND estado = 'liquidada'
                        AND liquidada_at >= date_trunc('month', NOW())), 0)::numeric AS comisiones_liquidadas_mes_total`,
        [empresaId]
      );

      const liquidaciones = await query(
        `SELECT rl.id,
                rl.created_at AS liquidada_at,
                rl.comisiones_count,
                rl.total,
                rl.referencia AS liquidacion_referencia,
                rl.nota AS liquidacion_nota,
                u.username AS liquidada_por_username
           FROM referente_liquidaciones rl
           LEFT JOIN usuarios u ON u.id = rl.liquidada_por
          WHERE rl.empresa_id = $1
          ORDER BY rl.created_at DESC, rl.id DESC
          LIMIT 8`,
        [empresaId]
      );

      return res.json({ resumen: summary || {}, liquidaciones });
    } catch (e) {
      console.error('REFERENTES.RESUMEN.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo resumen de referentes' });
    }
  });

  router.get('/liquidaciones/:id', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteLiquidacionesSchema();
      const empresaId = resolveEmpresa(req);
      const loteId = Number(req.params.id);
      if (!empresaId || !Number.isInteger(loteId) || loteId <= 0) {
        return res.status(400).json({ error: 'Datos invalidos.' });
      }

      const lotes = await query(
        `SELECT rl.id,
                rl.created_at AS liquidada_at,
                rl.comisiones_count,
                rl.total,
                rl.referencia AS liquidacion_referencia,
                rl.nota AS liquidacion_nota,
                u.username AS liquidada_por_username
           FROM referente_liquidaciones rl
           LEFT JOIN usuarios u ON u.id = rl.liquidada_por
          WHERE rl.empresa_id = $1
            AND rl.id = $2
          LIMIT 1`,
        [empresaId, loteId]
      );
      if (!lotes.length) return res.status(404).json({ error: 'Liquidacion no encontrada.' });

      const comisiones = await query(
        `SELECT rc.id,
                rc.validada_at,
                rc.liquidada_at,
                rc.pedido_id,
                rc.base_monto,
                rc.porcentaje,
                rc.monto_comision,
                r.nombre AS referente_nombre,
                r.codigo AS referente_codigo,
                pe.cliente,
                pr.nombre AS producto_nombre
           FROM referente_comisiones rc
           JOIN referentes r ON r.id = rc.referente_id
           LEFT JOIN puntos_entrega pe ON pe.id = rc.punto_entrega_id
           LEFT JOIN productos pr ON pr.id = rc.producto_id
          WHERE rc.empresa_id = $1
            AND rc.liquidacion_lote_id = $2
          ORDER BY r.nombre ASC,
                   rc.liquidada_at DESC,
                   rc.id DESC`,
        [empresaId, loteId]
      );

      return res.json({ liquidacion: lotes[0], comisiones });
    } catch (e) {
      console.error('REFERENTES.LIQUIDACION.DETALLE.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo detalle de liquidacion' });
    }
  });

  router.get('/', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteAccessSchema();
      await ensureReferenteProfileSchema();
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const rows = await query(
        `SELECT r.*,
                u.id AS usuario_id,
                u.username AS usuario_username,
                COALESCE(u.activo, TRUE) AS usuario_activo,
                u.last_login_at AS usuario_last_login_at,
                COALESCE(cp.productos_count, 0)::int AS productos_count,
                COALESCE(cc.clientes_count, 0)::int AS clientes_count,
                COALESCE(cm.comisiones_total, 0)::numeric AS comisiones_total,
                COALESCE(cm.comisiones_pendientes, 0)::numeric AS comisiones_pendientes,
                COALESCE(cm.comisiones_liquidadas, 0)::numeric AS comisiones_liquidadas
           FROM referentes r
           LEFT JOIN usuarios u
             ON u.referente_id = r.id
            AND u.empresa_id = r.empresa_id
            AND LOWER(u.role) = 'referente'
           LEFT JOIN (
             SELECT referente_id, COUNT(*)::int AS productos_count
               FROM referente_productos
              WHERE empresa_id = $1 AND activo = TRUE
              GROUP BY referente_id
           ) cp ON cp.referente_id = r.id
           LEFT JOIN (
             SELECT referente_id, COUNT(*)::int AS clientes_count
               FROM cliente_referentes
              WHERE empresa_id = $1 AND estado = 'activo'
              GROUP BY referente_id
           ) cc ON cc.referente_id = r.id
           LEFT JOIN (
             SELECT referente_id, SUM(monto_comision) AS comisiones_total
                    ,SUM(CASE WHEN estado = 'validada' THEN monto_comision ELSE 0 END) AS comisiones_pendientes
                    ,SUM(CASE WHEN estado = 'liquidada' THEN monto_comision ELSE 0 END) AS comisiones_liquidadas
               FROM referente_comisiones
              WHERE empresa_id = $1 AND estado IN ('validada','liquidada')
              GROUP BY referente_id
           ) cm ON cm.referente_id = r.id
          WHERE r.empresa_id = $1
            AND r.deleted_at IS NULL
          ORDER BY r.created_at DESC`,
        [empresaId]
      );

      return res.json(rows);
    } catch (e) {
      console.error('REFERENTES.LIST.ERROR', e);
      return res.status(500).json({ error: 'Error listando referentes' });
    }
  });

  router.post('/', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteProfileSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const nombre = String(req.body?.nombre || '').trim();
      const codigo = normalizeReferenteCode(req.body?.codigo);
      const porcentaje = parsePercent(req.body?.porcentaje_comision);
      if (!nombre) return res.status(400).json({ error: 'Falta nombre.' });
      if (!codigo) return res.status(400).json({ error: 'Falta codigo.' });
      if (porcentaje == null) return res.status(400).json({ error: 'Porcentaje invalido.' });

      const rows = await query(
        `INSERT INTO referentes (
           empresa_id, nombre, telefono, email, direccion, codigo, porcentaje_comision,
           vigente_desde, vigente_hasta, notas, activo
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, TRUE))
         RETURNING *`,
        [
          empresaId,
          nombre,
          req.body?.telefono ? String(req.body.telefono).trim() : null,
          req.body?.email ? String(req.body.email).trim() : null,
          req.body?.direccion ? String(req.body.direccion).trim() : null,
          codigo,
          porcentaje,
          req.body?.vigente_desde || null,
          req.body?.vigente_hasta || null,
          req.body?.notas ? String(req.body.notas).trim() : null,
          req.body?.activo,
        ]
      );

      return res.status(201).json(rows[0]);
    } catch (e) {
      if (String(e?.message || '').includes('duplicate key')) {
        return res.status(409).json({ error: 'Codigo de referente ya existe para esta empresa.' });
      }
      console.error('REFERENTES.CREATE.ERROR', e);
      return res.status(500).json({ error: 'Error creando referente' });
    }
  });

  router.put('/:id', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteProfileSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      const id = Number(req.params.id);
      if (!empresaId || !id) return res.status(400).json({ error: 'Datos invalidos.' });

      const porcentaje = req.body?.porcentaje_comision == null ? null : parsePercent(req.body.porcentaje_comision);
      if (req.body?.porcentaje_comision != null && porcentaje == null) {
        return res.status(400).json({ error: 'Porcentaje invalido.' });
      }

      const rows = await query(
        `UPDATE referentes
            SET nombre = COALESCE($3, nombre),
                telefono = COALESCE($4, telefono),
                email = COALESCE($5, email),
                direccion = COALESCE($6, direccion),
                porcentaje_comision = COALESCE($7, porcentaje_comision),
                vigente_desde = COALESCE($8, vigente_desde),
                vigente_hasta = COALESCE($9, vigente_hasta),
                notas = COALESCE($10, notas),
                activo = COALESCE($11, activo),
                updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
            AND deleted_at IS NULL
          RETURNING *`,
        [
          id,
          empresaId,
          req.body?.nombre ? String(req.body.nombre).trim() : null,
          req.body?.telefono ? String(req.body.telefono).trim() : null,
          req.body?.email ? String(req.body.email).trim() : null,
          req.body?.direccion ? String(req.body.direccion).trim() : null,
          porcentaje,
          req.body?.vigente_desde || null,
          req.body?.vigente_hasta || null,
          req.body?.notas ? String(req.body.notas).trim() : null,
          typeof req.body?.activo === 'boolean' ? req.body.activo : null,
        ]
      );

      if (!rows.length) return res.status(404).json({ error: 'Referente no encontrado.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTES.UPDATE.ERROR', e);
      return res.status(500).json({ error: 'Error actualizando referente' });
    }
  });

  router.get('/:id/acceso', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteAccessSchema();
      const empresaId = resolveEmpresa(req);
      const referenteId = Number(req.params.id);
      if (!empresaId || !referenteId) return res.status(400).json({ error: 'Datos invalidos.' });

      const rows = await query(
        `SELECT u.id, u.username, u.role, u.empresa_id, u.referente_id,
                COALESCE(u.activo, TRUE) AS activo,
                u.last_login_at,
                r.nombre AS referente_nombre,
                r.codigo AS referente_codigo
           FROM referentes r
           LEFT JOIN usuarios u
             ON u.referente_id = r.id
            AND u.empresa_id = r.empresa_id
            AND LOWER(u.role) = 'referente'
          WHERE r.id = $1
            AND r.empresa_id = $2
            AND r.deleted_at IS NULL
          LIMIT 1`,
        [referenteId, empresaId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Referente no encontrado.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTES.ACCESO.GET.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo acceso del referente' });
    }
  });

  router.post('/:id/acceso', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteAccessSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      const referenteId = Number(req.params.id);
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      const activo = typeof req.body?.activo === 'boolean' ? req.body.activo : true;

      if (!empresaId || !referenteId) return res.status(400).json({ error: 'Datos invalidos.' });
      if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
        return res.status(400).json({ error: 'Usuario invalido. Usá 3-30 caracteres: letras, números, _, . o -' });
      }
      if (password && password.length < 8) return res.status(400).json({ error: 'Clave minima 8 caracteres.' });

      const passwordHash = password
        ? await bcrypt.hash(password, await bcrypt.genSalt(10))
        : null;
      const result = await runTransaction(async txQuery => {
        const refRows = await txQuery(
          `SELECT id
             FROM referentes
            WHERE id = $1
              AND empresa_id = $2
              AND activo IS TRUE
              AND deleted_at IS NULL
            FOR UPDATE`,
          [referenteId, empresaId]
        );
        if (refRows.length !== 1) {
          throw referenteMutationError(404, 'Referente no encontrado.');
        }

        const existing = await txQuery(
          `SELECT id
             FROM usuarios
            WHERE empresa_id = $1
              AND referente_id = $2
              AND LOWER(role) = 'referente'
            ORDER BY id
            FOR UPDATE`,
          [empresaId, referenteId]
        );
        if (existing.length > 1) {
          throw referenteMutationError(409, 'Acceso de referente ambiguo.');
        }

        if (existing.length === 1) {
          const sets = ['username = $1', 'activo = $2'];
          const params = [username, activo];
          let idx = 3;
          if (passwordHash) {
            sets.push(`password = $${idx++}`);
            params.push(passwordHash);
          }
          params.push(existing[0].id, empresaId, referenteId);
          const rows = await txQuery(
            `UPDATE usuarios
                SET ${sets.join(', ')}
              WHERE id = $${idx++}
                AND empresa_id = $${idx++}
                AND referente_id = $${idx}
                AND LOWER(role) = 'referente'
              RETURNING id, username, role, empresa_id, referente_id, activo, last_login_at`,
            params
          );
          if (rows.length !== 1) {
            throw referenteMutationError(409, 'El acceso del referente cambió durante la actualización.');
          }
          return { created: false, row: rows[0] };
        }

        if (!passwordHash) {
          throw referenteMutationError(400, 'Falta clave inicial.');
        }
        const rows = await txQuery(
          `INSERT INTO usuarios (username, password, role, empresa_id, referente_id, activo)
           VALUES ($1,$2,'referente',$3,$4,$5)
           RETURNING id, username, role, empresa_id, referente_id, activo, last_login_at`,
          [username, passwordHash, empresaId, referenteId, activo]
        );
        if (rows.length !== 1) {
          throw referenteMutationError(409, 'No se pudo confirmar el acceso del referente.');
        }
        return { created: true, row: rows[0] };
      });

      return res.status(result.created ? 201 : 200).json(result.row);
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de acceso del referente indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      if (Number.isInteger(e?.statusCode)) {
        return res.status(e.statusCode).json({ error: e.message });
      }
      if (String(e?.message || '').includes('unique')) {
        return res.status(409).json({ error: 'Usuario ya existe.' });
      }
      console.error('REFERENTES.ACCESO.SAVE.ERROR', e);
      return res.status(500).json({ error: 'Error guardando acceso del referente' });
    }
  });

  router.post('/:id/productos', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const source = req.body || {};
      const empresaId = resolveMutationEmpresa(req, source);
      const referenteId = parsePathPgInteger(req.params.id);
      if (!empresaId || !referenteId || !Array.isArray(source.productos)) {
        return res.status(400).json({ error: 'Datos invalidos.' });
      }

      const seenProductIds = new Set();
      const productos = [];
      for (const item of source.productos) {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || !isPositivePgInteger(item.producto_id)) {
          return res.status(400).json({ error: 'Producto invalido.' });
        }
        if (seenProductIds.has(item.producto_id)) {
          return res.status(409).json({ error: 'Producto duplicado en la asignacion.' });
        }
        seenProductIds.add(item.producto_id);
        const porcentaje = item.porcentaje_comision == null ? null : parsePercent(item.porcentaje_comision);
        if (item.porcentaje_comision != null && porcentaje == null) {
          return res.status(400).json({ error: 'Porcentaje invalido.' });
        }
        if (item.activo !== undefined && typeof item.activo !== 'boolean') {
          return res.status(400).json({ error: 'Estado de producto invalido.' });
        }
        const vigenteDesde = normalizeOptionalDate(item.vigente_desde);
        const vigenteHasta = normalizeOptionalDate(item.vigente_hasta);
        if (vigenteDesde === false || vigenteHasta === false) {
          return res.status(400).json({ error: 'Fecha de vigencia invalida.' });
        }
        productos.push({
          productoId: item.producto_id,
          porcentaje,
          vigenteDesde,
          vigenteHasta,
          activo: item.activo,
        });
      }
      productos.sort((a, b) => a.productoId - b.productoId);
      const productoIds = productos.map(item => item.productoId);

      await runTransaction(async txQuery => {
        const referentes = await txQuery(
          `SELECT id
             FROM referentes
            WHERE id = $1
              AND empresa_id = $2
              AND activo IS TRUE
              AND deleted_at IS NULL
            FOR UPDATE`,
          [referenteId, empresaId]
        );
        if (referentes.length !== 1) {
          throw referenteMutationError(404, 'Referente no encontrado.');
        }

        let observedProducts = [];
        if (productoIds.length) {
          observedProducts = await txQuery(
            `SELECT id, nombre
               FROM productos
              WHERE empresa_id = $1
                AND id = ANY($2::int[])
              ORDER BY id`,
            [empresaId, productoIds]
          );
          if (observedProducts.length !== productoIds.length) {
            throw referenteMutationError(404, 'Producto no encontrado.');
          }
          await lockProductIdentityNamespaces(txQuery, {
            empresaId,
            names: observedProducts.map(product => product.nombre),
          });
          const lockedProducts = await txQuery(
            `SELECT id
               FROM productos
              WHERE empresa_id = $1
                AND id = ANY($2::int[])
                AND activo IS TRUE
                AND deleted_at IS NULL
              ORDER BY id
              FOR SHARE`,
            [empresaId, productoIds]
          );
          if (lockedProducts.length !== productoIds.length) {
            throw referenteMutationError(404, 'Producto no encontrado.');
          }

          const conflicts = await txQuery(
            `SELECT empresa_id, producto_id
               FROM referente_productos
              WHERE referente_id = $1
                AND producto_id = ANY($2::int[])
              ORDER BY producto_id
              FOR UPDATE`,
            [referenteId, productoIds]
          );
          if (conflicts.some(row => Number(row.empresa_id) !== empresaId)) {
            throw referenteMutationError(409, 'Conflicto de asignacion de producto.');
          }
        }

        await txQuery(
          'DELETE FROM referente_productos WHERE empresa_id = $1 AND referente_id = $2',
          [empresaId, referenteId]
        );

        for (const item of productos) {
          const inserted = await txQuery(
            `INSERT INTO referente_productos (
               empresa_id, referente_id, producto_id, porcentaje_comision, vigente_desde, vigente_hasta, activo
             ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, TRUE))
             RETURNING id`,
            [
              empresaId,
              referenteId,
              item.productoId,
              item.porcentaje,
              item.vigenteDesde,
              item.vigenteHasta,
              item.activo,
            ]
          );
          if (inserted.length !== 1) {
            throw referenteMutationError(409, 'No se pudo confirmar la asignacion de producto.');
          }
        }
      });

      return res.json({ ok: true });
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de asignación de productos indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      if (Number.isInteger(e?.statusCode)) {
        return res.status(e.statusCode).json({ error: e.message });
      }
      if (e?.code === '23505') {
        return res.status(409).json({ error: 'Conflicto de asignacion de producto.' });
      }
      console.error('REFERENTES.PRODUCTOS.ERROR', e);
      return res.status(500).json({ error: 'Error guardando productos del referente' });
    }
  });

  router.get('/clientes-propuestos', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteClientesPropuestosSchema();
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });
      const estado = String(req.query?.estado || 'pendiente').trim().toLowerCase();
      const estadosValidos = ['pendiente', 'aprobado', 'rechazado', 'todos'];
      const filtroEstado = estadosValidos.includes(estado) ? estado : 'pendiente';

      const params = [empresaId];
      let estadoWhere = "AND rcp.estado = 'pendiente'";
      if (filtroEstado !== 'pendiente') {
        estadoWhere = filtroEstado === 'todos' ? '' : 'AND rcp.estado = $2';
        if (filtroEstado !== 'todos') params.push(filtroEstado);
      }

      const rows = await query(
        `SELECT rcp.*,
                r.nombre AS referente_nombre,
                r.codigo AS referente_codigo,
                pe.cliente AS cliente_aprobado_nombre,
                u.username AS reviewed_by_username
           FROM referente_clientes_propuestos rcp
           JOIN referentes r ON r.id = rcp.referente_id
           LEFT JOIN puntos_entrega pe ON pe.id = rcp.punto_entrega_id
           LEFT JOIN usuarios u ON u.id = rcp.reviewed_by
          WHERE rcp.empresa_id = $1
            ${estadoWhere}
          ORDER BY CASE rcp.estado WHEN 'pendiente' THEN 0 WHEN 'aprobado' THEN 1 ELSE 2 END,
                   rcp.created_at DESC,
                   rcp.id DESC
          LIMIT 300`,
        params
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTES.CLIENTES_PROPUESTOS.ERROR', e);
      return res.status(500).json({ error: 'Error listando clientes propuestos' });
    }
  });

  router.get('/clientes', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteClienteVinculosSchema();
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const rows = await query(
        `SELECT cr.id,
                cr.punto_entrega_id AS cliente_id,
                cr.referente_id,
                cr.codigo_referente,
                cr.estado,
                cr.asociado_at,
                cr.desvinculado_at,
                cr.desvinculado_motivo,
                r.nombre AS referente_nombre,
                r.codigo AS referente_codigo,
                pe.cliente,
                pe.telefono,
                pe.direccion,
                pe.ciudad,
                pe.provincia,
                COALESCE(pstats.pedidos_count, 0)::int AS pedidos_count,
                COALESCE(pstats.ventas_entregadas, 0)::numeric AS ventas_entregadas,
                COALESCE(cstats.comisiones_total, 0)::numeric AS comisiones_total
           FROM cliente_referentes cr
           JOIN referentes r
             ON r.id = cr.referente_id
            AND r.empresa_id = cr.empresa_id
           JOIN puntos_entrega pe
             ON pe.id = cr.punto_entrega_id
            AND pe.empresa_id = cr.empresa_id
           LEFT JOIN (
             SELECT empresa_id,
                    punto_entrega_id,
                    COUNT(*)::int AS pedidos_count,
                    SUM(CASE WHEN estado = 'entregado' THEN COALESCE(monto, 0) ELSE 0 END) AS ventas_entregadas
               FROM pedidos
              WHERE empresa_id = $1
              GROUP BY empresa_id, punto_entrega_id
           ) pstats
             ON pstats.empresa_id = cr.empresa_id
            AND pstats.punto_entrega_id = cr.punto_entrega_id
           LEFT JOIN (
             SELECT empresa_id,
                    punto_entrega_id,
                    referente_id,
                    SUM(COALESCE(monto_comision, 0)) AS comisiones_total
               FROM referente_comisiones
              WHERE empresa_id = $1
              GROUP BY empresa_id, punto_entrega_id, referente_id
           ) cstats
             ON cstats.empresa_id = cr.empresa_id
            AND cstats.punto_entrega_id = cr.punto_entrega_id
            AND cstats.referente_id = cr.referente_id
          WHERE cr.empresa_id = $1
            AND cr.estado = 'activo'
          ORDER BY cr.asociado_at DESC, cr.id DESC
          LIMIT 500`,
        [empresaId]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTES.CLIENTES.ERROR', e);
      return res.status(500).json({ error: 'Error listando clientes vinculados' });
    }
  });

  router.post('/clientes-propuestos/:id/aprobar', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteClientesPropuestosSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      const id = Number(req.params.id);
      if (!empresaId || !id) return res.status(400).json({ error: 'Datos invalidos.' });

      const result = await runTransaction(async (txQuery) => {
        const proposals = await txQuery(
          `SELECT rcp.*, r.codigo AS referente_codigo
             FROM referente_clientes_propuestos rcp
             JOIN referentes r
               ON r.id = rcp.referente_id
              AND r.empresa_id = rcp.empresa_id
              AND r.activo IS TRUE
              AND r.deleted_at IS NULL
            WHERE rcp.id = $1
              AND rcp.empresa_id = $2
              AND rcp.estado = 'pendiente'
            FOR UPDATE OF rcp, r`,
          [id, empresaId]
        );
        if (proposals.length !== 1) return null;
        const proposal = proposals[0];
        const cliente = cleanText(req.body?.cliente, 160) || proposal.cliente;
        const telefono = cleanText(req.body?.telefono, 80) || proposal.telefono;
        const direccion = cleanText(req.body?.direccion, 220) || proposal.direccion;
        const ciudad = cleanText(req.body?.ciudad, 120) || proposal.ciudad;
        const provincia = cleanText(req.body?.provincia, 120) || proposal.provincia;
        const pais = cleanText(req.body?.pais, 80) || proposal.pais || 'Argentina';
        const email = cleanText(req.body?.email, 180) || proposal.email;
        const notas = cleanText(req.body?.notas, 600) || proposal.notas;
        const identity = deliveryPointIdentity({
          normalizePhoneFn: value => String(value || '').replace(/\D+/g, ''),
          telefono,
          direccion,
        });
        if (!identity) throw deliveryPointConflict('Teléfono y dirección son requeridos para aprobar el cliente');
        await lockDeliveryPointIdentities(txQuery, { empresaId, identities: [identity] });

        const existing = await findDeliveryPointsByIdentity(txQuery, { empresaId, identity });
        if (existing.length > 1) throw deliveryPointConflict();
        let puntoEntregaId = existing[0]?.id || null;
        if (!puntoEntregaId) {
          const inserted = await txQuery(
            `INSERT INTO puntos_entrega (
               empresa_id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, email, notas
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id`,
            [empresaId, cliente, telefono, String(telefono || '').replace(/\D+/g, ''), direccion, ciudad, provincia, pais, email, notas]
          );
          if (inserted.length !== 1) throw deliveryPointConflict('No se creó exactamente un cliente');
          puntoEntregaId = inserted[0].id;
        }

        const vinculo = await txQuery(
          `INSERT INTO cliente_referentes (
             empresa_id, punto_entrega_id, referente_id, codigo_referente, estado, asociado_at
           ) VALUES ($1,$2,$3,$4,'activo',NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [empresaId, puntoEntregaId, proposal.referente_id, proposal.referente_codigo]
        );
        const updated = await txQuery(
          `UPDATE referente_clientes_propuestos
              SET estado='aprobado', punto_entrega_id=$1, reviewed_at=NOW(), reviewed_by=$2, updated_at=NOW()
            WHERE id=$3 AND empresa_id=$4 AND estado='pendiente'
            RETURNING *`,
          [puntoEntregaId, req.user?.uid || null, id, empresaId]
        );
        if (updated.length !== 1) throw deliveryPointConflict('La propuesta cambió durante la aprobación');
        return { ...updated[0], cliente_id: puntoEntregaId, vinculo_id: vinculo[0]?.id || null };
      });

      if (!result) return res.status(404).json({ error: 'Cliente propuesto pendiente no encontrado.' });
      return res.json(result);
    } catch (e) {
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'Resultado de aprobación indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      if (e?.code === 'DELIVERY_POINT_IDENTITY_CONFLICT') {
        return res.status(409).json({ error: e.message, code: e.code });
      }
      console.error('REFERENTES.CLIENTES_PROPUESTOS.APROBAR.ERROR', e);
      return res.status(500).json({ error: 'Error aprobando cliente propuesto' });
    }
  });

  router.post('/clientes-propuestos/:id/rechazar', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteClientesPropuestosSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      const id = Number(req.params.id);
      if (!empresaId || !id) return res.status(400).json({ error: 'Datos invalidos.' });

      const rows = await query(
        `UPDATE referente_clientes_propuestos
            SET estado = 'rechazado',
                rechazo_motivo = $4,
                reviewed_at = NOW(),
                reviewed_by = $3,
                updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
            AND estado = 'pendiente'
          RETURNING *`,
        [id, empresaId, req.user?.uid || null, cleanText(req.body?.motivo, 500)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Cliente propuesto pendiente no encontrado.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTES.CLIENTES_PROPUESTOS.RECHAZAR.ERROR', e);
      return res.status(500).json({ error: 'Error rechazando cliente propuesto' });
    }
  });

  router.get('/:id/productos', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const empresaId = resolveEmpresa(req);
      const referenteId = Number(req.params.id);
      if (!empresaId || !referenteId) return res.status(400).json({ error: 'Datos invalidos.' });

      const rows = await query(
        `SELECT rp.id,
                rp.referente_id,
                rp.producto_id,
                rp.porcentaje_comision,
                rp.vigente_desde,
                rp.vigente_hasta,
                rp.activo,
                p.nombre AS producto_nombre,
                p.precio AS producto_precio
           FROM referente_productos rp
           JOIN productos p ON p.id = rp.producto_id AND p.empresa_id = rp.empresa_id
          WHERE rp.empresa_id = $1
            AND rp.referente_id = $2
          ORDER BY p.nombre ASC`,
        [empresaId, referenteId]
      );

      return res.json(rows);
    } catch (e) {
      console.error('REFERENTES.PRODUCTOS.LIST.ERROR', e);
      return res.status(500).json({ error: 'Error listando productos del referente' });
    }
  });

  router.delete('/:id', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const empresaId = resolveEmpresa(req, req.query || {});
      const referenteId = Number(req.params.id);
      if (!empresaId || !referenteId) return res.status(400).json({ error: 'Datos invalidos.' });

      const rows = await query(
        `UPDATE referentes
            SET activo = FALSE,
                deleted_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
            AND deleted_at IS NULL
          RETURNING id`,
        [referenteId, empresaId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Referente no encontrado.' });
      return res.json({ ok: true });
    } catch (e) {
      console.error('REFERENTES.DELETE.ERROR', e);
      return res.status(500).json({ error: 'Error eliminando referente' });
    }
  });

  router.post('/comisiones/liquidar', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteLiquidacionesSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const ids = Array.isArray(req.body?.comision_ids)
        ? [...new Set(req.body.comision_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
        : [];
      if (!ids.length) return res.status(400).json({ error: 'Seleccioná al menos una comisión pendiente.' });

      const referencia = cleanText(req.body?.referencia, 120);
      const nota = cleanText(req.body?.nota, 500);
      const rows = await query(
        `WITH candidates AS (
           SELECT rc.id, rc.referente_id, rc.monto_comision
             FROM referente_comisiones rc
             JOIN referentes r
               ON r.id = rc.referente_id
              AND r.empresa_id = rc.empresa_id
            WHERE rc.empresa_id = $1
              AND rc.id = ANY($2::int[])
              AND rc.estado = 'validada'
         ),
         totals AS (
           SELECT COUNT(*)::int AS comisiones_count,
                  COALESCE(SUM(monto_comision), 0)::numeric AS total
             FROM candidates
         ),
         lote AS (
           INSERT INTO referente_liquidaciones (
             empresa_id, referencia, nota, comisiones_count, total, liquidada_por
           )
           SELECT $1, $3, $4, comisiones_count, total, $5
             FROM totals
           WHERE comisiones_count > 0
           RETURNING id, created_at, comisiones_count, total, referencia, nota
         ),
         updated AS (
           UPDATE referente_comisiones rc
              SET estado = 'liquidada',
                  liquidada_at = NOW(),
                  liquidacion_referencia = $3,
                  liquidacion_nota = $4,
                  liquidada_por = $5,
                  liquidacion_lote_id = lote.id
             FROM lote
            WHERE rc.empresa_id = $1
              AND rc.id = ANY($2::int[])
              AND rc.estado = 'validada'
           RETURNING rc.id, rc.referente_id, rc.monto_comision, lote.id AS lote_id
         )
         SELECT updated.*, lote.created_at AS lote_created_at,
                lote.comisiones_count AS lote_comisiones_count,
                lote.total AS lote_total,
                lote.referencia AS lote_referencia,
                lote.nota AS lote_nota
           FROM updated
           JOIN lote ON lote.id = updated.lote_id`,
        [empresaId, ids, referencia, nota, req.user?.uid || null]
      );

      const total = rows.reduce((acc, row) => acc + Number(row.monto_comision || 0), 0);
      await createComisionLiquidadaNotifications({ queryFn: query, empresaId, comisiones: rows });
      const first = rows[0] || {};
      return res.json({
        ok: true,
        liquidadas: rows.length,
        total,
        lote: rows.length ? {
          id: first.lote_id,
          created_at: first.lote_created_at,
          comisiones_count: first.lote_comisiones_count,
          total: Number(first.lote_total || total),
          referencia: first.lote_referencia,
          nota: first.lote_nota,
        } : null,
      });
    } catch (e) {
      console.error('REFERENTES.COMISIONES.LIQUIDAR.ERROR', e);
      return res.status(500).json({ error: 'Error liquidando comisiones' });
    }
  });

  router.get('/comisiones', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteLiquidacionesSchema();
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const from = String(req.query?.from || '').trim();
      const to = String(req.query?.to || '').trim();
      const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
      const filters = ['rc.empresa_id = $1'];
      const params = [empresaId];
      let idx = 2;

      if (from) {
        if (!isDate(from)) return res.status(400).json({ error: 'Fecha desde inválida.' });
        filters.push(`rc.validada_at >= $${idx++}::date`);
        params.push(from);
      }
      if (to) {
        if (!isDate(to)) return res.status(400).json({ error: 'Fecha hasta inválida.' });
        filters.push(`rc.validada_at < ($${idx++}::date + INTERVAL '1 day')`);
        params.push(to);
      }

      const rows = await query(
        `SELECT rc.*,
                r.nombre AS referente_nombre,
                r.codigo AS referente_codigo,
                pe.cliente,
                pr.nombre AS producto_nombre,
                rc.liquidacion_lote_id,
                u.username AS liquidada_por_username
           FROM referente_comisiones rc
           JOIN referentes r ON r.id = rc.referente_id
           LEFT JOIN puntos_entrega pe ON pe.id = rc.punto_entrega_id
           LEFT JOIN productos pr ON pr.id = rc.producto_id
           LEFT JOIN usuarios u ON u.id = rc.liquidada_por
          WHERE ${filters.join(' AND ')}
          ORDER BY CASE WHEN rc.estado = 'validada' THEN 0 ELSE 1 END,
                   COALESCE(rc.liquidada_at, rc.validada_at) DESC,
                   rc.id DESC
          LIMIT 500`,
        params
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTES.COMISIONES.ERROR', e);
      return res.status(500).json({ error: 'Error listando comisiones' });
    }
  });

  router.post('/clientes/:clienteId/desvincular', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      await ensureReferenteClienteVinculosSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      const clienteId = Number(req.params.clienteId);
      if (!empresaId || !clienteId) return res.status(400).json({ error: 'Datos invalidos.' });

      const rows = await query(
        `UPDATE cliente_referentes
            SET estado = 'desvinculado',
                desvinculado_at = NOW(),
                desvinculado_por = $3,
                desvinculado_motivo = $4
          WHERE empresa_id = $1
            AND punto_entrega_id = $2
            AND estado = 'activo'
          RETURNING id, punto_entrega_id, referente_id, desvinculado_at`,
        [empresaId, clienteId, req.user?.uid || null, cleanText(req.body?.motivo, 500)]
      );

      if (!rows.length) return res.status(404).json({ error: 'Cliente vinculado activo no encontrado.' });
      return res.json({ ok: true, desvinculados: rows.length, vinculo: rows[0] });
    } catch (e) {
      console.error('REFERENTES.DESVINCULAR.ERROR', e);
      return res.status(500).json({ error: 'Error desvinculando cliente' });
    }
  });

  return router;
}
