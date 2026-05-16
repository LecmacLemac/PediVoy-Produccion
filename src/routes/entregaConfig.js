// src/routes/entregaConfig.js
// Extraído desde server.js para reducir el monolito.

import express from 'express';

export function createEntregaConfigRouter(deps) {
  const { query, withAuth, resolveEmpresaId } = deps || {};
  if (typeof query !== 'function') throw new Error('createEntregaConfigRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createEntregaConfigRouter: falta withAuth(fn)');
  if (typeof resolveEmpresaId !== 'function') throw new Error('createEntregaConfigRouter: falta resolveEmpresaId(fn)');

  const router = express.Router();

  // GET /api/entrega/config
  router.get('/config', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const rows = await query('SELECT config_entrega FROM empresas WHERE id=$1', [empresaId]);
      return res.json(rows[0]?.config_entrega || {});
    } catch (e) {
      console.error('ENTREGA CONFIG GET ERROR', e);
      return res.status(500).json({ error: 'Error leyendo configuración de entrega' });
    }
  });

  // PUT /api/entrega/config
  router.put('/config', withAuth, async (req, res) => {
    try {
      const empresaId = resolveEmpresaId(req);
      const nuevaConfig = req.body || {};

      // por si viene empresa_id dentro del payload
      delete nuevaConfig.empresa_id;

      await query('UPDATE empresas SET config_entrega = $1 WHERE id = $2', [
        JSON.stringify(nuevaConfig),
        empresaId,
      ]);

      return res.json({ ok: true });
    } catch (e) {
      console.error('ENTREGA CONFIG PUT ERROR', e);
      return res.status(500).json({ error: 'Error guardando configuración de entrega' });
    }
  });

  return router;
}
