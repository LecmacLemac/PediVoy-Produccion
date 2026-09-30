import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { createStockRouter } from '../src/routes/stock.js';
import { createGastosRouter } from '../src/routes/gastos.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY, config_operativa jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true);
    CREATE TABLE productos (id integer PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), nombre text, activo boolean DEFAULT true, retornable boolean DEFAULT false, deleted_at timestamptz);
    CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), nombre text, direccion text, activo boolean DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (empresa_id, nombre));
    CREATE TABLE deposito_chofer (id serial PRIMARY KEY, empresa_id integer, deposito_id integer, chofer_id integer, activo boolean DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (empresa_id, deposito_id, chofer_id));
    CREATE TABLE pedidos (id integer PRIMARY KEY);
    CREATE TABLE gastos_repartidor (
      id integer PRIMARY KEY, empresa_id integer, chofer_id integer, fecha date, tipo text,
      descripcion text, monto numeric, comprobante_path text, cantidad numeric,
      producto_id integer, deposito_id integer
    );
    CREATE TABLE chofer_stock (
      empresa_id integer, chofer_id integer, producto_id integer, cantidad numeric,
      PRIMARY KEY (empresa_id, chofer_id, producto_id)
    );
    CREATE TABLE chofer_stock_mov (
      id serial PRIMARY KEY, empresa_id integer, chofer_id integer, producto_id integer,
      deposito_id integer, gasto_id integer, fecha timestamptz, tipo text, cantidad numeric,
      motivo text, referencia text, created_at timestamptz DEFAULT now()
    );
    INSERT INTO empresas VALUES (3, '{"deposito_permisos_estricto":true}');
    INSERT INTO choferes VALUES (7, 3, true);
    INSERT INTO productos VALUES
      (11, 3, 'Bidón', true, false, null),
      (12, 3, 'Pack', true, false, null);
    INSERT INTO depositos VALUES
      (1, 3, 'Origen', null, true),
      (2, 3, 'Destino', null, true),
      (3, 3, 'Nuevo', null, true);
    INSERT INTO deposito_chofer (empresa_id, deposito_id, chofer_id) VALUES (3,1,7),(3,2,7),(3,3,7);
    INSERT INTO gastos_repartidor VALUES (55,3,7,'2026-09-20','compra_mercaderia','Carga original',1000,null,5,11,1);
    INSERT INTO chofer_stock VALUES (3,7,11,5);
    INSERT INTO chofer_stock_mov (empresa_id,chofer_id,producto_id,deposito_id,gasto_id,fecha,tipo,cantidad,referencia)
      VALUES (3,7,11,1,55,'2026-09-20 12:00Z','INGRESO_GASTOS',5,'Carga desde Gastos: Carga original');
  `);
}

async function buildApp(pool, { pausedRoute, acquired, release, pauseOnTransaction = 1 }) {
  const gastosDir = await mkdtemp(path.join(process.cwd(), '.gastos-stock-race-'));
  const app = express();
  app.use(express.json());
  const auth = (req, _res, next) => { req.user = { role: 'admin', empresa_id: 3 }; next(); };
  const transactionCounts = new Map();
  const makeTransaction = route => work => {
    const transactionNumber = (transactionCounts.get(route) || 0) + 1;
    transactionCounts.set(route, transactionNumber);
    return dbWithTransaction(
    txQuery => work(async (sql, params = []) => {
      const rows = await txQuery(sql, params);
      if (route === pausedRoute
        && transactionNumber === pauseOnTransaction
        && sql.includes('pg_advisory_xact_lock')
        && String(params[0]).includes('balance:11:deposito:1')) {
        acquired.resolve();
        await release.promise;
      }
      return rows;
    }),
    { pool, maxRetries: 0, retryDelayMs: 0 },
  );
  };
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  app.use('/api/stock', createStockRouter({
    query, pool, withTransaction: makeTransaction('stock'), withAuth: auth,
    checkLicencia(_req, _res, next) { next(); }, isSuper() { return false; },
    getEmpresaIdFromToken() { return 3; },
  }));
  app.use('/api/gastos', createGastosRouter({
    GASTOS_DIR: gastosDir, query, withTransaction: makeTransaction('gastos'), withAuth: auth,
    checkLicencia(_req, _res, next) { next(); }, isSuper() { return false; },
    isRepartidor() { return false; }, getEmpresaIdFromToken() { return 3; },
  }));
  return { app, cleanup: () => rm(gastosDir, { recursive: true, force: true }) };
}

async function transfer(base) {
  return fetch(`${base}/api/stock/depositos/transferir`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origen_deposito_id: 1, destino_deposito_id: 2, producto_id: 11, chofer_id: 7, cantidad: 4 }),
  });
}

async function updateGasto(base) {
  const body = new FormData();
  body.append('tipo', 'compra_mercaderia');
  body.append('descripcion', 'Carga nueva');
  body.append('cantidad', '3');
  body.append('producto_id', '12');
  body.append('deposito_id', '3');
  body.append('chofer_id', '7');
  return fetch(`${base}/api/gastos/55`, { method: 'PUT', body });
}

async function deleteGasto(base) {
  return fetch(`${base}/api/gastos/55`, { method: 'DELETE' });
}

async function assertStockInvariant(pool) {
  const mismatch = await pool.query(`
    WITH physical AS (
      SELECT empresa_id, chofer_id, producto_id, SUM(cantidad) AS cantidad
        FROM chofer_stock
       GROUP BY empresa_id, chofer_id, producto_id
    ), ledger AS (
      SELECT empresa_id, chofer_id, producto_id, SUM(cantidad) AS cantidad
        FROM chofer_stock_mov
       GROUP BY empresa_id, chofer_id, producto_id
    )
    SELECT COALESCE(p.empresa_id,l.empresa_id) AS empresa_id,
           COALESCE(p.chofer_id,l.chofer_id) AS chofer_id,
           COALESCE(p.producto_id,l.producto_id) AS producto_id
      FROM physical p
      FULL JOIN ledger l USING (empresa_id,chofer_id,producto_id)
     WHERE COALESCE(p.cantidad,0) <> COALESCE(l.cantidad,0)`);
  assert.deepEqual(mismatch.rows, []);

  const negative = await pool.query(`
    SELECT empresa_id, producto_id, deposito_id, SUM(cantidad) AS saldo
      FROM chofer_stock_mov
     WHERE deposito_id IS NOT NULL
     GROUP BY empresa_id, producto_id, deposito_id
    HAVING SUM(cantidad) < 0`);
  assert.deepEqual(negative.rows, []);
}

async function detailedState(pool) {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM gastos_repartidor WHERE id=55) AS gasto,
    (SELECT cantidad FROM gastos_repartidor WHERE id=55) AS gasto_cantidad,
    (SELECT producto_id FROM gastos_repartidor WHERE id=55) AS gasto_producto,
    (SELECT deposito_id FROM gastos_repartidor WHERE id=55) AS gasto_deposito,
    COALESCE((SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=11),0) AS stock_11,
    COALESCE((SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=12),0) AS stock_12,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE empresa_id=3 AND producto_id=11 AND deposito_id=1) AS d1_p11,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE empresa_id=3 AND producto_id=11 AND deposito_id=2) AS d2_p11,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE empresa_id=3 AND producto_id=12 AND deposito_id=3) AS d3_p12`);
  const row = result.rows[0];
  return {
    gasto: row.gasto,
    gastoCantidad: row.gasto_cantidad == null ? null : Number(row.gasto_cantidad),
    gastoProducto: row.gasto_producto == null ? null : Number(row.gasto_producto),
    gastoDeposito: row.gasto_deposito == null ? null : Number(row.gasto_deposito),
    stock11: Number(row.stock_11), stock12: Number(row.stock_12),
    d1p11: Number(row.d1_p11), d2p11: Number(row.d2_p11), d3p12: Number(row.d3_p12),
  };
}

