import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { createGastosRouter } from '../src/routes/gastos.js';
import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY, config_entrega jsonb);
    CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true);
    CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), cuenta_corriente_habilitada boolean DEFAULT false, zona_id integer);
    CREATE TABLE zonas_geograficas (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
    CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
    CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text, activo boolean DEFAULT true);
    CREATE TABLE deposito_chofer (empresa_id integer, deposito_id integer, chofer_id integer, activo boolean DEFAULT true);
    CREATE TABLE productos (
      id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), nombre text,
      retornable boolean DEFAULT false, deleted_at timestamptz, config_activo jsonb DEFAULT '{}'::jsonb,
      activo boolean DEFAULT true, stock_infinito boolean DEFAULT false
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), chofer_id integer REFERENCES choferes(id),
      estado text, metodo_pago text, zona_id integer, punto_entrega_id integer REFERENCES puntos_entrega(id),
      monto numeric, fecha_entrega_estimada date, fecha_entrega timestamptz,
      cantidad numeric DEFAULT 0, cantidad_entregada numeric DEFAULT 0
    );
    CREATE TABLE items_pedido (id serial PRIMARY KEY, pedido_id integer REFERENCES pedidos(id), producto_id integer REFERENCES productos(id), producto text, cantidad numeric);
    CREATE TABLE chofer_stock (
      empresa_id integer, chofer_id integer, producto_id integer, cantidad numeric,
      PRIMARY KEY (empresa_id, chofer_id, producto_id)
    );
    CREATE TABLE gastos_repartidor (
      id serial PRIMARY KEY, empresa_id integer, chofer_id integer, fecha date, tipo text,
      descripcion text, monto numeric, comprobante_path text, cantidad numeric,
      producto_id integer, deposito_id integer
    );
    CREATE TABLE chofer_stock_mov (
      id serial PRIMARY KEY, empresa_id integer, chofer_id integer, producto_id integer,
      deposito_id integer, gasto_id integer, fecha timestamptz, tipo text, cantidad numeric,
      motivo text, referencia text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE entregas_evidencias (
      empresa_id integer, pedido_id integer PRIMARY KEY, chofer_id integer,
      checklist jsonb, evidencia jsonb, updated_at timestamptz
    );
    CREATE TABLE cliente_retornables_saldos (
      empresa_id integer, punto_entrega_id integer, producto_id integer, saldo numeric DEFAULT 0,
      updated_at timestamptz DEFAULT now(), PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
    );
    CREATE TABLE cliente_retornables_movimientos (
      id serial PRIMARY KEY, empresa_id integer, punto_entrega_id integer, pedido_id integer,
      chofer_id integer, producto_id integer, entregados numeric DEFAULT 0, devueltos numeric DEFAULT 0,
      delta numeric DEFAULT 0, saldo_resultante numeric, observacion text, fecha timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE retornables_saldos (
      empresa_id integer, sujeto_tipo text, sujeto_id integer, producto_id integer, saldo numeric DEFAULT 0,
      updated_at timestamptz DEFAULT now(), PRIMARY KEY (empresa_id, sujeto_tipo, sujeto_id, producto_id)
    );
    CREATE TABLE retornables_movimientos (
      id serial PRIMARY KEY, empresa_id integer, fecha timestamptz, producto_id integer,
      sujeto_tipo text, sujeto_id integer, contraparte_tipo text, contraparte_id integer,
      pedido_id integer, gasto_id integer, chofer_id integer, proveedor_id integer, deposito_id integer,
      tipo text, cantidad_llenos numeric DEFAULT 0, cantidad_vacios numeric DEFAULT 0,
      delta_saldo numeric DEFAULT 0, saldo_resultante numeric, observacion text,
      origen text, referencia text, created_by text, created_at timestamptz DEFAULT now()
    );

    INSERT INTO empresas VALUES (3, '{}'::jsonb);
    INSERT INTO choferes VALUES (7, 3, true);
    INSERT INTO puntos_entrega (id, empresa_id) VALUES (9, 3);
    INSERT INTO productos (id, empresa_id, nombre, retornable, activo) VALUES (55, 3, 'Pack', false, true);
    INSERT INTO pedidos (id, empresa_id, chofer_id, estado, metodo_pago, zona_id, punto_entrega_id, monto)
      VALUES (42, 3, 7, 'en_ruta', 'efectivo', 5, 9, 1200);
    INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad) VALUES (42, 55, 'Pack', 3);
    INSERT INTO chofer_stock VALUES (3, 7, 55, 5);
  `);
}

async function postDelivery(base) {
  return fetch(`${base}/api/repartidor/pedidos/42/entregar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      movimientos: [],
      checklist: { cliente_confirmado: true, producto_entregado: true, cobro_confirmado: true },
    }),
  });
}

