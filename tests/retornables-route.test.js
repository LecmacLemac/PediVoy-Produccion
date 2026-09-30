import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRetornablesRouter } from '../src/routes/retornables.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
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

function isSchemaQuery(sql) {
  return /CREATE TABLE|CREATE INDEX/i.test(sql);
}

function buildApp({
  query,
  pool = null,
  withTransaction,
  user = { role: 'user', empresa_id: 3, id: 9 },
  checkLicencia = (_req, _res, next) => next(),
}) {
  const app = express();
  app.use('/api/retornables', createRetornablesRouter({
    query,
    pool,
    withTransaction: withTransaction || (work => work(query)),
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

test('GET /api/retornables/resumen filtra por empresa del usuario y devuelve KPIs', async () => {
  const calls = [];
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('WITH ultimo_mov AS')) {
        assert.equal(params[0], 3);
        assert.equal(params[1], 11);
        return [{
          empresa_id: 3,
          punto_entrega_id: 20,
          cliente: 'Cliente Test',
          direccion: 'Calle 1',
          producto_id: 11,
          producto: 'Bidón 20L',
          saldo: '4.00',
          estado: 'pendiente',
        }];
      }
      if (sql.includes('total_pendiente')) {
        assert.equal(params[0], 3);
        return [{ total_pendiente: '4', total_a_favor: '0', cuentas_con_saldo: '1', clientes_deudores: '1', productos_con_saldo: '1' }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/resumen?empresa_id=999&producto_id=11`);
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.equal(json.rows[0].saldo, 4);
    assert.equal(json.kpis.total_pendiente, 4);
  });
});

test('POST /api/retornables/ajustes valida producto retornable y actualiza saldo', async () => {
  const queries = [];
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (/puntos_entrega/i.test(sql) && /SELECT\s+id/i.test(sql)) return [{ id: 20 }];
      if (/productos/i.test(sql) && /SELECT\s+id/i.test(sql)) return [{ id: 11, nombre: 'Bidón 20L' }];
      if (sql.includes('FOR UPDATE')) return [{ saldo: '2' }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '5' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 76, saldo_resultante: '5' }];
      if (sql.includes('INSERT INTO cliente_retornables_saldos')) return [];
      if (sql.includes('UPDATE cliente_retornables_saldos')) return [];
      if (sql.includes('INSERT INTO cliente_retornables_movimientos')) return [{ id: 77, fecha: '2026-07-16T20:30:00.000Z' }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ punto_entrega_id: 20, producto_id: 11, modo: 'sumar', cantidad: 3, observacion: 'Recuento físico' }),
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.equal(json.saldo_anterior, 2);
    assert.equal(json.delta, 3);
    assert.equal(json.saldo_resultante, 5);
  });

  assert.ok(queries.some((q) => /retornable\s*=\s*TRUE[\s\S]*deleted_at IS NULL[\s\S]*FOR SHARE/i.test(q.sql)));
  const clienteLockIndex = queries.findIndex((q) => q.sql.includes('FROM cliente_retornables_saldos') && q.sql.includes('FOR UPDATE'));
  const clienteWriteIndex = queries.findIndex((q) => q.sql.includes('UPDATE cliente_retornables_saldos'));
  const ledgerWriteIndex = queries.findIndex((q) => q.sql.includes('INSERT INTO retornables_saldos'));
  const movementIndexes = queries
    .map((q, index) => (/INSERT INTO (cliente_retornables_movimientos|retornables_movimientos)/.test(q.sql) ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(clienteLockIndex >= 0);
  assert.ok(clienteLockIndex < clienteWriteIndex);
  assert.ok(clienteWriteIndex < ledgerWriteIndex);
  assert.equal(movementIndexes.length, 2);
  assert.ok(ledgerWriteIndex < Math.min(...movementIndexes));
});

test('POST /api/retornables/ajustes cliente preserva saldo administrativo negativo', async () => {
  const queries = [];
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (/puntos_entrega/i.test(sql) && /SELECT\s+id/i.test(sql)) return [{ id: 20 }];
      if (/productos/i.test(sql) && /SELECT\s+id/i.test(sql)) return [{ id: 11, nombre: 'Bidón 20L' }];
      if (sql.includes('INSERT INTO cliente_retornables_saldos')) return [];
      if (sql.includes('FROM cliente_retornables_saldos') && sql.includes('FOR UPDATE')) return [{ saldo: '2' }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '-3' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 76, saldo_resultante: '-3' }];
      if (sql.includes('UPDATE cliente_retornables_saldos')) return [];
      if (sql.includes('INSERT INTO cliente_retornables_movimientos')) return [{ id: 77 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ punto_entrega_id: 20, producto_id: 11, modo: 'restar', cantidad: 5 }),
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.saldo_anterior, 2);
    assert.equal(json.delta, -5);
    assert.equal(json.saldo_resultante, -3);
  });

  const ledgerUpsert = queries.find((q) => q.sql.includes('INSERT INTO retornables_saldos'));
  assert.equal(ledgerUpsert.params[4], -3);
  const clienteUpdate = queries.find((q) => q.sql.includes('UPDATE cliente_retornables_saldos'));
  assert.equal(clienteUpdate.params[3], -3);
});

test('POST /api/retornables/ajustes crea saldo no-cliente antes de bloquearlo', async () => {
  const queries = [];
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11, nombre: 'Bidón' }];
      if (sql.includes('INSERT INTO retornables_saldos') && sql.includes('DO NOTHING')) return [];
      if (sql.includes('SELECT saldo FROM retornables_saldos') && sql.includes('FOR UPDATE')) return [{ saldo: '0' }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '4' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '4' }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'fijar', cantidad: 4 }),
    });
    assert.equal(resp.status, 200);
  });

  const createIndex = queries.findIndex(({ sql }) => sql.includes('INSERT INTO retornables_saldos') && sql.includes('DO NOTHING'));
  const lockIndex = queries.findIndex(({ sql }) => sql.includes('SELECT saldo FROM retornables_saldos') && sql.includes('FOR UPDATE'));
  assert.ok(createIndex >= 0 && createIndex < lockIndex);
});

test('POST /api/retornables/ajustes rechaza roles no canónicos antes de cualquier query', async (t) => {
  const roles = ['repartidor', 'referente', 'user', 'Admin', ' admin', 'admin ', 'SUPER', ' super', null, undefined];

  for (const role of roles) {
    await t.test(String(role), async () => {
      let licenciaCalls = 0;
      let queryCalls = 0;
      let transactionCalls = 0;
      const query = async () => {
        queryCalls += 1;
        return [];
      };
      const app = buildApp({
        user: { role, empresa_id: 3, id: 9 },
        query,
        pool: {
          async connect() {
            transactionCalls += 1;
            throw new Error('No debería iniciar una transacción');
          },
        },
        async checkLicencia(_req, _res, next) {
          licenciaCalls += 1;
          await query('SELECT licencia_instrumentada');
          next();
        },
      });

      await withServer(app, async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ empresa_id: 999, sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, cantidad: 1 }),
        });
        assert.equal(resp.status, 403);
      });
      assert.equal(licenciaCalls, 0);
      assert.equal(queryCalls, 0);
      assert.equal(transactionCalls, 0);
    });
  }
});

test('POST /api/retornables/ajustes ejecuta licencia y autoriza roles admin y super exactos', async (t) => {
  for (const role of ['admin', 'super']) {
    await t.test(role, async () => {
      let licenciaCalls = 0;
      const queries = [];
      const query = async (sql, params = []) => {
        queries.push({ sql, params });
        if (sql === 'SELECT licencia_instrumentada') return [{ activa: true }];
        if (isSchemaQuery(sql)) return [];
        if (sql.includes('FROM choferes')) return [{ id: 7 }];
        if (sql.includes('FROM productos')) return [{ id: 11, nombre: 'Bidón' }];
        if (sql.includes('INSERT INTO retornables_saldos') && sql.includes('DO NOTHING')) return [];
        if (sql.includes('SELECT saldo FROM retornables_saldos') && sql.includes('FOR UPDATE')) return [{ saldo: '0' }];
        if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '1' }];
        if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '1' }];
        throw new Error(`Consulta inesperada: ${sql}`);
      };
      const app = buildApp({
        user: { role, empresa_id: 3, id: 9 },
        query,
        async checkLicencia(_req, _res, next) {
          licenciaCalls += 1;
          await query('SELECT licencia_instrumentada');
          next();
        },
      });

      await withServer(app, async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(role === 'super' ? { empresa_id: 3 } : {}),
            sujeto_tipo: 'chofer',
            sujeto_id: 7,
            producto_id: 11,
            modo: 'sumar',
            cantidad: 1,
          }),
        });
        assert.equal(resp.status, 200);
        assert.equal((await resp.json()).saldo_resultante, 1);
      });

      assert.equal(licenciaCalls, 1);
      assert.equal(queries.filter(({ sql }) => sql === 'SELECT licencia_instrumentada').length, 1);
    });
  }
});

test('POST /api/retornables/ajustes rechaza cantidad inválida', async () => {
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      throw new Error(`No debería consultar datos: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ punto_entrega_id: 20, producto_id: 11, cantidad: -1, observacion: 'x' }),
    });
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /Cantidad inválida/);
  });
});

