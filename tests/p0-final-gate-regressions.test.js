import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { createAuthGuestSignupRouter } from '../src/routes/authGuestSignup.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function repartidorApp({ crearPagoParaPedido }) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async sql => /FROM pedidos p/.test(sql)
      ? [{ id: 42, empresa_id: 7, chofer_id: 9, estado: 'en_ruta', metodo_pago: 'efectivo' }]
      : [],
    pool: { connect: async () => { throw new Error('unused'); } },
    withTransaction: async work => work(async () => []),
    withAuth: (req, _res, next) => { req.user = { role: 'repartidor', empresa_id: 7, chofer_id: 9 }; next(); },
    getEmpresaIdFromToken: req => req.user.empresa_id,
    crearPagoParaPedido,
  }));
  return app;
}

test('pago QR sanitiza errores internos y no registra secretos', async t => {
  const secret = 'password=super-secret token=provider-token SELECT * FROM users';
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  await withServer(repartidorApp({ crearPagoParaPedido: async () => { throw new Error(secret); } }), async base => {
    const response = await fetch(`${base}/api/repartidor/pedidos/42/pago-qr`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Error generando pago QR' });
  });
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('pago QR conserva sólo error de dominio allowlisted con status y code seguros', async () => {
  const error = new Error('El proveedor de pagos no está configurado');
  error.statusCode = 400;
  error.code = 'PAYMENT_PROVIDER_NOT_CONFIGURED';
  await withServer(repartidorApp({ crearPagoParaPedido: async () => { throw error; } }), async base => {
    const response = await fetch(`${base}/api/repartidor/pedidos/42/pago-qr`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'El proveedor de pagos no está configurado',
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
  });
});

test('signup-full usa transacción canónica sin retry y sanitiza COMMIT ambiguo', async () => {
  const calls = [];
  const withTransaction = async (work, options) => {
    calls.push(['options', options]);
    let insert = 0;
    await work(async (sql) => {
      calls.push(['sql', String(sql)]);
      insert += 1;
      return insert === 1
        ? [{ id: 7 }]
        : [{ id: 9, username: 'nuevo.usuario', role: 'user', empresa_id: 7 }];
    });
    const error = new Error('commit transport password=secret');
    error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
    throw error;
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthGuestSignupRouter({
    query: async () => [],
    withAuth: (_req, _res, next) => next(),
    pool: { connect: async () => assert.fail('wrapper manual no debe usarse') },
    withTransaction,
  }));
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/auth/signup-full`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({ username: 'nuevo.usuario', password: 'Password123', empresa_nombre: 'Nueva Empresa' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Resultado de creación indeterminado',
      code: 'TRANSACTION_OUTCOME_UNKNOWN',
    });
    assert.equal(response.headers.get('set-cookie'), null);
  });
  assert.equal(calls[0][1].maxRetries, 0);
  assert.equal(calls.filter(([kind]) => kind === 'sql').length, 2);
});
