import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createAuthGuestSignupRouter } from '../src/routes/authGuestSignup.js';

async function withServer(app, fn) {
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('POST /api/auth/guest está retirado y no crea usuario, cookie ni JWT', async () => {
  const queries = [];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthGuestSignupRouter({
    query: async (...args) => { queries.push(args); return []; },
    withAuth: (_req, _res, next) => next(),
    pool: { connect: async () => { throw new Error('pool no debe usarse'); } },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/auth/guest?includeToken=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id: 999 }),
    });
    const body = await response.json();

    assert.equal(response.status, 410);
    assert.deepEqual(body, { error: 'El registro de invitados ya no está disponible' });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal('token' in body, false);
  });

  assert.equal(queries.length, 0);
});

test('register está retirado y signup-full conserva sus validaciones', async () => {
  const queries = [];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthGuestSignupRouter({
    query: async (...args) => { queries.push(args); return []; },
    withAuth: (req, _res, next) => {
      req.user = { uid: 1, empresa_id: 1 };
      next();
    },
    pool: { connect: async () => { throw new Error('pool no debe usarse con payload inválido'); } },
  }));

  await withServer(app, async baseUrl => {
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(register.status, 410);
    assert.deepEqual(await register.json(), { error: 'El registro de invitados ya no está disponible' });

    const signup = await fetch(`${baseUrl}/api/auth/signup-full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(signup.status, 400);
    assert.deepEqual(await signup.json(), { error: 'Faltan datos obligatorios' });
  });

  assert.equal(queries.length, 0);
});

for (const credential of ['none', 'bearer', 'cookie']) {
  test(`register devuelve 410 sin efectos con credencial ${credential}`, async t => {
    const token = jwt.sign({ uid: 88, role: 'guest', empresa_id: 99 }, 'old-secret');
    const sign = t.mock.method(jwt, 'sign', () => assert.fail('No debe emitir JWT'));
    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthGuestSignupRouter({
      query: async () => assert.fail('No debe consultar DB'),
      pool: { connect: async () => assert.fail('No debe conectar DB') },
      withAuth: (req, _res, next) => {
        req.user = jwt.verify(token, 'old-secret');
        next();
      },
    }));
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/register?includeToken=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-include-token': '1',
          ...(credential === 'bearer' ? { authorization: `Bearer ${token}` } : {}),
          ...(credential === 'cookie' ? { cookie: `token=${token}` } : {}),
        },
        body: JSON.stringify({ username: 'old.guest', password: 'Password123!' }),
      });
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { error: 'El registro de invitados ya no está disponible' });
      assert.equal(sign.mock.callCount(), 0);
    });
  });
}
