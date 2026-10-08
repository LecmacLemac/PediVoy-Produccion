import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';
import { createPublicLandingRouter } from '../src/routes/publicLanding.js';
import { createPublicClientAppRouter } from '../src/routes/publicClientApp.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

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

function tenantFixture() {
  const calls = [];
  const tenants = new Map([
    [1, { id: 1, slug: 'uno', enabled: true }],
    [2, { id: 2, slug: 'dos', enabled: true }],
    [3, { id: 3, slug: 'inactivo', enabled: false }],
    [4, { id: 4, slug: 'vencido', enabled: false }],
    [5, { id: 5, slug: 'duplicado', enabled: true }],
    [6, { id: 6, slug: 'duplicado', enabled: true }],
  ]);
  const query = async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (/pg_advisory_xact_lock/i.test(sql)) return [];
    if (/SELECT\s+id\s+FROM empresas/i.test(sql)) {
      if (/landing_slug/i.test(sql)) {
        return [...tenants.values()].filter((t) => t.enabled && t.slug === params[0]).map(({ id }) => ({ id })).slice(0, 2);
      }
      const tenant = tenants.get(params[0]);
      return tenant?.enabled ? [{ id: tenant.id }] : [];
    }
    if (/FROM productos/i.test(sql)) return [{ id: 10, nombre: 'Producto' }];
    if (/FROM puntos_entrega/i.test(sql)) return [{ id: 20, cliente: 'Cliente' }];
    if (/FROM pedidos/i.test(sql)) return [{ id: 30, estado: 'pendiente', tracking_token: 'track' }];
    if (/FROM empresas/i.test(sql)) {
      const tenant = tenants.get(params[0]);
      return tenant ? [{ id: tenant.id, empresa_id: tenant.id, nombre: `Empresa ${tenant.id}`, landing_slug: tenant.slug }] : [];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  return { calls, tenants, query };
}

function businessCalls(calls) {
  return calls.filter(({ sql }) => /FROM (?:productos|puntos_entrega|pedidos)/i.test(sql));
}

async function jsonRequest(base, path, options) {
  const response = await fetch(base + path, options);
  const body = await response.json();
  return { response, body };
}

test('legacy públicos exigen selector común antes de toda query de negocio y nunca usan tenant 1 implícito', async () => {
  for (const mount of ['legacy', 'api']) {
    const fixture = tenantFixture();
    const app = express();
    const withTransaction = work => work(fixture.query);
    app.use(mount === 'legacy' ? '/public' : '/api/public', mount === 'legacy'
      ? createPublicLegacyCatalogRouter({ query: fixture.query, withTransaction })
      : createPublicLandingRouter({ query: fixture.query, withTransaction }));
    const requests = mount === 'legacy'
      ? [
          { path: '/productos' },
          {
            path: '/contacto',
            options: {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ telefono: '3531234567' }),
            },
          },
          { path: '/ultimo-pedido?telefono=3531234567' },
        ]
      : [{ path: '/productos' }, { path: '/pedidos/ultimo?telefono=3531234567' }];

    await serve(app, async (base) => {
      for (const request of requests) {
        const { response, body } = await jsonRequest(
          base,
          `${mount === 'legacy' ? '/public' : '/api/public'}${request.path}`,
          request.options,
        );
        assert.equal(response.status, 400, request.path);
        assert.equal(body.code, 'PUBLIC_TENANT_UNRESOLVED', request.path);
      }
    });
    assert.equal(businessCalls(fixture.calls).length, 0);
    assert.equal(fixture.calls.some(({ params }) => params.includes(1)), false);
  }
});

test('legacy públicos aceptan slug/id concordantes y fallan cerrado para conflicto, duplicado e inválidos', async () => {
  const fixture = tenantFixture();
  const app = express();
  app.use('/public', createPublicLegacyCatalogRouter({
    query: fixture.query,
    withTransaction: work => work(fixture.query),
  }));

  await serve(app, async (base) => {
    const ok = await jsonRequest(base, '/public/productos?slug=uno&empresa_id=1');
    assert.equal(ok.response.status, 200);
    assert.deepEqual(ok.body, [{ id: 10, nombre: 'Producto' }]);

    for (const [suffix, status, code] of [
      ['?slug=uno&empresa_id=2', 403, 'PUBLIC_TENANT_CONFLICT'],
      ['?slug=duplicado', 409, 'PUBLIC_TENANT_AMBIGUOUS'],
      ['?slug=inactivo', 400, 'PUBLIC_TENANT_UNRESOLVED'],
      ['?empresa_id=999', 400, 'PUBLIC_TENANT_UNRESOLVED'],
      ['?empresa_id=1.0', 400, 'PUBLIC_TENANT_UNRESOLVED'],
      ['?empresa_id=01', 400, 'PUBLIC_TENANT_UNRESOLVED'],
      ['?empresa_id=9007199254740992', 400, 'PUBLIC_TENANT_UNRESOLVED'],
      ['?empresa_id=1&empresa_id=2', 400, 'PUBLIC_TENANT_UNRESOLVED'],
    ]) {
      const result = await jsonRequest(base, `/public/productos${suffix}`);
      assert.equal(result.response.status, status, suffix);
      assert.equal(result.body.code, code, suffix);
    }
  });
});

