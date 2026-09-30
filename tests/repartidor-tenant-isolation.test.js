import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { createRepartidorStatsRouter } from '../src/routes/repartidorStats.js';
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

function buildApiApp({ query, user = { role: 'repartidor', empresa_id: 1, chofer_id: 7 } }) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    pool: { connect: async () => { throw new Error('pool no esperado'); } },
    withTransaction: async work => work(query),
    withAuth(req, _res, next) { req.user = user; next(); },
    getEmpresaIdFromToken: req => req.user?.empresa_id,
  }));
  return app;
}

async function setupReadFixture(pool) {
  await pool.query(`
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, cliente text, direccion text,
      direccion_completa text, ciudad text, telefono text, cuenta_corriente_habilitada boolean,
      latitud numeric, longitud numeric, notas text, zona_id integer
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, chofer_id integer, estado text,
      fecha timestamptz DEFAULT NOW(), fecha_entrega timestamptz, fecha_entrega_estimada date,
      punto_entrega_id integer, cantidad numeric, monto numeric, metodo_pago text, zona_id integer
    );
    CREATE TABLE zonas_geograficas (id integer PRIMARY KEY, empresa_id integer, nombre text, dias_entrega text);
    CREATE TABLE items_pedido (
      id integer PRIMARY KEY, pedido_id integer, producto text, cantidad numeric,
      precio_unitario numeric, producto_id integer
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY, empresa_id integer, nombre text, config_activo jsonb,
      retornable boolean
    );
    CREATE TABLE cliente_retornables_saldos (
      empresa_id integer, punto_entrega_id integer, producto_id integer, saldo numeric
    );
    CREATE TABLE entregas_evidencias (
      id integer PRIMARY KEY, empresa_id integer, pedido_id integer, chofer_id integer,
      checklist jsonb, evidencia jsonb, updated_at timestamptz DEFAULT NOW()
    );
    CREATE TABLE empresa_activos (
      id integer PRIMARY KEY, empresa_id integer, cliente_id integer, codigo text, tipo text,
      estado text, producto_id integer, numero_serie text, alquiler_mensual numeric,
      marca text, modelo text
    );
    CREATE TABLE pedido_activos (
      id integer PRIMARY KEY, empresa_id integer, pedido_id integer, activo_id integer,
      activo_relacionado_id integer, tipo_operacion text, estado text, observacion text,
      accion_at_utc timestamptz
    );

    INSERT INTO puntos_entrega VALUES
      (11,1,'Cliente Uno','Dir Uno',NULL,'Ciudad','111',FALSE,-34,-58,NULL,NULL),
      (12,2,'SECRETO DOS','DIR SECRETA DOS',NULL,'Ciudad','222',FALSE,-35,-59,NULL,NULL);
    INSERT INTO pedidos (id,empresa_id,chofer_id,estado,punto_entrega_id,cantidad,monto,metodo_pago) VALUES
      (101,2,7,'pendiente',11,1,100,'efectivo'),
      (102,1,7,'pendiente',12,1,200,'efectivo'),
      (103,1,7,'pendiente',11,1,300,'efectivo'),
      (104,2,7,'entregado',12,1,400,'efectivo');
    INSERT INTO entregas_evidencias (id,empresa_id,pedido_id,chofer_id,checklist,evidencia) VALUES
      (1,1,104,7,'{}','{"foto":"secreta"}'),
      (2,1,103,7,'{}','{"foto":"propia"}');
  `);
}

function postgresQuery(pool) {
  return async (sql, params = []) => {
    if (/^\s*(CREATE|ALTER)\b/i.test(sql)) return [];
    return (await pool.query(sql, params)).rows;
  };
}

test('PostgreSQL: GET pedidos exige cadena pedido-punto íntegra dentro del tenant', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupReadFixture(pool);
    const app = buildApiApp({ query: postgresQuery(pool) });
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/repartidor/pedidos`);
      assert.equal(response.status, 200);
      const rows = await response.json();
      assert.deepEqual(rows.map(row => row.id), [103]);
      assert.equal(JSON.stringify(rows).includes('SECRETO DOS'), false);
    });
  });
});

test('PostgreSQL: activos-resumen falla cerrado si el punto del pedido pertenece a otro tenant', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupReadFixture(pool);
    const app = buildApiApp({ query: postgresQuery(pool) });
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/repartidor/pedidos/102/activos-resumen`);
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(JSON.stringify(body).includes('SECRETO DOS'), false);
      assert.equal(JSON.stringify(body).includes('DIR SECRETA DOS'), false);
    });
  });
});

