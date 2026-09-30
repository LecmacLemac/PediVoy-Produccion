import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { createClientesRouter } from '../src/routes/clientes.js';
import { createPublicClientAppRouter } from '../src/routes/publicClientApp.js';
import { withTransaction } from '../src/db.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const JWT_SECRET = 'delivery-point-test-secret';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      landing_slug text,
      landing_domain text,
      plan_estado text DEFAULT 'active',
      plan_vencimiento timestamptz,
      config_entrega jsonb DEFAULT '{}'::jsonb,
      ciudad text,
      provincia text,
      pais text,
      config_operativa jsonb DEFAULT '{}'::jsonb
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      nombre text NOT NULL,
      activo boolean DEFAULT true,
      deleted_at timestamptz,
      promo_config jsonb,
      config_activo jsonb DEFAULT '{}'::jsonb,
      retornable boolean DEFAULT false
    );
    CREATE TABLE zonas_geograficas (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      dias_entrega jsonb DEFAULT '[]'::jsonb
    );
    CREATE TABLE puntos_entrega (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      cliente text,
      nombre text,
      telefono text,
      telefono_normalizado text,
      direccion text,
      ciudad text,
      provincia text,
      pais text,
      latitud numeric,
      longitud numeric,
      notas text,
      email text,
      zona_id integer,
      razon_social text,
      cuit text,
      condicion_iva text,
      email_facturacion text,
      crm_estado text,
      crm_riesgo text,
      crm_segmento text,
      crm_motivo text,
      crm_ticket_objetivo numeric,
      crm_proxima_accion timestamptz,
      crm_ultima_accion timestamptz,
      cuenta_corriente_habilitada boolean DEFAULT false,
      requiere_factura boolean DEFAULT false
    );
    CREATE TABLE pedidos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      punto_entrega_id integer,
      fecha timestamptz,
      estado text,
      cantidad numeric,
      cantidad_entregada numeric,
      monto numeric,
      metodo_pago text,
      aviso_recibido integer,
      sats integer,
      submission_id text,
      chofer_id integer,
      zona_id integer,
      fecha_entrega_estimada date,
      referido_por_id integer,
      tracking_token text
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL,
      producto text,
      producto_id integer,
      cantidad numeric,
      precio_unitario numeric
    );
    CREATE TABLE cliente_recompensas (
      id serial PRIMARY KEY, cliente_id integer, producto_id integer, cantidad numeric,
      reclamado boolean DEFAULT false, fecha_reclamado timestamptz, origen_pedido_id integer
    );
    CREATE TABLE cliente_retornables_saldos (empresa_id integer, punto_entrega_id integer, producto_id integer, saldo numeric);
    CREATE TABLE promociones_redenciones (
      id serial PRIMARY KEY, empresa_id integer, punto_entrega_id integer, trigger_producto_id integer,
      beneficio_tipo text, beneficio_producto_id integer, pedido_id integer, created_at timestamptz DEFAULT now()
    );
    INSERT INTO empresas (id, landing_slug) VALUES (1, 'tenant-uno'), (2, 'tenant-dos');
    INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón'), (77, 2, 'Bidón');
  `);
}

function buildApp(pool) {
  process.env.JWT_SECRET = JWT_SECRET;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;

  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    pool,
    geocodeIfNeeded: async () => null,
    normalizePhone: value => String(value || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => null,
    enqueueWppMessage: async () => null,
    sendSmsViaIfttt: async () => ({ skipped: true }),
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => null,
    ejecutarEstrategiaVecinosFn: async () => null,
  });

  app.use('/api/clientes', createClientesRouter({
    query,
    pool,
    withTransaction,
    withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: 1 }; next(); },
    checkLicencia(_req, _res, next) { next(); },
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
    normalizePhone: value => String(value || '').replace(/\D+/g, ''),
    geocodeIfNeeded: async () => null,
    pointInAnyZone: async () => null,
  }));
  app.use('/api/public/app', createPublicClientAppRouter({ query, pool, withTransaction }));
  return app;
}

function publicBody(submissionId, empresaId = 1) {
  return {
    empresa_id: empresaId,
    cliente: 'Cliente público',
    telefono: '3515550000',
    direccion: ' Calle Compartida 10 ',
    submission_id: submissionId,
    items: [{ producto_id: empresaId === 1 ? 55 : 77, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function identityCount(pool, empresaId = 1) {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS c
      FROM puntos_entrega
     WHERE empresa_id = $1
       AND RIGHT(REGEXP_REPLACE(COALESCE(telefono_normalizado, telefono, ''), '\\D', '', 'g'), 7) = '5550000'
       AND LOWER(TRIM(COALESCE(direccion, ''))) = 'calle compartida 10'`, [empresaId]);
  return result.rows[0].c;
}

