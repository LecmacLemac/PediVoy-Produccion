import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { createPedidosItemsRouter } from '../src/routes/pedidosItems.js';
import { createProductosRouter } from '../src/routes/productos.js';
import { createSetupRouter } from '../src/routes/setup.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { lockProductIdentityNamespaces } from '../src/services/productIdentityNamespace.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const validChecklist = {
  cliente_confirmado: true,
  producto_entregado: true,
  cobro_confirmado: true,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function requestJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE usuarios (
      id integer PRIMARY KEY,
      role text NOT NULL,
      empresa_id integer,
      activo boolean NOT NULL
    );
    CREATE TABLE empresas (id integer PRIMARY KEY, config_entrega jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE choferes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      activo boolean NOT NULL DEFAULT true
    );
    CREATE TABLE zonas_geograficas (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      dias_entrega jsonb DEFAULT '[]'::jsonb
    );
    CREATE TABLE zona_chofer (
      empresa_id integer NOT NULL,
      chofer_id integer NOT NULL,
      zona_id integer NOT NULL
    );
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      cuenta_corriente_habilitada boolean DEFAULT false,
      zona_id integer
    );
    CREATE TABLE productos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      descripcion text,
      precio numeric DEFAULT 0,
      imagen text,
      imagen_2 text,
      imagen_3 text,
      activo boolean DEFAULT true,
      sku text,
      external_id text,
      stock_min numeric DEFAULT 0,
      stock_max numeric DEFAULT 0,
      retornable boolean DEFAULT false,
      stock_infinito boolean DEFAULT false,
      categoria text,
      unidad_medida text,
      orden integer,
      etiqueta text,
      imagen_promo text,
      mostrar_en_catalogo boolean DEFAULT true,
      mostrar_en_landing boolean DEFAULT false,
      config_activo jsonb DEFAULT '{}'::jsonb,
      promo_config jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      deleted_at timestamptz,
      created_by integer,
      updated_by integer,
      deleted_by integer
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      chofer_id integer REFERENCES choferes(id),
      estado text NOT NULL,
      metodo_pago text,
      zona_id integer,
      punto_entrega_id integer REFERENCES puntos_entrega(id),
      monto numeric DEFAULT 0,
      fecha_entrega_estimada date,
      fecha_entrega timestamptz,
      cantidad numeric DEFAULT 0,
      cantidad_entregada numeric DEFAULT 0
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      producto_id integer REFERENCES productos(id),
      producto text NOT NULL,
      cantidad numeric NOT NULL,
      precio_unitario numeric DEFAULT 0
    );
    CREATE TABLE chofer_stock_mov (
      id serial PRIMARY KEY,
      empresa_id integer,
      chofer_id integer,
      producto_id integer,
      cantidad numeric,
      tipo text,
      motivo text,
      referencia text,
      fecha timestamptz,
      gasto_id integer
    );
    CREATE TABLE chofer_stock (
      empresa_id integer,
      chofer_id integer,
      producto_id integer,
      cantidad numeric DEFAULT 0,
      PRIMARY KEY (empresa_id, chofer_id, producto_id)
    );
    CREATE TABLE gastos_repartidor (id integer PRIMARY KEY);
    CREATE TABLE entregas_evidencias (
      empresa_id integer,
      pedido_id integer PRIMARY KEY,
      chofer_id integer,
      checklist jsonb,
      evidencia jsonb,
      updated_at timestamptz
    );
    CREATE TABLE cliente_retornables_saldos (
      empresa_id integer,
      punto_entrega_id integer,
      producto_id integer,
      saldo numeric NOT NULL DEFAULT 0,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
    );
    CREATE TABLE cliente_retornables_movimientos (
      id serial PRIMARY KEY,
      empresa_id integer,
      punto_entrega_id integer,
      pedido_id integer,
      chofer_id integer,
      producto_id integer,
      entregados numeric DEFAULT 0,
      devueltos numeric DEFAULT 0,
      delta numeric DEFAULT 0,
      saldo_resultante numeric,
      observacion text,
      fecha timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE retornables_saldos (
      empresa_id integer,
      sujeto_tipo text,
      sujeto_id integer,
      producto_id integer,
      saldo numeric NOT NULL DEFAULT 0,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (empresa_id, sujeto_tipo, sujeto_id, producto_id)
    );
    CREATE TABLE retornables_movimientos (
      id serial PRIMARY KEY,
      empresa_id integer,
      fecha timestamptz DEFAULT now(),
      producto_id integer,
      sujeto_tipo text,
      sujeto_id integer,
      contraparte_tipo text,
      contraparte_id integer,
      pedido_id integer,
      gasto_id integer,
      chofer_id integer,
      proveedor_id integer,
      deposito_id integer,
      tipo text,
      cantidad_llenos numeric DEFAULT 0,
      cantidad_vacios numeric DEFAULT 0,
      delta_saldo numeric DEFAULT 0,
      saldo_resultante numeric,
      observacion text,
      origen text,
      referencia text,
      created_by text,
      created_at timestamptz DEFAULT now()
    );

    INSERT INTO usuarios VALUES (80, 'admin', 3, true);
    INSERT INTO empresas (id) VALUES (3), (4);
    INSERT INTO choferes (id, empresa_id) VALUES (7, 3);
    INSERT INTO puntos_entrega (id, empresa_id) VALUES (9, 3);
    INSERT INTO pedidos (id, empresa_id, chofer_id, estado, metodo_pago, punto_entrega_id, monto)
    VALUES (42, 3, 7, 'en_ruta', 'efectivo', 9, 100);
    INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad) VALUES
      (3, 7, 55, 100),
      (3, 7, 56, 100),
      (3, 7, 66, 100);
  `);
}

function buildApp(pool, { effects = [], deliveryPool = pool, withTransaction = null } = {}) {
  const app = express();
  app.use(express.json());
  const tx = withTransaction || ((work, options = {}) => dbWithTransaction(work, { ...options, pool }));
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const repartidorAuth = (req, _res, next) => {
    req.user = { id: 70, uid: 70, role: 'repartidor', empresa_id: 3, chofer_id: 7, username: 'chofer-test' };
    next();
  };
  const adminAuth = (req, _res, next) => {
    req.user = { id: 80, uid: 80, role: 'admin', empresa_id: 3, chofer_id: null, username: 'admin-test' };
    next();
  };
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    pool: deliveryPool,
    withTransaction: tx,
    withAuth: repartidorAuth,
    getEmpresaIdFromToken: req => req.user.empresa_id,
    notifyEstadoPedidoPush: () => effects.push('push'),
    notificarEnRuta: async () => {},
    notificarPedidoTransferencia: async () => {},
    ejecutarEstrategiaVecinos: async () => {},
    ejecutarPostEntregaUpsell: () => effects.push('upsell'),
    ejecutarRecompensaReferido: () => effects.push('recompensa'),
    ejecutarEstrategiaReferidos: () => effects.push('referidos'),
    awardPointsForDeliveredOrder: () => effects.push('puntos'),
    generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
    registrarMovimientosActivosDesdePedido: async () => {},
  }));
  app.use('/api/pedidos', createPedidosItemsRouter({
    query,
    pool,
    withTransaction: tx,
    withAuth: adminAuth,
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  app.use('/api/productos', createProductosRouter({
    query,
    withTransaction: tx,
    withAuth: adminAuth,
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  app.use('/api/setup', createSetupRouter({
    query,
    withTransaction: tx,
    withAuth: adminAuth,
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  return app;
}

async function deliveryState(pool) {
  const [pedido, stockMov, saldos, movimientos, items] = await Promise.all([
    pool.query('SELECT estado, fecha_entrega FROM pedidos WHERE id = 42'),
    pool.query('SELECT producto_id, cantidad, tipo FROM chofer_stock_mov ORDER BY id'),
    pool.query('SELECT producto_id, saldo FROM cliente_retornables_saldos ORDER BY producto_id'),
    pool.query('SELECT producto_id, delta FROM cliente_retornables_movimientos ORDER BY id'),
    pool.query('SELECT producto_id, producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id = 42 ORDER BY id'),
  ]);
  return {
    pedido: pedido.rows,
    stockMov: stockMov.rows,
    saldos: saldos.rows,
    movimientos: movimientos.rows,
    items: items.rows,
  };
}

test('PostgreSQL real: /entregar rechaza item legacy ambiguo antes de cualquier mutación o postcommit', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES
        (55, 3, 'Bidón', true),
        (56, 3, 'Bidón', true);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, NULL, 'Bidón', 2, 50);
    `);
    const effects = [];
    const app = buildApp(pool, { effects });

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      });
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: 'Producto legacy ambiguo en el pedido' });
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(await deliveryState(pool), {
      pedido: [{ estado: 'en_ruta', fecha_entrega: null }],
      stockMov: [],
      saldos: [],
      movimientos: [],
      items: [{ producto_id: null, producto: 'Bidón', cantidad: '2', precio_unitario: '50' }],
    });
    assert.deepEqual(effects, []);
  });
});

