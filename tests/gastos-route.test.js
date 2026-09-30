import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGastosRouter } from '../src/routes/gastos.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { ensureRetornablesLedgerSchema } from '../src/services/retornablesLedger.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function buildGastosApp({ query, user = { role: 'admin', empresa_id: 3 }, withTransaction, ...routerOverrides }) {
  const gastosDir = await mkdtemp(path.join(tmpdir(), 'pedivoy-gastos-'));
  const app = express();
  app.use('/api/gastos', createGastosRouter({
    GASTOS_DIR: gastosDir,
    query,
    ...routerOverrides,
    withTransaction: withTransaction || (work => work(query)),
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
    isRepartidor(req) {
      return String(req.user?.role || '').toLowerCase() === 'repartidor';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return { app, gastosDir, cleanup: () => rm(gastosDir, { recursive: true, force: true }) };
}

function isSchemaQuery(sql) {
  return /ALTER TABLE|CREATE TABLE|CREATE INDEX/i.test(sql);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('POST /api/gastos elimina el upload cuando la validación rechaza la operación', async () => {
  const { app, gastosDir, cleanup } = await buildGastosApp({
    query: async (sql) => isSchemaQuery(sql) ? [] : [],
  });
  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('tipo', 'combustible');
      body.append('comprobante', new Blob(['%PDF-test'], { type: 'application/pdf' }), 'ticket.pdf');
      const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(response.status, 400);
    });
    assert.deepEqual(await readdir(gastosDir), []);
  } finally {
    await cleanup();
  }
});

test('POST /api/gastos rechaza chofer que no pertenece a la empresa del usuario', async () => {
  const calls = [];
  const { app, cleanup } = await buildGastosApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM choferes') && sql.includes('empresa_id')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('fecha', '2026-06-27');
      body.append('tipo', 'combustible');
      body.append('descripcion', 'YPF');
      body.append('monto', '1000');
      body.append('chofer_id', '99');

      const resp = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(resp.status, 400);
      assert.match((await resp.json()).error, /Chofer inválido/);
    });
  } finally {
    await cleanup();
  }

  assert.ok(calls.some((c) => c.sql.includes('FROM choferes') && c.params[0] === 99 && c.params[1] === 3));
});

test('POST /api/gastos respeta permisos estrictos de depósito', async () => {
  const { app, cleanup } = await buildGastosApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('FROM depositos')) return [{ id: 5 }];
      if (sql.includes('FROM deposito_chofer')) return [];
      if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: true }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('fecha', '2026-06-27');
      body.append('tipo', 'carga_llenos');
      body.append('descripcion', 'Carga');
      body.append('monto', '2000');
      body.append('cantidad', '2');
      body.append('producto_id', '11');
      body.append('deposito_id', '5');
      body.append('chofer_id', '7');

      const resp = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(resp.status, 403);
      assert.match((await resp.json()).error, /depósito/);
    });
  } finally {
    await cleanup();
  }
});

test('PUT /api/gastos conserva producto y depósito existentes si el panel no los reenvía', async () => {
  const updates = [];
  let transactionCalls = 0;
  let insideTransaction = false;
  let directMutation = false;
  const query = async (sql, params = []) => {
    const isMutation = /UPDATE chofer_stock|DELETE FROM chofer_stock_mov|UPDATE gastos_repartidor|INSERT INTO chofer_stock|INSERT INTO retornables_/.test(sql);
    if (isMutation && !insideTransaction) directMutation = true;
    if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('FROM gastos_repartidor') && sql.includes('WHERE id = $1')) {
      return [{
        id: 55,
        empresa_id: 3,
        chofer_id: 7,
        fecha: '2026-06-26',
        tipo: 'carga_llenos',
        descripcion: 'Carga original',
        monto: '1000.00',
        comprobante_path: null,
        cantidad: '2',
        producto_id: 11,
        deposito_id: 5,
      }];
    }
    if (sql.includes('FROM choferes')) return [{ id: 7 }];
    if (sql.includes('FROM productos')) return [{ id: 11 }];
    if (sql.includes('FROM depositos')) return [{ id: 5 }];
    if (sql.includes('FROM deposito_chofer')) return [{ deposito_id: 5 }];
    if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: false }];
    if (sql.includes('FROM chofer_stock_mov') && sql.includes("tipo = 'INGRESO_GASTOS'")) return [{
      id: 9, empresa_id: 3, chofer_id: 7, producto_id: 11, deposito_id: 5,
      gasto_id: 55, fecha: '2026-06-26', tipo: 'INGRESO_GASTOS', cantidad: '2',
      referencia: 'Carga desde Gastos: Carga original',
    }];
    if (sql.includes('SUM(cantidad)')) return [{ saldo: '2' }];
    if (sql.includes('UPDATE chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
    if (sql.includes('DELETE FROM chofer_stock_mov')) return [{ id: 9 }];
    if (sql.includes('UPDATE gastos_repartidor')) {
      updates.push(params);
      return [{ id: 55 }];
    }
    if (sql.includes('INSERT INTO chofer_stock_mov')) return [{ id: 10 }];
    if (sql.includes('INSERT INTO chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
    if (sql.includes('SELECT saldo FROM retornables_saldos')) return [{ saldo: '2' }];
    if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '5' }];
    if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 88, saldo_resultante: '5' }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  const { app, cleanup } = await buildGastosApp({
    query,
    withTransaction: async work => {
      transactionCalls += 1;
      insideTransaction = true;
      try { return await work(query); } finally { insideTransaction = false; }
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('fecha', '2026-06-27');
      body.append('tipo', 'carga_llenos');
      body.append('descripcion', 'Carga editada');
      body.append('monto', '1500');
      body.append('cantidad', '3');
      body.append('chofer_id', '7');

      const resp = await fetch(`${baseUrl}/api/gastos/55`, { method: 'PUT', body });
      assert.equal(resp.status, 200);
    });
  } finally {
    await cleanup();
  }

  assert.equal(updates.length, 1);
  assert.equal(updates[0][8], 11);
  assert.equal(updates[0][9], 5);
  assert.equal(transactionCalls, 1);
  assert.equal(directMutation, false);
});

