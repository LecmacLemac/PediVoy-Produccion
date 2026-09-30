import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import express from 'express';
import puppeteer from 'puppeteer';
import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';
import { createPublicLandingRouter } from '../src/routes/publicLanding.js';
import { resolvePublicPedidoEmpresaId } from '../src/services/publicPedidoTenant.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);

async function serve(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function tenantQueryFixture() {
  const calls = [];
  const tenants = [
    { id: 1, nombre: 'Tenant Uno', landing_slug: 'tenant-uno', landing_domain: 'uno.example.test', logo_url: null, config_operativa: {}, active: true },
    { id: 2, nombre: 'Tenant Dos', landing_slug: 'tenant-dos', landing_domain: 'dos.example.test', logo_url: null, config_operativa: {}, active: true },
    { id: 3, nombre: 'Inactivo', landing_slug: 'inactivo', landing_domain: 'inactivo.example.test', logo_url: null, config_operativa: {}, active: false },
    { id: 4, nombre: 'Vencido', landing_slug: 'vencido', landing_domain: 'vencido.example.test', logo_url: null, config_operativa: {}, active: false },
    { id: 5, nombre: 'Plan inválido', landing_slug: 'plan-invalido', landing_domain: 'plan.example.test', logo_url: null, config_operativa: {}, active: false },
    { id: 6, nombre: 'Duplicado A', landing_slug: 'duplicado', landing_domain: 'dup-a.example.test', logo_url: null, config_operativa: {}, active: true },
    { id: 7, nombre: 'Duplicado B', landing_slug: 'duplicado', landing_domain: 'dup-b.example.test', logo_url: null, config_operativa: {}, active: true },
  ];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/landing_domain\s*=|LOWER\s*\(\s*landing_domain/i.test(sql)) throw new Error('landing_domain lookup forbidden');
    if (/SELECT\s+id\s+FROM empresas/i.test(sql)) {
      if (/landing_slug/i.test(sql)) {
        return tenants.filter((t) => t.active && t.landing_slug === params[0]).map((t) => ({ id: t.id })).slice(0, 2);
      }
      return tenants.filter((t) => t.active && t.id === params[0]).map((t) => ({ id: t.id })).slice(0, 2);
    }
    if (/FROM empresas/i.test(sql) && /WHERE id = \$1/i.test(sql)) {
      const row = tenants.find((t) => t.id === params[0]);
      if (!row) return [];
      return /id AS empresa_id/i.test(sql) ? [{ empresa_id: row.id, nombre: row.nombre, landing_slug: row.landing_slug }] : [row];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  return { calls, query };
}

function makeConfigApp(query) {
  const app = express();
  app.set('trust proxy', 1);
  const withTransaction = work => work(query);
  app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction }));
  app.use('/api/public', createPublicLandingRouter({ query, withTransaction }));
  return app;
}

async function getJson(base, pathname, headers = {}) {
  const response = await fetch(base + pathname, { headers });
  return { status: response.status, body: await response.json() };
}

test('configs públicos ignoran Host/XFH y sin selector fallan 400 sin lookup de dominio', async () => {
  const fixture = tenantQueryFixture();
  const app = makeConfigApp(fixture.query);
  await serve(app, async (base) => {
    for (const pathname of ['/public/config', '/api/public/config']) {
      const result = await getJson(base, pathname, {
        host: 'uno.example.test',
        'x-forwarded-host': 'dos.example.test',
        forwarded: 'host=tres.example.test',
      });
      assert.equal(result.status, 400, pathname);
      assert.equal(result.body.code, 'PUBLIC_TENANT_UNRESOLVED', pathname);
    }
  });
  assert.equal(fixture.calls.length, 0);
});