test('PostgreSQL real: PUT items resuelve nombre único y persiste producto_id canónico', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      UPDATE pedidos SET estado = 'pendiente', chofer_id = NULL WHERE id = 42;
      INSERT INTO productos (id, empresa_id, nombre, precio) VALUES
        (55, 3, 'Bidón único', 50),
        (99, 4, 'Bidón único', 999);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Anterior', 1, 10);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/pedidos/42/items`, 'PUT', {
        items: [{ producto: 'Bidón único', cantidad: 2, precio_unitario: 50 }],
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { ok: true });
    });

    const items = await pool.query(
      'SELECT producto_id, producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id = 42'
    );
    const pedido = await pool.query('SELECT monto FROM pedidos WHERE id = 42');
    assert.deepEqual(items.rows, [{
      producto_id: 55,
      producto: 'Bidón único',
      cantidad: '2',
      precio_unitario: '50',
    }]);
    assert.equal(Number(pedido.rows[0].monto), 100);
  });
});

test('PostgreSQL real: nombre legacy único cierra una vez sin duplicar stock ni retornables', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES (55, 3, 'Bidón único', true);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, NULL, 'Bidón único', 2, 50);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const first = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      });
      assert.equal(first.status, 200);
      const second = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      });
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, { ok: true, already: true });
    });

    const state = await deliveryState(pool);
    assert.equal(state.pedido[0].estado, 'entregado');
    assert.deepEqual(state.stockMov, [{ producto_id: 55, cantidad: '2', tipo: 'venta' }]);
    assert.deepEqual(state.saldos, [{ producto_id: 55, saldo: '2' }]);
    assert.deepEqual(state.movimientos, [{ producto_id: 55, delta: '2' }]);
  });
});

