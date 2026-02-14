import express from 'express';

export function createPublicLegacyMarketplaceRouter({ query }) {
  if (typeof query !== 'function') throw new Error('createPublicLegacyMarketplaceRouter: falta query(fn)');

  const router = express.Router();

  router.get('/marketplace', async (req, res) => {
    try {
      const lat = parseFloat(req.query.lat);
      const lng = parseFloat(req.query.lng);

      let empresas = [];

      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        empresas = await query(
          `SELECT DISTINCT e.id, e.nombre, e.rubro, e.etiquetas, e.landing_slug, e.landing_domain
           FROM empresas e
           JOIN zonas_geograficas z ON z.empresa_id = e.id
           WHERE (e.landing_slug IS NOT NULL OR e.landing_domain IS NOT NULL)
             AND z.geom IS NOT NULL
             AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
           ORDER BY e.id ASC`,
          [lng, lat]
        );
      } else {
        empresas = await query(
          `SELECT id, nombre, rubro, etiquetas, landing_slug, landing_domain
           FROM empresas
           WHERE landing_slug IS NOT NULL OR landing_domain IS NOT NULL
           ORDER BY id ASC`
        );
      }

      const resultados = [];
      for (const emp of empresas) {
        const productos = await query(
          `SELECT id, nombre, precio, imagen
           FROM productos
           WHERE empresa_id = $1
             AND (activo = true OR activo IS NULL)
             AND mostrar_en_catalogo = true
           ORDER BY destacado DESC, id ASC
           LIMIT 3`,
          [emp.id]
        );

        if (productos.length > 0) resultados.push({ ...emp, productos });
      }

      return res.json(resultados);
    } catch (e) {
      console.error('MARKETPLACE ERROR:', e);
      return res.status(500).json({ error: 'Error cargando marketplace' });
    }
  });

  return router;
}
