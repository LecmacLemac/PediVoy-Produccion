import express from 'express';

export function createPromocionesRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createPromocionesRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createPromocionesRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createPromocionesRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createPromocionesRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  function resolveEmpresa(req) {
    const superAdmin = isSuper(req);
    let empresaId = getEmpresaIdFromToken(req);
    if (superAdmin && req.query?.empresa_id) {
      empresaId = Number(req.query.empresa_id);
    }
    return { superAdmin, empresaId: Number(empresaId || 0) || null };
  }

  router.get('/dashboard', withAuth, async (req, res) => {
    try {
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const [summary] = await query(
        `SELECT
           COUNT(*) FILTER (WHERE p.promo_config IS NOT NULL AND (p.promo_config->'once_per_client_gift'->>'enabled')::boolean IS TRUE)::int AS promos_activas,
           COUNT(*) FILTER (WHERE p.promo_config IS NOT NULL AND COALESCE((p.promo_config->'once_per_client_gift'->>'discount_percent')::numeric,0) > 0)::int AS promos_con_descuento,
           COUNT(*) FILTER (WHERE p.promo_config IS NOT NULL AND COALESCE((p.promo_config->'once_per_client_gift'->>'gift_product_id')::int,0) > 0)::int AS promos_con_regalo
         FROM productos p
        WHERE p.empresa_id = $1
          AND p.deleted_at IS NULL`,
        [empresaId]
      );

      const [redemptions] = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30d,
           COUNT(DISTINCT punto_entrega_id)::int AS unique_clients
         FROM promociones_redenciones
        WHERE empresa_id = $1`,
        [empresaId]
      );

      const [pointsRow] = await query(
        `SELECT
           COALESCE(SUM(puntos),0)::int AS points_issued_total,
           COALESCE(SUM(puntos) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'),0)::int AS points_issued_30d,
           COUNT(DISTINCT punto_entrega_id)::int AS points_clients
         FROM puntos_movimientos
        WHERE empresa_id = $1
          AND tipo = 'acumulacion_entrega'`,
        [empresaId]
      );

      const items = await query(
        `SELECT
           p.id,
           p.nombre,
           p.promo_config,
           COALESCE(pr.total, 0)::int AS redemptions_total,
           COALESCE(pr.last_30d, 0)::int AS redemptions_30d
         FROM productos p
         LEFT JOIN (
           SELECT trigger_producto_id,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30d
             FROM promociones_redenciones
            WHERE empresa_id = $1
            GROUP BY trigger_producto_id
         ) pr ON pr.trigger_producto_id = p.id
        WHERE p.empresa_id = $1
          AND p.deleted_at IS NULL
          AND p.promo_config IS NOT NULL
        ORDER BY p.nombre ASC`,
        [empresaId]
      );

      return res.json({
        kpis: {
          promos_activas: Number(summary?.promos_activas || 0),
          promos_con_regalo: Number(summary?.promos_con_regalo || 0),
          promos_con_descuento: Number(summary?.promos_con_descuento || 0),
          redemptions_total: Number(redemptions?.total || 0),
          redemptions_30d: Number(redemptions?.last_30d || 0),
          unique_clients: Number(redemptions?.unique_clients || 0),
          points_issued_total: Number(pointsRow?.points_issued_total || 0),
          points_issued_30d: Number(pointsRow?.points_issued_30d || 0),
          points_clients: Number(pointsRow?.points_clients || 0),
        },
        items,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error cargando tablero de promociones' });
    }
  });

  router.get('/config', withAuth, async (req, res) => {
    try {
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const rows = await query(
        `SELECT empresa_id, points_config, promos_config, updated_at
           FROM promociones_config
          WHERE empresa_id = $1
          LIMIT 1`,
        [empresaId]
      );

      const row = rows[0] || null;
      return res.json({
        empresa_id: empresaId,
        points_config: row?.points_config || {},
        promos_config: row?.promos_config || {},
        updated_at: row?.updated_at || null,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error leyendo configuración de promociones' });
    }
  });

  router.put('/config', withAuth, async (req, res) => {
    try {
      const { empresaId } = resolveEmpresa(req);
      if (!empresaId) return res.status(400).json({ error: 'Falta empresa.' });

      const pointsConfig = req.body?.points_config && typeof req.body.points_config === 'object'
        ? req.body.points_config
        : {};
      const promosConfig = req.body?.promos_config && typeof req.body.promos_config === 'object'
        ? req.body.promos_config
        : {};

      await query(
        `INSERT INTO promociones_config (empresa_id, points_config, promos_config, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, NOW())
         ON CONFLICT (empresa_id)
         DO UPDATE SET
           points_config = EXCLUDED.points_config,
           promos_config = EXCLUDED.promos_config,
           updated_at = NOW()`,
        [empresaId, JSON.stringify(pointsConfig), JSON.stringify(promosConfig)]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Error guardando configuración de promociones' });
    }
  });

  return router;
}
