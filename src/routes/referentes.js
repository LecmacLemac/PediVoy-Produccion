import express from 'express';
import bcrypt from 'bcryptjs';

import { normalizeReferenteCode } from '../services/referentesService.js';
import { createComisionLiquidadaNotifications } from '../services/referenteNotifications.js';

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
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createReferentesRouter: falta query(fn)');
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
      ALTER TABLE referente_comisiones
        ADD COLUMN IF NOT EXISTS liquidacion_referencia TEXT,
        ADD COLUMN IF NOT EXISTS liquidacion_nota TEXT,
        ADD COLUMN IF NOT EXISTS liquidada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
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

  function isReferenteUser(req) {
    return String(req.user?.role || '').toLowerCase() === 'referente';
  }

  function requireBackoffice(req, res) {
    if (isReferenteUser(req)) {
      res.status(403).json({ error: 'No autorizado para administrar referentes.' });
      return false;
    }
    return true;
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

  router.get('/', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.post('/', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.put('/:id', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.get('/:id/acceso', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.post('/:id/acceso', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

      const refRows = await query(
        `SELECT id FROM referentes
          WHERE id = $1 AND empresa_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [referenteId, empresaId]
      );
      if (!refRows.length) return res.status(404).json({ error: 'Referente no encontrado.' });

      const existing = await query(
        `SELECT id FROM usuarios
          WHERE empresa_id = $1
            AND referente_id = $2
            AND LOWER(role) = 'referente'
          LIMIT 1`,
        [empresaId, referenteId]
      );

      const passwordHash = password
        ? await bcrypt.hash(password, await bcrypt.genSalt(10))
        : null;

      if (existing.length) {
        const sets = ['username = $1', 'activo = $2'];
        const params = [username, activo];
        let idx = 3;
        if (passwordHash) {
          sets.push(`password = $${idx++}`);
          params.push(passwordHash);
        }
        params.push(existing[0].id);
        const rows = await query(
          `UPDATE usuarios
              SET ${sets.join(', ')}
            WHERE id = $${idx}
            RETURNING id, username, role, empresa_id, referente_id, activo, last_login_at`,
          params
        );
        return res.json(rows[0]);
      }

      if (!passwordHash) return res.status(400).json({ error: 'Falta clave inicial.' });

      const rows = await query(
        `INSERT INTO usuarios (username, password, role, empresa_id, referente_id, activo)
         VALUES ($1,$2,'referente',$3,$4,$5)
         RETURNING id, username, role, empresa_id, referente_id, activo, last_login_at`,
        [username, passwordHash, empresaId, referenteId, activo]
      );

      return res.status(201).json(rows[0]);
    } catch (e) {
      if (String(e?.message || '').includes('unique')) {
        return res.status(409).json({ error: 'Usuario ya existe.' });
      }
      console.error('REFERENTES.ACCESO.SAVE.ERROR', e);
      return res.status(500).json({ error: 'Error guardando acceso del referente' });
    }
  });

  router.post('/:id/productos', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
      const empresaId = resolveEmpresa(req, req.body || {});
      const referenteId = Number(req.params.id);
      const productos = Array.isArray(req.body?.productos) ? req.body.productos : [];
      if (!empresaId || !referenteId) return res.status(400).json({ error: 'Datos invalidos.' });

      await query('DELETE FROM referente_productos WHERE empresa_id = $1 AND referente_id = $2', [empresaId, referenteId]);

      for (const p of productos) {
        const productoId = Number(p?.producto_id || p?.id);
        if (!productoId) continue;
        const pct = p?.porcentaje_comision == null ? null : parsePercent(p.porcentaje_comision);
        await query(
          `INSERT INTO referente_productos (
             empresa_id, referente_id, producto_id, porcentaje_comision, vigente_desde, vigente_hasta, activo
           ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, TRUE))
           ON CONFLICT (referente_id, producto_id)
           DO UPDATE SET
             porcentaje_comision = EXCLUDED.porcentaje_comision,
             vigente_desde = EXCLUDED.vigente_desde,
             vigente_hasta = EXCLUDED.vigente_hasta,
             activo = EXCLUDED.activo`,
          [empresaId, referenteId, productoId, pct, p?.vigente_desde || null, p?.vigente_hasta || null, p?.activo]
        );
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('REFERENTES.PRODUCTOS.ERROR', e);
      return res.status(500).json({ error: 'Error guardando productos del referente' });
    }
  });

  router.get('/clientes-propuestos', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.get('/clientes', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.post('/clientes-propuestos/:id/aprobar', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
      await ensureReferenteClientesPropuestosSchema();
      const empresaId = resolveEmpresa(req, req.body || {});
      const id = Number(req.params.id);
      if (!empresaId || !id) return res.status(400).json({ error: 'Datos invalidos.' });

      const rows = await query(
        `WITH propuesta AS (
           SELECT *
             FROM referente_clientes_propuestos
            WHERE id = $1
              AND empresa_id = $2
              AND estado = 'pendiente'
         ),
         cliente_creado AS (
           INSERT INTO puntos_entrega (
             empresa_id, cliente, telefono, direccion, ciudad, provincia, pais,
             email, notas
           )
           SELECT empresa_id,
                  COALESCE($4, cliente),
                  COALESCE($5, telefono),
                  COALESCE($6, direccion),
                  COALESCE($7, ciudad),
                  COALESCE($8, provincia),
                  COALESCE($9, pais, 'Argentina'),
                  COALESCE($10, email),
                  COALESCE($11, notas)
             FROM propuesta
           RETURNING id
         ),
         vinculo AS (
           INSERT INTO cliente_referentes (
             empresa_id, punto_entrega_id, referente_id, codigo_referente, estado, asociado_at
           )
           SELECT p.empresa_id, cc.id, p.referente_id, r.codigo, 'activo', NOW()
             FROM propuesta p
             JOIN cliente_creado cc ON TRUE
             JOIN referentes r ON r.id = p.referente_id
           ON CONFLICT DO NOTHING
           RETURNING id
         ),
         actualizada AS (
           UPDATE referente_clientes_propuestos rcp
              SET estado = 'aprobado',
                  punto_entrega_id = (SELECT id FROM cliente_creado),
                  reviewed_at = NOW(),
                  reviewed_by = $3,
                  updated_at = NOW()
            WHERE rcp.id = $1
              AND rcp.empresa_id = $2
              AND rcp.estado = 'pendiente'
            RETURNING rcp.*
         )
         SELECT actualizada.*,
                (SELECT id FROM cliente_creado) AS cliente_id,
                (SELECT id FROM vinculo) AS vinculo_id
           FROM actualizada`,
        [
          id,
          empresaId,
          req.user?.uid || null,
          cleanText(req.body?.cliente, 160),
          cleanText(req.body?.telefono, 80),
          cleanText(req.body?.direccion, 220),
          cleanText(req.body?.ciudad, 120),
          cleanText(req.body?.provincia, 120),
          cleanText(req.body?.pais, 80),
          cleanText(req.body?.email, 180),
          cleanText(req.body?.notas, 600),
        ]
      );

      if (!rows.length) return res.status(404).json({ error: 'Cliente propuesto pendiente no encontrado.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTES.CLIENTES_PROPUESTOS.APROBAR.ERROR', e);
      return res.status(500).json({ error: 'Error aprobando cliente propuesto' });
    }
  });

  router.post('/clientes-propuestos/:id/rechazar', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.get('/:id/productos', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.delete('/:id', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.post('/comisiones/liquidar', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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
        `UPDATE referente_comisiones
            SET estado = 'liquidada',
                liquidada_at = NOW(),
                liquidacion_referencia = $3,
                liquidacion_nota = $4,
                liquidada_por = $5
          WHERE empresa_id = $1
            AND id = ANY($2::int[])
            AND estado = 'validada'
          RETURNING id, referente_id, monto_comision`,
        [empresaId, ids, referencia, nota, req.user?.uid || null]
      );

      const total = rows.reduce((acc, row) => acc + Number(row.monto_comision || 0), 0);
      await createComisionLiquidadaNotifications({ queryFn: query, empresaId, comisiones: rows });
      return res.json({ ok: true, liquidadas: rows.length, total });
    } catch (e) {
      console.error('REFERENTES.COMISIONES.LIQUIDAR.ERROR', e);
      return res.status(500).json({ error: 'Error liquidando comisiones' });
    }
  });

  router.get('/comisiones', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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

  router.post('/clientes/:clienteId/desvincular', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
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
