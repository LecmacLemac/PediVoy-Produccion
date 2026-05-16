// src/routes/publicLanding.js
// Rutas públicas para landings (sin auth)

import express from 'express';

function normalizeHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return h.replace(/^www\./, '');
}

export function createPublicLandingRouter(deps) {
  const { query } = deps || {};
  if (typeof query !== 'function') throw new Error('createPublicLandingRouter: falta query(fn)');

  const router = express.Router();

  // GET /api/public/config
  router.get('/config', async (req, res) => {
    try {
      const host = normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);
      const rows = await query(
        'SELECT id AS empresa_id, nombre, landing_slug FROM empresas WHERE landing_domain = $1 LIMIT 1',
        [host]
      );
      return res.json(rows[0] || {});
    } catch {
      return res.status(500).json({});
    }
  });

  // GET /api/public/productos
  router.get('/productos', async (req, res) => {
    try {
      const empresaId = Number(req.query?.empresa_id);
      const scope = req.query?.scope; // 'landing' o null

      if (!empresaId) return res.json([]);

      let sql = `
        SELECT id, nombre, descripcion, precio, imagen, imagen_promo, etiqueta, categoria
        FROM productos
        WHERE empresa_id = $1
          AND activo = true
      `;

      if (scope === 'landing') {
        sql += ` AND mostrar_en_landing = true`;
      }

      sql += ` ORDER BY orden ASC, id DESC`;

      const rows = await query(sql, [empresaId]);
      return res.json(rows);
    } catch (e) {
      console.error('Error public products:', e);
      return res.status(500).json({ error: 'Error cargando catálogo' });
    }
  });

  // GET /api/public/pedidos/ultimo
  router.get('/pedidos/ultimo', async (req, res) => {
    try {
      const empresaId = Number(req.query?.empresa_id);
      const telefono = req.query?.telefono;

      if (!empresaId || !telefono) return res.status(400).json({ error: 'Datos incompletos' });

      const rows = await query(
        `
        SELECT p.id, p.estado, p.monto, p.fecha
        FROM pedidos p
        JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE pe.empresa_id = $1
          AND pe.telefono_normalizado LIKE '%' || $2
        ORDER BY p.id DESC LIMIT 1
        `,
        [empresaId, String(telefono).slice(-10)]
      );

      if (rows.length) return res.json(rows[0]);
      return res.json({});
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error buscando pedido' });
    }
  });

  return router;
}
