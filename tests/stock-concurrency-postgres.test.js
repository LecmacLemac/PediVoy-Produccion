import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createStockRouter } from '../src/routes/stock.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      config_operativa jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE choferes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      activo boolean NOT NULL DEFAULT true
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text,
      activo boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE depositos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      direccion text,
      activo boolean NOT NULL DEFAULT true,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (empresa_id, nombre)
    );
    CREATE TABLE deposito_chofer (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      deposito_id integer NOT NULL REFERENCES depositos(id),
      chofer_id integer NOT NULL REFERENCES choferes(id),
      activo boolean NOT NULL DEFAULT true,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE (empresa_id, deposito_id, chofer_id)
    );
    CREATE TABLE chofer_stock_mov (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      chofer_id integer NOT NULL REFERENCES choferes(id),
      producto_id integer NOT NULL REFERENCES productos(id),
      deposito_id integer REFERENCES depositos(id),
      fecha timestamptz DEFAULT now(),
      tipo text,
      cantidad numeric NOT NULL,
      motivo text,
      referencia text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE chofer_stock (
      empresa_id integer NOT NULL,
      chofer_id integer NOT NULL,
      producto_id integer NOT NULL,
      cantidad numeric NOT NULL,
      PRIMARY KEY (empresa_id, chofer_id, producto_id)
    );
    INSERT INTO empresas (id, config_operativa) VALUES (3, '{"deposito_permisos_estricto":true}');
    INSERT INTO choferes VALUES (7, 3, true);
    INSERT INTO productos VALUES (11, 3, 'Bidón', true, NULL);
    INSERT INTO depositos (id, empresa_id, nombre) VALUES (1, 3, 'Origen'), (2, 3, 'Destino'), (3, 3, 'Auxiliar');
    SELECT setval(pg_get_serial_sequence('depositos','id'), 3, true);
    INSERT INTO deposito_chofer (empresa_id, deposito_id, chofer_id, activo)
      VALUES (3,1,7,true),(3,2,7,true),(3,3,7,true);
    INSERT INTO chofer_stock_mov
      (empresa_id, chofer_id, producto_id, deposito_id, tipo, cantidad, motivo)
      VALUES (3,7,11,1,'SEED',5,'seed');
    INSERT INTO chofer_stock VALUES (3,7,11,5);
  `);
}

function buildApp(pool, { transactionPool = pool } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/stock', createStockRouter({
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    pool: transactionPool,
    withTransaction: (work, options = {}) => dbWithTransaction(work, {
      ...options,
      pool: transactionPool,
      maxRetries: 0,
      retryDelayMs: 0,
    }),
    withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: 3 }; next(); },
    checkLicencia(_req, _res, next) { next(); },
    isSuper() { return false; },
    getEmpresaIdFromToken() { return 3; },
  }));
  return app;
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function movementState(pool) {
  const { rows } = await pool.query(`
    SELECT deposito_id, COALESCE(SUM(cantidad),0)::numeric AS saldo
      FROM chofer_stock_mov
     WHERE empresa_id = 3 AND producto_id = 11
     GROUP BY deposito_id
     ORDER BY deposito_id
  `);
  return Object.fromEntries(rows.map(row => [Number(row.deposito_id), Number(row.saldo)]));
}

test('PostgreSQL real: dos transferencias concurrentes no sobregiran el origen', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withServer(buildApp(pool), async base => {
      const payload = { origen_deposito_id: 1, destino_deposito_id: 2, producto_id: 11, chofer_id: 7, cantidad: 4 };
      const results = await Promise.all([
        post(base, '/api/stock/depositos/transferir', payload),
        post(base, '/api/stock/depositos/transferir', payload),
      ]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    });

    assert.deepEqual(await movementState(pool), { 1: 1, 2: 4 });
    const { rows: counts } = await pool.query(`
      SELECT tipo, COUNT(*)::int AS c, SUM(cantidad)::numeric AS total
        FROM chofer_stock_mov
       WHERE tipo IN ('TRANSFER_OUT','TRANSFER_IN')
       GROUP BY tipo ORDER BY tipo
    `);
    assert.deepEqual(counts.map(row => ({ ...row, total: Number(row.total) })), [
      { tipo: 'TRANSFER_IN', c: 1, total: 4 },
      { tipo: 'TRANSFER_OUT', c: 1, total: -4 },
    ]);
  });
});

test('PostgreSQL real: dos reversas concurrentes crean como máximo un par', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    let reference;
    await withServer(buildApp(pool), async base => {
      const transfer = await post(base, '/api/stock/depositos/transferir', {
        origen_deposito_id: 1, destino_deposito_id: 2, producto_id: 11, chofer_id: 7, cantidad: 4,
      });
      assert.equal(transfer.status, 200);
      reference = transfer.body.referencia;
      const results = await Promise.all([
        post(base, '/api/stock/depositos/transferencias/revertir', { referencia: reference, chofer_id: 7 }),
        post(base, '/api/stock/depositos/transferencias/revertir', { referencia: reference, chofer_id: 7 }),
      ]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    });

    assert.deepEqual(await movementState(pool), { 1: 5, 2: 0 });
    const count = await pool.query(
      `SELECT COUNT(*)::int AS c FROM chofer_stock_mov
        WHERE empresa_id = 3 AND referencia = $1
          AND tipo IN ('TRANSFER_REV_OUT','TRANSFER_REV_IN')`,
      [`REVERSA:${reference}`]
    );
    assert.equal(count.rows[0].c, 2);
  });
});

test('PostgreSQL real: invalidaciones concurrentes de chofer/producto/depósito/permiso cierran la transferencia', postgresOptions, async t => {
  const cases = [
    ['chofer', `UPDATE choferes SET activo = FALSE WHERE id = 7`],
    ['producto', `UPDATE productos SET activo = FALSE WHERE id = 11`],
    ['depósito', `UPDATE depositos SET activo = FALSE WHERE id = 1`],
    ['permiso', `UPDATE deposito_chofer SET activo = FALSE WHERE empresa_id = 3 AND chofer_id = 7 AND deposito_id = 1`],
  ];

  for (const [name, mutation] of cases) {
    await t.test(name, async () => {
      await withIsolatedPostgres(async pool => {
        await fixture(pool);
        const blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query(mutation);
        await withServer(buildApp(pool), async base => {
          const pending = post(base, '/api/stock/depositos/transferir', {
            origen_deposito_id: 1, destino_deposito_id: 2, producto_id: 11, chofer_id: 7, cantidad: 2,
          });
          await new Promise(resolve => setTimeout(resolve, 40));
          await blocker.query('COMMIT');
          const result = await pending;
          assert.ok([400, 403].includes(result.status), JSON.stringify(result));
        });
        blocker.release();
        assert.deepEqual(await movementState(pool), { 1: 5 });
      });
    });
  }
});

test('PostgreSQL real: ajuste espera invalidación de producto o permiso y no usa estado revocado', postgresOptions, async t => {
  for (const [name, mutation, expected] of [
    ['producto', `UPDATE productos SET activo = FALSE WHERE id = 11`, 400],
    ['permiso', `UPDATE deposito_chofer SET activo = FALSE WHERE empresa_id = 3 AND chofer_id = 7 AND deposito_id = 1`, 403],
  ]) {
    await t.test(name, async () => {
      await withIsolatedPostgres(async pool => {
        await fixture(pool);
        const blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query(mutation);
        await withServer(buildApp(pool), async base => {
          const pending = post(base, '/api/stock/ajuste', {
            producto_id: 11, qty: 2, tipo: 'ADJUST+', chofer_id: 7, deposito_id: 1,
          });
          await new Promise(resolve => setTimeout(resolve, 40));
          await blocker.query('COMMIT');
          const result = await pending;
          assert.equal(result.status, expected, JSON.stringify(result));
        });
        blocker.release();
        const state = await pool.query(`
          SELECT COUNT(*)::int AS c FROM chofer_stock_mov WHERE tipo = 'ajuste'
        `);
        assert.equal(state.rows[0].c, 0);
      });
    });
  }
});

test('PostgreSQL real: reemplazos concurrentes son conjuntos completos y un fallo intermedio revierte todo', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withServer(buildApp(pool), async base => {
      const results = await Promise.all([
        post(base, '/api/stock/depositos/choferes', { chofer_id: 7, deposito_ids: [1] }),
        post(base, '/api/stock/depositos/choferes', { chofer_id: 7, deposito_ids: [2, 3] }),
      ]);
      assert.deepEqual(results.map(result => result.status), [200, 200]);
    });
    const active = await pool.query(`
      SELECT deposito_id FROM deposito_chofer
       WHERE empresa_id = 3 AND chofer_id = 7 AND activo = TRUE
       ORDER BY deposito_id
    `);
    assert.ok(
      JSON.stringify(active.rows) === JSON.stringify([{ deposito_id: 1 }])
      || JSON.stringify(active.rows) === JSON.stringify([{ deposito_id: 2 }, { deposito_id: 3 }]),
      JSON.stringify(active.rows)
    );

    await pool.query(`UPDATE deposito_chofer SET activo = (deposito_id = 1) WHERE empresa_id = 3 AND chofer_id = 7`);
    let failInsert = true;
    const failingPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            if (failInsert && /INSERT INTO deposito_chofer/.test(sql)) {
              failInsert = false;
              throw new Error('fallo inyectado entre deactivate/upsert');
            }
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    await withServer(buildApp(pool, { transactionPool: failingPool }), async base => {
      const result = await post(base, '/api/stock/depositos/choferes', { chofer_id: 7, deposito_ids: [2, 3] });
      assert.equal(result.status, 500);
    });
    const afterFailure = await pool.query(`
      SELECT deposito_id FROM deposito_chofer
       WHERE empresa_id = 3 AND chofer_id = 7 AND activo = TRUE
       ORDER BY deposito_id
    `);
    assert.deepEqual(afterFailure.rows, [{ deposito_id: 1 }]);
  });
});
