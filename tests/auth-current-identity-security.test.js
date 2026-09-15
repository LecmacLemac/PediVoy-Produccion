import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import * as auth from '../src/core/auth.js';
import { cfg } from '../src/config.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createProductosRouter } from '../src/routes/productos.js';
import { createEmpresasRouter } from '../src/routes/empresas.js';
import { getEmpresaIdFromToken, resolveEmpresaId } from '../src/core/tenant.js';

const secret = process.env.JWT_SECRET || cfg.jwtSecret;
const claims = { uid: 12, role: 'super', empresa_id: 99, chofer_id: 88, referente_id: 77 };
const current = { id: 12, role: 'user', empresa_id: 7, chofer_id: null, referente_id: null, activo: true };
const middleware = queryFn => auth.createWithAuth({ queryFn });

async function serve(row, run, { dbError = false } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM usuarios/.test(sql)) {
      if (dbError) throw new Error('database unavailable');
      return row ? [{ ...row }] : [];
    }
    if (/config_integraciones/.test(sql)) return [{ config_integraciones: { pagos: { preferido: 'efectivo' } } }];
    return [{ id: 1 }];
  };
  const app = express();
  app.use(express.json(), cookieParser());
  const withAuth = middleware(query);
  app.get('/identity', withAuth, (req, res) => res.json(req.user));
  app.use('/api', createAuthRouter({ queryFn: query }));
  const deps = { query, withAuth, isSuper: auth.isSuper, getEmpresaIdFromToken, resolveEmpresaId, getEmpresaById: async () => null };
  app.use('/api/productos', createProductosRouter(deps));
  app.use('/api/empresas', createEmpresasRouter(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, payload = claims, method = 'GET', transport = 'bearer') => {
    const token = typeof payload === 'string' ? payload : jwt.sign(payload, secret, { expiresIn: '1h' });
    const headers = { 'Content-Type': 'application/json' };
    if (transport === 'cookie') headers.Cookie = `token=${token}`;
    else if (transport === 'header') headers['x-access-token'] = token;
    else headers.Authorization = `Bearer ${token}`;
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers, ...(method === 'POST' ? { body: JSON.stringify({ nombre: 'Agua', precio: 10, empresa_id: 99 }) } : {}),
    });
  };
  try { await run({ request, calls }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

for (const [name, fn] of [['super', auth.isSuper], ['repartidor', auth.isRepartidor], ['referente', auth.isReferente]]) {
  test(`privilege helper requires exact ${name}`, () => {
    assert.equal(fn({ user: { role: name } }), true);
    for (const role of [name.toUpperCase(), ` ${name} `, '', null, {}, 1]) assert.equal(fn({ user: { role } }), false);
  });
}

for (const transport of ['bearer', 'header', 'cookie']) {
  test(`DB identity replaces stale role, tenant and links through ${transport}`, async () => {
    await serve(current, async ({ request, calls }) => {
      for (const path of ['/identity', '/api/me']) {
        const res = await request(path, claims, 'GET', transport);
        assert.equal(res.status, 200);
        const body = await res.json();
        const user = body.user || body;
        for (const key of ['role', 'empresa_id', 'chofer_id', 'referente_id']) assert.equal(user[key], current[key]);
        assert.equal(user.uid, current.id);
      }
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => /SELECT.*id.*role.*empresa_id.*chofer_id.*referente_id.*activo/s.test(call.sql)));
      assert.ok(calls.every(call => JSON.stringify(call.params) === '[12]'));
    });
  });
}

const invalid = [
  ['missing user', null, claims],
  ['inactive', { ...current, activo: false }, claims],
  ['null active', { ...current, activo: null }, claims],
  ...['guest', 'SUPER', ' admin ', null, 'inventado'].map(role => [`DB role ${role}`, { ...current, role }, claims]),
  ['guest token even if DB now canonical', current, { ...claims, role: 'guest' }],
  ['client token', current, { type: 'client', empresa_id: 99 }],
  ['client token with user claims', current, { ...claims, type: 'client' }],
  ...[undefined, '12', null, 0, -1, 1.5].map(uid => [`uid ${uid}`, current, { ...claims, uid }]),
  ['bad signature', current, jwt.sign(claims, 'wrong-secret')],
  ['expired', current, jwt.sign(claims, secret, { expiresIn: -1 })],
];
for (const [name, row, payload] of invalid) {
  test(`rejects ${name} before protected queries on real routes`, async () => {
    await serve(row, async ({ request, calls }) => {
      const responses = [];
      for (const [path, method] of [['/identity', 'GET'], ['/api/me', 'GET'], ['/api/empresa/config', 'GET'], ['/api/productos', 'POST'], ['/api/empresas/99', 'DELETE']]) {
        const res = await request(path, payload, method);
        responses.push({ status: res.status, route: `${method} ${path}` });
      }
      assert.ok(calls.every(call => /FROM usuarios/.test(call.sql)), 'No protected read/write query may execute');
      for (const { status, route } of responses) assert.equal(status, 401, route);
    });
  });
}

test('same super token loses DELETE permission immediately after downgrade or deactivation', async () => {
  const row = { ...current, role: 'super' };
  await serve(row, async ({ request, calls }) => {
    assert.equal((await request('/api/empresas/99', claims, 'DELETE')).status, 200);
    calls.length = 0;
    row.role = 'admin';
    assert.equal((await request('/api/empresas/99', claims, 'DELETE')).status, 403);
    row.role = 'super';
    row.activo = false;
    assert.equal((await request('/api/empresas/99', claims, 'DELETE')).status, 401);
    assert.ok(calls.every(call => /FROM usuarios/.test(call.sql)), 'No DELETE after downgrade/deactivation');
  });
});

test('tenant reassignment is immediate for company config and product writes', async () => {
  const row = { ...current };
  await serve(row, async ({ request, calls }) => {
    for (const empresaId of [7, 8]) {
      row.empresa_id = empresaId;
      const config = await request('/api/empresa/config');
      assert.equal(config.status, 200);
      assert.deepEqual(await config.json(), { pagos: { canales: { efectivo: true, transferencia: true, qr_dinamico: false }, preferido: 'efectivo' } });
      assert.equal(calls.at(-1).params[0], empresaId);
      const product = await request('/api/productos', claims, 'POST');
      assert.ok(product.ok);
      assert.equal(calls.findLast(call => /INSERT INTO productos/.test(call.sql)).params[0], empresaId);
    }
  });
});

test('DB errors fail closed on all protected routes', async () => {
  await serve(current, async ({ request, calls }) => {
    for (const [path, method] of [['/identity', 'GET'], ['/api/me', 'GET'], ['/api/empresa/config', 'GET'], ['/api/productos', 'POST'], ['/api/empresas/99', 'DELETE']]) {
      const res = await request(path, claims, method);
      assert.ok(res.status >= 400, `${method} ${path}`);
    }
    assert.ok(calls.every(call => /FROM usuarios/.test(call.sql)));
  }, { dbError: true });
});
