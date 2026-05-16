// src/routes/analytics.js
import express from 'express';

export function createAnalyticsRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createAnalyticsRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAnalyticsRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createAnalyticsRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createAnalyticsRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  function resolveEmpresa(req) {
    const esSuper = isSuper(req);
    const empresaQ = Number(req.query?.empresa_id || 0);
    if (esSuper && empresaQ > 0) return empresaQ;
    return Number(getEmpresaIdFromToken(req) || 0);
  }

  function buildFilters(req, withExtra = false) {
    const empresaId = resolveEmpresa(req);
    const params = [empresaId];
    const where = ['pv.empresa_id = $1'];

    const from = String(req.query?.from || '').trim();
    const to = String(req.query?.to || '').trim();
    const path = String(req.query?.path || '').trim();
    const userTipo = String(req.query?.user_tipo || '').trim();
    const device = String(req.query?.device || '').trim().toLowerCase();

    if (from) {
      params.push(from + ' 00:00:00');
      where.push(`pv.created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to + ' 23:59:59');
      where.push(`pv.created_at <= $${params.length}`);
    }
    if (path) {
      params.push(path);
      where.push(`pv.path = $${params.length}`);
    }
    if (userTipo) {
      params.push(userTipo);
      where.push(`COALESCE(pv.user_agent, '') ILIKE CASE WHEN $${params.length}='chofer' THEN '%chofer%' WHEN $${params.length}='empresa' THEN '%empresa%' ELSE '%' END`);
    }
    if (withExtra && device) {
      params.push('%' + device + '%');
      where.push(`LOWER(COALESCE(pv.user_agent,'')) LIKE $${params.length}`);
    }

    return { empresaId, where: where.join(' AND '), params };
  }

  const userTypeExpr = `
    CASE
      WHEN COALESCE(pv.user_agent,'') ILIKE '%chofer%' THEN 'chofer'
      WHEN COALESCE(pv.user_agent,'') ILIKE '%empresa%' THEN 'empresa'
      ELSE 'desconocido'
    END
  `;

  const deviceExpr = `
    CASE
      WHEN COALESCE(pv.user_agent,'') ILIKE '%android%' THEN 'android'
      WHEN COALESCE(pv.user_agent,'') ILIKE '%iphone%' OR COALESCE(pv.user_agent,'') ILIKE '%ios%' THEN 'ios'
      WHEN COALESCE(pv.user_agent,'') ILIKE '%windows%' THEN 'windows'
      WHEN COALESCE(pv.user_agent,'') ILIKE '%macintosh%' THEN 'mac'
      ELSE 'otro'
    END
  `;

  router.get('/summary', withAuth, async (req, res) => {
    try {
      const { empresaId, where, params } = buildFilters(req);
      if (!empresaId) return res.status(400).json({ error: 'Empresa no detectada' });

      const [totals, topPages, events] = await Promise.all([
        query(
          `SELECT COUNT(*)::int AS views, COUNT(DISTINCT COALESCE(session_id, ip))::int AS unique_visitors
             FROM page_views pv
            WHERE ${where}`,
          params
        ),
        query(
          `SELECT pv.path, COUNT(*)::int AS views
             FROM page_views pv
            WHERE ${where}
            GROUP BY pv.path
            ORDER BY views DESC
            LIMIT 10`,
          params
        ),
        query(
          `SELECT
              to_char(pv.created_at, 'YYYY-MM-DD HH24:MI:SS') AS timestamp,
              pv.path,
              COALESCE(pve.tipo, 'view') AS metodo,
              ${userTypeExpr} AS user_tipo,
              ${deviceExpr} AS dispositivo,
              pv.ip
           FROM page_views pv
           LEFT JOIN page_view_events pve ON pve.page_view_id = pv.id
           WHERE ${where}
           ORDER BY pv.created_at DESC
           LIMIT 200`,
          params
        )
      ]);

      res.json({
        totales: totals?.[0] || { views: 0, unique_visitors: 0 },
        topPages: topPages || [],
        eventos: events || [],
      });
    } catch (e) {
      console.error('ANALYTICS SUMMARY ERROR:', e);
      res.status(500).json({ error: 'Error obteniendo summary de analytics' });
    }
  });

  router.get('/timeseries', withAuth, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, Number(req.query?.days || 30)));
      const { empresaId, where, params } = buildFilters(req);
      if (!empresaId) return res.status(400).json({ error: 'Empresa no detectada' });

      params.push(days);
      const data = await query(
        `SELECT
            to_char((pv.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS views
         FROM page_views pv
         WHERE ${where}
           AND pv.created_at >= NOW() - ($${params.length}::text || ' days')::interval
         GROUP BY 1
         ORDER BY 1`,
        params
      );
      res.json({ data: data || [] });
    } catch (e) {
      console.error('ANALYTICS TIMESERIES ERROR:', e);
      res.status(500).json({ error: 'Error obteniendo serie temporal' });
    }
  });

  router.get('/top-pages', withAuth, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 10)));
      const { empresaId, where, params } = buildFilters(req);
      if (!empresaId) return res.status(400).json({ error: 'Empresa no detectada' });
      params.push(limit);
      const data = await query(
        `SELECT pv.path, COUNT(*)::int AS views
         FROM page_views pv
         WHERE ${where}
         GROUP BY pv.path
         ORDER BY views DESC
         LIMIT $${params.length}`,
        params
      );
      res.json({ data: data || [] });
    } catch (e) {
      console.error('ANALYTICS TOP PAGES ERROR:', e);
      res.status(500).json({ error: 'Error obteniendo top páginas' });
    }
  });

  router.get('/devices', withAuth, async (req, res) => {
    try {
      const { empresaId, where, params } = buildFilters(req, true);
      if (!empresaId) return res.status(400).json({ error: 'Empresa no detectada' });
      const data = await query(
        `SELECT ${deviceExpr} AS dispositivo, COUNT(*)::int AS total
         FROM page_views pv
         WHERE ${where}
         GROUP BY 1
         ORDER BY total DESC`,
        params
      );
      res.json({ data: data || [] });
    } catch (e) {
      console.error('ANALYTICS DEVICES ERROR:', e);
      res.status(500).json({ error: 'Error obteniendo dispositivos' });
    }
  });

  router.get('/users', withAuth, async (req, res) => {
    try {
      const { empresaId, where, params } = buildFilters(req);
      if (!empresaId) return res.status(400).json({ error: 'Empresa no detectada' });
      const data = await query(
        `SELECT ${userTypeExpr} AS user_tipo, COUNT(*)::int AS total
         FROM page_views pv
         WHERE ${where}
         GROUP BY 1
         ORDER BY total DESC`,
        params
      );
      res.json({ data: data || [] });
    } catch (e) {
      console.error('ANALYTICS USERS ERROR:', e);
      res.status(500).json({ error: 'Error obteniendo tipos de usuario' });
    }
  });

  router.get('/zonas', withAuth, async (_req, res) => {
    // Placeholder compatible con UI anterior
    res.json({ data: [] });
  });

  return router;
}