async function state(pool) {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM gastos_repartidor WHERE id=55) AS gasto,
    (SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=11) AS stock,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE empresa_id=3 AND producto_id=11 AND deposito_id=1) AS origen,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE empresa_id=3 AND producto_id=11 AND deposito_id=2) AS destino`);
  const row = result.rows[0];
  return { gasto: row.gasto, stock: Number(row.stock), origen: Number(row.origen), destino: Number(row.destino) };
}

for (const winner of ['stock', 'gastos']) {
  test(`PostgreSQL real: transferencia vs DELETE serializa cuando gana ${winner}`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      const acquired = deferred();
      const release = deferred();
      const { app, cleanup } = await buildApp(pool, { pausedRoute: winner, acquired, release });
      try {
        await withServer(app, async base => {
          const first = winner === 'stock' ? transfer(base) : fetch(`${base}/api/gastos/55`, { method: 'DELETE' });
          await acquired.promise;
          const second = winner === 'stock' ? fetch(`${base}/api/gastos/55`, { method: 'DELETE' }) : transfer(base);
          await new Promise(resolve => setTimeout(resolve, 50));
          release.resolve();
          const [firstResponse, secondResponse] = await Promise.all([first, second]);
          const statuses = winner === 'stock'
            ? [firstResponse.status, secondResponse.status]
            : [secondResponse.status, firstResponse.status];
          assert.deepEqual(statuses, winner === 'stock' ? [200, 409] : [400, 200]);
        });
      } finally {
        release.resolve();
        await cleanup();
      }
      assert.deepEqual(await state(pool), winner === 'stock'
        ? { gasto: 1, stock: 5, origen: 1, destino: 4 }
        : { gasto: 0, stock: 0, origen: 0, destino: 0 });
      await assertStockInvariant(pool);
    });
  });
}

for (const winner of ['stock', 'gastos']) {
  test(`PostgreSQL real: transferencia vs PUT serializa cuando gana ${winner}`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      const acquired = deferred();
      const release = deferred();
      const { app, cleanup } = await buildApp(pool, { pausedRoute: winner, acquired, release });
      try {
        await withServer(app, async base => {
          const first = winner === 'stock' ? transfer(base) : updateGasto(base);
          await acquired.promise;
          const second = winner === 'stock' ? updateGasto(base) : transfer(base);
          await new Promise(resolve => setTimeout(resolve, 50));
          release.resolve();
          const [firstResponse, secondResponse] = await Promise.all([first, second]);
          const statuses = winner === 'stock'
            ? [firstResponse.status, secondResponse.status]
            : [secondResponse.status, firstResponse.status];
          assert.deepEqual(statuses, winner === 'stock' ? [200, 409] : [400, 200]);
        });
      } finally {
        release.resolve();
        await cleanup();
      }
      assert.deepEqual(await detailedState(pool), winner === 'stock'
        ? { gasto: 1, gastoCantidad: 5, gastoProducto: 11, gastoDeposito: 1, stock11: 5, stock12: 0, d1p11: 1, d2p11: 4, d3p12: 0 }
        : { gasto: 1, gastoCantidad: 3, gastoProducto: 12, gastoDeposito: 3, stock11: 0, stock12: 3, d1p11: 0, d2p11: 0, d3p12: 3 });
      await assertStockInvariant(pool);
    });
  });
}

for (const winner of ['PUT', 'DELETE']) {
  test(`PostgreSQL real: PUT vs DELETE mismo gasto no revierte dos veces cuando gana ${winner}`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      const acquired = deferred();
      const release = deferred();
      const { app, cleanup } = await buildApp(pool, { pausedRoute: 'gastos', acquired, release });
      try {
        await withServer(app, async base => {
          const first = winner === 'PUT' ? updateGasto(base) : deleteGasto(base);
          await acquired.promise;
          const second = winner === 'PUT' ? deleteGasto(base) : updateGasto(base);
          await new Promise(resolve => setTimeout(resolve, 50));
          release.resolve();
          const responses = await Promise.all([first, second]);
          assert.deepEqual(responses.map(response => response.status), winner === 'PUT' ? [200, 409] : [200, 404]);
        });
      } finally {
        release.resolve();
        await cleanup();
      }
      assert.deepEqual(await detailedState(pool), winner === 'PUT'
        ? { gasto: 1, gastoCantidad: 3, gastoProducto: 12, gastoDeposito: 3, stock11: 0, stock12: 3, d1p11: 0, d2p11: 0, d3p12: 3 }
        : { gasto: 0, gastoCantidad: null, gastoProducto: null, gastoDeposito: null, stock11: 0, stock12: 0, d1p11: 0, d2p11: 0, d3p12: 0 });
      const oldMovementCount = await pool.query("SELECT COUNT(*)::int AS c FROM chofer_stock_mov WHERE gasto_id=55 AND producto_id=11");
      assert.equal(oldMovementCount.rows[0].c, 0);
      await assertStockInvariant(pool);
    });
  });
}

test('PostgreSQL real: fallo entre revertir viejo y aplicar nuevo hace rollback total', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const acquired = deferred();
    const release = deferred();
    const gastosDir = await mkdtemp(path.join(process.cwd(), '.gastos-stock-rollback-'));
    const app = express();
    const auth = (req, _res, next) => { req.user = { role: 'admin', empresa_id: 3 }; next(); };
    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const withTransaction = work => dbWithTransaction(
      txQuery => work(async (sql, params = []) => {
        if (sql.includes('INSERT INTO chofer_stock (') && Number(params[2]) === 12) {
          throw new Error('fallo instrumentado al aplicar stock nuevo');
        }
        return txQuery(sql, params);
      }),
      { pool, maxRetries: 0, retryDelayMs: 0 },
    );
    app.use('/api/gastos', createGastosRouter({
      GASTOS_DIR: gastosDir, query, withTransaction, withAuth: auth,
      checkLicencia(_req, _res, next) { next(); }, isSuper() { return false; },
      isRepartidor() { return false; }, getEmpresaIdFromToken() { return 3; },
    }));
    try {
      await withServer(app, async base => assert.equal((await updateGasto(base)).status, 500));
    } finally {
      acquired.resolve(); release.resolve();
      await rm(gastosDir, { recursive: true, force: true });
    }
    assert.deepEqual(await detailedState(pool), {
      gasto: 1, gastoCantidad: 5, gastoProducto: 11, gastoDeposito: 1,
      stock11: 5, stock12: 0, d1p11: 5, d2p11: 0, d3p12: 0,
    });
    await assertStockInvariant(pool);
  });
});

for (const legacyCase of ['ausente', 'múltiple']) {
  test(`PostgreSQL real: movimiento legacy ${legacyCase} falla cerrado sin mutar gasto ni stock`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      await pool.query('UPDATE chofer_stock_mov SET gasto_id = NULL, referencia = $1 WHERE gasto_id = 55',
        [legacyCase === 'ausente' ? 'referencia no coincidente' : 'Carga desde Gastos: Carga original']);
      if (legacyCase === 'múltiple') {
        await pool.query(`
          INSERT INTO chofer_stock_mov (empresa_id,chofer_id,producto_id,deposito_id,gasto_id,fecha,tipo,cantidad,referencia)
          VALUES (3,7,11,1,NULL,'2026-09-20 18:00Z','INGRESO_GASTOS',5,'Carga desde Gastos: Carga original')
        `);
      }
      const acquired = deferred();
      const release = deferred();
      const { app, cleanup } = await buildApp(pool, { pausedRoute: null, acquired, release });
      try {
        await withServer(app, async base => assert.equal((await deleteGasto(base)).status, 409));
      } finally {
        release.resolve();
        await cleanup();
      }
      const result = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM gastos_repartidor WHERE id=55) AS gasto,
        (SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=11) AS stock,
        (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE tipo='INGRESO_GASTOS') AS movimientos`);
      assert.deepEqual({ gasto: result.rows[0].gasto, stock: Number(result.rows[0].stock), movimientos: result.rows[0].movimientos },
        { gasto: 1, stock: 5, movimientos: legacyCase === 'ausente' ? 1 : 2 });
    });
  });
}