test('DELETE /api/gastos revierte stock, ledger y gasto en una sola transacción', async () => {
  let transactionCalls = 0;
  let insideTransaction = false;
  let directMutation = false;
  const txSql = [];
  const query = async (sql) => {
    const isMutation = /UPDATE chofer_stock|DELETE FROM chofer_stock_mov|DELETE FROM gastos_repartidor|INSERT INTO retornables_/.test(sql);
    if (isMutation && !insideTransaction) directMutation = true;
    if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (/\bSELECT\b/i.test(sql) && sql.includes('FROM gastos_repartidor')) return [{
      id: 55,
      empresa_id: 3,
      chofer_id: 7,
      fecha: '2026-06-26',
      tipo: 'carga_llenos',
      descripcion: 'Carga original',
      monto: '1000',
      cantidad: '2',
      producto_id: 11,
      deposito_id: null,
      comprobante_path: null,
    }];
    if (sql.includes('FROM chofer_stock_mov') && sql.includes("tipo = 'INGRESO_GASTOS'")) return [{
      id: 9, empresa_id: 3, chofer_id: 7, producto_id: 11, deposito_id: null,
      gasto_id: 55, fecha: '2026-06-26', tipo: 'INGRESO_GASTOS', cantidad: '2',
      referencia: 'Carga desde Gastos: Carga original',
    }];
    if (sql.includes('UPDATE chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
    if (sql.includes('DELETE FROM chofer_stock_mov')) return [{ id: 9 }];
    if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '0' }];
    if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 8, saldo_resultante: '0' }];
    if (sql.includes('DELETE FROM gastos_repartidor')) return [{ id: 55 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  const { app, cleanup } = await buildGastosApp({
    query,
    withTransaction: async work => {
      transactionCalls += 1;
      insideTransaction = true;
      try {
        return await work(async (sql, params) => {
          txSql.push(sql);
          return query(sql, params);
        });
      } finally {
        insideTransaction = false;
      }
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/gastos/55`, { method: 'DELETE' });
      assert.equal(response.status, 200);
    });
  } finally {
    await cleanup();
  }

  assert.equal(transactionCalls, 1);
  assert.equal(directMutation, false);
  assert.ok(txSql.some(sql => sql.includes('UPDATE chofer_stock')));
  assert.ok(txSql.some(sql => sql.includes('INSERT INTO retornables_movimientos')));
  assert.ok(txSql.some(sql => sql.includes('DELETE FROM gastos_repartidor')));
});

test('POST /api/gastos ejecuta gasto, stock y ledger dentro de una sola transacción', async () => {
  const txSql = [];
  let directMutation = false;
  const query = async (sql) => {
    if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('FROM choferes')) return [{ id: 7 }];
    if (sql.includes('FROM productos')) return [{ id: 11 }];
    if (/INSERT INTO gastos_repartidor|INSERT INTO chofer_stock|INSERT INTO retornables_|UPDATE chofer_stock|DELETE FROM chofer_stock_mov/.test(sql)) {
      directMutation = true;
    }
    throw new Error(`Consulta directa inesperada: ${sql}`);
  };
  let transactionCalls = 0;
  const withTransaction = async (work) => {
    transactionCalls += 1;
    return work(async (sql) => {
      txSql.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('INSERT INTO gastos_repartidor')) return [{ id: 90 }];
      if (sql.includes('INSERT INTO chofer_stock_mov')) return [{ id: 91 }];
      if (sql.includes('INSERT INTO chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '2' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 5, saldo_resultante: '2' }];
      throw new Error(`SQL transaccional inesperado: ${sql}`);
    });
  };
  const { app, cleanup } = await buildGastosApp({ query, withTransaction });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('tipo', 'carga_llenos');
      body.append('descripcion', 'Carga');
      body.append('cantidad', '2');
      body.append('producto_id', '11');
      body.append('chofer_id', '7');
      const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(response.status, 200);
    });
  } finally {
    await cleanup();
  }

  assert.equal(transactionCalls, 1);
  assert.equal(directMutation, false);
  assert.ok(txSql.some(sql => sql.includes('INSERT INTO gastos_repartidor')));
  assert.ok(txSql.some(sql => sql.includes('INSERT INTO chofer_stock_mov')));
  assert.ok(txSql.some(sql => sql.includes('INSERT INTO retornables_movimientos')));
});

test('ledger retornable desde gastos revierte saldo si falla el movimiento', async () => {
  let saldoPersistido = 5;
  let transactionCalls = 0;
  const withTransaction = async (work) => {
    transactionCalls += 1;
    let saldoTx = saldoPersistido;
    const txQuery = async (sql, params = []) => {
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('INSERT INTO gastos_repartidor')) return [{ id: 90 }];
      if (sql.includes('INSERT INTO retornables_saldos')) {
        saldoTx += Number(params[4]);
        return [{ saldo: String(saldoTx) }];
      }
      if (sql.includes('INSERT INTO retornables_movimientos')) {
        throw new Error('fallo movimiento');
      }
      throw new Error(`SQL transaccional inesperado: ${sql}`);
    };
    const result = await work(txQuery);
    saldoPersistido = saldoTx;
    return result;
  };
  const { app, cleanup } = await buildGastosApp({
    withTransaction,
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('INSERT INTO gastos_repartidor')) return [{ id: 90 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('tipo', 'descarga_vacios');
      body.append('descripcion', 'Descarga');
      body.append('cantidad', '2');
      body.append('producto_id', '11');
      body.append('chofer_id', '7');
      const resp = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(resp.status, 500);
    });
  } finally {
    await cleanup();
  }

  assert.equal(transactionCalls, 1);
  assert.equal(saldoPersistido, 5);
});

test('POST /api/gastos conserva upload y responde 503 ante outcome unknown', async () => {
  const outcomeUnknown = new Error('detalle privado');
  outcomeUnknown.code = 'TRANSACTION_OUTCOME_UNKNOWN';
  const { app, gastosDir, cleanup } = await buildGastosApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    withTransaction: async () => { throw outcomeUnknown; },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('tipo', 'combustible');
      body.append('chofer_id', '7');
      body.append('comprobante', new Blob(['%PDF-test'], { type: 'application/pdf' }), 'ticket.pdf');
      const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: 'Resultado del gasto indeterminado',
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
    });
    assert.equal((await readdir(gastosDir)).length, 1);
  } finally {
    await cleanup();
  }
});

test('GET /api/gastos filtra por depósito y respeta límite solicitado', async () => {
  let selectCall = null;
  const { app, cleanup } = await buildGastosApp({
    query: async (sql, params = []) => {
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM gastos_repartidor g')) {
        selectCall = { sql, params };
        return [{
          id: 91,
          empresa_id: 3,
          chofer_id: 7,
          deposito_id: 5,
          deposito_nombre: 'Depósito Centro',
          fecha: '2026-08-21',
          tipo: 'combustible',
          descripcion: 'YPF',
          monto: '15000.00',
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/gastos?deposito_id=5&from=2026-06-01&to=2026-06-30&limit=500`);
      assert.equal(resp.status, 200);
      const rows = await resp.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].deposito_nombre, 'Depósito Centro');
    });
  } finally {
    await cleanup();
  }

  assert.ok(selectCall);
  assert.match(selectCall.sql, /COALESCE\(g\.deposito_id, md\.deposito_id\) =/);
  assert.match(selectCall.sql, /LIMIT \$/);
  assert.deepEqual(selectCall.params, [3, 5, '2026-06-01', '2026-06-30', 500]);
});

