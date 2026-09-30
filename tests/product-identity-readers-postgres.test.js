import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { createReportesRouter } from '../src/routes/reportes.js';
import { createStockRouter } from '../src/routes/stock.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import {
  lockProductIdentityNamespaces,
  resolveProductIdentityItems,
} from '../src/services/productIdentityNamespace.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY, config_operativa jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE choferes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      tipo text DEFAULT 'propio',
      activo boolean DEFAULT true
    );
    CREATE TABLE zonas_geograficas (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      dias_entrega jsonb DEFAULT '[]'::jsonb
    );
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      cliente text,
      direccion text,
      direccion_completa text,
      zona_id integer,
      cuenta_corriente_habilitada boolean DEFAULT false
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      stock_min numeric DEFAULT 0,
      stock_max numeric DEFAULT 0,
      retornable boolean DEFAULT false,
      config_activo jsonb DEFAULT '{}'::jsonb
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      chofer_id integer REFERENCES choferes(id),
      punto_entrega_id integer REFERENCES puntos_entrega(id),
      estado text NOT NULL,
      fecha timestamptz DEFAULT now(),
      fecha_entrega timestamptz,
      monto numeric DEFAULT 0,
      metodo_pago text
    );
    CREATE TABLE items_pedido (
      id integer PRIMARY KEY,
      pedido_id integer NOT NULL REFERENCES pedidos(id),
      producto_id integer,
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
      fecha timestamptz DEFAULT now(),
      gasto_id integer
    );
    CREATE TABLE gastos_repartidor (id integer PRIMARY KEY, empresa_id integer, chofer_id integer, fecha date);
    CREATE TABLE empresa_activos (
      id integer PRIMARY KEY,
      empresa_id integer,
      producto_id integer,
      cliente_id integer,
      codigo text,
      tipo text,
      estado text,
      numero_serie text,
      alquiler_mensual numeric
    );
    CREATE TABLE pedido_activos (
      id integer PRIMARY KEY,
      empresa_id integer,
      pedido_id integer,
      activo_id integer,
      activo_relacionado_id integer,
      item_pedido_id integer,
      producto_id integer,
      tipo_operacion text,
      motivo text,
      estado text,
      observacion text,
      accion_at_utc timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );

    INSERT INTO empresas (id) VALUES (3), (4);
    INSERT INTO choferes (id, empresa_id, tipo) VALUES (7, 3, 'propio');
    INSERT INTO puntos_entrega (id, empresa_id, cliente, direccion) VALUES (9, 3, 'Cliente', 'Calle 1');
    INSERT INTO pedidos (id, empresa_id, chofer_id, punto_entrega_id, estado, fecha, fecha_entrega, monto, metodo_pago)
    VALUES (42, 3, 7, 9, 'entregado', '2026-09-20T12:00:00Z', '2026-09-20T12:00:00Z', 100, 'efectivo');
  `);
}

function buildApp(pool) {
  const app = express();
  app.use(express.json());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const withTransaction = (work, options = {}) => dbWithTransaction(work, { ...options, pool });
  const repartidorAuth = (req, _res, next) => {
    req.user = { id: 70, role: 'repartidor', empresa_id: 3, chofer_id: 7, username: 'chofer' };
    next();
  };
  const adminAuth = (req, _res, next) => {
    req.user = { id: 80, role: 'admin', empresa_id: 3, username: 'admin' };
    next();
  };
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    pool,
    withTransaction,
    withAuth: repartidorAuth,
    getEmpresaIdFromToken: req => req.user.empresa_id,
    notifyEstadoPedidoPush: async () => {},
    notificarEnRuta: async () => {},
    notificarPedidoTransferencia: async () => {},
    ejecutarEstrategiaVecinos: async () => {},
    awardPointsForDeliveredOrder: async () => {},
    generateComisionesForDeliveredOrder: async () => {},
    registrarMovimientosActivosDesdePedido: async () => {},
  }));
  app.use('/api/stock', createStockRouter({
    query,
    pool,
    withAuth: adminAuth,
    checkLicencia: (_req, _res, next) => next(),
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  app.use('/api/reportes', createReportesRouter({
    query,
    withAuth: adminAuth,
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
    enqueueWppMessage: async () => {},
  }));
  return app;
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

test('PostgreSQL real: homónimos legacy fallan cerrado en lectores operativos y no inflan el reporte', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, config_activo) VALUES
        (55, 3, ' Bidon ', '{"es_activo":true}'),
        (56, 3, 'bidon', '{"es_activo":true}');
      INSERT INTO items_pedido (id, pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (501, 42, NULL, ' BIDON ', 2, 50);
    `);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const [acumulado, activos, stock, reporte] = await Promise.all([
        getJson(baseUrl, '/api/repartidor/stock-acumulado?fecha=2026-09-20'),
        getJson(baseUrl, '/api/repartidor/pedidos/42/activos-resumen'),
        getJson(baseUrl, '/api/stock/movimientos-por-tipo?from=2026-09-20&to=2026-09-20'),
        getJson(baseUrl, '/api/reportes/productos-margen?from=2026-09-20&to=2026-09-20'),
      ]);
      assert.equal(acumulado.status, 409);
      assert.equal(activos.status, 409);
      assert.equal(stock.status, 409);
      assert.equal(reporte.status, 200);
      assert.equal(reporte.body.identity_warnings.legacy_ambiguous, 1, JSON.stringify(reporte.body));
      assert.equal(reporte.body.top.length, 1);
      assert.equal(reporte.body.top[0].unidades, 2);
      assert.equal(reporte.body.top[0].ventas, 100);
    });
  });
});

