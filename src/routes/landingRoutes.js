// src/routes/landingRoutes.js
// Extraído desde server.js para reducir el monolito.

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';

// Helper: nombre y path del archivo HTML asociado a una empresa
function getEmpresaLandingFilename(empresaId) {
  return `empresa_${empresaId}.html`;
}

function normalizeHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return h.replace(/^www\./, '');
}

function resolveDefaultIndex(projectDir) {
  const htm = path.join(projectDir, 'index.htm');
  const html = path.join(projectDir, 'index.html');
  if (fs.existsSync(htm)) return htm;
  if (fs.existsSync(html)) return html;
  return null;
}

/**
 * Registra:
 * - Ruteo inteligente de / (landing por empresa) vs index global
 * - Endpoints para subir/borrar landing HTML por empresa
 * - Static /pages
 */
export function registerLandingRoutes(app, deps) {
  const {
    projectDir,
    query,
    withAuth,
    resolveEmpresaId,
    isSuper,
  } = deps;

  if (!projectDir) throw new Error('registerLandingRoutes: falta projectDir');
  if (typeof query !== 'function') throw new Error('registerLandingRoutes: query debe ser función');

  const PAGES_DIR = path.join(projectDir, 'pages');
  if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });

  function getEmpresaLandingPath(empresaId) {
    return path.join(PAGES_DIR, getEmpresaLandingFilename(empresaId));
  }

  const DEFAULT_INDEX = resolveDefaultIndex(projectDir);

  // Uploader para LANDINGS HTML
  const pagesUploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 }, // ~500KB
    fileFilter: (_, file, cb) => {
      const name = (file.originalname || '').toLowerCase();
      const isHtml = file.mimetype === 'text/html' || name.endsWith('.html') || name.endsWith('.htm');
      cb(isHtml ? null : new Error('Solo se permiten archivos .html'), isHtml);
    },
  });

  async function resolvePagePath(req) {
    // A) ?slug=xyz
    const slugParamRaw = (req.query?.slug || '').toString().trim().toLowerCase();
    if (slugParamRaw) {
      if (/^\d+$/.test(slugParamRaw)) {
        const empresaId = Number(slugParamRaw);
        const byId = getEmpresaLandingPath(empresaId);
        if (fs.existsSync(byId)) return byId;
      } else {
        const cleanSlug = /^[a-z0-9_-]+$/.test(slugParamRaw) ? slugParamRaw : '';
        if (cleanSlug) {
          try {
            const rows = await query(
              `SELECT id
               FROM empresas
               WHERE LOWER(landing_slug) = $1
               LIMIT 1`,
              [cleanSlug]
            );
            if (rows?.length) {
              const empresaId = rows[0].id;
              const bySlug = getEmpresaLandingPath(empresaId);
              if (fs.existsSync(bySlug)) return bySlug;
            }
          } catch (e) {
            console.error('Error resolviendo slug landing:', e.message);
          }
        }
      }
    }

    if (req.query?.slug !== undefined) return null;

    // B) ?empresa_id=123
    const empresaIdParam = (req.query?.empresa_id || '').toString().trim();
    if (empresaIdParam && /^\d+$/.test(empresaIdParam)) {
      const empresaId = Number(empresaIdParam);
      const byEmpresaParam = getEmpresaLandingPath(empresaId);
      if (fs.existsSync(byEmpresaParam)) return byEmpresaParam;
    }

    if (req.query?.empresa_id !== undefined) return null;

    // C) Dominio
    const host = normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);
    if (host.includes('localhost') || host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      return null;
    }

    try {
      const rows = await query(
        `SELECT id
         FROM empresas
         WHERE LOWER(landing_domain) = $1
            OR LOWER(landing_domain) = $2
         LIMIT 1`,
        [host, `www.${host}`]
      );

      if (rows?.length) {
        const empresaId = rows[0].id;
        const byDomain = getEmpresaLandingPath(empresaId);
        if (fs.existsSync(byDomain)) return byDomain;
      }
    } catch (e) {
      console.error('Error resolviendo dominio landing:', e.message);
    }

    return null;
  }

  async function serveDetectedPage(req, res) {
    try {
      const customPage = await resolvePagePath(req);
      if (customPage) return res.sendFile(customPage);
      if (req.query?.slug !== undefined || req.query?.empresa_id !== undefined) return res.sendStatus(404);
      if (DEFAULT_INDEX) return res.sendFile(DEFAULT_INDEX);
      return res.redirect('/pedidos/login.html');
    } catch (err) {
      console.error('Error en serveDetectedPage:', err);
      return res.status(500).send('Error interno en ruteo');
    }
  }

  // Template resources belong to the editor, never to tenant resolution.
  const templateDir = path.join(PAGES_DIR, 'landing');
  const templateNames = fs.existsSync(templateDir) ? fs.readdirSync(templateDir).filter(name => name.endsWith('.html')) : [];
  const templateNameSet = new Set(templateNames);
  const redirectTemplateToEditor = (req, res, next) => {
    if (!templateNameSet.has(req.params.template)) return next();
    return res.redirect('/pedidos/iaweb.html');
  };
  app.get('/pages/:template', redirectTemplateToEditor);
  app.get('/pages/landing/:template', redirectTemplateToEditor);
  app.use('/pages/landing', (_req, res) => res.sendStatus(404));

  app.get('/pages/empresa_:id.html', async (req, res) => {
    try {
      const rows = await query('SELECT landing_slug FROM empresas WHERE id = $1 LIMIT 1', [Number(req.params.id)]);
      const slug = rows?.[0]?.landing_slug;
      if (!/^[a-z0-9_-]+$/.test(slug || '')) return res.sendStatus(404);
      return res.redirect(`/landing/${encodeURIComponent(slug)}`);
    } catch { return res.sendStatus(500); }
  });
  app.get(['/landing/:slug', '/l/:slug'], async (req, res) => {
    const slug = req.params.slug.toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(slug)) return res.sendStatus(404);
    try {
      const rows = await query('SELECT id FROM empresas WHERE LOWER(landing_slug) = $1 LIMIT 1', [slug]);
      if (!rows?.length) return res.sendStatus(404);
      const file = getEmpresaLandingPath(rows[0].id);
      if (!fs.existsSync(file)) return res.sendStatus(404);
      return res.sendFile(file);
    } catch { return res.sendStatus(500); }
  });
  app.use(['/landing', '/l'], (_req, res) => res.sendStatus(404));

  // Static de /pages
  if (fs.existsSync(PAGES_DIR)) {
    app.use('/pages', express.static(PAGES_DIR, { index: false }));
  }

  // Archivo suelto en raíz (queda acá porque es parte del “frontend base”)
  app.get('/simple-cart.js', (req, res) => res.sendFile(path.join(projectDir, 'simple-cart.js')));

  // Rutas principales que disparan detección
  app.get('/', serveDetectedPage);
  app.get(['/index', '/index.html', '/index.htm'], serveDetectedPage);

  // EXCLUYENDO: /api, /public, /pedidos, /Transferencia, /Gastos, /Facturas
  app.get(/^\/(?!api\/|public\/|pedidos\/|Transferencia\/|Gastos\/|Facturas\/).*/, serveDetectedPage);

  // ------------------------------
  // API: subir/borrar landing HTML
  // ------------------------------
  if (withAuth && resolveEmpresaId && isSuper) {
    app.post(
      '/api/empresas/:id/landing-page',
      withAuth,
      pagesUploader.single('file'),
      async (req, res) => {
        try {
          const requestedId = Number(req.params.id);
          if (!Number.isFinite(requestedId) || requestedId <= 0) {
            return res.status(400).json({ error: 'empresa_id inválido' });
          }

          const authEmpresaId = resolveEmpresaId(req);
          if (!isSuper(req) && authEmpresaId !== requestedId) {
            return res.status(403).json({ error: 'No podés modificar esta empresa' });
          }

          if (!req.file) {
            return res.status(400).json({ error: 'Falta archivo .html' });
          }

          const rows = await query(
            'SELECT landing_slug FROM empresas WHERE id = $1 LIMIT 1',
            [requestedId]
          );

          if (!rows?.length) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
          }

          if (!/^[a-z0-9_-]+$/.test(rows[0].landing_slug || '')) {
            return res.status(409).json({ error: 'Configurá un slug válido antes de publicar' });
          }

          const html = req.file.buffer.toString('utf8');

          if (!fs.existsSync(PAGES_DIR)) {
            await fs.promises.mkdir(PAGES_DIR, { recursive: true });
          }

          const filePath = getEmpresaLandingPath(requestedId);
          await fs.promises.writeFile(filePath, html, 'utf8');

          console.log('Landing actualizada:', filePath);

          return res.json({
            ok: true,
            slug: rows[0].landing_slug,
            path: `/landing/${encodeURIComponent(rows[0].landing_slug)}`,
          });
        } catch (err) {
          console.error('Error subiendo landing html:', err);
          return res.status(500).json({ error: 'Error guardando página' });
        }
      }
    );

    app.delete('/api/empresas/:id/landing-page', withAuth, async (req, res) => {
      try {
        const requestedId = Number(req.params.id);
        if (!Number.isFinite(requestedId) || requestedId <= 0) {
          return res.status(400).json({ error: 'empresa_id inválido' });
        }

        const authEmpresaId = resolveEmpresaId(req);
        if (!isSuper(req) && authEmpresaId !== requestedId) {
          return res.status(403).json({ error: 'No podés modificar esta empresa' });
        }

        const filePath = getEmpresaLandingPath(requestedId);

        try {
          await fs.promises.unlink(filePath);
        } catch (e) {
          if (e.code !== 'ENOENT') {
            console.error('Error eliminando landing:', e);
            return res.status(500).json({ error: 'Error eliminando página' });
          }
        }

        return res.json({ ok: true });
      } catch (err) {
        console.error('Error en delete landing html:', err);
        return res.status(500).json({ error: 'Error interno' });
      }
    });
  } else {
    console.warn('[landingRoutes] No se registraron endpoints /api/empresas/:id/landing-page (faltan deps)');
  }
}
