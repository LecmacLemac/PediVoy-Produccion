import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createStockRouter } from '../src/routes/stock.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function isSchemaQuery(sql) {
  return /CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql);
}

function buildApp({ query, pool, user = { role: 'user', empresa_id: 3 } }) {
  const app = express();
  app.use(express.json());
  app.use('/api/stock', createStockRouter({
    query,
    pool,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    checkLicencia(_req, _res, next) {
      next();
    },
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return app;
}

function buildPool(handler, calls = []) {
  return {
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params, tx: true });
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          const rows = await handler(sql, params);
          return { rows };
        },
        release() {
          calls.push({ sql: 'RELEASE', params: [], tx: true });
        },
      };
    },
  };
}

test('POST /api/stock/ajuste rechaza chofer externo a la empresa', async () => {
  const calls = [];
  const app = buildApp({
    pool: buildPool(async () => []),
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/stock/ajuste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ producto_id: 11, qty: 2, tipo: 'ADJUST+', chofer_id: 99 }),
    });

    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /Chofer inválido/);
  });

  assert.ok(calls.some((c) => c.sql.includes('FROM choferes') && c.params[0] === 99 && c.params[1] === 3));
});

test('POST /api/stock/ajuste exige depósito cuando permisos estrictos está activo', async () => {
  const app = buildApp({
    pool: buildPool(async () => {
      throw new Error('No debe abrir transacción');
    }),
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: true }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/stock/ajuste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ producto_id: 11, qty: 2, tipo: 'ADJUST+', chofer_id: 7 }),
    });

    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /Depósito requerido/);
  });
});

test('POST /api/stock/ajuste confirma movimiento y agregado en una transacción', async () => {
  const txCalls = [];
  const app = buildApp({
    pool: buildPool(async () => [], txCalls),
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: false }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/stock/ajuste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ producto_id: 11, qty: 2, tipo: 'ADJUST+', chofer_id: 7 }),
    });

    assert.equal(resp.status, 200);
  });

  assert.ok(txCalls.some((c) => c.sql === 'BEGIN'));
  assert.ok(txCalls.some((c) => c.sql.includes('INSERT INTO chofer_stock_mov')));
  assert.ok(txCalls.some((c) => c.sql.includes('INSERT INTO chofer_stock')));
  assert.ok(txCalls.some((c) => c.sql === 'COMMIT'));
  assert.equal(txCalls.some((c) => c.sql === 'ROLLBACK'), false);
});

test('POST /api/stock/depositos/transferir revierte si falla una escritura del par', async () => {
  const txCalls = [];
  const app = buildApp({
    pool: buildPool(async (sql) => {
      if (sql.includes('SELECT COALESCE(SUM(cantidad),0) AS saldo')) return [{ saldo: 10 }];
      if (sql.includes("'TRANSFER_OUT'")) return [];
      if (sql.includes("'TRANSFER_IN'")) throw new Error('fallo insert destino');
      throw new Error(`Consulta transaccional inesperada: ${sql}`);
    }, txCalls),
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('FROM depositos') && sql.includes('id = ANY')) return [{ id: 1 }, { id: 2 }];
      if (sql.includes('FROM depositos')) return [{ id: 1 }];
      if (sql.includes('COUNT(*)::int AS c')) return [{ c: 0 }];
      if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: false }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/stock/depositos/transferir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origen_deposito_id: 1,
        destino_deposito_id: 2,
        producto_id: 11,
        cantidad: 2,
        chofer_id: 7,
      }),
    });

    assert.equal(resp.status, 500);
  });

  assert.ok(txCalls.some((c) => c.sql === 'BEGIN'));
  assert.ok(txCalls.some((c) => c.sql === 'ROLLBACK'));
  assert.equal(txCalls.some((c) => c.sql === 'COMMIT'), false);
});

test('POST /api/stock/depositos/choferes rechaza chofer externo a la empresa', async () => {
  const app = buildApp({
    pool: buildPool(async () => []),
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/stock/depositos/choferes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chofer_id: 99, deposito_ids: [1] }),
    });

    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /Chofer inválido/);
  });
});
