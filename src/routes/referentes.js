import express from 'express';

import { normalizeReferenteCode } from '../services/referentesService.js';

export function createReferentesRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createReferentesRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createReferentesRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createReferentesRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createReferentesRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

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
      const empresaId = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const rows = await query(
        `SELECT r.*,
                COALESCE(cp.productos_count, 0)::int AS productos_count,
                COALESCE(cc.clientes_count, 0)::int AS clientes_count,
                COALESCE(cm.comisiones_total, 0)::numeric AS comisiones_total
           FROM referentes r
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

  router.post('/:id/productos', withAuth, async (req, res) => {
    try {
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