async function postGasto(base) {
  const body = new FormData();
  body.append('tipo', 'compra_mercaderia');
  body.append('descripcion', 'Reposición concurrente');
  body.append('monto', '1000');
  body.append('cantidad', '2');
  body.append('producto_id', '55');
  body.append('chofer_id', '7');
  return fetch(`${base}/api/gastos`, { method: 'POST', body });
}

async function putGasto(base) {
  const body = new FormData();
  body.append('tipo', 'compra_mercaderia');
  body.append('descripcion', 'Reposición editada');
  body.append('monto', '800');
  body.append('cantidad', '2');
  body.append('producto_id', '12');
  body.append('chofer_id', '7');
  return fetch(`${base}/api/gastos/55`, { method: 'PUT', body });
}

async function seedExistingGasto(pool) {
  await pool.query(`
    INSERT INTO productos (id, empresa_id, nombre, retornable, activo) VALUES (12, 3, 'Pack nuevo', false, true);
    INSERT INTO gastos_repartidor
      (id, empresa_id, chofer_id, fecha, tipo, descripcion, monto, cantidad, producto_id, deposito_id)
    VALUES (55, 3, 7, '2026-09-20', 'compra_mercaderia', 'Carga original', 1000, 5, 55, NULL);
    INSERT INTO chofer_stock_mov
      (empresa_id, chofer_id, producto_id, gasto_id, fecha, tipo, cantidad, motivo, referencia)
    VALUES (3, 7, 55, 55, '2026-09-20 12:00Z', 'INGRESO_GASTOS', 5, 'Compra mercadería', 'Carga desde Gastos: Carga original');
  `);
}

async function buildRaceApp(pool) {
  const acquired = deferred();
  const release = deferred();
  let paused = false;
  const coordinatedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params = []) {
          const result = await client.query(sql, params);
          const isSharedChoferLock = sql.includes('pg_advisory_xact_lock') && String(params[0]).includes('chofer:7');
          if (!paused && isSharedChoferLock) {
            paused = true;
            acquired.resolve();
            await release.promise;
          }
          return result;
        },
        release(error) { client.release(error); },
      };
    },
  };
  const effects = [];
  const gastosDir = await mkdtemp(path.join(process.cwd(), '.gastos-entrega-race-'));
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    pool: coordinatedPool,
    withAuth(req, _res, next) { req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' }; next(); },
    getEmpresaIdFromToken: () => 3,
    notifyEstadoPedidoPush: () => effects.push('push'), notificarEnRuta: async () => {},
    notificarPedidoTransferencia: () => effects.push('transferencia'), ejecutarEstrategiaVecinos: async () => {},
    ejecutarPostEntregaUpsell: () => effects.push('upsell'),
    ejecutarRecompensaReferido: () => effects.push('recompensa'), ejecutarEstrategiaReferidos: () => effects.push('referidos'),
    awardPointsForDeliveredOrder: () => effects.push('puntos'), generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
    registrarMovimientosActivosDesdePedido: async () => {},
  }));
  app.use('/api/gastos', createGastosRouter({
    GASTOS_DIR: gastosDir,
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    withTransaction: work => dbWithTransaction(work, { pool: coordinatedPool, maxRetries: 0, retryDelayMs: 0 }),
    withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: 3 }; next(); },
    checkLicencia(_req, _res, next) { next(); },
    isSuper: () => false, isRepartidor: () => false, getEmpresaIdFromToken: () => 3,
  }));
  return {
    app,
    acquired,
    release,
    effects,
    cleanup: () => rm(gastosDir, { recursive: true, force: true }),
  };
}