test('PostgreSQL real: entrega gana lock y PUT espera, ve entregado y no cambia composición', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES
        (55, 3, 'Bidón actual', true),
        (66, 3, 'Producto nuevo', false);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Bidón actual', 2, 50);
    `);
    const deliveryLocked = deferred();
    const releaseDelivery = deferred();
    const deliveryPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            const result = await client.query(sql, params);
            if (sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE OF p')) {
              deliveryLocked.resolve();
              await releaseDelivery.promise;
            }
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { deliveryPool });

    await withServer(app, async baseUrl => {
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      });
      await deliveryLocked.promise;
      let editorSettled = false;
      const editing = requestJson(`${baseUrl}/api/pedidos/42/items`, 'PUT', {
        items: [{ producto_id: 66, cantidad: 5, precio_unitario: 10 }],
      }).then(result => { editorSettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(editorSettled, false, 'el editor debe esperar el lock del pedido');
      releaseDelivery.resolve();

      const [deliveryResult, editResult] = await Promise.all([delivering, editing]);
      assert.equal(deliveryResult.status, 200);
      assert.equal(editResult.status, 409);
    });

    const state = await deliveryState(pool);
    assert.deepEqual(state.items, [{ producto_id: 55, producto: 'Bidón actual', cantidad: '2', precio_unitario: '50' }]);
    assert.deepEqual(state.stockMov, [{ producto_id: 55, cantidad: '2', tipo: 'venta' }]);
    assert.deepEqual(state.saldos, [{ producto_id: 55, saldo: '2' }]);
  });
});

test('PostgreSQL real: PUT gana lock y entrega espera y procesa exactamente la composición nueva', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES
        (55, 3, 'Producto anterior', false),
        (66, 3, 'Bidón nuevo', true);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Producto anterior', 1, 50);
    `);
    const editorLocked = deferred();
    const releaseEditor = deferred();
    let held = false;
    const editorTransaction = (work, options = {}) => dbWithTransaction(async (txQuery, client) => {
      const gatedQuery = async (sql, params = []) => {
        const rows = await txQuery(sql, params);
        if (!held && sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) {
          held = true;
          editorLocked.resolve();
          await releaseEditor.promise;
        }
        return rows;
      };
      return work(gatedQuery, client);
    }, { ...options, pool });
    const app = buildApp(pool, { withTransaction: editorTransaction });

    await withServer(app, async baseUrl => {
      const editing = requestJson(`${baseUrl}/api/pedidos/42/items`, 'PUT', {
        items: [{ producto_id: 66, cantidad: 3, precio_unitario: 40 }],
      });
      await editorLocked.promise;
      let deliverySettled = false;
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      }).then(result => { deliverySettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(deliverySettled, false, 'la entrega debe esperar el lock del editor');
      releaseEditor.resolve();

      const [editResult, deliveryResult] = await Promise.all([editing, delivering]);
      assert.equal(editResult.status, 200);
      assert.equal(deliveryResult.status, 200);
    });

    const state = await deliveryState(pool);
    assert.deepEqual(state.items, [{ producto_id: 66, producto: 'Bidón nuevo', cantidad: '3', precio_unitario: '40' }]);
    assert.deepEqual(state.stockMov, [{ producto_id: 66, cantidad: '3', tipo: 'venta' }]);
    assert.deepEqual(state.saldos, [{ producto_id: 66, saldo: '3' }]);
  });
});

