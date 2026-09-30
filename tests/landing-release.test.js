import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { registerLandingRoutes } from '../src/routes/landingRoutes.js';
import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';
async function serve(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(r => server.close(r)); }
}
test('canonical tenant landing and legacy company URL resolve only selected company', async () => {
  const app = express();
  registerLandingRoutes(app, { projectDir: path.resolve('.'), query: async (_sql, params) => params[0] === 'selected' || params[0] === 7 ? [{ id: 7, landing_slug: 'selected' }] : [] });
  await serve(app, async base => {
    const response = await fetch(base + '/landing/selected');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /LANDING_SLUG_NOT_FOUND/);
    const conflictingSelector = await fetch(base + '/landing/selected?slug=other&empresa_id=8&campaign=spring', { redirect: 'manual' });
    assert.equal(conflictingSelector.status, 302);
    assert.equal(conflictingSelector.headers.get('location'), '/landing/selected?campaign=spring');
    const old = await fetch(base + '/pages/empresa_7.html', { redirect: 'manual' });
    assert.equal(old.headers.get('location'), '/landing/selected');
    for (const url of ['/landing/unknown', '/landing/file.html', '/landing/a/b']) assert.equal((await fetch(base + url)).status, 404);
  });
});
test('all template filenames redirect to editor from old and current paths', async () => {
  const app = express();
  registerLandingRoutes(app, { projectDir: path.resolve('.'), query: async () => { throw Error('must not resolve tenant'); } });
  await serve(app, async base => {
    for (const name of fs.readdirSync('pages/landing').filter(n => n.endsWith('.html'))) {
      for (const prefix of ['/pages/', '/pages/landing/']) {
        const r = await fetch(base + prefix + name, { redirect: 'manual' });
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/pedidos/iaweb.html');
      }
    }
  });
});
test('scanner-style sensitive paths fail closed before landing fallback', async () => {
  const app = express();
  let queried = false;
  registerLandingRoutes(app, {
    projectDir: path.resolve('.'),
    query: async () => { queried = true; return [{ id: 1 }]; },
  });
  await serve(app, async base => {
    for (const url of [
      '/.env',
      '/%2eenv',
      '/.git-credentials',
      '/.npmrc',
      '/actuator/env',
      '/server-status',
      '/phpinfo.php',
      '/wp-includes/wlwmanifest.xml',
      '/xmlrpc.php',
    ]) {
      const response = await fetch(base + url, { redirect: 'manual' });
      assert.equal(response.status, 404, url);
      assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/i, url);
    }
    assert.equal(queried, false);
  });
});