test('ambos configs comparten éxito por slug/id, concordancia y conflicto estable', async () => {
  for (const pathname of ['/public/config', '/api/public/config']) {
    const fixture = tenantQueryFixture();
    const app = makeConfigApp(fixture.query);
    await serve(app, async (base) => {
      for (const suffix of ['?slug=tenant-uno', '?empresa_id=1', '?slug=tenant-uno&empresa_id=1']) {
        const result = await getJson(base, pathname + suffix);
        assert.equal(result.status, 200, `${pathname}${suffix}`);
        assert.equal(result.body.empresa_id, 1);
        assert.equal(result.body.nombre, 'Tenant Uno');
      }
      const conflict = await getJson(base, pathname + '?slug=tenant-uno&empresa_id=2');
      assert.equal(conflict.status, 403);
      assert.equal(conflict.body.code, 'PUBLIC_TENANT_CONFLICT');
    });
  }
});

test('ambos configs fallan cerrado para duplicado, inexistente, inactivo, vencido y plan inválido', async () => {
  for (const pathname of ['/public/config', '/api/public/config']) {
    const fixture = tenantQueryFixture();
    const app = makeConfigApp(fixture.query);
    await serve(app, async (base) => {
      const ambiguous = await getJson(base, pathname + '?slug=duplicado');
      assert.equal(ambiguous.status, 409);
      assert.equal(ambiguous.body.code, 'PUBLIC_TENANT_AMBIGUOUS');
      for (const suffix of ['?slug=inexistente', '?empresa_id=999', '?slug=inactivo', '?slug=vencido', '?slug=plan-invalido']) {
        const result = await getJson(base, pathname + suffix);
        assert.equal(result.status, 400, `${pathname}${suffix}`);
        assert.equal(result.body.code, 'PUBLIC_TENANT_UNRESOLVED');
      }
    });
  }
});

test('empresa_id público exige string decimal canónica segura y rechaza shapes coercibles', async () => {
  const accepted = [];
  const query = async (_sql, params) => {
    accepted.push(params[0]);
    return [{ id: params[0] }];
  };
  assert.equal(await resolvePublicPedidoEmpresaId({ method: 'GET', query: { empresa_id: '1' } }, query), 1);
  assert.deepEqual(accepted, [1]);
  for (const value of ['1x', '1.0', '01', '0', '-1', '9007199254740992', true, false, ['1'], { 0: '1' }]) {
    await assert.rejects(
      resolvePublicPedidoEmpresaId({ method: 'GET', query: { empresa_id: value } }, query),
      (error) => error?.code === 'PUBLIC_TENANT_UNRESOLVED' && error?.statusCode === 400,
      String(value)
    );
  }
  assert.deepEqual(accepted, [1]);
});

test('body empresa_id no es autoridad ni concordancia en GET', async () => {
  const query = async (_sql, params) => [{ id: params[0] }];
  assert.equal(await resolvePublicPedidoEmpresaId({ method: 'GET', query: { empresa_id: '1' }, body: { empresa_id: 2 } }, query), 1);
});