test('PostgreSQL real: PUT items falla cerrado por nombre 0/>1, ID cross-tenant o inválido y revierte todo', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      UPDATE pedidos SET estado = 'pendiente', chofer_id = NULL, monto = 10 WHERE id = 42;
      INSERT INTO productos (id, empresa_id, nombre) VALUES
        (55, 3, 'Anterior'),
        (56, 3, 'Duplicado'),
        (57, 3, 'Duplicado'),
        (99, 4, 'Ajeno');
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Anterior', 1, 10);
    `);
    const app = buildApp(pool);
    const cases = [
      ['nombre inexistente', { producto: 'No existe', cantidad: 2, precio_unitario: 5 }, 400],
      ['nombre ambiguo', { producto: 'Duplicado', cantidad: 2, precio_unitario: 5 }, 409],
      ['ID cross-tenant', { producto_id: 99, cantidad: 2, precio_unitario: 5 }, 400],
      ['ID string', { producto_id: '55', cantidad: 2, precio_unitario: 5 }, 400],
      ['cantidad string', { producto_id: 55, cantidad: '2', precio_unitario: 5 }, 400],
    ];

    await withServer(app, async baseUrl => {
      for (const [name, item, status] of cases) {
        await t.test(name, async () => {
          const result = await requestJson(`${baseUrl}/api/pedidos/42/items`, 'PUT', { items: [item] });
          assert.equal(result.status, status);
          const items = await pool.query(
            'SELECT producto_id, producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id = 42'
          );
          const pedido = await pool.query('SELECT monto FROM pedidos WHERE id = 42');
          assert.deepEqual(items.rows, [{ producto_id: 55, producto: 'Anterior', cantidad: '1', precio_unitario: '10' }]);
          assert.equal(Number(pedido.rows[0].monto), 10);
        });
      }
    });
  });
});

test('PostgreSQL real: COMMIT ambiguo de PUT items devuelve 503 sin retry ni rollback compensatorio', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      UPDATE pedidos SET estado = 'pendiente', chofer_id = NULL WHERE id = 42;
      INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 3, 'Anterior'), (66, 3, 'Nuevo');
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Anterior', 1, 10);
    `);
    let connects = 0;
    let rollbacks = 0;
    const ambiguousPool = {
      async connect() {
        connects += 1;
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            if (sql === 'ROLLBACK') rollbacks += 1;
            const result = await client.query(sql, params);
            if (sql === 'COMMIT') throw new Error('private commit transport detail');
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    const ambiguousTransaction = work => dbWithTransaction(work, {
      pool: ambiguousPool,
      maxRetries: 3,
      retryDelayMs: 0,
    });
    const app = buildApp(pool, { withTransaction: ambiguousTransaction });

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/pedidos/42/items`, 'PUT', {
        items: [{ producto_id: 66, cantidad: 2, precio_unitario: 20 }],
      });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, {
        error: 'Resultado de actualización de ítems indeterminado',
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
      assert.equal(JSON.stringify(result.body).includes('private'), false);
    });

    assert.equal(connects, 1);
    assert.equal(rollbacks, 0);
    const items = await pool.query('SELECT producto_id, cantidad FROM items_pedido WHERE pedido_id = 42');
    assert.deepEqual(items.rows, [{ producto_id: 66, cantidad: '2' }]);
    const stockMov = await pool.query('SELECT COUNT(*)::int AS total FROM chofer_stock_mov');
    assert.equal(stockMov.rows[0].total, 0);
  });
});

test('PostgreSQL real: mutación clasificatoria de producto usa transacción canónica y lock incompatible', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES (55, 3, 'Bidón', false)");
    let transactions = 0;
    const sqlSeen = [];
    const productTransaction = (work, options = {}) => {
      transactions += 1;
      return dbWithTransaction(async (txQuery, client) => {
        const traced = async (sql, params = []) => {
          sqlSeen.push(sql);
          return txQuery(sql, params);
        };
        return work(traced, client);
      }, { ...options, pool });
    };
    const app = buildApp(pool, { withTransaction: productTransaction });

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/productos/55`, 'PUT', {
        nombre: 'Bidón nuevo',
        retornable: true,
        config_activo: { es_activo: true },
        activo: false,
      });
      assert.equal(result.status, 200);
    });

    assert.equal(transactions, 1);
    assert.ok(sqlSeen.some(sql => /FROM productos[\s\S]*FOR UPDATE/i.test(sql)));
    assert.ok(sqlSeen.findIndex(sql => /FOR UPDATE/i.test(sql)) < sqlSeen.findIndex(sql => /UPDATE productos/i.test(sql)));
  });
});

test('seed-catalog overwrite bloquea producto antes de cambiar nombre o estado', async () => {
  const sqlSeen = [];
  let transactionCalls = 0;
  const query = async (sql) => {
    sqlSeen.push(`outside:${sql}`);
    return [];
  };
  const withTransaction = async work => {
    transactionCalls += 1;
    return work(async (sql) => {
      sqlSeen.push(`tx:${sql}`);
      if (sql.includes('LOWER(sku) AS sku_key')) return [{ id: 55, sku_key: 'b2b-limp-5l', nombre: 'Nombre anterior' }];
      if (sql.includes('FROM productos') && sql.includes('FOR UPDATE')) return [{ id: 55 }];
      if (sql.includes('UPDATE productos')) return [{ id: 55 }];
      if (sql.includes('INSERT INTO productos')) return [{ id: 56 }];
      return [];
    });
  };
  const app = express();
  app.use(express.json());
  app.use('/api/setup', createSetupRouter({
    query,
    withTransaction,
    withAuth: (req, _res, next) => {
      req.user = { id: 80, role: 'admin', empresa_id: 3 };
      next();
    },
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));

  await withServer(app, async baseUrl => {
    const response = await requestJson(`${baseUrl}/api/setup/seed-catalog`, 'POST', {
      vertical: 'distribuidora_b2b',
      overwrite: true,
    });
    assert.equal(response.status, 200);
  });

  assert.equal(transactionCalls, 1);
  const lockIndex = sqlSeen.findIndex(sql => sql.startsWith('tx:') && sql.includes('FOR UPDATE'));
  const updateIndex = sqlSeen.findIndex(sql => sql.startsWith('tx:') && sql.includes('UPDATE productos'));
  assert.ok(lockIndex >= 0, 'debe bloquear los productos de la plantilla');
  assert.ok(updateIndex > lockIndex, 'debe actualizar sólo después del lock incompatible');
  assert.equal(sqlSeen.some(sql => sql.startsWith('outside:') && sql.includes('UPDATE productos')), false);
});

test('PostgreSQL real: entrega gana lock de producto y usa una sola clasificación anterior sin mezcla', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable, stock_infinito, config_activo)
      VALUES (55, 3, 'Bidón viejo', true, false, '{}'::jsonb);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Bidón viejo', 2, 50);
    `);
    const productLocked = deferred();
    const releaseDelivery = deferred();
    const deliveryPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            const result = await client.query(sql, params);
            if (sql.includes('FROM productos') && sql.includes('FOR SHARE')) {
              productLocked.resolve();
              await releaseDelivery.promise;
            }
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { deliveryPool });

    await withServer(app, async baseUrl => {
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      });
      await productLocked.promise;
      let updateSettled = false;
      const updating = requestJson(`${baseUrl}/api/productos/55`, 'PUT', {
        nombre: 'Activo nuevo',
        retornable: false,
        stock_infinito: true,
        config_activo: { es_activo: true },
        activo: false,
      }).then(result => { updateSettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(updateSettled, false, 'la mutación del producto debe esperar FOR SHARE de entrega');
      releaseDelivery.resolve();

      const [deliveryResult, updateResult] = await Promise.all([delivering, updating]);
      assert.equal(deliveryResult.status, 200);
      assert.equal(updateResult.status, 200);
    });

    const state = await deliveryState(pool);
    assert.deepEqual(state.stockMov, [{ producto_id: 55, cantidad: '2', tipo: 'venta' }]);
    assert.deepEqual(state.saldos, [{ producto_id: 55, saldo: '2' }]);
    assert.equal((await pool.query('SELECT stock_infinito FROM productos WHERE id = 55')).rows[0].stock_infinito, true);
  });
});

test('PostgreSQL real: update de producto gana lock y entrega procesa sólo la clasificación nueva', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable, stock_infinito, config_activo)
      VALUES (55, 3, 'Bidón viejo', true, false, '{}'::jsonb);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 55, 'Bidón viejo', 2, 50);
    `);
    const updateLocked = deferred();
    const releaseUpdate = deferred();
    let held = false;
    const productTransaction = (work, options = {}) => dbWithTransaction(async (txQuery, client) => {
      const gated = async (sql, params = []) => {
        const rows = await txQuery(sql, params);
        if (!held && sql.includes('FROM productos') && sql.includes('FOR UPDATE')) {
          held = true;
          updateLocked.resolve();
          await releaseUpdate.promise;
        }
        return rows;
      };
      return work(gated, client);
    }, { ...options, pool });
    const app = buildApp(pool, { withTransaction: productTransaction });

    await withServer(app, async baseUrl => {
      const updating = requestJson(`${baseUrl}/api/productos/55`, 'PUT', {
        nombre: 'Consumible nuevo',
        retornable: false,
        stock_infinito: true,
        config_activo: {},
        activo: false,
      });
      await updateLocked.promise;
      let deliverySettled = false;
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      }).then(result => { deliverySettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(deliverySettled, false, 'la entrega debe esperar el lock exclusivo del producto');
      releaseUpdate.resolve();

      const [updateResult, deliveryResult] = await Promise.all([updating, delivering]);
      assert.equal(updateResult.status, 200);
      assert.equal(deliveryResult.status, 200);
    });

    const state = await deliveryState(pool);
    assert.deepEqual(state.stockMov, []);
    assert.deepEqual(state.saldos, []);
    assert.equal((await pool.query('SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55')).rows[0].cantidad, '100');
    const product = await pool.query('SELECT nombre, retornable, stock_infinito, activo FROM productos WHERE id = 55');
    assert.deepEqual(product.rows, [{ nombre: 'Consumible nuevo', retornable: false, stock_infinito: true, activo: false }]);
  });
});

