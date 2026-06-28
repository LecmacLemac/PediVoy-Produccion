import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPedidosPagoRouter } from '../src/routes/pedidosPago.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({ user, pool, checkLicencia = (_req, _res, next) => next() }) {
  const app = express();
  app.use(express.json());
  app.use('/api/pedidos', createPedidosPagoRouter({
    pool,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    checkLicencia,
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return app;
}

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    connect: async () => ({
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        return { rows: await handler(sql, params) };
      },
      release: () => {
        calls.push({ sql: 'RELEASE', params: [] });
      },
    }),
  };
}

test('toggle-pago rechaza repartidor antes de tocar DB', async () => {
  const pool = fakePool(async () => {
    throw new Error('No debe consultar DB');
  });
  const app = buildApp({
    user: { uid: 7, role: 'repartidor', empresa_id: 3 },
    pool,
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/pedidos/42/toggle-pago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marcado: true }),
    });
    assert.equal(resp.status, 403);
  });

  assert.equal(pool.calls.length, 0);
});

test('toggle-pago marca transferencia en una transaccion auditada', async () => {
  let licenciaChequeada = false;
  const pool = fakePool(async (sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) {
      assert.deepEqual(params, [42, 3]);
      return [{ empresa_id: 3, monto: 1500, chofer_id: 8, fecha: '2026-06-28' }];
    }
    if (sql.includes('FROM transferencias')) return [];
    if (sql.includes('INSERT INTO transferencias')) {
      assert.deepEqual(params, [3, 8, '2026-06-28', 1500, 42]);
      return [];
    }
    if (sql.includes('UPDATE comprobantes_transferencia') && sql.includes('validado = 1')) {
      assert.deepEqual(params, [42, 3, 99]);
      return [];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app = buildApp({
    user: { uid: 99, role: 'admin', empresa_id: 3 },
    pool,
    checkLicencia(_req, _res, next) {
      licenciaChequeada = true;
      next();
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/pedidos/42/toggle-pago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marcado: true }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  });

  assert.equal(licenciaChequeada, true);
  assert.ok(pool.calls.some(c => c.sql === 'BEGIN'));
  assert.ok(pool.calls.some(c => c.sql === 'COMMIT'));
  assert.equal(pool.calls.some(c => c.sql === 'ROLLBACK'), false);
});

test('toggle-pago revierte la transaccion si falla una escritura', async () => {
  const pool = fakePool(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return [];
    if (sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) {
      return [{ empresa_id: 3, monto: 1500, chofer_id: 8, fecha: '2026-06-28' }];
    }
    if (sql.includes('FROM transferencias')) return [];
    if (sql.includes('INSERT INTO transferencias')) return [];
    if (sql.includes('UPDATE comprobantes_transferencia')) throw new Error('fallo update comprobante');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app = buildApp({
    user: { uid: 99, role: 'admin', empresa_id: 3 },
    pool,
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/pedidos/42/toggle-pago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marcado: true }),
    });
    assert.equal(resp.status, 500);
  });

  assert.ok(pool.calls.some(c => c.sql === 'BEGIN'));
  assert.ok(pool.calls.some(c => c.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(c => c.sql === 'COMMIT'), false);
});
