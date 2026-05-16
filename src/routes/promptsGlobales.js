// src/routes/promptsGlobales.js
import express from 'express';
import { withAuth, isSuper } from '../services.js';
import { query } from '../db.js';

export function createPromptsGlobalesRouter() {
  const router = express.Router();

  // 1) Obtener prompts globales
  router.get('/global', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Acceso denegado' });
    try {
      const rows = await query(
        `SELECT tipo, contenido, updated_at
         FROM empresa_prompts
         WHERE empresa_id IS NULL
         ORDER BY tipo`
      );
      res.json(rows);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error al leer configuración' });
    }
  });

  // 2) Guardar/Actualizar prompt global
  router.post('/global', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Acceso denegado' });

    const { tipo, contenido } = req.body || {};
    if (!tipo || !contenido) return res.status(400).json({ error: 'Datos incompletos' });

    try {
      await query(
        `
        INSERT INTO empresa_prompts (empresa_id, tipo, contenido, updated_at)
        VALUES (NULL, $1, $2, NOW())
        ON CONFLICT (tipo) WHERE empresa_id IS NULL
        DO UPDATE SET
          contenido = EXCLUDED.contenido,
          updated_at = NOW()
        `,
        [tipo, contenido]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('Error guardando prompt global:', e);
      res.status(500).json({ error: 'Error al guardar' });
    }
  });

  // 3) Eliminar prompt global
  router.delete('/global/:tipo', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Acceso denegado' });
    try {
      await query(
        `DELETE FROM empresa_prompts WHERE empresa_id IS NULL AND tipo = $1`,
        [req.params.tipo]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Error al eliminar' });
    }
  });

  return router;
}