test('PostgreSQL real: nombre legacy único con espacios/case se resuelve una vez en todos los lectores', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, config_activo) VALUES
        (55, 3, ' Bidon ', '{"es_activo":true}');
      INSERT INTO items_pedido (id, pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (501, 42, NULL, 'bIDON', 2, 50);
    `);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const acumulado = await getJson(baseUrl, '/api/repartidor/stock-acumulado?fecha=2026-09-20');
      assert.equal(acumulado.status, 200);
      assert.equal(acumulado.body.rows.length, 1);
      assert.equal(Number(acumulado.body.rows[0].entregado), 2);
      assert.equal(Number(acumulado.body.rows[0].producto_id), 55);

      const activos = await getJson(baseUrl, '/api/repartidor/pedidos/42/activos-resumen');
      assert.equal(activos.status, 200);
      assert.deepEqual(activos.body.items_activos.map(row => Number(row.producto_id)), [55]);

      const stock = await getJson(baseUrl, '/api/stock/movimientos-por-tipo?from=2026-09-20&to=2026-09-20');
      assert.equal(stock.status, 200);
      assert.equal(stock.body.length, 1);
      assert.equal(Number(stock.body[0].entregado), 2);
      assert.equal(Number(stock.body[0].producto_id), 55);

      const reporte = await getJson(baseUrl, '/api/reportes/productos-margen?from=2026-09-20&to=2026-09-20');
      assert.equal(reporte.status, 200);
      assert.deepEqual(reporte.body.identity_warnings, {
        legacy_ambiguous: 0,
        legacy_unresolved: 0,
        canonical_invalid: 0,
      });
      assert.equal(reporte.body.top[0].unidades, 2);
    });
  });
});

test('PostgreSQL real: producto_id canónico no cae por nombre y un ID cross-tenant falla cerrado', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre, config_activo) VALUES
        (55, 3, 'Bidon', '{"es_activo":true}'),
        (56, 3, ' bidon ', '{"es_activo":true}'),
        (77, 4, 'Bidon', '{"es_activo":true}');
      INSERT INTO items_pedido (id, pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (501, 42, 55, ' bidon ', 2, 50);
    `);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const activos = await getJson(baseUrl, '/api/repartidor/pedidos/42/activos-resumen');
      assert.equal(activos.status, 200);
      assert.deepEqual(activos.body.items_activos.map(row => Number(row.producto_id)), [55]);
      const stock = await getJson(baseUrl, '/api/stock/movimientos-por-tipo?from=2026-09-20&to=2026-09-20');
      assert.equal(stock.status, 200);
      assert.deepEqual(stock.body.map(row => Number(row.producto_id)), [55]);

      await pool.query('UPDATE items_pedido SET producto_id = 77 WHERE id = 501');
      const [badActivos, badStock, reporte] = await Promise.all([
        getJson(baseUrl, '/api/repartidor/pedidos/42/activos-resumen'),
        getJson(baseUrl, '/api/stock/movimientos-por-tipo?from=2026-09-20&to=2026-09-20'),
        getJson(baseUrl, '/api/reportes/productos-margen?from=2026-09-20&to=2026-09-20'),
      ]);
      assert.equal(badActivos.status, 409);
      assert.equal(badStock.status, 409);
      assert.equal(reporte.status, 200);
      assert.equal(reporte.body.identity_warnings.canonical_invalid, 1);
      assert.equal(reporte.body.top[0].unidades, 2);
      assert.equal(reporte.body.top[0].producto, ' bidon ');
    });
  });
});