function makeClientApp(fixture, pool) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/public/app', createPublicClientAppRouter({ query: fixture.query, pool }));
  return app;
}

function selector(path, value = 'empresa_id=1') {
  return `${path}${path.includes('?') ? '&' : '?'}${value}`;
}

test('OTP resuelve tenant explícito antes de generar código, enviar WhatsApp o consultar perfil', async () => {
  const fixture = tenantFixture();
  let outboxWrites = 0;
  const pool = createWppEnqueueTestPool({
    configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
    onQuery(request) {
      if (/INSERT INTO wpp_outbox/.test(request.text)) outboxWrites += 1;
      return undefined;
    },
  });
  const app = makeClientApp(fixture, pool);

  await serve(app, async (base) => {
    for (const suffix of ['', '?empresa_id=999', '?slug=inactivo', '?slug=uno&empresa_id=2', '?slug=duplicado']) {
      const result = await jsonRequest(base, `/api/public/app/auth/request-otp${suffix}`, {
        method: 'POST', headers: { 'content-type': 'application/json', host: 'uno.test', 'x-forwarded-host': 'dos.test' },
        body: JSON.stringify({ telefono: '353 123-4567' }),
      });
      assert.notEqual(result.response.status, 200, suffix || 'missing');
    }
    assert.equal(outboxWrites, 0);

    const requested = await jsonRequest(base, selector('/api/public/app/auth/request-otp'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ telefono: '353 123-4567' }),
    });
    assert.equal(requested.response.status, 200);
    assert.match(requested.body.debug_code, /^\d{6}$/);
    assert.equal(outboxWrites, 1);

    fixture.tenants.get(1).enabled = false;
    const before = businessCalls(fixture.calls).length;
    const verified = await jsonRequest(base, selector('/api/public/app/auth/verify-otp'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telefono: '353 123-4567', code: requested.body.debug_code }),
    });
    assert.equal(verified.response.status, 400);
    assert.equal(verified.body.code, 'PUBLIC_TENANT_UNRESOLVED');
    assert.equal(verified.response.headers.get('set-cookie'), null);
    assert.equal(businessCalls(fixture.calls).length, before);
  });
});