for (const first of ['pedido', 'clientes']) {
  test(`carrera pedido público vs alta clientes (${first} primero) no duplica identidad`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await fixture(pool);
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(1, hashtext('point:5550000:calle compartida 10'))");
      const app = buildApp(pool);
      await withServer(app, async base => {
        const order = () => postJson(`${base}/public/pedidos?empresa_id=1`, publicBody(`race-${first}`));
        const client = () => postJson(`${base}/api/clientes`, {
          cliente: 'Alta explícita', telefono: '+54 9 351 555 0000', direccion: 'calle compartida 10',
        });
        const a = first === 'pedido' ? order() : client();
        await new Promise(resolve => setTimeout(resolve, 40));
        const b = first === 'pedido' ? client() : order();
        await blocker.query('COMMIT');
        const results = await Promise.all([a, b]);
        assert.ok(results.some(result => result.status === 200), JSON.stringify(results));
        assert.ok(results.every(result => [200, 409].includes(result.status)), JSON.stringify(results));
      });
      blocker.release();
      assert.equal(await identityCount(pool), 1);
    });
  });
}

for (const first of ['pedido', 'profile']) {
  test(`carrera pedido público vs publicClientApp profile (${first} primero) reutiliza un punto`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await fixture(pool);
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(1, hashtext('point:5550000:calle compartida 10'))");
      const token = jwt.sign({ type: 'client', empresa_id: 1, telefono: '3515550000', telefono_norm: '3515550000' }, JWT_SECRET);
      const app = buildApp(pool);
      await withServer(app, async base => {
        const order = () => postJson(`${base}/public/pedidos?empresa_id=1`, publicBody(`profile-${first}`));
        const profile = () => postJson(`${base}/api/public/app/profile?empresa_id=1`, {
          cliente: 'Perfil', telefono: '+54 9 351 555 0000', direccion: 'calle compartida 10',
        }, { cookie: `client_token=${token}` });
        const a = first === 'pedido' ? order() : profile();
        await new Promise(resolve => setTimeout(resolve, 40));
        const b = first === 'pedido' ? profile() : order();
        await blocker.query('COMMIT');
        const results = await Promise.all([a, b]);
        assert.deepEqual(results.map(result => result.status).sort(), [200, 200]);
      });
      blocker.release();
      assert.equal(await identityCount(pool), 1);
    });
  });
}

test('pedido público vs rename hacia la misma identidad produce un resultado serial sin duplicados', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await pool.query(`INSERT INTO puntos_entrega
      (empresa_id, cliente, telefono, telefono_normalizado, direccion)
      VALUES (1, 'Anterior', '3515559999', '3515559999', 'Calle Vieja 1')`);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const [order, rename] = await Promise.all([
        postJson(`${base}/public/pedidos?empresa_id=1`, publicBody('rename-race')),
        putJson(`${base}/api/clientes/1`, { telefono: '3515550000', direccion: 'calle compartida 10' }),
      ]);
      assert.equal(order.status, 200);
      assert.ok([200, 409].includes(rename.status), JSON.stringify(rename));
    });
    assert.equal(await identityCount(pool), 1);
  });
});

test('namespaces de punto están aislados por tenant', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT pg_advisory_xact_lock(1, hashtext('point:5550000:calle compartida 10'))");
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await Promise.race([
        postJson(`${base}/public/pedidos?empresa_id=2`, publicBody('tenant-two', 2)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('bloqueo cross-tenant')), 600)),
      ]);
      assert.equal(result.status, 200);
    });
    await blocker.query('ROLLBACK');
    blocker.release();
    assert.equal(await identityCount(pool, 2), 1);
  });
});

test('dos renames inversos adquieren namespaces en orden estable y no deadlockean', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await pool.query(`INSERT INTO puntos_entrega
      (id, empresa_id, cliente, telefono, telefono_normalizado, direccion) VALUES
      (10, 1, 'A', '3515550001', '3515550001', 'Calle A'),
      (20, 1, 'B', '3515550002', '3515550002', 'Calle B')`);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const results = await Promise.race([
        Promise.all([
          putJson(`${base}/api/clientes/10`, { telefono: '3515550002', direccion: 'Calle B' }),
          putJson(`${base}/api/clientes/20`, { telefono: '3515550001', direccion: 'Calle A' }),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock/timeout')), 1500)),
      ]);
      assert.ok(results.every(result => result.status === 409), JSON.stringify(results));
    });
  });
});