test('PostgreSQL real: entrega legacy gana namespace y bloquea rename de otra fila al mismo nombre', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES
        (55, 3, 'Bidón', true),
        (66, 3, 'Otro producto', false);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, NULL, '  BIDÓN  ', 2, 50);
    `);
    const deliveryResolvedProducts = deferred();
    const releaseDelivery = deferred();
    let held = false;
    const deliveryPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            const result = await client.query(sql, params);
            if (!held && sql.includes('FROM productos') && sql.includes('FOR SHARE')) {
              held = true;
              deliveryResolvedProducts.resolve();
              await releaseDelivery.promise;
            }
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { deliveryPool });

    await withServer(app, async baseUrl => {
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist,
        movimientos: [],
        retornables: [],
      });
      await deliveryResolvedProducts.promise;

      let renameSettled = false;
      const renaming = requestJson(`${baseUrl}/api/productos/66`, 'PUT', {
        nombre: 'Bidón',
      }).then(result => { renameSettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      const renameWasBlocked = !renameSettled;
      releaseDelivery.resolve();

      const [deliveryResult, renameResult] = await Promise.all([delivering, renaming]);
      assert.equal(renameWasBlocked, true, 'el rename de otra fila debe esperar el namespace legacy');
      assert.equal(deliveryResult.status, 200);
      assert.equal(renameResult.status, 200);
    });

    const products = await pool.query('SELECT id, nombre FROM productos ORDER BY id');
    assert.deepEqual(products.rows, [
      { id: 55, nombre: 'Bidón' },
      { id: 66, nombre: 'Bidón' },
    ]);
    const state = await deliveryState(pool);
    assert.deepEqual(state.stockMov, [{ producto_id: 55, cantidad: '2', tipo: 'venta' }]);
  });
});

test('PostgreSQL real: rename gana namespace, entrega espera y rechaza la ambigüedad sin mutaciones', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES
        (55, 3, 'Bidón', true), (66, 3, 'Otro', false);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, NULL, 'Bidón', 2, 50);
    `);
    const renameUpdated = deferred();
    const releaseRename = deferred();
    let held = false;
    const productTransaction = (work, options = {}) => dbWithTransaction(async (txQuery, client) => {
      const gated = async (sql, params = []) => {
        const rows = await txQuery(sql, params);
        if (!held && sql.includes('UPDATE productos')) {
          held = true;
          renameUpdated.resolve();
          await releaseRename.promise;
        }
        return rows;
      };
      return work(gated, client);
    }, { ...options, pool });
    const app = buildApp(pool, { withTransaction: productTransaction });

    await withServer(app, async baseUrl => {
      const renaming = requestJson(`${baseUrl}/api/productos/66`, 'PUT', { nombre: '  bidón ' });
      await renameUpdated.promise;
      let deliverySettled = false;
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      }).then(result => { deliverySettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      const deliveryWasBlocked = !deliverySettled;
      releaseRename.resolve();

      const [renameResult, deliveryResult] = await Promise.all([renaming, delivering]);
      assert.equal(deliveryWasBlocked, true, 'la entrega debe esperar el namespace ganado por el rename');
      assert.equal(renameResult.status, 200);
      assert.equal(deliveryResult.status, 409);
      assert.deepEqual(deliveryResult.body, { error: 'Producto legacy ambiguo en el pedido' });
    });
    const state = await deliveryState(pool);
    assert.equal(state.pedido[0].estado, 'en_ruta');
    assert.deepEqual(state.stockMov, []);
    assert.deepEqual(state.saldos, []);
  });
});