test('PostgreSQL: evidencias exige evidencia-pedido-punto íntegros del tenant y chofer', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await setupReadFixture(pool);
    const app = buildApiApp({ query: postgresQuery(pool) });
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/repartidor/entregas-evidencias`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.items.map(row => row.pedido_id), [103]);
      assert.equal(JSON.stringify(body).includes('secreta'), false);
    });
  });
});

test('optimizar-ruta limita pedidos y puntos por empresa+chofer autenticados sin mutaciones', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    return [{ id: 103, cliente: 'Cliente Uno' }];
  };
  const app = buildApiApp({ query });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/optimizar-ruta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: -34, lng: -58, empresa_id: 999, chofer_id: 999 }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [7, -34, -58, 1]);
  assert.match(calls[0].sql, /p\.chofer_id\s*=\s*\$1[\s\S]*p\.empresa_id\s*=\s*\$4/i);
  assert.match(calls[0].sql, /JOIN puntos_entrega pe[\s\S]*ON[\s\S]*pe\.empresa_id\s*=\s*p\.empresa_id/i);
  assert.doesNotMatch(calls[0].sql, /\b(UPDATE|INSERT|DELETE)\b/i);
});

test('PostgreSQL: stats no mezclan pedidos ni items de otro tenant aunque colisione chofer_id', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE pedidos (
        id integer PRIMARY KEY, empresa_id integer NOT NULL, chofer_id integer,
        estado text, monto numeric, fecha timestamptz, fecha_entrega timestamptz,
        punto_entrega_id integer
      );
      CREATE TABLE puntos_entrega (id integer PRIMARY KEY, empresa_id integer NOT NULL);
      CREATE TABLE items_pedido (id integer PRIMARY KEY, pedido_id integer, cantidad numeric, precio_unitario numeric);
      CREATE TABLE chofer_escalas (
        id integer PRIMARY KEY, empresa_id integer, chofer_id integer,
        vigente_desde date, vigente_hasta date
      );
      CREATE TABLE chofer_escala_tramos (id integer PRIMARY KEY, escala_id integer, rango_min numeric, rango_max numeric, monto numeric);
      INSERT INTO puntos_entrega VALUES (11,1),(12,2);
      INSERT INTO pedidos VALUES
        (1,1,7,'entregado',100,NOW(),NOW(),11),
        (2,2,7,'entregado',900,NOW(),NOW(),11),
        (3,1,7,'entregado',700,NOW(),NOW(),12);
      INSERT INTO items_pedido VALUES (1,1,2,10),(2,2,9,10),(3,3,7,10);
      INSERT INTO chofer_escalas VALUES (1,1,7,CURRENT_DATE,NULL),(2,2,7,CURRENT_DATE,NULL);
      INSERT INTO chofer_escala_tramos VALUES (1,1,0,100,30),(2,2,0,100,999);
    `);
    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const app = express();
    app.use('/api/repartidor', createRepartidorStatsRouter({
      query,
      withAuth(req, _res, next) {
        req.user = { role: 'repartidor', empresa_id: 1, chofer_id: 7 };
        next();
      },
    }));

    await withServer(app, async baseUrl => {
      const resumen = await fetch(`${baseUrl}/api/repartidor/resumen-dia`);
      assert.equal(resumen.status, 200);
      assert.deepEqual(await resumen.json(), { entregados: '2', pendientes: '0', dinero: '800' });

      const pago = await fetch(`${baseUrl}/api/repartidor/pago-dia?fecha=${new Date().toISOString().slice(0, 10)}`);
      assert.equal(pago.status, 200);
      assert.deepEqual(await pago.json(), {
        fecha: new Date().toISOString().slice(0, 10),
        cantidad: 2,
        pago: 30,
      });
    });
  });
});
