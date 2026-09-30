import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { withTransaction as canonicalWithTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function buildApp({ query = async () => [], withTransaction, user, effects = {} }) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    withTransaction,
    withAuth(req, _res, next) {
      req.user = user || { role: 'repartidor', empresa_id: 3, chofer_id: 7 };
      next();
    },
    getEmpresaIdFromToken: req => req.user?.empresa_id,
    notifyEstadoPedidoPush: effects.notifyEstadoPedidoPush || (() => Promise.resolve()),
    notificarEnRuta: effects.notificarEnRuta || (() => Promise.resolve()),
    ejecutarEstrategiaVecinos: effects.ejecutarEstrategiaVecinos || (() => Promise.resolve()),
  }));
  return app;
}

async function put(baseUrl, id, body) {
  const response = await fetch(`${baseUrl}/api/repartidor/pedidos/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function mockTransactionForPedido(pedido, { zonaRows = [], puntoRows = [], updateRows = [{ id: 42 }], calls = [] } = {}) {
  return async work => work(async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM pedidos p')) return [pedido];
    if (sql.includes('FROM choferes')) return [{ id: 7 }];
    if (sql.includes('FROM zona_chofer')) return zonaRows;
    if (sql.includes('SELECT id, cuenta_corriente_habilitada')) return puntoRows;
    if (sql.includes('to_jsonb(pe)')) return [{ id: pedido.punto_entrega_id, empresa_id: 3 }];
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('id = ANY')) return [{ id: pedido.punto_entrega_id, empresa_id: 3 }];
    if (sql.includes('UPDATE pedidos')) return updateRows;
    if (sql.includes('UPDATE puntos_entrega')) return [{ id: pedido.punto_entrega_id }];
    throw new Error(`SQL inesperado: ${sql}`);
  });
}

const pedidoBase = {
  id: 42,
  chofer_id: 7,
  estado: 'pendiente',
  metodo_pago: 'efectivo',
  zona_id: 5,
  punto_entrega_id: 9,
};

test('zona inválida revierte la toma implícita y no ejecuta efectos', async () => {
  const state = { chofer_id: null };
  const effects = [];
  const withTransaction = async work => {
    const snapshot = { ...state };
    const txQuery = async sql => {
      if (sql.includes('FROM pedidos p')) {
        return [{ ...pedidoBase, chofer_id: state.chofer_id, zona_id: null }];
      }
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM zona_chofer')) return [];
      if (sql.includes('UPDATE pedidos')) {
        state.chofer_id = 7;
        return [{ id: 42 }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    };
    try {
      return await work(txQuery);
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  };
  const app = buildApp({
    withTransaction,
    effects: {
      notifyEstadoPedidoPush: () => { effects.push('push'); return Promise.resolve(); },
      notificarEnRuta: () => { effects.push('ruta'); return Promise.resolve(); },
      ejecutarEstrategiaVecinos: () => { effects.push('vecinos'); return Promise.resolve(); },
    },
  });

  await withServer(app, async baseUrl => {
    const result = await put(baseUrl, 42, { estado: 'en_ruta', zona_id: 999 });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Zona no válida/);
  });

  assert.equal(state.chofer_id, null);
  assert.deepEqual(effects, []);
});

test('pedido entregado no puede reabrirse por PUT', async () => {
  let updateCalls = 0;
  const app = buildApp({
    withTransaction: async work => work(async sql => {
      if (sql.includes('FROM pedidos p')) return [{ ...pedidoBase, estado: 'entregado' }];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('UPDATE')) updateCalls += 1;
      return [];
    }),
  });

  await withServer(app, async baseUrl => {
    const result = await put(baseUrl, 42, { estado: 'en_ruta' });
    assert.equal(result.status, 409);
  });
  assert.equal(updateCalls, 0);
});

test('valida fail-closed ID, payload, estado, pago y zona antes de abrir transacción', async () => {
  const invalidCases = [
    ['0', { estado: 'pendiente' }],
    ['-1', { estado: 'pendiente' }],
    ['1.5', { estado: 'pendiente' }],
    ['abc', { estado: 'pendiente' }],
    ['9007199254740992', { estado: 'pendiente' }],
    ['42', {}],
    ['42', { estado: 'entregado' }],
    ['42', { estado: 'ENTREGADO' }],
    ['42', { estado: ' entregado ' }],
    ['42', { estado: 'En_Ruta' }],
    ['42', { estado: ' en_ruta ' }],
    ['42', { estado: 'inventado' }],
    ['42', { estado: 1 }],
    ['42', { metodo_pago: 'QR' }],
    ['42', { metodo_pago: ' efectivo ' }],
    ['42', { metodo_pago: 1 }],
    ['42', { zona_id: 0 }],
    ['42', { zona_id: '5' }],
    ['42', { zona_id: 1.5 }],
  ];
  for (const [id, body] of invalidCases) {
    let transactionCalls = 0;
    const app = buildApp({
      withTransaction: async () => { transactionCalls += 1; throw new Error('No debe abrir transacción'); },
    });
    await withServer(app, async baseUrl => {
      const result = await put(baseUrl, id, body);
      assert.equal(result.status, 400, `${id} ${JSON.stringify(body)}`);
      if (body.estado === 'entregado') assert.match(result.body.error, /POST .*\/entregar/);
    });
    assert.equal(transactionCalls, 0, `${id} ${JSON.stringify(body)}`);
  }
});

test('máquina de estados permite sólo la matriz operativa exacta', async () => {
  const operational = ['pendiente', 'en_ruta', 'en_camino'];
  const allowedTargets = ['pendiente', 'en_ruta', 'en_camino', 'cancelado'];
  for (const source of operational) {
    for (const target of allowedTargets) {
      const calls = [];
      const app = buildApp({
        withTransaction: mockTransactionForPedido({ ...pedidoBase, estado: source }, { calls }),
      });
      await withServer(app, async baseUrl => {
        const result = await put(baseUrl, 42, { estado: target });
        assert.equal(result.status, 200, `${source} -> ${target}`);
      });
      const update = calls.find(call => call.sql.includes('UPDATE pedidos'));
      assert.ok(update, `${source} -> ${target}`);
      assert.match(update.sql, /RETURNING id/);
      assert.match(update.sql, /empresa_id/);
    }
  }
});

test('estados terminales, NULL, variantes y desconocidos persistidos fallan 409 sin mutar', async () => {
  for (const source of ['entregado', 'cancelado', null, 'PENDIENTE', ' pendiente ', 'desconocido']) {
    let updateCalls = 0;
    const app = buildApp({
      withTransaction: async work => work(async sql => {
        if (sql.includes('FROM pedidos p')) return [{ ...pedidoBase, estado: source }];
        if (sql.includes('FROM choferes')) return [{ id: 7 }];
        if (sql.includes('UPDATE')) updateCalls += 1;
        return [];
      }),
    });
    await withServer(app, async baseUrl => {
      const result = await put(baseUrl, 42, { estado: 'en_ruta' });
      assert.equal(result.status, 409, String(source));
    });
    assert.equal(updateCalls, 0, String(source));
  }
});

test('pedido de otro chofer responde 403 y pedido vacante no pendiente responde 409', async () => {
  for (const [pedido, status] of [
    [{ ...pedidoBase, chofer_id: 99 }, 403],
    [{ ...pedidoBase, chofer_id: null, estado: 'en_ruta' }, 409],
  ]) {
    let updateCalls = 0;
    const app = buildApp({
      withTransaction: async work => work(async sql => {
        if (sql.includes('FROM pedidos p')) return [pedido];
        if (sql.includes('FROM choferes')) return [{ id: 7 }];
        if (sql.includes('UPDATE')) updateCalls += 1;
        return [];
      }),
    });
    await withServer(app, async baseUrl => {
      assert.equal((await put(baseUrl, 42, { estado: 'pendiente' })).status, status);
    });
    assert.equal(updateCalls, 0);
  }
});

test('PUT revalida chofer activo del tenant bajo lock antes de cualquier mutación', async () => {
  for (const scenario of ['inactivo', 'inexistente', 'cross-tenant']) {
    const calls = [];
    const app = buildApp({
      withTransaction: async work => work(async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM pedidos p')) return [{ ...pedidoBase, chofer_id: null }];
        if (sql.includes('FROM choferes')) return [];
        if (/^\s*UPDATE\b/i.test(sql)) throw new Error('No debe mutar');
        throw new Error(`SQL inesperado: ${sql}`);
      }),
    });

    await withServer(app, async baseUrl => {
      const result = await put(baseUrl, 42, { estado: 'en_ruta' });
      assert.equal(result.status, 403, scenario);
      assert.deepEqual(result.body, { error: 'No autorizado' }, scenario);
    });

    const driverLock = calls.find(call => call.sql.includes('FROM choferes'));
    assert.ok(driverLock, scenario);
    assert.match(driverLock.sql, /id\s*=\s*\$1[\s\S]*empresa_id\s*=\s*\$2[\s\S]*activo\s+IS\s+TRUE[\s\S]*FOR SHARE/i);
    assert.deepEqual(driverLock.params, [7, 3]);
    assert.equal(calls.some(call => /^\s*UPDATE\b/i.test(call.sql)), false, scenario);
  }
});

test('cuenta corriente se revalida con lock tenant-scoped dentro de la transacción', async () => {
  const calls = [];
  const app = buildApp({
    withTransaction: mockTransactionForPedido(pedidoBase, {
      calls,
      puntoRows: [{ id: 9, cuenta_corriente_habilitada: true }],
    }),
  });
  await withServer(app, async baseUrl => {
    assert.equal((await put(baseUrl, 42, { metodo_pago: 'cuenta_corriente' })).status, 200);
  });
  const lock = calls.find(call => call.sql.includes('SELECT id, cuenta_corriente_habilitada'));
  assert.ok(lock);
  assert.match(lock.sql, /empresa_id\s*=\s*\$2/);
  assert.match(lock.sql, /FOR SHARE/);
  assert.deepEqual(lock.params, [9, 3]);
});

test('validación posterior de cuenta corriente no toma pedido vacante', async () => {
  let updated = false;
  const app = buildApp({
    withTransaction: async work => work(async sql => {
      if (sql.includes('FROM pedidos p')) return [{ ...pedidoBase, chofer_id: null }];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('SELECT id, cuenta_corriente_habilitada')) {
        return [{ id: 9, cuenta_corriente_habilitada: false }];
      }
      if (sql.includes('UPDATE pedidos')) updated = true;
      return [];
    }),
  });
  await withServer(app, async baseUrl => {
    assert.equal((await put(baseUrl, 42, { metodo_pago: 'cuenta_corriente' })).status, 400);
  });
  assert.equal(updated, false);
});

test('UPDATE RETURNING vacío responde 409, no actualiza cliente ni ejecuta efectos', async () => {
  const calls = [];
  const effects = [];
  const app = buildApp({
    withTransaction: mockTransactionForPedido({ ...pedidoBase, zona_id: null }, {
      calls,
      zonaRows: [{ zona_id: 5 }],
      updateRows: [],
    }),
    effects: {
      notifyEstadoPedidoPush: () => { effects.push('push'); },
      notificarEnRuta: () => { effects.push('ruta'); },
      ejecutarEstrategiaVecinos: () => { effects.push('vecinos'); },
    },
  });
  await withServer(app, async baseUrl => {
    assert.equal((await put(baseUrl, 42, { estado: 'en_ruta' })).status, 409);
  });
  assert.equal(calls.some(call => call.sql.includes('UPDATE puntos_entrega')), false);
  assert.deepEqual(effects, []);
});

test('fallo al actualizar punto de entrega revierte el pedido y no ejecuta efectos', async () => {
  const state = { estado: 'pendiente', chofer_id: null };
  const effects = [];
  const withTransaction = async work => {
    const before = { ...state };
    try {
      return await work(async sql => {
        if (sql.includes('FROM pedidos p')) return [{ ...pedidoBase, ...state, zona_id: null }];
        if (sql.includes('FROM choferes')) return [{ id: 7 }];
        if (sql.includes('FROM zona_chofer')) return [{ zona_id: 5 }];
        if (sql.includes('to_jsonb(pe)')) return [{ id: 9, empresa_id: 3 }];
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('id = ANY')) return [{ id: 9, empresa_id: 3 }];
        if (sql.includes('UPDATE pedidos')) {
          state.estado = 'en_ruta';
          state.chofer_id = 7;
          return [{ id: 42 }];
        }
        if (sql.includes('UPDATE puntos_entrega')) return [];
        throw new Error(`SQL inesperado: ${sql}`);
      });
    } catch (error) {
      Object.assign(state, before);
      throw error;
    }
  };
  const app = buildApp({
    withTransaction,
    effects: {
      notifyEstadoPedidoPush: () => effects.push('push'),
      notificarEnRuta: () => effects.push('ruta'),
      ejecutarEstrategiaVecinos: () => effects.push('vecinos'),
    },
  });
  await withServer(app, async baseUrl => {
    assert.equal((await put(baseUrl, 42, { estado: 'en_ruta' })).status, 409);
  });
  assert.deepEqual(state, { estado: 'pendiente', chofer_id: null });
  assert.deepEqual(effects, []);
});

test('COMMIT ambiguo responde 503 sanitizado, no reintenta ni ejecuta efectos', async () => {
  let attempts = 0;
  const effects = [];
  const error = new Error('detalle privado del COMMIT');
  error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
  const app = buildApp({
    withTransaction: async work => {
      attempts += 1;
      await work(async sql => {
        if (sql.includes('FROM pedidos p')) return [pedidoBase];
        if (sql.includes('FROM choferes')) return [{ id: 7 }];
        if (sql.includes('UPDATE pedidos')) return [{ id: 42 }];
        return [];
      });
      throw error;
    },
    effects: {
      notifyEstadoPedidoPush: () => effects.push('push'),
      notificarEnRuta: () => effects.push('ruta'),
      ejecutarEstrategiaVecinos: () => effects.push('vecinos'),
    },
  });
  await withServer(app, async baseUrl => {
    const result = await put(baseUrl, 42, { estado: 'en_ruta' });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      error: 'Resultado de actualización indeterminado',
      code: 'TRANSACTION_OUTCOME_UNKNOWN',
    });
    assert.equal(JSON.stringify(result.body).includes('detalle privado'), false);
  });
  assert.equal(attempts, 1);
  assert.deepEqual(effects, []);
});

test('efectos se lanzan sólo después de commit y capturan throws síncronos/rechazos', async () => {
  const order = [];
  const app = buildApp({
    withTransaction: async work => {
      order.push('begin');
      const result = await work(async sql => {
        if (sql.includes('FROM pedidos p')) return [pedidoBase];
        if (sql.includes('FROM choferes')) return [{ id: 7 }];
        if (sql.includes('UPDATE pedidos')) return [{ id: 42 }];
        return [];
      });
      order.push('commit');
      return result;
    },
    effects: {
      notifyEstadoPedidoPush: () => { order.push('push'); throw new Error('sync'); },
      notificarEnRuta: () => { order.push('ruta'); return Promise.reject(new Error('async')); },
      ejecutarEstrategiaVecinos: () => { order.push('vecinos'); return Promise.resolve(); },
    },
  });
  await withServer(app, async baseUrl => {
    assert.equal((await put(baseUrl, 42, { estado: 'en_ruta' })).status, 200);
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(order.indexOf('commit') < order.indexOf('push'), true);
  assert.equal(order.indexOf('commit') < order.indexOf('ruta'), true);
  assert.equal(order.indexOf('commit') < order.indexOf('vecinos'), true);
});

async function setupPostgresPutFixture(pool) {
  await pool.query(`
    CREATE TABLE choferes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      activo boolean NOT NULL
    );
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      cuenta_corriente_habilitada boolean NOT NULL DEFAULT false,
      zona_id integer
    );
    CREATE TABLE zona_chofer (
      empresa_id integer NOT NULL,
      chofer_id integer NOT NULL,
      zona_id integer NOT NULL,
      PRIMARY KEY (empresa_id, chofer_id, zona_id)
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      chofer_id integer,
      estado text,
      metodo_pago text,
      zona_id integer,
      punto_entrega_id integer
    );
    INSERT INTO choferes VALUES (7,3,TRUE),(8,3,TRUE);
    INSERT INTO puntos_entrega VALUES (9,3,false,NULL);
    INSERT INTO zona_chofer VALUES (3,7,5),(3,8,6);
    INSERT INTO pedidos VALUES (42,3,NULL,'pendiente','efectivo',NULL,9);
  `);
}

function buildPostgresApp(pool, choferId) {
  return buildApp({
    user: { role: 'repartidor', empresa_id: 3, chofer_id: choferId },
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    withTransaction: work => canonicalWithTransaction(work, { pool, maxRetries: 0 }),
  });
}

test('PostgreSQL: PUT espera el lock del chofer y falla cerrado si queda inactivo', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupPostgresPutFixture(pool);
    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE choferes SET activo = FALSE WHERE id = 7');

      const app = buildPostgresApp(pool, 7);
      await withServer(app, async baseUrl => {
        const pending = put(baseUrl, 42, { estado: 'en_ruta' });
        await new Promise(resolve => setTimeout(resolve, 100));
        const beforeCommit = await pool.query('SELECT chofer_id, estado FROM pedidos WHERE id = 42');
        assert.deepEqual(beforeCommit.rows[0], { chofer_id: null, estado: 'pendiente' });

        await blocker.query('COMMIT');
        committed = true;
        const result = await pending;
        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { error: 'No autorizado' });
      });

      const after = await pool.query('SELECT chofer_id, estado FROM pedidos WHERE id = 42');
      assert.deepEqual(after.rows[0], { chofer_id: null, estado: 'pendiente' });
    } finally {
      if (!committed) {
        try { await blocker.query('ROLLBACK'); } catch {}
      }
      blocker.release();
    }
  });
});

test('PostgreSQL: zona inválida deja pedido vacante y cliente sin zona', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupPostgresPutFixture(pool);
    const app = buildPostgresApp(pool, 7);
    await withServer(app, async baseUrl => {
      assert.equal((await put(baseUrl, 42, { estado: 'en_ruta', zona_id: 999 })).status, 400);
    });
    const pedido = await pool.query('SELECT chofer_id, estado, zona_id FROM pedidos WHERE id=42');
    const punto = await pool.query('SELECT zona_id FROM puntos_entrega WHERE id=9');
    assert.deepEqual(pedido.rows[0], { chofer_id: null, estado: 'pendiente', zona_id: null });
    assert.equal(punto.rows[0].zona_id, null);
  });
});

test('PostgreSQL: validación posterior deja pedido vacante', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupPostgresPutFixture(pool);
    const app = buildPostgresApp(pool, 7);
    await withServer(app, async baseUrl => {
      assert.equal((await put(baseUrl, 42, { metodo_pago: 'cuenta_corriente' })).status, 400);
    });
    const pedido = await pool.query('SELECT chofer_id, metodo_pago FROM pedidos WHERE id=42');
    assert.deepEqual(pedido.rows[0], { chofer_id: null, metodo_pago: 'efectivo' });
  });
});

test('PostgreSQL: dos choferes concurrentes, exactamente uno toma y muta', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupPostgresPutFixture(pool);
    const appA = buildPostgresApp(pool, 7);
    const appB = buildPostgresApp(pool, 8);
    await withServer(appA, async baseA => {
      await withServer(appB, async baseB => {
        const [a, b] = await Promise.all([
          put(baseA, 42, { estado: 'en_ruta', zona_id: 5 }),
          put(baseB, 42, { estado: 'en_camino', zona_id: 6 }),
        ]);
        assert.deepEqual([a.status, b.status].sort(), [200, 403]);
      });
    });
    const pedido = (await pool.query('SELECT chofer_id, estado, zona_id FROM pedidos WHERE id=42')).rows[0];
    assert.ok(
      (pedido.chofer_id === 7 && pedido.estado === 'en_ruta' && pedido.zona_id === 5)
      || (pedido.chofer_id === 8 && pedido.estado === 'en_camino' && pedido.zona_id === 6)
    );
    const punto = (await pool.query('SELECT zona_id FROM puntos_entrega WHERE id=9')).rows[0];
    assert.equal(punto.zona_id, pedido.zona_id);
  });
});