test('POST /api/retornables/ajustes rechaza tipos JSON coercitivos antes de la transacción', async (t) => {
  const cases = [
    ['empresa_id string para super', { empresa_id: '3', sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: 1 }, { role: 'super', empresa_id: 99 }],
    ['empresa_id faltante para super', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: 1 }, { role: 'super', empresa_id: 99 }],
    ['sujeto_id string', { sujeto_tipo: 'chofer', sujeto_id: '7', producto_id: 11, modo: 'sumar', cantidad: 1 }],
    ['sujeto_id boolean', { sujeto_tipo: 'chofer', sujeto_id: true, producto_id: 11, modo: 'sumar', cantidad: 1 }],
    ['sujeto_id array', { sujeto_tipo: 'chofer', sujeto_id: [7], producto_id: 11, modo: 'sumar', cantidad: 1 }],
    ['sujeto_id decimal', { sujeto_tipo: 'chofer', sujeto_id: 7.5, producto_id: 11, modo: 'sumar', cantidad: 1 }],
    ['producto_id string', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: '11', modo: 'sumar', cantidad: 1 }],
    ['producto_id fuera de safe range', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 9007199254740992, modo: 'sumar', cantidad: 1 }],
    ['chofer_id objeto', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, chofer_id: {}, modo: 'sumar', cantidad: 1 }],
    ['cantidad string', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: '1' }],
    ['cantidad boolean', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: false }],
    ['cantidad decimal', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: 1.5 }],
    ['cantidad fuera de safe range', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: 9007199254740992 }],
    ['modo normalizado', { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: ' SUMAR ', cantidad: 1 }],
    ['sujeto no exacto', { sujeto_tipo: ' Chofer ', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: 1 }],
  ];

  for (const [name, body, user = { role: 'admin', empresa_id: 3, id: 9 }] of cases) {
    await t.test(name, async () => {
      let businessQueries = 0;
      let transactionCalls = 0;
      const app = buildApp({
        user,
        query: async (sql) => {
          if (isSchemaQuery(sql)) return [];
          businessQueries += 1;
          throw new Error(`No debería consultar datos: ${sql}`);
        },
        withTransaction: async () => {
          transactionCalls += 1;
          throw new Error('No debería iniciar transacción');
        },
      });

      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
      });
      assert.equal(businessQueries, 0);
      assert.equal(transactionCalls, 0);
    });
  }
});