async function durableState(pool) {
  const result = await pool.query(`SELECT
    (SELECT estado FROM pedidos WHERE id=42) AS pedido_estado,
    (SELECT COUNT(*)::int FROM entregas_evidencias WHERE pedido_id=42) AS evidencias,
    (SELECT COUNT(*)::int FROM gastos_repartidor WHERE id=55) AS gasto,
    (SELECT producto_id FROM gastos_repartidor WHERE id=55) AS gasto_producto,
    (SELECT cantidad FROM gastos_repartidor WHERE id=55) AS gasto_cantidad,
    COALESCE((SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55),0) AS stock_55,
    COALESCE((SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=12),0) AS stock_12,
    (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE tipo='venta') AS ventas,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE tipo='venta' AND producto_id=55) AS venta_qty,
    (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE tipo='INGRESO_GASTOS') AS ingresos,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE tipo='INGRESO_GASTOS' AND producto_id=55) AS ingreso_55,
    (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE tipo='INGRESO_GASTOS' AND producto_id=12) AS ingreso_12,
    (SELECT COUNT(*)::int FROM cliente_retornables_movimientos) AS cliente_retornables_mov,
    (SELECT COUNT(*)::int FROM retornables_movimientos) AS retornables_mov`);
  const row = result.rows[0];
  return {
    pedidoEstado: row.pedido_estado,
    evidencias: row.evidencias,
    gasto: row.gasto,
    gastoProducto: row.gasto_producto == null ? null : Number(row.gasto_producto),
    gastoCantidad: row.gasto_cantidad == null ? null : Number(row.gasto_cantidad),
    stock55: Number(row.stock_55), stock12: Number(row.stock_12),
    ventas: row.ventas, ventaQty: Number(row.venta_qty), ingresos: row.ingresos,
    ingreso55: Number(row.ingreso_55), ingreso12: Number(row.ingreso_12),
    clienteRetornablesMov: row.cliente_retornables_mov, retornablesMov: row.retornables_mov,
  };
}

test('PostgreSQL real: entrega y gasto comparten lock de saldo y conservan el resultado serial', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const acquired = deferred();
    const release = deferred();
    const gastoAttemptedSharedLock = deferred();
    let pauseDelivery = true;
    let choferLockCalls = 0;
    const coordinatedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            const isSharedChoferLock = sql.includes('pg_advisory_xact_lock') && String(params[0]).includes('chofer:7');
            if (isSharedChoferLock) {
              choferLockCalls += 1;
              if (choferLockCalls === 2) gastoAttemptedSharedLock.resolve();
            }
            const result = await client.query(sql, params);
            if (pauseDelivery && isSharedChoferLock) {
              pauseDelivery = false;
              acquired.resolve();
              await release.promise;
            }
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    const gastosDir = await mkdtemp(path.join(process.cwd(), '.gastos-entrega-race-'));
    const app = express();
    app.use(express.json());
    app.use('/api/repartidor', createRepartidorApiRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool: coordinatedPool,
      withAuth(req, _res, next) { req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' }; next(); },
      getEmpresaIdFromToken: () => 3,
      notifyEstadoPedidoPush: async () => {}, notificarEnRuta: async () => {},
      notificarPedidoTransferencia: async () => {}, ejecutarEstrategiaVecinos: async () => {},
      awardPointsForDeliveredOrder: async () => {}, generateComisionesForDeliveredOrder: async () => {},
      registrarMovimientosActivosDesdePedido: async () => {},
    }));
    app.use('/api/gastos', createGastosRouter({
      GASTOS_DIR: gastosDir,
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      withTransaction: work => dbWithTransaction(work, { pool: coordinatedPool, maxRetries: 0, retryDelayMs: 0 }),
      withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: 3 }; next(); },
      checkLicencia(_req, _res, next) { next(); },
      isSuper: () => false, isRepartidor: () => false, getEmpresaIdFromToken: () => 3,
    }));

    try {
      await withServer(app, async base => {
        const delivery = postDelivery(base);
        await acquired.promise;
        let gastoSettled = false;
        const gasto = postGasto(base).finally(() => { gastoSettled = true; });
        await gastoAttemptedSharedLock.promise;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(gastoSettled, false, 'el gasto debe esperar el lock compartido de chofer');
        release.resolve();
        const [deliveryResponse, gastoResponse] = await Promise.all([delivery, gasto]);
        assert.equal(deliveryResponse.status, 200);
        assert.equal(gastoResponse.status, 200);
      });
    } finally {
      release.resolve();
      await rm(gastosDir, { recursive: true, force: true });
    }

    const state = await pool.query(`SELECT
      (SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55) AS stock,
      (SELECT COUNT(*)::int FROM gastos_repartidor) AS gastos,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE tipo='venta') AS ventas,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE tipo='INGRESO_GASTOS') AS ingresos`);
    assert.deepEqual({
      stock: Number(state.rows[0].stock), gastos: state.rows[0].gastos,
      ventas: state.rows[0].ventas, ingresos: state.rows[0].ingresos,
    }, { stock: 4, gastos: 1, ventas: 1, ingresos: 1 });
  });
});