test('PostgreSQL real: POST producto gana namespace, entrega espera y falla cerrado', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, retornable) VALUES (55, 3, 'Bidón', true);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, NULL, 'Bidón', 2, 50);
    `);
    const createInserted = deferred();
    const releaseCreate = deferred();
    let held = false;
    const productTransaction = (work, options = {}) => dbWithTransaction(async (txQuery, client) => {
      const gated = async (sql, params = []) => {
        const rows = await txQuery(sql, params);
        if (!held && sql.includes('INSERT INTO productos')) {
          held = true;
          createInserted.resolve();
          await releaseCreate.promise;
        }
        return rows;
      };
      return work(gated, client);
    }, { ...options, pool });
    const app = buildApp(pool, { withTransaction: productTransaction });

    await withServer(app, async baseUrl => {
      const creating = requestJson(`${baseUrl}/api/productos`, 'POST', { nombre: ' bidón ', precio: 10 });
      const transactionGateReached = await Promise.race([
        createInserted.promise.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 250)),
      ]);
      if (!transactionGateReached) {
        await creating;
        assert.equal(transactionGateReached, true, 'POST producto debe usar la transacción canónica');
      }
      let deliverySettled = false;
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      }).then(result => { deliverySettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      const deliveryWasBlocked = !deliverySettled;
      releaseCreate.resolve();
      const [createResult, deliveryResult] = await Promise.all([creating, delivering]);
      assert.equal(deliveryWasBlocked, true);
      assert.equal(createResult.status, 200);
      assert.equal(deliveryResult.status, 409);
      assert.deepEqual(deliveryResult.body, { error: 'Producto legacy ambiguo en el pedido' });
    });
    assert.equal((await pool.query('SELECT estado FROM pedidos WHERE id=42')).rows[0].estado, 'en_ruta');
  });
});

test('PostgreSQL real: setup overwrite gana namespaces, entrega espera y rechaza colisión', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, sku, retornable) VALUES
        (55, 3, 'Detergente Industrial 5L', 'LEGACY', true),
        (66, 3, 'Nombre anterior', 'B2B-LIMP-5L', false);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, NULL, 'Detergente Industrial 5L', 2, 50);
    `);
    const setupUpdated = deferred();
    const releaseSetup = deferred();
    let held = false;
    const setupTransaction = (work, options = {}) => dbWithTransaction(async (txQuery, client) => {
      const gated = async (sql, params = []) => {
        const rows = await txQuery(sql, params);
        if (!held && sql.includes('UPDATE productos')) {
          held = true;
          setupUpdated.resolve();
          await releaseSetup.promise;
        }
        return rows;
      };
      return work(gated, client);
    }, { ...options, pool });
    const app = buildApp(pool, { withTransaction: setupTransaction });

    await withServer(app, async baseUrl => {
      const settingUp = requestJson(`${baseUrl}/api/setup/seed-catalog`, 'POST', {
        vertical: 'distribuidora_b2b', overwrite: true,
      });
      await setupUpdated.promise;
      let deliverySettled = false;
      const delivering = requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      }).then(result => { deliverySettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      const deliveryWasBlocked = !deliverySettled;
      releaseSetup.resolve();
      const [setupResult, deliveryResult] = await Promise.all([settingUp, delivering]);
      assert.equal(deliveryWasBlocked, true, 'la entrega debe esperar el overwrite del namespace');
      assert.equal(setupResult.status, 200);
      assert.equal(deliveryResult.status, 409);
      assert.deepEqual(deliveryResult.body, { error: 'Producto legacy ambiguo en el pedido' });
    });
  });
});

test('PostgreSQL real: tenants distintos con el mismo nombre no se bloquean', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const tenant3 = await pool.connect();
    const tenant4 = await pool.connect();
    try {
      await tenant3.query('BEGIN');
      await tenant4.query('BEGIN');
      await lockProductIdentityNamespaces(
        async (sql, params) => (await tenant3.query(sql, params)).rows,
        { empresaId: 3, names: [' Bidón '] }
      );
      const otherTenant = lockProductIdentityNamespaces(
        async (sql, params) => (await tenant4.query(sql, params)).rows,
        { empresaId: 4, names: ['bidón'] }
      );
      const settled = await Promise.race([
        otherTenant.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 150)),
      ]);
      assert.equal(settled, true, 'el tenant 4 no debe esperar el namespace del tenant 3');
      await tenant4.query('COMMIT');
      await tenant3.query('COMMIT');
    } finally {
      tenant3.release();
      tenant4.release();
    }
  });
});

