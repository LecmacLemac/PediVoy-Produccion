// src/routes/asignacionesZonas.js
// Asignar/desasignar choferes a zonas (extraído desde server.js)

import express from 'express';

export function createAsignacionesZonasRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createAsignacionesZonasRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAsignacionesZonasRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createAsignacionesZonasRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createAsignacionesZonasRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // POST /api/asignarChofer
  router.post('/asignarChofer', withAuth, async (req, res) => {
    try {
      const { chofer_id, zona_id, empresa_id } = req.body || {};
      const choferIdNum = Number(chofer_id);
      const zonaIdNum = Number(zona_id);

      if (!Number.isInteger(choferIdNum) || !Number.isInteger(zonaIdNum)) {
        return res.status(400).json({ error: 'chofer_id y zona_id deben ser enteros' });
      }

      const esSuperAdmin = isSuper(req);
      let empresaId = esSuperAdmin && empresa_id ? Number(empresa_id) : getEmpresaIdFromToken(req);

      // 1) Validar zona y obtener empresa real de la zona (tenant-safe)
      const zonaRows = await query(
        'SELECT id, empresa_id FROM zonas_geograficas WHERE id = $1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [zonaIdNum, esSuperAdmin ? null : Number(empresaId)]
      );
      if (!zonaRows.length) {
        return res.status(400).json({ error: 'Zona no encontrada' });
      }
      const empresaZonaId = zonaRows[0].empresa_id;

      if (!esSuperAdmin && empresaId && empresaId !== empresaZonaId) {
        return res.status(403).json({ error: 'Zona no pertenece a tu empresa' });
      }

      // Forzar empresaId a la de la zona
      empresaId = empresaZonaId;

      // 2) Validar chofer y coherencia de empresa (tenant-safe)
      const choferRows = await query(
        'SELECT id, empresa_id FROM choferes WHERE id = $1 AND ($2::int IS NULL OR empresa_id=$2) LIMIT 1',
        [choferIdNum, esSuperAdmin ? null : Number(empresaId)]
      );
      if (!choferRows.length) {
        return res.status(400).json({ error: 'Chofer no encontrado' });
      }
      const empresaChoferId = choferRows[0].empresa_id;

      if (empresaChoferId !== empresaId) {
        return res.status(400).json({ error: 'Chofer y zona pertenecen a empresas distintas' });
      }

      // 3) Insertar asignación
      await query(
        `INSERT INTO zona_chofer (empresa_id, zona_id, chofer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (zona_id, chofer_id) DO NOTHING`,
        [empresaId, zonaIdNum, choferIdNum]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR ASIGNAR:', e);
      return res.status(500).json({ error: 'Error asignando: ' + (e.message || e) });
    }
  });

  // DELETE /api/desasignarChofer
  router.delete('/desasignarChofer', withAuth, async (req, res) => {
    try {
      const { chofer_id, zona_id, empresa_id } = req.body || {};
      const choferIdNum = Number(chofer_id);
      const zonaIdNum = Number(zona_id);

      if (!Number.isInteger(choferIdNum) || !Number.isInteger(zonaIdNum)) {
        return res.status(400).json({ error: 'chofer_id y zona_id deben ser enteros' });
      }

      const esSuperAdmin = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);
      const empresaId = esSuperAdmin && empresa_id ? Number(empresa_id) : myEmpresa;

      const rows = await query(
        'DELETE FROM zona_chofer WHERE chofer_id=$1 AND zona_id=$2 AND ($3::int IS NULL OR empresa_id=$3) RETURNING zona_id',
        [choferIdNum, zonaIdNum, esSuperAdmin ? null : Number(empresaId)]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'Asignación no encontrada o sin permiso' });
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('ERROR DESASIGNAR:', e);
      return res.status(500).json({ error: 'Error desasignando' });
    }
  });

  return router;
}