test('carrito exige selector, preserva canal original y bloquea config discordante', async () => {
  const app = express();
  const requests = [];
  app.use(express.json());
  app.get('/public/config', (req, res) => {
    requests.push({ kind: 'config', url: req.originalUrl });
    const id = req.query.slug === 'tenant-uno' ? 1 : Number(req.query.empresa_id);
    const returnedId = req.query.empresa_id === '9' ? 10 : id;
    res.json({ empresa_id: returnedId, nombre: 'Tenant', landing_slug: req.query.slug || null });
  });
  app.get('/public/productos', (req, res) => {
    requests.push({ kind: 'productos', url: req.originalUrl });
    res.json([{ id: 11, nombre: 'Bidón', precio: 100 }]);
  });
  app.get('/public/contacto', (_req, res) => res.json({ ok: true, found: false }));
  app.post('/public/pedidos', (req, res) => {
    requests.push({ kind: 'pedido', url: req.originalUrl, body: req.body });
    res.json({ ok: true, pedido: {} });
  });
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));

  await serve(app, async (base) => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const missing = await browser.newPage();
      await missing.goto(base + '/pedidos/');
      await missing.waitForFunction(() => document.body.textContent.includes('identificar la tienda'));
      assert.equal(requests.length, 0);
      assert.equal(await missing.$eval('#mobSubmit', (el) => el.disabled), true);

      async function submitFrom(search) {
        const page = await browser.newPage();
        await page.goto(base + '/pedidos/' + search);
        await page.waitForSelector('button[data-action="add-to-cart"]');
        await page.click('button[data-action="add-to-cart"]');
        await page.type('[name="cliente"]', 'Cliente Test');
        await page.type('[name="telefono"]', '3531234567');
        await page.type('[name="direccion"]', 'Calle 123');
        await page.type('[name="ciudad"]', 'Ciudad');
        const pedidoResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === 'POST' && url.pathname === '/public/pedidos';
        });
        await page.$eval('#form', (form) => form.requestSubmit());
        const response = await pedidoResponse;
        assert.equal(response.status(), 200);
        await page.close();
      }

      await submitFrom('?slug=tenant-uno');
      await submitFrom('?empresa_id=1');
      const posts = requests.filter((item) => item.kind === 'pedido');
      assert.equal(posts.length, 2, JSON.stringify(requests));
      assert.equal(posts[0].url, '/public/pedidos?slug=tenant-uno');
      assert.equal(posts[1].url, '/public/pedidos?empresa_id=1');
      assert.equal(Object.hasOwn(posts[0].body, 'empresa_id'), false);
      assert.equal(Object.hasOwn(posts[1].body, 'empresa_id'), false);

      const discordant = await browser.newPage();
      await discordant.goto(base + '/pedidos/?empresa_id=9');
      await discordant.waitForFunction(() => document.body.textContent.includes('identificar la tienda'));
      assert.equal(requests.some((item) => item.kind === 'productos' && item.url.includes('empresa_id=10')), false);
      assert.equal(await discordant.$eval('#mobSubmit', (el) => el.disabled), true);
    } finally {
      await browser.close();
    }
  });
});

test('inventario estructural: montajes config usan resolver común y callers no dependen de host', () => {
  const legacy = fs.readFileSync(path.join(root, 'src/routes/publicLegacyCatalog.js'), 'utf8');
  const landing = fs.readFileSync(path.join(root, 'src/routes/publicLanding.js'), 'utf8');
  const resolver = fs.readFileSync(path.join(root, 'src/services/publicPedidoTenant.js'), 'utf8');
  const landingRoutes = fs.readFileSync(path.join(root, 'src/routes/landingRoutes.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const modules = fs.readFileSync(path.join(root, 'src/routes/mountApiModules.js'), 'utf8');
  for (const source of [legacy, landing, resolver, landingRoutes]) {
    assert.doesNotMatch(source, /x-forwarded-host|headers(?:\?\.)?\.host|LOWER\s*\(\s*landing_domain|landing_domain\s*=\s*\$1/i);
  }
  assert.match(legacy, /resolvePublicPedidoEmpresaId/);
  assert.match(landing, /resolvePublicPedidoEmpresaId/);
  assert.match(landingRoutes, /resolvePublicPedidoEmpresaId/);
  assert.match(app, /app\.use\('\/public', createPublicLegacyCatalogRouter/);
  assert.match(modules, /app\.use\('\/api\/public', createPublicLandingRouter/);

  const productionCallers = [];
  for (const base of ['index.html', 'pedidos', 'pages']) {
    const start = path.join(root, base);
    const files = fs.statSync(start).isDirectory()
      ? fs.readdirSync(start, { recursive: true }).filter((name) => /\.(?:html|js)$/.test(name)).map((name) => path.join(start, name))
      : [start];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('/public/config') || source.includes('/api/public/config')) productionCallers.push([path.relative(root, file), source]);
    }
  }
  assert.ok(productionCallers.length >= 10);
  for (const [file, source] of productionCallers) {
    assert.doesNotMatch(source, /fetch\(\s*['"]\/public\/config['"]\s*[,)]/, file);
    assert.doesNotMatch(source, /x-forwarded-host|document\.location\.host|location\.host/i, file);
  }
});

test('scripts inline del carrito pasan node --check extraídos', () => {
  const html = fs.readFileSync(path.join(root, 'pedidos/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedidos-inline-'));
  try {
    for (const [index, source] of scripts.entries()) {
      const file = path.join(dir, `inline-${index}.mjs`);
      fs.writeFileSync(file, source);
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