test('PostgreSQL real: POST revierte gasto, stock, stock_mov y saldo si falla el movimiento ledger', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await pool.query(`
      CREATE TABLE empresas (id integer PRIMARY KEY, config_operativa jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, username text, activo boolean NOT NULL DEFAULT true);
      CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
      CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text);
      CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, direccion text, activo boolean DEFAULT true);
      CREATE TABLE productos (
        id integer PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        nombre text,
        retornable boolean DEFAULT false,
        deleted_at timestamptz
      );
      CREATE TABLE pedidos (id integer PRIMARY KEY);
      CREATE TABLE gastos_repartidor (
        id serial PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        chofer_id integer REFERENCES choferes(id),
        fecha date,
        tipo text,
        descripcion text,
        monto numeric,
        comprobante_path text,
        cantidad numeric,
        producto_id integer REFERENCES productos(id),
        deposito_id integer REFERENCES depositos(id)
      );
      CREATE TABLE chofer_stock (
        empresa_id integer,
        chofer_id integer,
        producto_id integer,
        cantidad numeric,
        PRIMARY KEY (empresa_id, chofer_id, producto_id)
      );
      CREATE TABLE chofer_stock_mov (
        id serial PRIMARY KEY,
        empresa_id integer,
        chofer_id integer,
        producto_id integer,
        deposito_id integer,
        gasto_id integer,
        fecha timestamptz,
        tipo text,
        cantidad numeric,
        referencia text,
        created_at timestamptz DEFAULT now()
      );
      INSERT INTO empresas (id) VALUES (3);
      INSERT INTO choferes (id, empresa_id) VALUES (7, 3);
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES (11, 3, 'Bidón', true);
      INSERT INTO chofer_stock VALUES (3, 7, 11, 5);
    `);

    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const withTransaction = work => dbWithTransaction(
      txQuery => work(async (sql, params = []) => {
        if (sql.includes('INSERT INTO retornables_movimientos')) throw new Error('fallo movimiento instrumentado');
        return txQuery(sql, params);
      }),
      { pool, maxRetries: 0, retryDelayMs: 0 },
    );
    const { app, cleanup } = await buildGastosApp({ query, withTransaction });

    try {
      await withServer(app, async (baseUrl) => {
        const body = new FormData();
        body.append('tipo', 'carga_llenos');
        body.append('descripcion', 'Carga fallida');
        body.append('cantidad', '2');
        body.append('producto_id', '11');
        body.append('chofer_id', '7');
        const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
        assert.equal(response.status, 500);
      });
    } finally {
      await cleanup();
    }

    const state = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM gastos_repartidor) AS gastos,
      (SELECT cantidad FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 11) AS stock,
      (SELECT COUNT(*)::int FROM chofer_stock_mov) AS stock_mov,
      (SELECT COUNT(*)::int FROM retornables_saldos) AS saldos,
      (SELECT COUNT(*)::int FROM retornables_movimientos) AS movimientos`);
    assert.deepEqual({
      gastos: state.rows[0].gastos,
      stock: Number(state.rows[0].stock),
      stock_mov: state.rows[0].stock_mov,
      saldos: state.rows[0].saldos,
      movimientos: state.rows[0].movimientos,
    }, { gastos: 0, stock: 5, stock_mov: 0, saldos: 0, movimientos: 0 });
  });
});

test('PUT /api/gastos bloquea y relee el gasto dentro del tx antes de derivar defaults', async () => {
  const directSql = [];
  const txSql = [];
  let updateParams;
  const locked = {
    id: 55,
    empresa_id: 3,
    chofer_id: 7,
    fecha: '2026-09-20',
    tipo: 'combustible',
    descripcion: 'versión confirmada',
    monto: '2500',
    comprobante_path: null,
    cantidad: null,
    producto_id: null,
    deposito_id: null,
  };
  const { app, cleanup } = await buildGastosApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      directSql.push(sql);
      throw new Error(`Consulta directa inesperada: ${sql}`);
    },
    withTransaction: async work => work(async (sql, params = []) => {
      txSql.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM gastos_repartidor')) return [locked];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('UPDATE gastos_repartidor')) {
        updateParams = params;
        return [{ id: 55 }];
      }
      throw new Error(`SQL transaccional inesperado: ${sql}`);
    }),
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('monto', '3000');
      const response = await fetch(`${baseUrl}/api/gastos/55`, { method: 'PUT', body });
      assert.equal(response.status, 200);
    });
  } finally {
    await cleanup();
  }

  assert.deepEqual(directSql, []);
  const lockIndex = txSql.findIndex(sql => sql.includes('FROM gastos_repartidor') && /FOR UPDATE/i.test(sql));
  const updateIndex = txSql.findIndex(sql => sql.includes('UPDATE gastos_repartidor'));
  assert.ok(lockIndex >= 0 && updateIndex > lockIndex);
  assert.match(txSql[lockIndex], /FOR UPDATE/i);
  assert.match(txSql[updateIndex], /RETURNING id/i);
  assert.equal(updateParams[4], 'versión confirmada');
});

for (const method of ['PUT', 'DELETE']) {
  test(`${method} /api/gastos exige RETURNING exactamente una fila y revierte auxiliares`, async () => {
    const durable = { stock: 2, saldo: 2, gasto: true, movimientos: 1 };
    const gasto = {
      id: 55,
      empresa_id: 3,
      chofer_id: 7,
      fecha: '2026-09-20',
      tipo: 'carga_llenos',
      descripcion: 'Carga',
      monto: '1000',
      comprobante_path: null,
      cantidad: '2',
      producto_id: 11,
      deposito_id: null,
    };
    let transactionCalls = 0;
    const { app, cleanup } = await buildGastosApp({
      query: async (sql) => {
        if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FROM gastos_repartidor')) return [gasto];
        throw new Error(`Consulta directa inesperada: ${sql}`);
      },
      withTransaction: async work => {
        transactionCalls += 1;
        const pending = { ...durable };
        const txQuery = async (sql) => {
          if (/\bSELECT\b/i.test(sql) && sql.includes('FROM gastos_repartidor')) return [{
            id: 55,
            empresa_id: 3,
            chofer_id: 7,
            fecha: '2026-09-20',
            tipo: 'carga_llenos',
            descripcion: 'Carga',
            monto: '1000',
            comprobante_path: null,
            cantidad: '2',
            producto_id: 11,
            deposito_id: null,
          }];
          if (sql.includes('FROM choferes')) return [{ id: 7 }];
          if (sql.includes('FROM productos')) return [{ id: 11 }];
          if (sql.includes('UPDATE chofer_stock')) { pending.stock -= 2; return []; }
          if (sql.includes('DELETE FROM chofer_stock_mov')) return [];
          if (sql.includes('INSERT INTO retornables_saldos')) { pending.saldo -= 2; return [{ saldo: String(pending.saldo) }]; }
          if (sql.includes('INSERT INTO retornables_movimientos')) { pending.movimientos += 1; return [{ id: 2, saldo_resultante: String(pending.saldo) }]; }
          if (sql.includes('UPDATE gastos_repartidor') || sql.includes('DELETE FROM gastos_repartidor')) return [];
          throw new Error(`SQL transaccional inesperado: ${sql}`);
        };
        const result = await work(txQuery);
        Object.assign(durable, pending);
        return result;
      },
    });

    try {
      await withServer(app, async (baseUrl) => {
        const options = { method };
        if (method === 'PUT') {
          const body = new FormData();
          body.append('cantidad', '3');
          options.body = body;
        }
        const response = await fetch(`${baseUrl}/api/gastos/55`, options);
        assert.equal(response.status, 500);
      });
    } finally {
      await cleanup();
    }

    assert.equal(transactionCalls, 1);
    assert.deepEqual(durable, { stock: 2, saldo: 2, gasto: true, movimientos: 1 });
  });
}

test('PostgreSQL real: dos DELETE concurrentes revierten stock y ledger una sola vez', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await pool.query(`
      CREATE TABLE empresas (id integer PRIMARY KEY, config_operativa jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, username text, activo boolean NOT NULL DEFAULT true);
      CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
      CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text);
      CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, direccion text, activo boolean DEFAULT true);
      CREATE TABLE productos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, retornable boolean DEFAULT false, deleted_at timestamptz);
      CREATE TABLE pedidos (id integer PRIMARY KEY);
      CREATE TABLE gastos_repartidor (
        id integer PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        chofer_id integer REFERENCES choferes(id),
        fecha date,
        tipo text,
        descripcion text,
        monto numeric,
        comprobante_path text,
        cantidad numeric,
        producto_id integer REFERENCES productos(id),
        deposito_id integer REFERENCES depositos(id)
      );
      CREATE TABLE chofer_stock (
        empresa_id integer,
        chofer_id integer,
        producto_id integer,
        cantidad numeric,
        PRIMARY KEY (empresa_id, chofer_id, producto_id)
      );
      CREATE TABLE chofer_stock_mov (
        id serial PRIMARY KEY,
        empresa_id integer,
        chofer_id integer,
        producto_id integer,
        deposito_id integer,
        gasto_id integer,
        fecha timestamptz,
        tipo text,
        cantidad numeric,
        referencia text,
        created_at timestamptz DEFAULT now()
      );
      INSERT INTO empresas (id) VALUES (3);
      INSERT INTO choferes (id, empresa_id) VALUES (7, 3);
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES (11, 3, 'Bidón', true);
      INSERT INTO gastos_repartidor VALUES (55, 3, 7, '2026-09-20', 'carga_llenos', 'Carga', 1000, null, 2, 11, null);
      INSERT INTO chofer_stock VALUES (3, 7, 11, 2);
      INSERT INTO chofer_stock_mov (empresa_id, chofer_id, producto_id, gasto_id, fecha, tipo, cantidad)
      VALUES (3, 7, 11, 55, now(), 'INGRESO_GASTOS', 2);
    `);

    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    await ensureRetornablesLedgerSchema(query);
    await pool.query(`
      INSERT INTO retornables_saldos (empresa_id, sujeto_tipo, sujeto_id, producto_id, saldo)
      VALUES (3, 'chofer', 7, 11, 2)
    `);
    const firstLocked = deferred();
    const releaseFirst = deferred();
    let transactionNumber = 0;
    const withTransaction = work => {
      const number = ++transactionNumber;
      return dbWithTransaction(
        txQuery => work(async (sql, params = []) => {
          const rows = await txQuery(sql, params);
          if (number === 1 && sql.includes('FROM gastos_repartidor') && /FOR UPDATE/i.test(sql)) {
            firstLocked.resolve();
            await releaseFirst.promise;
          }
          return rows;
        }),
        { pool, maxRetries: 0, retryDelayMs: 0 },
      );
    };
    const { app, cleanup } = await buildGastosApp({ query, withTransaction });

    try {
      await withServer(app, async (baseUrl) => {
        const first = fetch(`${baseUrl}/api/gastos/55`, { method: 'DELETE' });
        await firstLocked.promise;
        const second = fetch(`${baseUrl}/api/gastos/55`, { method: 'DELETE' });
        await new Promise(resolve => setTimeout(resolve, 50));
        releaseFirst.resolve();
        const responses = await Promise.all([first, second]);
        assert.deepEqual(responses.map(response => response.status).sort(), [200, 404]);
      });
    } finally {
      releaseFirst.resolve();
      await cleanup();
    }

    const state = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM gastos_repartidor WHERE id = 55) AS gastos,
      (SELECT cantidad FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 11) AS stock,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE gasto_id = 55) AS stock_mov,
      (SELECT saldo FROM retornables_saldos WHERE empresa_id = 3 AND sujeto_tipo = 'chofer' AND sujeto_id = 7 AND producto_id = 11) AS saldo,
      (SELECT COUNT(*)::int FROM retornables_movimientos WHERE observacion = 'Reversión por borrado de gasto #55') AS reversiones`);
    assert.deepEqual({
      gastos: state.rows[0].gastos,
      stock: Number(state.rows[0].stock),
      stock_mov: state.rows[0].stock_mov,
      saldo: Number(state.rows[0].saldo),
      reversiones: state.rows[0].reversiones,
    }, { gastos: 0, stock: 0, stock_mov: 0, saldo: 0, reversiones: 1 });
  });
});