test('PostgreSQL real: renombres inversos adquieren namespaces ordenados y terminan sin deadlock', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`INSERT INTO productos (id, empresa_id, nombre) VALUES (55,3,'Alfa'),(66,3,'Beta')`);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const results = await Promise.race([
        Promise.all([
          requestJson(`${baseUrl}/api/productos/55`, 'PUT', { nombre: 'Beta' }),
          requestJson(`${baseUrl}/api/productos/66`, 'PUT', { nombre: 'Alfa' }),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('renombres inversos deadlock')), 3000)),
      ]);
      assert.deepEqual(results.map(result => result.status), [200, 200]);
    });
    assert.deepEqual((await pool.query('SELECT id,nombre FROM productos ORDER BY id')).rows, [
      { id: 55, nombre: 'Beta' }, { id: 66, nombre: 'Alfa' },
    ]);
  });
});

test('helper normaliza, deduplica y ordena namespaces antes de bloquear', async () => {
  const calls = [];
  const locked = await lockProductIdentityNamespaces(async (sql, params) => {
    calls.push({ sql, params });
    return [];
  }, { empresaId: 3, names: [' Beta ', 'alfa', 'ALFA', '', 'beta'] });
  assert.deepEqual(locked, ['alfa', 'beta']);
  assert.deepEqual(calls.map(call => call.params), [[3, 'alfa'], [3, 'beta']]);
  assert.ok(calls.every(call => call.sql.includes('pg_advisory_xact_lock')));
});

test('POST producto conserva contrato sanitizado ante COMMIT ambiguo', async () => {
  let transactionCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/productos', createProductosRouter({
    query: async () => assert.fail('POST producto no debe salir de la transacción'),
    withTransaction: async work => {
      transactionCalls += 1;
      await work(async sql => sql.includes('INSERT INTO productos') ? [{ id: 77 }] : []);
      const error = new Error('detalle privado');
      error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
      throw error;
    },
    withAuth: (req, _res, next) => {
      req.user = { id: 80, uid: 80, role: 'admin', empresa_id: 3 };
      next();
    },
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  await withServer(app, async baseUrl => {
    const result = await requestJson(`${baseUrl}/api/productos`, 'POST', { nombre: 'Bidón', precio: 10 });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, {
      error: 'Resultado de creación de producto indeterminado',
      code: 'TRANSACTION_OUTCOME_UNKNOWN',
    });
    assert.equal(JSON.stringify(result.body).includes('privado'), false);
  });
  assert.equal(transactionCalls, 1);
});

test('PostgreSQL real: stock infinito sin fila física entrega sin descuento ni movimiento de venta', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, stock_infinito)
      VALUES (77, 3, 'Servicio ilimitado', true);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 77, 'Servicio ilimitado', 2, 50);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      });
      assert.equal(result.status, 200);
    });

    const result = await pool.query(`SELECT
      (SELECT estado FROM pedidos WHERE id = 42) AS estado,
      (SELECT COUNT(*)::int FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 77) AS stock_rows,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 77 AND tipo = 'venta') AS movimientos`);
    assert.deepEqual(result.rows[0], { estado: 'entregado', stock_rows: 0, movimientos: 0 });
  });
});