test('PostgreSQL real: dos entregas concurrentes conservan idempotencia y descuentan stock una sola vez', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const race = await buildRaceApp(pool);
    try {
      await withServer(race.app, async base => {
        const first = postDelivery(base);
        await race.acquired.promise;
        let secondSettled = false;
        const second = postDelivery(base).finally(() => { secondSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal(secondSettled, false, 'la segunda entrega debe esperar el lock del pedido/stock');
        race.release.resolve();
        const [firstResponse, secondResponse] = await Promise.all([first, second]);
        assert.deepEqual([firstResponse.status, secondResponse.status], [200, 200]);
        assert.deepEqual(await firstResponse.json(), { ok: true });
        assert.deepEqual(await secondResponse.json(), { ok: true, already: true });
      });
    } finally {
      race.release.resolve();
      await race.cleanup();
    }

    const state = await pool.query(`SELECT
      (SELECT estado FROM pedidos WHERE id=42) AS estado,
      (SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55) AS stock,
      (SELECT COUNT(*)::int FROM chofer_stock_mov WHERE tipo='venta') AS ventas,
      (SELECT COALESCE(SUM(cantidad),0) FROM chofer_stock_mov WHERE tipo='venta') AS venta_qty`);
    assert.deepEqual({
      estado: state.rows[0].estado,
      stock: Number(state.rows[0].stock),
      ventas: state.rows[0].ventas,
      ventaQty: Number(state.rows[0].venta_qty),
    }, { estado: 'entregado', stock: 2, ventas: 1, ventaQty: 3 });
  });
});

for (const [caso, preparar] of [
  ['saldo inexistente', pool => pool.query('DELETE FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55')],
  ['saldo insuficiente', pool => pool.query('UPDATE chofer_stock SET cantidad=2 WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55')],
]) {
  test(`PostgreSQL real: entrega con ${caso} revierte pedido, evidencia y movimientos`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      await preparar(pool);
      const race = await buildRaceApp(pool);
      try {
        await withServer(race.app, async base => {
          const pending = postDelivery(base);
          await race.acquired.promise;
          race.release.resolve();
          const response = await pending;
          assert.equal(response.status, 409);
          assert.deepEqual(await response.json(), { error: 'Stock insuficiente para completar la entrega' });
        });
      } finally {
        race.release.resolve();
        await race.cleanup();
      }
      const state = await pool.query(`SELECT
        (SELECT estado FROM pedidos WHERE id=42) AS estado,
        (SELECT COUNT(*)::int FROM entregas_evidencias WHERE pedido_id=42) AS evidencias,
        (SELECT COUNT(*)::int FROM chofer_stock_mov) AS movimientos,
        COALESCE((SELECT cantidad FROM chofer_stock WHERE empresa_id=3 AND chofer_id=7 AND producto_id=55),0) AS stock`);
      assert.deepEqual({
        estado: state.rows[0].estado,
        evidencias: state.rows[0].evidencias,
        movimientos: state.rows[0].movimientos,
        stock: Number(state.rows[0].stock),
      }, {
        estado: 'en_ruta', evidencias: 0, movimientos: 0,
        stock: caso === 'saldo inexistente' ? 0 : 2,
      });
      assert.deepEqual(race.effects, []);
    });
  });
}