test('mutaciones de gastos rechazan roles no canónicos antes de upload, query o transacción', async () => {
  const deniedRoles = ['user', 'facturacion', 'contable', 'Admin', ' admin', 'repartidor ', '', null];
  for (const role of deniedRoles) {
    let nonSchemaQueries = 0;
    let transactionCalls = 0;
    const { app, gastosDir, cleanup } = await buildGastosApp({
      user: { role, empresa_id: 3, chofer_id: 7 },
      query: async sql => {
        if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
        nonSchemaQueries += 1;
        throw new Error('No debe consultar');
      },
      withTransaction: async () => {
        transactionCalls += 1;
        throw new Error('No debe abrir transacción');
      },
    });
    try {
      await withServer(app, async baseUrl => {
        for (const [method, suffix] of [['POST', ''], ['PUT', '/55'], ['DELETE', '/55']]) {
          const options = { method };
          if (method !== 'DELETE') {
            const body = new FormData();
            body.append('chofer_id', '7');
            body.append('tipo', 'combustible');
            body.append('comprobante', new Blob(['%PDF-test'], { type: 'application/pdf' }), 'ticket.pdf');
            options.body = body;
          }
          const response = await fetch(`${baseUrl}/api/gastos${suffix}`, options);
          assert.equal(response.status, 403, `${method} role=${String(role)}`);
        }
      });
      assert.deepEqual(await readdir(gastosDir), [], String(role));
      assert.equal(nonSchemaQueries, 0, String(role));
      assert.equal(transactionCalls, 0, String(role));
    } finally {
      await cleanup();
    }
  }
});

