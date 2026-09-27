import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function makeWithTransaction(query) {
  return async work => work(query, { query: async (sql, params) => ({ rows: await query(sql, params) }) });
}

function buildApp({ user, query, withTransaction = makeWithTransaction(query) }) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    withTransaction,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    getEmpresaIdFromToken: req => req.user?.empresa_id,
  }));
  return app;
}

async function tomar(baseUrl, id, body = { empresa_id: 999, chofer_id: 999 }) {
  return fetch(`${baseUrl}/api/repartidor/tomar/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const driver = { role: 'repartidor', empresa_id: 7, chofer_id: 4 };

test('tomar pedido usa exclusivamente empresa y chofer autenticados y no revela pedidos cross-tenant', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM choferes')) return [{ id: 4 }];
    if (sql.includes('UPDATE pedidos')) return [];
    throw new Error(`SQL inesperado: ${sql}`);
  };
  const app = buildApp({ user: driver, query });

  await withServer(app, async baseUrl => {
    const response = await tomar(baseUrl, 55);
    assert.equal(response.status, 404);
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /empresa_id\s*=\s*\$2/i);
  assert.match(calls[0].sql, /activo\s+IS\s+TRUE/i);
  assert.deepEqual(calls[0].params, [4, 7]);
  assert.match(calls[1].sql, /WHERE\s+id\s*=\s*\$2[\s\S]*empresa_id\s*=\s*\$3[\s\S]*chofer_id\s+IS\s+NULL/i);
  assert.match(calls[1].sql, /estado\s*=\s*'pendiente'/);
  assert.doesNotMatch(calls[1].sql, /LOWER\s*\(|COALESCE\s*\(\s*estado/i);
  assert.deepEqual(calls[1].params, [4, 55, 7]);
});

test('tomar pedido valida un ID entero positivo y seguro antes de abrir transacción', async () => {
  for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    let transactionCalls = 0;
    const queryCalls = [];
    const app = buildApp({
      user: driver,
      query: async (...args) => { queryCalls.push(args); return []; },
      withTransaction: async () => { transactionCalls += 1; throw new Error('No debe abrir transacción'); },
    });

    await withServer(app, async baseUrl => {
      const response = await tomar(baseUrl, id);
      assert.equal(response.status, 400, id);
    });
    assert.equal(transactionCalls, 0, id);
    assert.equal(queryCalls.length, 0, id);
  }
});

test('tomar pedido exige rol repartidor canónico y vínculos enteros válidos antes de consultar', async () => {
  const denied = [
    { ...driver, role: 'admin' },
    { ...driver, role: 'super' },
    { ...driver, role: 'REPARTIDOR' },
    { ...driver, role: ' repartidor ' },
    { ...driver, empresa_id: null },
    { ...driver, empresa_id: '7' },
    { ...driver, chofer_id: null },
    { ...driver, chofer_id: '4' },
  ];

  for (const user of denied) {
    const calls = [];
    const app = buildApp({ user, query: async (...args) => { calls.push(args); return []; } });
    await withServer(app, async baseUrl => {
      const response = await tomar(baseUrl, 55);
      assert.equal(response.status, 403, JSON.stringify(user));
    });
    assert.equal(calls.length, 0, JSON.stringify(user));
  }
});

test('tomar pedido rechaza chofer inactivo o de otra empresa sin intentar actualizar', async () => {
  for (const scenario of ['inactivo', 'cross-tenant']) {
    const calls = [];
    const query = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM choferes')) return [];
      throw new Error('No debe actualizar pedidos');
    };
    const app = buildApp({ user: driver, query });
    await withServer(app, async baseUrl => {
      const response = await tomar(baseUrl, 55);
      assert.equal(response.status, 403, scenario);
    });
    assert.equal(calls.length, 1, scenario);
  }
});

test('dos repartidores concurrentes: exactamente uno toma el pedido', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE choferes (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL,
        activo boolean NOT NULL
      );
      CREATE TABLE pedidos (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL,
        chofer_id integer,
        estado text
      );
      INSERT INTO choferes VALUES (4,7,TRUE),(5,7,TRUE),(6,8,TRUE),(7,7,FALSE);
      INSERT INTO pedidos VALUES (55,7,NULL,'pendiente'),(56,8,NULL,'pendiente');
    `);

    const query = async (sql, params) => (await pool.query(sql, params)).rows;
    let transactionsStarted = 0;
    let releaseBoth;
    const bothStarted = new Promise(resolve => { releaseBoth = resolve; });
    const withTransaction = async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        transactionsStarted += 1;
        if (transactionsStarted === 2) releaseBoth();
        await bothStarted;
        const txQuery = async (sql, params) => (await client.query(sql, params)).rows;
        const result = await work(txQuery, client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const appA = buildApp({ user: { ...driver, chofer_id: 4 }, query, withTransaction });
    const appB = buildApp({ user: { ...driver, chofer_id: 5 }, query, withTransaction });

    await withServer(appA, async baseA => {
      await withServer(appB, async baseB => {
        const [a, b] = await Promise.all([tomar(baseA, 55), tomar(baseB, 55)]);
        assert.deepEqual([a.status, b.status].sort(), [200, 404]);
      });
    });

    const result = await pool.query('SELECT chofer_id FROM pedidos WHERE id=55');
    assert.ok([4, 5].includes(result.rows[0].chofer_id));
  });
});

test('pedidos terminales o no operativos vacantes no se pueden tomar ni se modifican', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE choferes (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL,
        activo boolean NOT NULL
      );
      CREATE TABLE pedidos (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL,
        chofer_id integer,
        estado text
      );
      INSERT INTO choferes VALUES (4,7,TRUE);
      INSERT INTO pedidos VALUES
        (51,7,NULL,'entregado'),
        (52,7,NULL,'cancelado'),
        (53,7,NULL,'en_ruta'),
        (54,7,NULL,' pendiente '),
        (55,7,NULL,NULL),
        (56,7,NULL,'PENDIENTE'),
        (57,7,NULL,'Pendiente'),
        (58,7,NULL,'pendiente');
    `);

    const query = async (sql, params) => (await pool.query(sql, params)).rows;
    const withTransaction = async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txQuery = async (sql, params) => (await client.query(sql, params)).rows;
        const result = await work(txQuery, client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const app = buildApp({ user: driver, query, withTransaction });

    await withServer(app, async baseUrl => {
      for (const id of [51, 52, 53, 54, 55, 56, 57]) {
        const response = await tomar(baseUrl, id);
        assert.equal(response.status, 404, String(id));
      }
      const response = await tomar(baseUrl, 58);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    });

    const result = await pool.query('SELECT id, chofer_id FROM pedidos ORDER BY id');
    assert.deepEqual(result.rows, [
      { id: 51, chofer_id: null },
      { id: 52, chofer_id: null },
      { id: 53, chofer_id: null },
      { id: 54, chofer_id: null },
      { id: 55, chofer_id: null },
      { id: 56, chofer_id: null },
      { id: 57, chofer_id: null },
      { id: 58, chofer_id: 4 },
    ]);
  });
});
