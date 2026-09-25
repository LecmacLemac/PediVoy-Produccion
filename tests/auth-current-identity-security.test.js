import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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
const claims = { username: 'obsoleto', uid: 12, role: 'super', empresa_id: 99, chofer_id: 88, referente_id: 77 };
const current = { username: 'actual', id: 12, role: 'user', empresa_id: 7, chofer_id: null, referente_id: null, activo: true };
const middleware = queryFn => auth.createWithAuth({ queryFn });

async function serve(row, run, { dbError = false, linked = {} } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM usuarios/.test(sql)) {
      if (dbError) throw new Error('database unavailable');
      return row ? [{ ...row, ...(/LEFT JOIN choferes/.test(sql) ? { chofer_valid: linked.chofer?.id === row.chofer_id && linked.chofer?.activo === true && linked.chofer?.empresa_id === row.empresa_id, referente_valid: linked.referente?.id === row.referente_id && linked.referente?.activo === true && linked.referente?.empresa_id === row.empresa_id && linked.referente?.deleted_at === null } : {}) }] : [];
    }
    if (/config_integraciones/.test(sql)) return [{ config_integraciones: { pagos: { preferido: 'efectivo' } } }];
    return [{ id: 1 }];
  };
  const app = express();
  app.use(express.json(), cookieParser());
  const withAuth = middleware(query);
  app.get('/identity', withAuth, (req, res) => res.json(req.user));
  app.use('/api', createAuthRouter({ queryFn: query }));
  const deps = {
    query,
    withTransaction: async work => work(query),
    withAuth,
    isSuper: auth.isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,
    getEmpresaById: async () => null,
  };
  app.use('/api/productos', createProductosRouter(deps));
  app.use('/api/empresas', createEmpresasRouter(deps));
  const stats = { express, withAuth, query, getEmpresaIdFromToken };
  vm.runInNewContext(readFileSync(new URL('../src/routes/repartidorStats.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace('export function', 'function') + '\nglobalThis.router = createRepartidorStatsRouter();', stats);
  app.use('/api/repartidor', stats.router);
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
        for (const key of ['username', 'role', 'empresa_id', 'chofer_id', 'referente_id']) assert.equal(user[key], current[key]);
        assert.equal(user.uid, current.id);
      }
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => /u\.username/.test(call.sql)));
      assert.ok(calls.every(call => /SELECT.*id.*role.*empresa_id.*chofer_id.*referente_id.*activo/s.test(call.sql)));
      assert.ok(calls.every(call => JSON.stringify(call.params) === '[12]'));
    });
  });
}

const canonicalRoles = ['user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin', 'super'];
for (const role of canonicalRoles) {
  test(`accepts coherent DB identity for ${role}`, async () => {
    const row = { ...current, role, empresa_id: role === 'super' ? null : 7, chofer_id: role === 'repartidor' ? 4 : null, referente_id: role === 'referente' ? 5 : null };
    await serve(row, async ({ request }) => {
      const res = await request('/identity');
      assert.equal(res.status, 200);
      const identity = await res.json();
      assert.equal(identity.role, role);
      assert.equal(identity.empresa_id, row.empresa_id);
    }, { linked: { chofer: { id: 4, activo: true, empresa_id: 7 }, referente: { id: 5, activo: true, empresa_id: 7, deleted_at: null } } });
  });
}

const invalid = [
  ...[undefined, 7, 0, -1, '7', false].map(empresa_id => [
    `super tenant ${empresa_id}`, { ...current, role: 'super', empresa_id }, claims,
  ]),
  ...canonicalRoles.filter(role => role !== 'super').flatMap(role =>
    [undefined, null, 0, -1, 1.5, '7', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(empresa_id => [
      `${role} tenant ${empresa_id}`, { ...current, role, empresa_id }, claims,
    ])),
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
  const row = { ...current, role: 'super', empresa_id: null };
  await serve(row, async ({ request, calls }) => {
    assert.equal((await request('/api/empresas/99', claims, 'DELETE')).status, 200);
    calls.length = 0;
    row.role = 'admin';
    row.empresa_id = 7;
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

for (const role of ['repartidor', 'referente']) {
  for (const state of ['missing-id', 'missing-record', 'inactive', 'cross-tenant', 'incompatible', 'deleted', 'valid']) {
    if (role === 'repartidor' && state === 'deleted') continue;
    test(`real routes reject ${role} ${state} links before protected queries`, async () => {
      const driver = role === 'repartidor';
      const row = { ...current, role, [driver ? 'chofer_id' : 'referente_id']: state === 'missing-id' ? null : 4 };
      if (state === 'incompatible') row[driver ? 'referente_id' : 'chofer_id'] = 5;
      const record = { id: 4, empresa_id: state === 'cross-tenant' ? 8 : 7, activo: state !== 'inactive', deleted_at: state === 'deleted' ? new Date() : null };
      await serve(row, async ({ request, calls }) => {
        for (const path of ['/identity', '/api/me', '/api/empresa/config', '/api/repartidor/resumen-dia', '/api/repartidor/pago-dia']) {
          const res = await request(path);
          if (state !== 'valid') assert.equal(res.status, 401, path);
          else if (driver || !path.includes('/api/repartidor')) assert.equal(res.status, 200, path);
        }
        if (state !== 'valid') assert.ok(calls.every(({ sql }) => /FROM usuarios/.test(sql)), 'No protected query');
      }, { linked: state === 'missing-record' ? {} : { [driver ? 'chofer' : 'referente']: record } });
    });
  }
}
for (const role of ['user', 'admin', 'facturacion', 'contable', 'super']) {
  for (const link of ['chofer_id', 'referente_id']) {
    test(`${role} with incompatible ${link} cannot expose repartidorStats`, async () => {
      await serve({ ...current, role, empresa_id: role === 'super' ? null : 7, [link]: 4 }, async ({ request, calls }) => {
        for (const path of ['/api/repartidor/resumen-dia', '/api/repartidor/pago-dia', '/api/empresa/config']) assert.equal((await request(path)).status, 401);
        assert.ok(calls.every(({ sql }) => /FROM usuarios/.test(sql)));
      });
    });
  }
}