test('POST /api/gastos impide que repartidor cree un gasto para otro chofer de su empresa', async () => {
  let transactionCalls = 0;
  const { app, cleanup } = await buildGastosApp({
    user: { role: 'repartidor', empresa_id: 3, chofer_id: 7 },
    query: async sql => isSchemaQuery(sql) ? [] : [{ id: 8 }],
    withTransaction: async () => {
      transactionCalls += 1;
      throw new Error('No debe abrir transacción');
    },
  });
  try {
    await withServer(app, async baseUrl => {
      const body = new FormData();
      body.append('tipo', 'combustible');
      body.append('chofer_id', '8');
      const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(response.status, 403);
    });
  } finally {
    await cleanup();
  }
  assert.equal(transactionCalls, 0);
});

for (const returnedRows of [[], [{ id: 90 }, { id: 91 }]]) {
  test(`POST /api/gastos exige INSERT RETURNING exactamente una fila (${returnedRows.length})`, async () => {
    const durable = { gastos: 0, stock: 0, ledger: 0 };
    const { app, cleanup } = await buildGastosApp({
      user: { role: 'admin', empresa_id: 3 },
      query: async sql => {
        if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
        throw new Error(`Consulta directa inesperada: ${sql}`);
      },
      withTransaction: async work => {
        const pending = { ...durable };
        const result = await work(async sql => {
          if (sql.includes('FROM choferes')) return [{ id: 7 }];
          if (sql.includes('INSERT INTO gastos_repartidor')) {
            pending.gastos += returnedRows.length;
            return returnedRows;
          }
          throw new Error(`SQL transaccional inesperado: ${sql}`);
        });
        Object.assign(durable, pending);
        return result;
      },
    });
    try {
      await withServer(app, async baseUrl => {
        const body = new FormData();
        body.append('tipo', 'combustible');
        body.append('chofer_id', '7');
        const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
        assert.equal(response.status, 500);
      });
    } finally {
      await cleanup();
    }
    assert.deepEqual(durable, { gastos: 0, stock: 0, ledger: 0 });
  });
}