test('POST /api/retornables/ajustes acepta cero entero y admin no puede sobrescribir empresa', async () => {
  const paramsSeen = [];
  const query = async (sql, params = []) => {
    if (isSchemaQuery(sql)) return [];
    paramsSeen.push(params);
    if (sql.includes('FROM choferes')) return [{ id: 7 }];
    if (sql.includes('FROM productos')) return [{ id: 11 }];
    if (sql.includes('DO NOTHING')) return [];
    if (sql.includes('FOR UPDATE')) return [{ saldo: '4' }];
    if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '4' }];
    if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '4' }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query,
    withTransaction: work => work(query),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id: 999, sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'fijar', cantidad: 0 }),
    });
    assert.equal(response.status, 200);
  });

  assert.ok(paramsSeen.some(params => params.includes(3)));
  assert.equal(paramsSeen.some(params => params.includes(999)), false);
});

test('POST /api/retornables/ajustes responde outcome unknown sanitizado', async () => {
  const error = new Error('detalle privado del COMMIT');
  error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
  let transactionCalls = 0;
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query: async (sql) => isSchemaQuery(sql) ? [] : (() => { throw new Error(`Consulta inesperada: ${sql}`); })(),
    withTransaction: async () => {
      transactionCalls += 1;
      throw error;
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 11, modo: 'sumar', cantidad: 1 }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Resultado del ajuste indeterminado',
      code: 'TRANSACTION_OUTCOME_UNKNOWN',
    });
  });
  assert.equal(transactionCalls, 1);
});