test('PostgreSQL real: lector operativo y rename serializan en ambos órdenes por namespace', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre) VALUES
        (55, 3, 'Bidon'),
        (56, 3, 'Otro');
      INSERT INTO items_pedido (id, pedido_id, producto_id, producto, cantidad, precio_unitario)
      VALUES (501, 42, NULL, ' bidon ', 2, 50);
    `);

    const reader = await pool.connect();
    const writer = await pool.connect();
    try {
      await reader.query('BEGIN');
      const readerRows = async (sql, params = []) => (await reader.query(sql, params)).rows;
      await resolveProductIdentityItems(readerRows, {
        empresaId: 3,
        items: [{ item_pedido_id: 501, producto_id: null, producto: ' bidon ' }],
      });

      let writerFinished = false;
      const writerAttempt = (async () => {
        await writer.query('BEGIN');
        const writerRows = async (sql, params = []) => (await writer.query(sql, params)).rows;
        await lockProductIdentityNamespaces(writerRows, { empresaId: 3, names: ['Bidon'] });
        await writer.query("UPDATE productos SET nombre = 'Bidon' WHERE id = 56");
        await writer.query('COMMIT');
        writerFinished = true;
      })();
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(writerFinished, false);
      await reader.query('COMMIT');
      await writerAttempt;
      assert.equal(writerFinished, true);

      await writer.query('BEGIN');
      const writerRows = async (sql, params = []) => (await writer.query(sql, params)).rows;
      await lockProductIdentityNamespaces(writerRows, { empresaId: 3, names: ['Bidon'] });
      await writer.query("UPDATE productos SET nombre = 'Otro' WHERE id = 56");

      let readerFinished = false;
      const readerAttempt = (async () => {
        await reader.query('BEGIN');
        const rows = async (sql, params = []) => (await reader.query(sql, params)).rows;
        const result = await resolveProductIdentityItems(rows, {
          empresaId: 3,
          items: [{ item_pedido_id: 501, producto_id: null, producto: ' bidon ' }],
        });
        await reader.query('COMMIT');
        readerFinished = true;
        return result;
      })();
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(readerFinished, false);
      await writer.query('COMMIT');
      const result = await readerAttempt;
      assert.equal(readerFinished, true);
      assert.equal(result[0].producto_resuelto_id, 55);
    } finally {
      await reader.query('ROLLBACK').catch(() => {});
      await writer.query('ROLLBACK').catch(() => {});
      reader.release();
      writer.release();
    }
  });
});
