// src/routes/zonas.js
// Zonas (CRUD) + asignaciones (GET /choferes) extraído desde server.js

import express from 'express';
import { normalizarDiasEntrega } from '../utils.js';

export function createZonasRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createZonasRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createZonasRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createZonasRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createZonasRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // GET /api/zonas
  router.get('/', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const empresaTarget = esSuperAdmin ? (Number(req.query?.empresa_id) || null) : getEmpresaIdFromToken(req);
      if (esSuperAdmin && !empresaTarget) return res.json([]);

      let sql = `SELECT id, empresa_id, nombre, dias_entrega, poligono FROM zonas_geograficas`;
      const params = [];
      if (empresaTarget) {
        sql += ` WHERE empresa_id = $1`;
        params.push(empresaTarget);
      }
      sql += ` ORDER BY id ASC`;

      const rows = await query(sql, params);
      const ret = rows.map((r) => {
        try {
          r.poligono = typeof r.poligono === 'string' ? JSON.parse(r.poligono) : r.poligono;
        } catch {
          r.poligono = [];
        }
        return r;
      });

      return res.json(ret);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error obteniendo zonas' });
    }
  });

  // POST /api/zonas
  router.post('/', withAuth, async (req, res) => {
    try {
      const { nombre, poligono, empresa_id } = req.body || {};
      const diasEntrega = normalizarDiasEntrega(req.body?.dias_entrega);
      const esSuperAdmin = isSuper(req);
      let finalEmpresaId = esSuperAdmin && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);

      if (!finalEmpresaId) return res.status(400).json({ error: 'Empresa requerida' });
      if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
      if (!poligono || !Array.isArray(poligono) || poligono.length < 3) {
        return res.status(400).json({ error: 'Polígono inválido (mínimo 3 puntos)' });
      }

      const pStart = poligono[0];
      const pEnd = poligono[poligono.length - 1];
      if (Array.isArray(pStart) && Array.isArray(pEnd)) {
        if (pStart[0] !== pEnd[0] || pStart[1] !== pEnd[1]) {
          poligono.push(pStart);
        }
      }

      const poliJson = JSON.stringify(poligono);
      const geoJsonObj = {
        type: 'Polygon',
        coordinates: [poligono],
        crs: { type: 'name', properties: { name: 'EPSG:4326' } },
      };

      const rows = await query(
        `INSERT INTO zonas_geograficas (empresa_id, nombre, dias_entrega, poligono, geom)
         VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5))
         RETURNING id`,
        [finalEmpresaId, nombre, JSON.stringify(diasEntrega), poliJson, JSON.stringify(geoJsonObj)]
      );

      return res.json(rows[0]);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error creando zona' });
    }
  });

  // PUT /api/zonas/:id
  router.put('/:id', withAuth, async (req, res) => {
    try {
      const { nombre, poligono } = req.body || {};
      const esSuperAdmin = isSuper(req);
      const miEmpresa = getEmpresaIdFromToken(req);

      let where = 'WHERE id=$1';
      const params = [req.params.id];
      if (!esSuperAdmin) {
        where += ' AND empresa_id=$2';
        params.push(miEmpresa);
      }

      const check = await query(`SELECT id FROM zonas_geograficas ${where}`, params);
      if (!check.length) return res.status(404).json({ error: 'Zona no encontrada o sin permiso' });

      const sets = [];
      const vals = [];
      let idx = 1;

      if (nombre) {
        sets.push(`nombre=$${idx++}`);
        vals.push(nombre);
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dias_entrega')) {
        sets.push(`dias_entrega=$${idx++}`);
        vals.push(JSON.stringify(normalizarDiasEntrega(req.body?.dias_entrega)));
      }

      if (poligono) {
        if (!Array.isArray(poligono) || poligono.length < 3) {
          return res.status(400).json({ error: 'Polígono inválido' });
        }

        const pStart = poligono[0];
        const pEnd = poligono[poligono.length - 1];
        if (Array.isArray(pStart) && Array.isArray(pEnd)) {
          if (pStart[0] !== pEnd[0] || pStart[1] !== pEnd[1]) {
            poligono.push(pStart);
          }
        }

        const poliJson = JSON.stringify(poligono);
        const geoJsonObj = {
          type: 'Polygon',
          coordinates: [poligono],
          crs: { type: 'name', properties: { name: 'EPSG:4326' } },
        };

        sets.push(`poligono=$${idx++}`);
        vals.push(poliJson);

        sets.push(`geom=ST_GeomFromGeoJSON($${idx++})`);
        vals.push(JSON.stringify(geoJsonObj));
      }

      if (sets.length === 0) return res.json({ ok: true });

      vals.push(req.params.id);
      const tenantParam = esSuperAdmin ? null : Number(miEmpresa);
      vals.push(tenantParam);

      await query(
        `UPDATE zonas_geograficas
         SET ${sets.join(', ')}
         WHERE id=$${idx} AND ($${idx + 1}::int IS NULL OR empresa_id=$${idx + 1})`,
        vals
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error actualizando zona' });
    }
  });

  // DELETE /api/zonas/:id
  router.delete('/:id', withAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID de zona inválido' });

    const esSuperAdmin = isSuper(req);
    const empresaId = getEmpresaIdFromToken(req);

    try {
      if (!esSuperAdmin && !empresaId) {
        return res.status(400).json({ error: 'Empresa no encontrada en token' });
      }

      const zonaRows = await query(
        'SELECT id, empresa_id FROM zonas_geograficas WHERE id = $1 AND ($2::int IS NULL OR empresa_id = $2) LIMIT 1',
        [id, esSuperAdmin ? null : Number(empresaId)]
      );
      if (!zonaRows.length) {
        return res.status(404).json({ error: 'Zona no encontrada o no pertenece a tu empresa' });
      }

      const zonaEmpresa = Number(zonaRows[0].empresa_id);

      await query('DELETE FROM zona_chofer WHERE zona_id = $1 AND empresa_id = $2', [id, zonaEmpresa]);
      await query('UPDATE puntos_entrega SET zona_id = NULL WHERE zona_id = $1 AND empresa_id = $2', [id, zonaEmpresa]);
      await query('DELETE FROM zonas_geograficas WHERE id = $1 AND empresa_id = $2', [id, zonaEmpresa]);

      return res.json({ ok: true });
    } catch (e) {
      console.error('Error eliminando zona:', e);
      return res.status(500).json({ error: e.detail || e.message || 'Error eliminando zona' });
    }
  });

  // GET /api/zonas/choferes
  router.get('/choferes', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const empresaIdParam = Number(req.query?.empresa_id) || null;
      const empresaId = esSuperAdmin ? empresaIdParam : getEmpresaIdFromToken(req);

      let sql = `
        SELECT z.id as zona_id, z.nombre as zona_nombre, z.dias_entrega, zc.chofer_id
        FROM zonas_geograficas z
        JOIN zona_chofer zc ON z.id = zc.zona_id
      `;
      const params = [];
      if (empresaId) {
        sql += ` WHERE z.empresa_id=$1 AND zc.empresa_id=$1`;
        params.push(empresaId);
      }

      const rows = await query(sql, params);
      const map = {};
      for (const r of rows) {
        if (!map[r.zona_id]) map[r.zona_id] = { id: r.zona_id, nombre: r.zona_nombre, dias_entrega: r.dias_entrega || [], choferes: [] };
        map[r.zona_id].choferes.push({ id: r.chofer_id });
      }

      return res.json(Object.values(map));
    } catch (e) {
      console.error('ERROR zonas/choferes', e);
      return res.status(500).json({ error: 'Error obteniendo asignaciones' });
    }
  });

  return router;
}