test('Google state contiene tenant resuelto y callback lo revalida antes de OAuth o sesión', async () => {
  const oldEnv = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect: process.env.GOOGLE_REDIRECT_URI,
  };
  process.env.GOOGLE_CLIENT_ID = 'client';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
  const fixture = tenantFixture();
  const app = makeClientApp(fixture, null);
  const originalFetch = globalThis.fetch;
  let externalFetches = 0;

  try {
    await serve(app, async (base) => {
      for (const suffix of ['', '?empresa_id=999', '?slug=inactivo', '?slug=uno&empresa_id=2', '?slug=duplicado']) {
        const response = await originalFetch(base + `/api/public/app/auth/google/start${suffix}`, { redirect: 'manual' });
        assert.notEqual(response.status, 302, suffix || 'missing');
      }

      const start = await originalFetch(base + '/api/public/app/auth/google/start?slug=uno&empresa_id=1', { redirect: 'manual' });
      assert.equal(start.status, 302);
      const redirect = new URL(start.headers.get('location'));
      const state = redirect.searchParams.get('state');
      assert.ok(state);

      fixture.tenants.get(1).enabled = false;
      globalThis.fetch = async () => {
        externalFetches += 1;
        throw new Error('No debe llamar OAuth externo');
      };
      const callback = await originalFetch(base + `/api/public/app/auth/google/callback?state=${encodeURIComponent(state)}&code=abc`, { redirect: 'manual' });
      assert.equal(callback.status, 400);
      assert.equal(callback.headers.get('set-cookie'), null);
      assert.equal(externalFetches, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = oldEnv.id;
    if (oldEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = oldEnv.secret;
    if (oldEnv.redirect === undefined) delete process.env.GOOGLE_REDIRECT_URI; else process.env.GOOGLE_REDIRECT_URI = oldEnv.redirect;
  }
});

test('Google OAuth conserva exactamente el selector originario y callback ignora overrides', async () => {
  const oldEnv = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect: process.env.GOOGLE_REDIRECT_URI,
  };
  process.env.GOOGLE_CLIENT_ID = 'client';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
  const fixture = tenantFixture();
  const app = makeClientApp(fixture, null);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return new Response(JSON.stringify({ email: 'cliente@example.com', name: 'Cliente' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`fetch externo inesperado: ${target}`);
    };

    await serve(app, async (base) => {
      for (const [startSelector, expectedLocation] of [
        ['empresa_id=1', '/pedidos/app/?empresa_id=1'],
        ['slug=UNO', '/pedidos/app/?slug=uno'],
        ['slug=UNO&empresa_id=1', '/pedidos/app/?slug=uno&empresa_id=1'],
      ]) {
        const start = await originalFetch(`${base}/api/public/app/auth/google/start?${startSelector}`, { redirect: 'manual' });
        assert.equal(start.status, 302, startSelector);
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        assert.ok(state, startSelector);

        const callback = await originalFetch(
          `${base}/api/public/app/auth/google/callback?state=${encodeURIComponent(state)}&code=abc&slug=dos&empresa_id=2`,
          { redirect: 'manual' }
        );
        assert.equal(callback.status, 302, startSelector);
        assert.equal(callback.headers.get('location'), expectedLocation, startSelector);
        const cookie = callback.headers.get('set-cookie');
        assert.match(cookie || '', /^client_token=/, startSelector);
        const token = cookie.match(/^client_token=([^;]+)/)?.[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev');
        assert.equal(payload.empresa_id, 1, startSelector);
        assert.equal(payload.type, 'client', startSelector);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = oldEnv.id;
    if (oldEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = oldEnv.secret;
    if (oldEnv.redirect === undefined) delete process.env.GOOGLE_REDIRECT_URI; else process.env.GOOGLE_REDIRECT_URI = oldEnv.redirect;
  }
});

test('sesiones cliente requieren selector explícito concordante y tenant aún habilitado antes de queries', async () => {
  const fixture = tenantFixture();
  const app = makeClientApp(fixture, null);
  const token = jwt.sign({ type: 'client', empresa_id: 1, telefono: '3531234567', telefono_norm: '3531234567', risk_fp: null }, process.env.JWT_SECRET || 'dev');

  await serve(app, async (base) => {
    const headers = { cookie: `client_token=${token}` };
    const missing = await jsonRequest(base, '/api/public/app/me', { headers });
    assert.equal(missing.response.status, 400);
    const conflict = await jsonRequest(base, '/api/public/app/me?empresa_id=2', { headers });
    assert.equal(conflict.response.status, 403);
    const ok = await jsonRequest(base, '/api/public/app/me?slug=uno&empresa_id=1', { headers });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.body.session.empresa_id, 1);

    fixture.tenants.get(1).enabled = false;
    const before = businessCalls(fixture.calls).length;
    const disabled = await jsonRequest(base, '/api/public/app/orders?empresa_id=1', { headers });
    assert.equal(disabled.response.status, 400);
    assert.equal(disabled.body.code, 'PUBLIC_TENANT_UNRESOLVED');
    assert.equal(businessCalls(fixture.calls).length, before);
  });
});

test('inventario estructural público no contiene fallback tenant 1, resolver coercitivo ni autoridad Host', () => {
  const inventory = [
    ['src/routes/publicLegacyCatalog.js', 5],
    ['src/routes/publicLanding.js', 3],
    ['src/routes/publicClientApp.js', 11],
  ];
  let routeCount = 0;
  for (const [relative, expectedRoutes] of inventory) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const routes = [...source.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*['\"]([^'\"]+)/g)].map((match) => match[1]);
    assert.equal(routes.length, expectedRoutes, `${relative}: ${routes.join(', ')}`);
    routeCount += routes.length;
    assert.doesNotMatch(source, /(?:empresa|tenant)[A-Za-z_]*[^\n]{0,50}(?:\|\|\s*1|\?\?\s*1)/i, relative);
    assert.doesNotMatch(source, /Number\([^\n]*(?:empresa|tenant)[^\n]*\)\s*\|\|\s*1/i, relative);
    assert.doesNotMatch(source, /x-forwarded-host|headers(?:\?\.)?\.host|LOWER\s*\(\s*landing_domain/i, relative);
  }
  assert.equal(routeCount, 19);

  const client = fs.readFileSync(path.join(root, 'src/routes/publicClientApp.js'), 'utf8');
  const mount = fs.readFileSync(path.join(root, 'src/routes/mountApiModules.js'), 'utf8');
  assert.match(client, /resolveEmpresaIdFn = resolvePublicPedidoEmpresaId/);
  assert.doesNotMatch(client, /async function resolveEmpresaId\s*\(/);
  assert.match(mount, /resolveEmpresaIdFn: resolvePublicPedidoEmpresaId/);

  const caller = fs.readFileSync(path.join(root, 'pedidos/app/main.js'), 'utf8');
  for (const endpoint of ['auth/companies', 'auth/request-otp', 'auth/verify-otp', 'auth/google/start', 'profile', 'orders', 'me']) {
    assert.match(caller, new RegExp(`withPublicTenant\\([^\\n]*${endpoint.replace('/', '\\/')}`), endpoint);
  }
  assert.doesNotMatch(caller, /selectedEmpresaId\s*\|\|\s*empresaId\s*\|\|\s*1/);
});