test('landing raíz ignora Host/XFH y no resuelve tenant sin selector explícito', async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'landing-hostless-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Global</title><p>GLOBAL_INDEX</p>');
  let queried = false;
  const app = express();
  app.set('trust proxy', 1);
  registerLandingRoutes(app, {
    projectDir: root,
    query: async () => { queried = true; return [{ id: 7 }]; },
  });
  try {
    await serve(app, async base => {
      const response = await fetch(base + '/', {
        headers: { host: 'victima.example.test', 'x-forwarded-host': 'victima.example.test' },
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /GLOBAL_INDEX/);
      assert.equal(queried, false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public config fails closed for unknown, invalid, missing tenant and query errors', async () => {
  const app = express();
  const queries = [];
  const query = async (sql, params) => {
    queries.push(sql);
    if (params?.[0] === 'broken') throw Error('database unavailable');
    return [];
  };
  app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction: work => work(query) }));
  await serve(app, async base => {
    for (const suffix of ['?slug=unknown', '?slug=file.html', '?empresa_id=999', '?empresa_id=bad', '']) {
      assert.equal((await fetch(base + '/public/config' + suffix)).status, 400);
    }
    assert.equal((await fetch(base + '/public/config?slug=broken')).status, 500);
    assert.ok(queries.every(sql => !/landing_domain\s*=|LOWER\s*\(\s*landing_domain/i.test(sql)));
  });
});

test('publishing returns canonical URL, rejects missing slug and preserves tenant authorization', async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'landing-release-'));
  let slug = 'selected';
  const app = express();
  registerLandingRoutes(app, {
    projectDir: root,
    query: async (_sql, params) => [{ id: params[0], landing_slug: slug }],
    withAuth: (req, _res, next) => { req.user = { role: 'admin', empresa_id: 7 }; next(); }, resolveEmpresaId: () => 7, isSuper: () => false,
  });
  const upload = async (base, id) => {
    const form = new FormData();
    form.append('file', new Blob(['<!doctype html><title>Selected</title>'], { type: 'text/html' }), 'landing.html');
    return fetch(`${base}/api/empresas/${id}/landing-page`, { method: 'POST', body: form });
  };
  try {
    await serve(app, async base => {
      assert.equal((await upload(base, 8)).status, 403);
      const result = await upload(base, 7);
      assert.equal(result.status, 200);
      assert.equal((await result.json()).path, '/landing/selected');
      const before = fs.readFileSync(path.join(root, 'pages/empresa_7.html'), 'utf8');
      slug = null;
      assert.equal((await upload(base, 7)).status, 409);
      assert.equal(fs.readFileSync(path.join(root, 'pages/empresa_7.html'), 'utf8'), before);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('landing admin rechaza roles no canónicos antes del uploader, query y filesystem', async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'landing-role-guard-'));
  const roles = ['repartidor', 'user', 'referente', 'facturacion', 'contable', ' admin', 'ADMIN', 'admin '];
  let role = roles[0];
  let queries = 0;
  const app = express();
  registerLandingRoutes(app, {
    projectDir: root,
    query: async () => { queries += 1; return [{ id: 7, landing_slug: 'selected' }]; },
    withAuth: (req, _res, next) => { req.user = { role, empresa_id: 7 }; next(); },
    resolveEmpresaId: () => 7,
    isSuper: req => req.user?.role === 'super',
  });
  try {
    await serve(app, async base => {
      for (const candidate of roles) {
        role = candidate;
        const oversized = new FormData();
        oversized.append('file', new Blob(['x'.repeat(600 * 1024)], { type: 'text/html' }), 'landing.html');
        const upload = await fetch(`${base}/api/empresas/7/landing-page`, { method: 'POST', body: oversized });
        assert.equal(upload.status, 403, candidate);
        assert.equal(await upload.text(), '{"error":"Acceso denegado"}', candidate);
        assert.equal((await fetch(`${base}/api/empresas/7/landing-page`, { method: 'DELETE' })).status, 403, candidate);
      }
      assert.equal(queries, 0);
      assert.equal(fs.existsSync(path.join(root, 'pages/empresa_7.html')), false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('landing admin permite admin tenant y super explícito, y bloquea cross-tenant admin', async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'landing-role-success-'));
  let user = { role: 'admin', empresa_id: 7 };
  const app = express();
  registerLandingRoutes(app, {
    projectDir: root,
    query: async (_sql, params) => [{ id: params[0], landing_slug: `empresa-${params[0]}` }],
    withAuth: (req, _res, next) => { req.user = user; next(); },
    resolveEmpresaId: req => req.user.empresa_id,
    isSuper: req => req.user.role === 'super',
  });
  const upload = async (base, id) => {
    const form = new FormData();
    form.append('file', new Blob([`<!doctype html>${id}`], { type: 'text/html' }), 'landing.html');
    return fetch(`${base}/api/empresas/${id}/landing-page`, { method: 'POST', body: form });
  };
  try {
    await serve(app, async base => {
      assert.equal((await upload(base, 7)).status, 200);
      assert.equal((await upload(base, 8)).status, 403);
      assert.equal(fs.existsSync(path.join(root, 'pages/empresa_8.html')), false);
      user = { role: 'super', empresa_id: null };
      assert.equal((await upload(base, 8)).status, 200);
      assert.equal((await fetch(`${base}/api/empresas/8/landing-page`, { method: 'DELETE' })).status, 200);
      assert.equal(fs.existsSync(path.join(root, 'pages/empresa_8.html')), false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