test('POST valida chofer, producto y depósito bloqueados dentro de la misma transacción', async () => {
  const directSql = [];
  const txSql = [];
  const { app, cleanup } = await buildGastosApp({
    user: { role: 'admin', empresa_id: 3 },
    query: async sql => {
      if (isSchemaQuery(sql)) return [];
    if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('pg_advisory_xact_lock')) return [];
      directSql.push(sql);
      throw new Error(`Consulta directa inesperada: ${sql}`);
    },
    withTransaction: async work => work(async sql => {
      txSql.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('FROM empresas')) return [{ estricto: false }];
      if (sql.includes('FROM depositos')) return [{ id: 5 }];
      if (sql.includes('FROM deposito_chofer')) return [{ deposito_id: 5 }];
      if (sql.includes('INSERT INTO gastos_repartidor')) return [{ id: 90 }];
      if (sql.includes('INSERT INTO chofer_stock_mov')) return [{ id: 2 }];
      if (sql.includes('INSERT INTO chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '2' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '2' }];
      throw new Error(`SQL transaccional inesperado: ${sql}`);
    }),
  });
  try {
    await withServer(app, async baseUrl => {
      const body = new FormData();
      body.append('tipo', 'carga_llenos');
      body.append('chofer_id', '7');
      body.append('producto_id', '11');
      body.append('cantidad', '2');
      body.append('deposito_id', '5');
      const response = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(response.status, 200);
    });
  } finally {
    await cleanup();
  }
  assert.deepEqual(directSql, []);
  for (const fragment of ['FROM choferes', 'FROM productos', 'FROM depositos']) {
    const sql = txSql.find(value => value.includes(fragment));
    assert.ok(sql, fragment);
    assert.match(sql, /FOR (SHARE|UPDATE)/i, fragment);
  }
  assert.ok(txSql.findIndex(sql => sql.includes('FROM choferes')) < txSql.findIndex(sql => sql.includes('INSERT INTO gastos_repartidor')));
});