test('POST /api/retornables/ajustes bloquea choferes, producto y sujeto con predicados fail-closed', async () => {
  const txCalls = [];
  const query = async sql => isSchemaQuery(sql) ? [] : (() => { throw new Error(`Consulta directa inesperada: ${sql}`); })();
  const app = buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query,
    withTransaction: work => work(async (sql, params = []) => {
      txCalls.push({ sql, params });
      if (sql.includes('FROM choferes')) return [{ id: params[0] }];
      if (sql.includes('FROM productos')) return [{ id: 11, nombre: 'Bidón' }];
      if (sql.includes('FROM depositos')) return [{ id: 9 }];
      if (sql.includes('INSERT INTO retornables_saldos') && sql.includes('DO NOTHING')) return [];
      if (sql.includes('SELECT saldo FROM retornables_saldos')) return [{ saldo: '0' }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '1' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '1' }];
      throw new Error(`SQL transaccional inesperado: ${sql}`);
    }),
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sujeto_tipo: 'deposito', sujeto_id: 9, chofer_id: 4, producto_id: 11, modo: 'sumar', cantidad: 1 }),
    });
    assert.equal(response.status, 200);
  });

  const choferIndexes = txCalls.map((call, index) => call.sql.includes('FROM choferes') ? index : -1).filter(index => index >= 0);
  const productoIndex = txCalls.findIndex(call => call.sql.includes('FROM productos'));
  const sujetoIndex = txCalls.findIndex(call => call.sql.includes('FROM depositos'));
  assert.equal(choferIndexes.length, 1);
  assert.ok(choferIndexes[0] < productoIndex && productoIndex < sujetoIndex);
  assert.match(txCalls[choferIndexes[0]].sql, /activo IS TRUE[\s\S]*FOR SHARE/i);
  assert.match(txCalls[productoIndex].sql, /retornable\s*=\s*TRUE[\s\S]*deleted_at IS NULL[\s\S]*FOR SHARE/i);
  assert.match(txCalls[sujetoIndex].sql, /activo\s*=\s*TRUE[\s\S]*FOR SHARE/i);
});

test('POST /api/retornables/ajustes ordena y deduplica todos los choferes involucrados', async () => {
  async function lockedIdsFor(body) {
    const lockedChoferIds = [];
    const query = async sql => isSchemaQuery(sql) ? [] : [];
    const app = buildApp({
      user: { role: 'admin', empresa_id: 3, id: 9 }, query,
      withTransaction: work => work(async (sql, params = []) => {
        if (sql.includes('FROM choferes')) { lockedChoferIds.push(params[0]); return [{ id: params[0] }]; }
        if (sql.includes('FROM productos')) return [{ id: 11 }];
        if (sql.includes('DO NOTHING')) return [];
        if (sql.includes('SELECT saldo FROM retornables_saldos')) return [{ saldo: '0' }];
        if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '1' }];
        if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 1, saldo_resultante: '1' }];
        throw new Error(`SQL inesperado: ${sql}`);
      }),
    });
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/retornables/ajustes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    });
    return lockedChoferIds;
  }

  assert.deepEqual(await lockedIdsFor({ sujeto_tipo: 'chofer', sujeto_id: 7, chofer_id: 4, producto_id: 11, cantidad: 1 }), [4, 7]);
  assert.deepEqual(await lockedIdsFor({ sujeto_tipo: 'chofer', sujeto_id: 7, chofer_id: 7, producto_id: 11, cantidad: 1 }), [7]);
});

