import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import { createStockRouter } from '../src/routes/stock.js';

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

function buildApp({ query, withTransaction, user = { role: 'admin', empresa_id: 3 } }) {
  const app = express();
  app.use(express.json());
  app.use('/api/stock', createStockRouter({
    query,
    pool: { connect: async () => { throw new Error('pool directo no permitido'); } },
    withTransaction,
    withAuth(req, _res, next) { req.user = user; next(); },
    checkLicencia(_req, _res, next) { next(); },
    isSuper(req) { return req.user?.role === 'super'; },
    getEmpresaIdFromToken(req) { return req.user?.empresa_id; },
  }));
  return app;
}

function isSchema(sql) {
  return /CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql);
}

test('schema readiness falla cerrado, coordina concurrentes y reintenta en la siguiente petición', async () => {
  let firstGateResolve;
  const firstGate = new Promise(resolve => { firstGateResolve = resolve; });
  let schemaAttempts = 0;
  let businessQueries = 0;
  const query = async sql => {
    if (isSchema(sql)) {
      if (/CREATE TABLE IF NOT EXISTS depositos/.test(sql)) {
        schemaAttempts += 1;
        if (schemaAttempts === 1) {
          await firstGate;
          throw new Error('detalle privado DDL');
        }
      }
      return [];
    }
    businessQueries += 1;
    if (/FROM depositos/.test(sql)) return [];
    throw new Error(`consulta inesperada: ${sql}`);
  };
  const app = buildApp({ query, withTransaction: async work => work(query) });

  await withServer(app, async base => {
    const one = fetch(`${base}/api/stock/depositos`);
    const two = fetch(`${base}/api/stock/depositos`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(schemaAttempts, 1);
    firstGateResolve();
    const failed = await Promise.all([one, two]);
    assert.deepEqual(failed.map(r => r.status), [503, 503]);
    for (const response of failed) {
      assert.deepEqual(await response.json(), {
        error: 'Stock temporalmente no disponible',
        code: 'STOCK_SCHEMA_UNAVAILABLE',
      });
    }
    assert.equal(businessQueries, 0);

    const retried = await fetch(`${base}/api/stock/depositos`);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), []);
  });

  assert.equal(schemaAttempts, 2);
  assert.equal(businessQueries, 1);
});

test('todas las clases mutantes propagan COMMIT ambiguo como 503 sanitizado', async t => {
  const cases = [
    ['POST', '/api/stock/depositos', { nombre: 'Central' }],
    ['PUT', '/api/stock/depositos/1', { nombre: 'Central 2' }],
    ['DELETE', '/api/stock/depositos/1', undefined],
    ['POST', '/api/stock/depositos/transferir', { origen_deposito_id: 1, destino_deposito_id: 2, producto_id: 11, chofer_id: 7, cantidad: 2 }],
    ['POST', '/api/stock/depositos/transferencias/revertir', { referencia: 'TRANSFER:abc', chofer_id: 7 }],
    ['POST', '/api/stock/depositos/choferes', { chofer_id: 7, deposito_ids: [1] }],
    ['PUT', '/api/stock/depositos/permisos-config', { deposito_permisos_estricto: true }],
    ['POST', '/api/stock/ajuste', { producto_id: 11, qty: 2, tipo: 'ADJUST+', chofer_id: 7, deposito_id: 1 }],
  ];

  for (const [method, path, body] of cases) {
    await t.test(`${method} ${path}`, async () => {
      let transactionCalls = 0;
      let workCalls = 0;
      const query = async sql => isSchema(sql) ? [] : [];
      const app = buildApp({
        query,
        withTransaction: async work => {
          transactionCalls += 1;
          workCalls += 1;
          await work(async (sql, params = []) => {
            if (/SELECT id, tipo, producto_id, deposito_id, cantidad/.test(sql)) {
              return [
                { id: 1, tipo: 'TRANSFER_OUT', producto_id: 11, deposito_id: 1, cantidad: -2 },
                { id: 2, tipo: 'TRANSFER_IN', producto_id: 11, deposito_id: 2, cantidad: 2 },
              ];
            }
            if (/referencia = \$2/.test(sql) && /TRANSFER_REV_IN/.test(sql) && /LIMIT 1/.test(sql)) return [];
            if (/RETURNING/.test(sql)) return [{ id: 1, empresa_id: 3, nombre: 'Central', activo: true }];
            if (/FROM choferes/.test(sql)) return [{ id: 7 }];
            if (/FROM productos/.test(sql)) return [{ id: 11 }];
            if (/FROM depositos/.test(sql) && /ANY/.test(sql)) {
              return (params[1] || []).map(id => ({ id, nombre: `D${id}`, activo: true }));
            }
            if (/FROM depositos/.test(sql)) return [{ id: 1, nombre: 'Central', direccion: null, activo: true }];
            if (/FROM empresas/.test(sql)) return [{ id: 3, estricto: true }];
            if (/FROM deposito_chofer/.test(sql)) {
              const ids = Array.isArray(params[2]) ? params[2] : [params[2] || 1];
              return ids.map(deposito_id => ({ deposito_id }));
            }
            if (/SUM\(cantidad\)/.test(sql)) return [{ saldo: 10 }];
            return [];
          });
          const error = new Error('detalle SQL privado');
          error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
          throw error;
        },
      });

      await withServer(app, async base => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: 'Resultado de operación de stock indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      });
      assert.equal(transactionCalls, 1);
      assert.equal(workCalls, 1);
    });
  }
});

test('inventario estructural: mutaciones usan helper canónico y locks ordenados', async () => {
  const source = await readFile(new URL('../src/routes/stock.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /async function withTransaction\s*\(/);
  assert.doesNotMatch(source, /dbQuery\([\s\S]{0,1200}(INSERT INTO depositos|UPDATE depositos|UPDATE deposito_chofer|INSERT INTO deposito_chofer|INSERT INTO chofer_stock_mov|INSERT INTO chofer_stock|UPDATE empresas)/);
  const lockingSource = await readFile(new URL('../src/services/stockLocking.js', import.meta.url), 'utf8');
  assert.match(source, /services\/stockLocking\.js/);
  assert.match(lockingSource, /Orden global: referencia\/idempotencia -> chofer -> producto -> depósitos -> saldos\/movimientos/);
  assert.match(lockingSource, /pg_advisory_xact_lock/);
  assert.match(lockingSource, /\.sort\(\(a, b\) => a - b\)/);

  const gastosSource = await readFile(new URL('../src/routes/gastos.js', import.meta.url), 'utf8');
  assert.doesNotMatch(gastosSource, /cfgRows\.length === 0[\s\S]{0,160}return !\(await isDepositoPermisosEstricto/);
});

test('reemplazo de permisos rechaza lista vacía para no ampliar acceso', async () => {
  let transactionCalls = 0;
  const app = buildApp({
    query: async sql => isSchema(sql) ? [] : [],
    withTransaction: async work => { transactionCalls += 1; return work(async () => []); },
  });
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/stock/depositos/choferes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chofer_id: 7, deposito_ids: [] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Se requiere al menos un depósito habilitado' });
  });
  assert.equal(transactionCalls, 0);
});
