import express from 'express';
import bcrypt from 'bcryptjs';

import { normalizeReferenteCode } from '../services/referentesService.js';

let referentesAccessSchemaReady = false;

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
                COALESCE(cm.comisiones_total, 0)::numeric AS comisiones_total
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
           empresa_id, nombre, telefono, email, codigo, porcentaje_comision,
           vigente_desde, vigente_hasta, notas, activo
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, TRUE))
         RETURNING *`,
        [
          empresaId,
          nombre,
          req.body?.telefono ? String(req.body.telefono).trim() : null,
          req.body?.email ? String(req.body.email).trim() : null,
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
                porcentaje_comision = COALESCE($6, porcentaje_comision),
                vigente_desde = COALESCE($7, vigente_desde),
                vigente_hasta = COALESCE($8, vigente_hasta),
                notas = COALESCE($9, notas),
                activo = COALESCE($10, activo),
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

  router.get('/comisiones', withAuth, async (req, res) => {
    try {
      if (!requireBackoffice(req, res)) return;
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const rows = await query(
        `SELECT rc.*,
                r.nombre AS referente_nombre,
                r.codigo AS referente_codigo,
                pe.cliente,
                pr.nombre AS producto_nombre
           FROM referente_comisiones rc
           JOIN referentes r ON r.id = rc.referente_id
           LEFT JOIN puntos_entrega pe ON pe.id = rc.punto_entrega_id
           LEFT JOIN productos pr ON pr.id = rc.producto_id
          WHERE rc.empresa_id = $1
          ORDER BY rc.validada_at DESC, rc.id DESC
          LIMIT 500`,
        [empresaId]
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
      const empresaId = resolveEmpresa(req, req.body || {});
      const clienteId = Number(req.params.clienteId);
      if (!empresaId || !clienteId) return res.status(400).json({ error: 'Datos invalidos.' });

      await query(
        `UPDATE cliente_referentes
            SET estado = 'desvinculado',
                desvinculado_at = NOW(),
                desvinculado_por = $3
          WHERE empresa_id = $1
            AND punto_entrega_id = $2
            AND estado = 'activo'`,
        [empresaId, clienteId, req.user?.uid || null]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('REFERENTES.DESVINCULAR.ERROR', e);
      return res.status(500).json({ error: 'Error desvinculando cliente' });
    }
  });

  return router;
}
