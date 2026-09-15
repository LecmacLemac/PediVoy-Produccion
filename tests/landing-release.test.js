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
test('public config fails closed for unknown, invalid, missing tenant and query errors', async () => {
  const app = express();
  const queries = [];
  app.use('/public', createPublicLegacyCatalogRouter({ query: async (sql, params) => {
    queries.push(sql);
    if (params?.[0] === 'broken') throw Error('database unavailable');
    if (sql.includes('ORDER BY')) return [{ id: 1 }];
    return [];
  } }));
  await serve(app, async base => {
    for (const suffix of ['?slug=unknown', '?slug=file.html', '?empresa_id=999', '?empresa_id=bad', '']) {
      assert.equal((await fetch(base + '/public/config' + suffix)).status, 404);
    }
    assert.equal((await fetch(base + '/public/config?slug=broken')).status, 500);
    assert.ok(queries.every(sql => !sql.includes('ORDER BY')));
  });
});

test('publishing returns canonical URL, rejects missing slug and preserves tenant authorization', async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'landing-release-'));
  let slug = 'selected';
  const app = express();
  registerLandingRoutes(app, {
    projectDir: root,
    query: async (_sql, params) => [{ id: params[0], landing_slug: slug }],
    withAuth: (_req, _res, next) => next(), resolveEmpresaId: () => 7, isSuper: () => false,
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