async function createAjustesPostgresFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY);
    CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), cliente text, nombre text, direccion text, direccion_completa text);
    CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true, nombre text, username text);
    CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true, nombre text);
    CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true, nombre text, direccion text);
    CREATE TABLE productos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, retornable boolean, deleted_at timestamptz);
    CREATE TABLE pedidos (id integer PRIMARY KEY);
    CREATE TABLE gastos_repartidor (id integer PRIMARY KEY);
    INSERT INTO empresas VALUES (3), (4);
    INSERT INTO choferes (id, empresa_id, activo) VALUES (7, 3, true);
    INSERT INTO depositos (id, empresa_id, activo, nombre) VALUES (9, 3, true, 'Central');
    INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES (11, 3, 'Bidón', true);
  `);
}

async function ajustesPostgresApp(pool) {
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  return buildApp({
    user: { role: 'admin', empresa_id: 3, id: 9 },
    query,
    withTransaction: work => dbWithTransaction(work, { pool, maxRetries: 0, retryDelayMs: 0 }),
  });
}

test('PostgreSQL real: ajuste espera producto y falla cerrado si deja de ser retornable', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createAjustesPostgresFixture(pool);
    const app = await ajustesPostgresApp(pool);
    const blocker = await pool.connect();
    try {
      await withServer(app, async baseUrl => {
        const warmup = await fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sujeto_tipo: 'deposito', sujeto_id: 9, producto_id: 999, cantidad: 1 }),
        });
        assert.equal(warmup.status, 400);
        await blocker.query('BEGIN');
        await blocker.query('UPDATE productos SET retornable = false WHERE id = 11');
        const pending = fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sujeto_tipo: 'deposito', sujeto_id: 9, producto_id: 11, cantidad: 2 }),
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        const beforeCommit = await pool.query(`SELECT
          (SELECT COUNT(*)::int FROM retornables_saldos) AS saldos,
          (SELECT COUNT(*)::int FROM retornables_movimientos) AS movimientos`);
        assert.deepEqual(beforeCommit.rows[0], { saldos: 0, movimientos: 0 });
        await blocker.query('COMMIT');
        assert.equal((await pending).status, 400);
      });
    } finally {
      try { await blocker.query('ROLLBACK'); } catch {}
      blocker.release();
    }
    const state = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM retornables_saldos) AS saldos,
      (SELECT COUNT(*)::int FROM retornables_movimientos) AS movimientos`);
    assert.deepEqual(state.rows[0], { saldos: 0, movimientos: 0 });
  });
});

test('PostgreSQL real: ajuste espera sujeto y falla cerrado si se desactiva', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createAjustesPostgresFixture(pool);
    const app = await ajustesPostgresApp(pool);
    const blocker = await pool.connect();
    try {
      await withServer(app, async baseUrl => {
        const warmup = await fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sujeto_tipo: 'deposito', sujeto_id: 9, producto_id: 999, cantidad: 1 }),
        });
        assert.equal(warmup.status, 400);
        await blocker.query('BEGIN');
        await blocker.query('UPDATE depositos SET activo = false WHERE id = 9');
        const pending = fetch(`${baseUrl}/api/retornables/ajustes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sujeto_tipo: 'deposito', sujeto_id: 9, producto_id: 11, cantidad: 2 }),
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        const beforeCommit = await pool.query('SELECT COUNT(*)::int AS c FROM retornables_saldos');
        assert.equal(beforeCommit.rows[0].c, 0);
        await blocker.query('COMMIT');
        assert.equal((await pending).status, 400);
      });
    } finally {
      try { await blocker.query('ROLLBACK'); } catch {}
      blocker.release();
    }
    const state = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM retornables_saldos) AS saldos,
      (SELECT COUNT(*)::int FROM retornables_movimientos) AS movimientos`);
    assert.deepEqual(state.rows[0], { saldos: 0, movimientos: 0 });
  });
});