for (const operation of ['DELETE', 'PUT']) {
  for (const winner of ['entrega', 'gasto']) {
    test(`PostgreSQL real: entrega vs ${operation} serializa cuando gana ${winner} sin saldo negativo`, postgresOptions, async () => {
      await withIsolatedPostgres(async pool => {
        await createFixture(pool);
        await seedExistingGasto(pool);
        const race = await buildRaceApp(pool);
        try {
          await withServer(race.app, async base => {
            const gastoRequest = () => operation === 'DELETE'
              ? fetch(`${base}/api/gastos/55`, { method: 'DELETE' })
              : putGasto(base);
            const first = winner === 'entrega' ? postDelivery(base) : gastoRequest();
            await race.acquired.promise;
            let secondSettled = false;
            const second = (winner === 'entrega' ? gastoRequest() : postDelivery(base))
              .finally(() => { secondSettled = true; });
            await new Promise(resolve => setTimeout(resolve, 75));
            assert.equal(secondSettled, false, 'el segundo writer debe esperar el lock compartido');
            race.release.resolve();
            const [firstResponse, secondResponse] = await Promise.all([first, second]);
            const deliveryResponse = winner === 'entrega' ? firstResponse : secondResponse;
            const gastoResponse = winner === 'entrega' ? secondResponse : firstResponse;
            assert.equal(deliveryResponse.status, winner === 'entrega' ? 200 : 409);
            if (winner === 'entrega') {
              assert.notEqual(gastoResponse.status, 200, 'el gasto no puede retirar ingreso si dejaría saldo negativo');
            } else {
              assert.equal(gastoResponse.status, 200);
            }
            if (winner === 'gasto') {
              assert.deepEqual(await deliveryResponse.json(), { error: 'Stock insuficiente para completar la entrega' });
            }
          });
        } finally {
          race.release.resolve();
          await race.cleanup();
        }
        await new Promise(resolve => setImmediate(resolve));

        const actual = await durableState(pool);
        const expected = winner === 'entrega'
          ? {
            pedidoEstado: 'entregado', evidencias: 1,
            gasto: 1, gastoProducto: 55, gastoCantidad: 5,
            stock55: 2, stock12: 0,
            ventas: 1, ventaQty: 3, ingresos: 1, ingreso55: 5, ingreso12: 0,
            clienteRetornablesMov: 0, retornablesMov: 0,
          }
          : operation === 'DELETE'
            ? {
              pedidoEstado: 'en_ruta', evidencias: 0,
              gasto: 0, gastoProducto: null, gastoCantidad: null,
              stock55: 0, stock12: 0,
              ventas: 0, ventaQty: 0, ingresos: 0, ingreso55: 0, ingreso12: 0,
              clienteRetornablesMov: 0, retornablesMov: 0,
            }
            : {
              pedidoEstado: 'en_ruta', evidencias: 0,
              gasto: 1, gastoProducto: 12, gastoCantidad: 2,
              stock55: 0, stock12: 2,
              ventas: 0, ventaQty: 0, ingresos: 1, ingreso55: 0, ingreso12: 2,
              clienteRetornablesMov: 0, retornablesMov: 0,
            };
        assert.deepEqual(actual, expected);
        assert.ok(actual.stock55 >= 0 && actual.stock12 >= 0);
        if (winner === 'gasto') assert.deepEqual(race.effects, []);
      });
    });
  }
}