test('PostgreSQL real: POST espera el lock del chofer y falla cerrado si se desactiva', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE empresas (id integer PRIMARY KEY, config_operativa jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true);
      CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
      CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text);
      CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean DEFAULT true);
      CREATE TABLE productos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), retornable boolean DEFAULT false, deleted_at timestamptz);
      CREATE TABLE pedidos (id integer PRIMARY KEY);
      CREATE TABLE gastos_repartidor (
        id serial PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        chofer_id integer REFERENCES choferes(id),
        fecha date,
        tipo text,
        descripcion text,
        monto numeric,
        comprobante_path text,
        cantidad numeric,
        producto_id integer REFERENCES productos(id),
        deposito_id integer REFERENCES depositos(id)
      );
      CREATE TABLE chofer_stock (empresa_id integer, chofer_id integer, producto_id integer, cantidad numeric, PRIMARY KEY (empresa_id, chofer_id, producto_id));
      CREATE TABLE chofer_stock_mov (
        id serial PRIMARY KEY,
        empresa_id integer,
        chofer_id integer,
        producto_id integer,
        fecha timestamptz,
        tipo text,
        cantidad numeric,
        referencia text,
        created_at timestamptz DEFAULT now()
      );
      INSERT INTO empresas (id) VALUES (3);
      INSERT INTO choferes (id, empresa_id, activo) VALUES (7, 3, true);
    `);

    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const withTransaction = work => dbWithTransaction(work, { pool, maxRetries: 0, retryDelayMs: 0 });
    const { app, cleanup } = await buildGastosApp({
      user: { role: 'admin', empresa_id: 3 },
      query,
      withTransaction,
    });
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE choferes SET activo = false WHERE id = 7');
      await withServer(app, async baseUrl => {
        const body = new FormData();
        body.append('tipo', 'combustible');
        body.append('chofer_id', '7');
        const pendingResponse = fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
        await new Promise(resolve => setTimeout(resolve, 75));
        const beforeCommit = await pool.query('SELECT COUNT(*)::int AS c FROM gastos_repartidor');
        assert.equal(beforeCommit.rows[0].c, 0);
        await blocker.query('COMMIT');
        const response = await pendingResponse;
        assert.equal(response.status, 400);
      });
    } finally {
      try { await blocker.query('ROLLBACK'); } catch {}
      blocker.release();
      await cleanup();
    }
    const state = await pool.query('SELECT COUNT(*)::int AS c FROM gastos_repartidor');
    assert.equal(state.rows[0].c, 0);
  });
});

test('PUT /api/gastos bloquea chofer, producto y depósito en ese orden', async () => {
  const txSql = [];
  const gasto = {
    id: 55, empresa_id: 3, chofer_id: 7, fecha: '2026-09-20', tipo: 'carga_llenos',
    descripcion: 'Carga', monto: '1000', comprobante_path: null, cantidad: '2', producto_id: 11, deposito_id: 5,
  };
  const { app, cleanup } = await buildGastosApp({
    query: async sql => isSchemaQuery(sql) ? [] : (() => { throw new Error(`Consulta directa inesperada: ${sql}`); })(),
    withTransaction: work => work(async (sql) => {
      txSql.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('FROM gastos_repartidor')) return [gasto];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('FROM depositos')) return [{ id: 5 }];
      if (sql.includes('FROM deposito_chofer')) return [{ deposito_id: 5 }];
      if (sql.includes('FROM empresas')) return [{ estricto: false }];
      if (sql.includes('FROM chofer_stock_mov') && sql.includes("tipo = 'INGRESO_GASTOS'")) return [{
        id: 9, empresa_id: 3, chofer_id: 7, producto_id: 11, deposito_id: 5,
        gasto_id: 55, fecha: '2026-09-20', tipo: 'INGRESO_GASTOS', cantidad: '2',
        referencia: 'Carga desde Gastos: Carga',
      }];
      if (sql.includes('SUM(cantidad)')) return [{ saldo: '2' }];
      if (sql.includes('UPDATE chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
      if (sql.includes('DELETE FROM chofer_stock_mov')) return [{ id: 9 }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '0' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '0' }];
      if (sql.includes('UPDATE gastos_repartidor')) return [{ id: 55 }];
      if (sql.includes('INSERT INTO chofer_stock_mov')) return [{ id: 10 }];
      if (sql.includes('INSERT INTO chofer_stock')) return [{ empresa_id: 3, chofer_id: 7, producto_id: 11 }];
      throw new Error(`SQL inesperado: ${sql}`);
    }),
  });
  try {
    await withServer(app, async baseUrl => {
      const body = new FormData();
      body.append('cantidad', '3');
      const response = await fetch(`${baseUrl}/api/gastos/55`, { method: 'PUT', body });
      assert.equal(response.status, 200);
    });
  } finally {
    await cleanup();
  }
  const choferIndex = txSql.findIndex(sql => sql.includes('FROM choferes'));
  const productoIndex = txSql.findIndex(sql => sql.includes('FROM productos'));
  const depositoIndex = txSql.findIndex(sql => sql.includes('FROM depositos'));
  assert.ok(choferIndex >= 0 && choferIndex < productoIndex && productoIndex < depositoIndex);
  assert.match(txSql[productoIndex], /retornable[\s\S]*deleted_at IS NULL[\s\S]*FOR SHARE/i);
});

test('PostgreSQL real: PUT espera producto y no altera gasto, stock ni ledgers si deja de ser retornable', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE empresas (id integer PRIMARY KEY, config_operativa jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true, nombre text, username text);
      CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
      CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text);
      CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean DEFAULT true, nombre text, direccion text);
      CREATE TABLE productos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), retornable boolean DEFAULT false, deleted_at timestamptz);
      CREATE TABLE pedidos (id integer PRIMARY KEY);
      CREATE TABLE gastos_repartidor (
        id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), chofer_id integer REFERENCES choferes(id),
        fecha date, tipo text, descripcion text, monto numeric, comprobante_path text, cantidad numeric,
        producto_id integer REFERENCES productos(id), deposito_id integer REFERENCES depositos(id)
      );
      CREATE TABLE chofer_stock (empresa_id integer, chofer_id integer, producto_id integer, cantidad numeric, PRIMARY KEY (empresa_id, chofer_id, producto_id));
      CREATE TABLE chofer_stock_mov (
        id serial PRIMARY KEY, empresa_id integer, chofer_id integer, producto_id integer, deposito_id integer,
        gasto_id integer, fecha timestamptz, tipo text, cantidad numeric, referencia text, created_at timestamptz DEFAULT now()
      );
      INSERT INTO empresas (id) VALUES (3);
      INSERT INTO choferes (id, empresa_id) VALUES (7, 3);
      INSERT INTO productos (id, empresa_id, retornable) VALUES (11, 3, true);
      INSERT INTO gastos_repartidor VALUES (55, 3, 7, '2026-09-20', 'carga_llenos', 'Carga original', 1000, null, 2, 11, null);
      INSERT INTO chofer_stock VALUES (3, 7, 11, 2);
      INSERT INTO chofer_stock_mov (empresa_id, chofer_id, producto_id, gasto_id, fecha, tipo, cantidad, referencia)
      VALUES (3, 7, 11, 55, now(), 'INGRESO_GASTOS', 2, 'Carga desde Gastos: Carga original');
    `);
    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    await ensureRetornablesLedgerSchema(query);
    await pool.query(`
      INSERT INTO retornables_saldos (empresa_id, sujeto_tipo, sujeto_id, producto_id, saldo) VALUES (3, 'chofer', 7, 11, 2);
      INSERT INTO retornables_movimientos (empresa_id, producto_id, sujeto_tipo, sujeto_id, tipo, delta_saldo, saldo_resultante, origen)
      VALUES (3, 11, 'chofer', 7, 'carga_chofer', 2, 2, 'gastos');
    `);
    const withTransaction = work => dbWithTransaction(work, { pool, maxRetries: 0, retryDelayMs: 0 });
    const { app, cleanup } = await buildGastosApp({ query, withTransaction });
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE productos SET retornable = false WHERE id = 11');
      await withServer(app, async baseUrl => {
        const body = new FormData();
        body.append('cantidad', '3');
        const pending = fetch(`${baseUrl}/api/gastos/55`, { method: 'PUT', body });
        await new Promise(resolve => setTimeout(resolve, 75));
        const beforeCommit = await pool.query(`SELECT
          (SELECT cantidad FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 11) AS stock,
          (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE gasto_id = 55) AS stock_mov`);
        assert.deepEqual({ stock: Number(beforeCommit.rows[0].stock), stock_mov: beforeCommit.rows[0].stock_mov }, { stock: 2, stock_mov: 1 });
        await blocker.query('COMMIT');
        assert.equal((await pending).status, 400);
      });
    } finally {
      try { await blocker.query('ROLLBACK'); } catch {}
      blocker.release();
      await cleanup();
    }
    const state = await pool.query(`SELECT
      (SELECT cantidad FROM gastos_repartidor WHERE id = 55) AS gasto_cantidad,
      (SELECT cantidad FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 11) AS stock,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE gasto_id = 55) AS stock_mov,
      (SELECT saldo FROM retornables_saldos WHERE empresa_id = 3 AND sujeto_tipo = 'chofer' AND sujeto_id = 7 AND producto_id = 11) AS saldo,
      (SELECT COUNT(*)::int FROM retornables_movimientos) AS movimientos`);
    assert.deepEqual({
      gasto_cantidad: Number(state.rows[0].gasto_cantidad), stock: Number(state.rows[0].stock),
      stock_mov: state.rows[0].stock_mov, saldo: Number(state.rows[0].saldo), movimientos: state.rows[0].movimientos,
    }, { gasto_cantidad: 2, stock: 2, stock_mov: 1, saldo: 2, movimientos: 1 });
  });
});