test('PostgreSQL real: writer canónico actualiza stock_infinito bajo lock de producto', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, stock_infinito) VALUES (77, 3, 'Conmutable', false)");
    const sqlSeen = [];
    const productTransaction = (work, options = {}) => dbWithTransaction(async (txQuery, client) => {
      const traced = async (sql, params = []) => {
        sqlSeen.push(sql);
        return txQuery(sql, params);
      };
      return work(traced, client);
    }, { ...options, pool });
    const app = buildApp(pool, { withTransaction: productTransaction });

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/productos/77`, 'PUT', { stock_infinito: true });
      assert.equal(result.status, 200);
    });

    assert.equal((await pool.query('SELECT stock_infinito FROM productos WHERE id = 77')).rows[0].stock_infinito, true);
    const lockIndex = sqlSeen.findIndex(sql => /FROM productos[\s\S]*FOR UPDATE/i.test(sql));
    const updateIndex = sqlSeen.findIndex(sql => /UPDATE productos/i.test(sql));
    assert.ok(lockIndex >= 0 && updateIndex > lockIndex);
  });
});

test('PostgreSQL real: stock infinito con fila física conserva saldo y no registra venta', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, stock_infinito)
      VALUES (77, 3, 'Servicio ilimitado', true);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (42, 77, 'Servicio ilimitado', 2, 50);
      INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
      VALUES (3, 7, 77, 9);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      });
      assert.equal(result.status, 200);
    });

    const result = await pool.query(`SELECT
      (SELECT cantidad FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 77) AS cantidad,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 77 AND tipo = 'venta') AS movimientos`);
    assert.deepEqual(result.rows[0], { cantidad: '9', movimientos: 0 });
  });
});

test('PostgreSQL real: pedido mixto descuenta y mueve únicamente el producto finito', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, stock_infinito) VALUES
        (77, 3, 'Servicio ilimitado', true),
        (78, 3, 'Pack finito', NULL);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario) VALUES
        (42, 77, 'Servicio ilimitado', 2, 10),
        (42, 78, 'Pack finito', 3, 20);
      INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
      VALUES (3, 7, 78, 8);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      });
      assert.equal(result.status, 200);
    });

    const stock = await pool.query('SELECT producto_id, cantidad FROM chofer_stock WHERE producto_id IN (77, 78) ORDER BY producto_id');
    const movimientos = await pool.query("SELECT producto_id, cantidad FROM chofer_stock_mov WHERE tipo = 'venta' ORDER BY producto_id");
    assert.deepEqual(stock.rows, [{ producto_id: 78, cantidad: '5' }]);
    assert.deepEqual(movimientos.rows, [{ producto_id: 78, cantidad: '3' }]);
  });
});

test('PostgreSQL real: pedido mixto con finito insuficiente revierte entrega y todo movimiento', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, stock_infinito) VALUES
        (77, 3, 'Servicio ilimitado', true),
        (78, 3, 'Pack finito', false);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario) VALUES
        (42, 77, 'Servicio ilimitado', 2, 10),
        (42, 78, 'Pack finito', 3, 20);
      INSERT INTO chofer_stock (empresa_id, chofer_id, producto_id, cantidad)
      VALUES (3, 7, 78, 2);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await requestJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, 'POST', {
        checklist: validChecklist, movimientos: [], retornables: [],
      });
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: 'Stock insuficiente para completar la entrega' });
    });

    const pedido = await pool.query('SELECT estado, fecha_entrega FROM pedidos WHERE id = 42');
    const stock = await pool.query('SELECT cantidad FROM chofer_stock WHERE empresa_id = 3 AND chofer_id = 7 AND producto_id = 78');
    const movimientos = await pool.query("SELECT COUNT(*)::int AS total FROM chofer_stock_mov WHERE tipo = 'venta'");
    assert.deepEqual(pedido.rows, [{ estado: 'en_ruta', fecha_entrega: null }]);
    assert.deepEqual(stock.rows, [{ cantidad: '2' }]);
    assert.equal(movimientos.rows[0].total, 0);
  });
});

test('inventario estructural: todo writer de productos.nombre y todo lector legacy participa del namespace común', () => {
  const srcRoot = join(process.cwd(), 'src');
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
  const sources = new Map(walk(srcRoot).map(file => [
    relative(process.cwd(), file).replaceAll('\\', '/'),
    readFileSync(file, 'utf8'),
  ]));
  const identityWriters = [];
  for (const [file, source] of sources) {
    const sqlTemplates = Array.from(source.matchAll(/`([^`]*)`/g), match => match[1]);
    const insertsName = sqlTemplates.some(sql => {
      const match = sql.match(/INSERT\s+INTO\s+productos\s*\(([^)]*)\)/i);
      return match && /\bnombre\b/i.test(match[1]);
    });
    const updatesName = sqlTemplates.some(sql => /UPDATE\s+productos/i.test(sql) && /\bSET[\s\S]*?\bnombre\s*=/i.test(sql));
    const dynamicNameUpdate = /sets\.push\(`nombre=\$\{idx\+\+\}`\)/.test(source);
    const deletesProduct = sqlTemplates.some(sql => /DELETE\s+FROM\s+productos/i.test(sql));
    if (insertsName || updatesName || dynamicNameUpdate || deletesProduct) identityWriters.push(file);
  }
  assert.deepEqual(identityWriters.sort(), ['src/routes/productos.js', 'src/routes/setup.js']);

  const productosSource = sources.get('src/routes/productos.js');
  assert.equal((productosSource.match(/lockProductIdentityNamespaces\(/g) || []).length, 3,
    'POST, PUT y DELETE de productos deben bloquear namespace');
  assert.match(productosSource, /namespace\(s\) -> fila de producto/);
  assert.match(sources.get('src/routes/setup.js'), /lockProductIdentityNamespaces\(/);
  assert.match(sources.get('src/routes/pedidosItems.js'), /lockProductIdentityNamespaces\(/);
  const readerInventory = {
    'src/routes/repartidorApi.js': {
      resolverCalls: 2,
      cardinalityBlocks: 2,
    },
    'src/routes/stock.js': {
      resolverCalls: 1,
      cardinalityBlocks: 1,
    },
    'src/routes/reportes.js': {
      resolverCalls: 0,
      cardinalityBlocks: 1,
    },
    'src/adm/pedidoActivosService.js': {
      resolverCalls: 2,
      cardinalityBlocks: 0,
    },
    'src/handlers.js': {
      resolverCalls: 1,
      cardinalityBlocks: 0,
    },
    'src/stockServices.js': {
      resolverCalls: 0,
      cardinalityBlocks: 2,
    },
  };
  for (const [file, expected] of Object.entries(readerInventory)) {
    const source = sources.get(file);
    assert.ok(source, `falta lector inventariado ${file}`);
    assert.equal((source.match(/resolveProductIdentityItems\(/g) || []).length, expected.resolverCalls,
      `${file}: cambió el inventario de resoluciones transaccionales`);
    const cardinalityPattern = /(?:COUNT\(\*\)(?:::\w+)?\s+AS\s+(?:match_count|legacy_match_count)|CASE\s+WHEN\s+COUNT\(\*\)\s*=\s*1\s+THEN\s+MIN\()/gi;
    assert.equal((source.match(cardinalityPattern) || []).length,
      expected.cardinalityBlocks, `${file}: cambió el inventario de bloques cardinality-safe`);
  }
  assert.match(sources.get('src/routes/repartidorApi.js'), /lockProductIdentityNamespaces\(/);
  assert.doesNotMatch(sources.get('src/adm/pedidoActivosService.js'), /OR\s*\(ip\.producto_id\s+IS\s+NULL/i);
  assert.doesNotMatch(sources.get('src/handlers.js'), /LOWER\s*\(\s*nombre\s*\)\s*=\s*LOWER/i);
  assert.doesNotMatch(sources.get('src/routes/stock.js'), /pr\.nombre\s*=\s*ip\.producto/i);
  assert.doesNotMatch(sources.get('src/routes/reportes.js'), /LOWER\s*\(\s*pr\.nombre\s*\)/i);
});