for (const method of ['PUT', 'DELETE']) {
  test(`${method} responde 503 ante COMMIT ambiguo sin rollback ni retry`, async () => {
    const calls = [];
    let connects = 0;
    let releasedWith;
    const gasto = {
      id: 55, empresa_id: 3, chofer_id: 7, fecha: '2026-09-20', tipo: 'combustible',
      descripcion: 'Combustible', monto: '1000', comprobante_path: null,
      cantidad: null, producto_id: null, deposito_id: null,
    };
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT') throw new Error('detalle privado del commit');
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM gastos_repartidor')) return { rows: [gasto] };
        if (sql.includes('FROM choferes')) return { rows: [{ id: 7 }] };
        if (sql.includes('UPDATE gastos_repartidor') || sql.includes('DELETE FROM gastos_repartidor')) {
          return { rows: [{ id: 55 }] };
        }
        throw new Error(`SQL inesperado: ${sql}`);
      },
      release(error) { releasedWith = error; },
    };
    const fakePool = {
      async connect() { connects += 1; return client; },
    };
    const { app, cleanup } = await buildGastosApp({
      query: async sql => isSchemaQuery(sql) ? [] : (() => { throw new Error(`Consulta directa inesperada: ${sql}`); })(),
      withTransaction: work => dbWithTransaction(work, { pool: fakePool, maxRetries: 2, retryDelayMs: 0 }),
    });
    try {
      await withServer(app, async baseUrl => {
        const options = { method };
        if (method === 'PUT') {
          const body = new FormData();
          body.append('monto', '1200');
          options.body = body;
        }
        const response = await fetch(`${baseUrl}/api/gastos/55`, options);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: 'Resultado del gasto indeterminado',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      });
    } finally {
      await cleanup();
    }
    assert.equal(connects, 1);
    assert.equal(calls.filter(sql => sql === 'COMMIT').length, 1);
    assert.equal(calls.filter(sql => sql === 'ROLLBACK').length, 0);
    assert.ok(releasedWith instanceof Error);
    assert.equal(releasedWith.message, 'detalle privado del commit');
  });
}
