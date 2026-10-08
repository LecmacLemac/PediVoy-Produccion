import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
import { lockProductIdentityNamespaces } from '../src/services/productIdentityNamespace.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address();
    await work(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      landing_slug text,
      landing_domain text,
      plan_estado text DEFAULT 'active',
      plan_vencimiento timestamptz,
      config_entrega jsonb DEFAULT '{}'::jsonb
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      nombre text NOT NULL,
      precio numeric DEFAULT 0,
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
      telefono text,
      telefono_normalizado text,
      direccion text,
      ciudad text,
      provincia text,
      pais text,
      latitud numeric,
      longitud numeric,
      notas text,
      zona_id integer
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
      notas text,
      tracking_token text
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL REFERENCES pedidos(id),
      producto text,
      producto_id integer,
      cantidad numeric,
      precio_unitario numeric
    );
    CREATE TABLE cliente_recompensas (
      id serial PRIMARY KEY,
      cliente_id integer,
      producto_id integer,
      cantidad numeric,
      reclamado boolean DEFAULT false,
      fecha_reclamado timestamptz,
      origen_pedido_id integer
    );
    CREATE TABLE cliente_retornables_saldos (
      empresa_id integer,
      punto_entrega_id integer,
      producto_id integer,
      saldo numeric
    );
    CREATE TABLE promociones_redenciones (
      id serial PRIMARY KEY,
      empresa_id integer,
      punto_entrega_id integer,
      trigger_producto_id integer,
      beneficio_tipo text,
      beneficio_producto_id integer,
      pedido_id integer,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO empresas (id, landing_slug, landing_domain) VALUES
      (1, 'tenant-uno', 'uno.example.test'),
      (2, 'tenant-dos', 'dos.example.test');
  `);
}

async function resetData(pool) {
  await pool.query(`
    TRUNCATE promociones_redenciones, cliente_retornables_saldos, cliente_recompensas,
      items_pedido, pedidos, puntos_entrega, productos RESTART IDENTITY CASCADE;
  `);
}

function buildApp(pool, overrides = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    pool: overrides.pool || pool,
    geocodeIfNeeded: overrides.geocodeIfNeeded || (async () => null),
    normalizePhone: value => String(value || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => null,
    enqueueOrderConfirmationWppMessage: overrides.enqueueWppMessage || (async () => null),
    enqueueWppMessage: overrides.enqueueWppMessage || (async () => null),
    sendSmsViaIfttt: async () => null,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => null,
    ejecutarEstrategiaVecinosFn: overrides.ejecutarEstrategiaVecinosFn || (async () => null),
    resolveEmpresaIdFn: overrides.resolveEmpresaIdFn,
  });
  return app;
}

function payload(item, suffix) {
  return {
    empresa_id: 1,
    cliente: `Cliente ${suffix}`,
    telefono: `351555${String(suffix).padStart(4, '0')}`,
    direccion: `Calle ${suffix}`,
    items: [{ cantidad: 1, precio_unitario: 1200, ...item }],
  };
}

async function postPedido(baseUrl, body, ipSuffix, extraHeaders = {}) {
  const tenantQuery = Object.hasOwn(extraHeaders, 'x-test-url-query')
    ? extraHeaders['x-test-url-query']
    : `empresa_id=${encodeURIComponent(body.empresa_id)}`;
  const headers = { ...extraHeaders };
  delete headers['x-test-url-query'];
  const response = await fetch(`${baseUrl}/public/pedidos?${tenantQuery}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.77.0.${ipSuffix}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function mutationCounts(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM pedidos) AS pedidos,
      (SELECT COUNT(*)::int FROM items_pedido) AS items,
      (SELECT COUNT(*)::int FROM promociones_redenciones) AS promociones,
      (SELECT COUNT(*)::int FROM puntos_entrega) AS puntos_entrega
  `);
  return result.rows[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('POST /public/pedidos rechaza metodo_pago arbitrario sin mutaciones', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón')`);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, {
        ...payload({ producto_id: 55, producto: 'Bidón' }, 9001),
        metodo_pago: 'bitcoin',
      }, 90);
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'payload inválido');
      assert.deepEqual(await mutationCounts(pool), {
        pedidos: 0,
        items: 0,
        promociones: 0,
        puntos_entrega: 0,
      });
    });
  });
});

test('POST /public/pedidos deja el pago a definir cuando metodo_pago se omite', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón')`);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, payload({ producto_id: 55, producto: 'Bidón' }, 9002), 91);
      assert.equal(result.status, 200);
      const saved = await pool.query('SELECT metodo_pago FROM pedidos WHERE id = $1', [result.body.pedido.id]);
      assert.deepEqual(saved.rows, [{ metodo_pago: null }]);
    });
  });
});

test('POST /public/pedidos trata coordenadas null como ubicación no informada', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón')`);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, {
        ...payload({ producto_id: 55, producto: 'Bidón' }, 9003),
        latitud: null,
        longitud: null,
      }, 92);
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
    });
  });
});

test('POST /public/pedidos reutiliza autoritativamente el último punto aceptado sin coordenadas del navegador', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón');
      INSERT INTO puntos_entrega
        (id, empresa_id, cliente, telefono, telefono_normalizado, direccion, ciudad, latitud, longitud, zona_id)
      VALUES
        (10, 1, 'Anterior', '3515550000', '3515550000', 'Calle vieja 10', 'Córdoba', -31.1, -64.1, NULL),
        (11, 1, 'Cliente canónico', '3515550000', '3515550000', 'Bv. San Martín 123', 'Villa María', -32.4101, -63.2402, NULL),
        (20, 2, 'Ajeno', '3515550000', '3515550000', 'Calle ajena 9', 'Otra', -30, -60, NULL);
      INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, estado, monto, tracking_token)
      VALUES
        (100, 1, 10, '2026-09-01T10:00:00Z', 'entregado', 100, 'old'),
        (101, 1, 11, '2026-10-01T10:00:00Z', 'entregado', 100, 'latest'),
        (200, 2, 20, '2026-10-02T10:00:00Z', 'entregado', 100, 'other');
    `);
    let geocodeCalls = 0;
    const app = buildApp(pool, {
      geocodeIfNeeded: async () => {
        geocodeCalls += 1;
        return { lat: -1, lng: -1 };
      },
    });

    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, {
        empresa_id: 1,
        punto_entrega_id: 11,
        cliente: 'Dato manipulado',
        telefono: '3515550000',
        direccion: 'Dirección manipulada 999',
        ciudad: 'Ciudad manipulada',
        latitud: 0,
        longitud: 0,
        notas: 'Departamento 4 B',
        submission_id: 'reuse-latest-point',
        items: [{ producto_id: 55, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
      }, 88);
      assert.equal(result.status, 200);
      assert.equal(geocodeCalls, 0);
      assert.deepEqual(result.body.coords, { lat: -32.4101, lng: -63.2402 });

      const order = await pool.query(`
        SELECT p.punto_entrega_id, p.notas, pe.cliente, pe.direccion, pe.ciudad, pe.latitud, pe.longitud
          FROM pedidos p
          JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id AND pe.empresa_id = p.empresa_id
         WHERE p.submission_id = 'reuse-latest-point' AND p.empresa_id = 1
      `);
      assert.deepEqual(order.rows, [{
        punto_entrega_id: 11,
        notas: 'Departamento 4 B',
        cliente: 'Cliente canónico',
        direccion: 'Bv. San Martín 123',
        ciudad: 'Villa María',
        latitud: '-32.4101',
        longitud: '-63.2402',
      }]);
      const count = await pool.query('SELECT COUNT(*)::int AS c FROM puntos_entrega');
      assert.equal(count.rows[0].c, 3);

      const forged = await postPedido(baseUrl, {
        empresa_id: 1,
        punto_entrega_id: 20,
        cliente: 'Intento ajeno',
        telefono: '3515550000',
        direccion: 'Calle ajena 9',
        ciudad: 'Otra',
        submission_id: 'forged-cross-tenant-point',
        items: [{ producto_id: 55, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
      }, 89);
      assert.equal(forged.status, 409);
      assert.equal(forged.body.code, 'DELIVERY_POINT_IDENTITY_CONFLICT');
      const forgedOrder = await pool.query("SELECT COUNT(*)::int AS c FROM pedidos WHERE submission_id = 'forged-cross-tenant-point'");
      assert.equal(forgedOrder.rows[0].c, 0);
      assert.equal(geocodeCalls, 0);
    });
  });
});

test('POST /public/pedidos acepta un punto único recuperado aunque todavía no tenga pedidos previos', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón');
      INSERT INTO puntos_entrega
        (id, empresa_id, cliente, telefono, telefono_normalizado, direccion, ciudad, latitud, longitud)
      VALUES
        (15, 1, 'Cliente nuevo', '3515550015', '3515550015', 'Avenida Colón 15', 'Córdoba', -31.415, -64.185);
    `);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, {
        empresa_id: 1,
        punto_entrega_id: 15,
        cliente: 'Cliente nuevo',
        telefono: '3515550015',
        direccion: 'Avenida Colón 15',
        ciudad: 'Córdoba',
        submission_id: 'unique-point-without-orders',
        items: [{ producto_id: 55, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
      }, 90);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.coords, { lat: -31.415, lng: -64.185 });
      const order = await pool.query("SELECT punto_entrega_id FROM pedidos WHERE submission_id = 'unique-point-without-orders'");
      assert.deepEqual(order.rows, [{ punto_entrega_id: 15 }]);

      await pool.query("UPDATE pedidos SET tracking_token = NULL WHERE submission_id = 'unique-point-without-orders'");
      const partialPhone = await postPedido(baseUrl, {
        empresa_id: 1,
        punto_entrega_id: 15,
        cliente: 'Cliente nuevo',
        telefono: '5550015',
        direccion: 'Avenida Colón 15',
        ciudad: 'Córdoba',
        submission_id: 'unique-point-without-orders',
        items: [{ producto_id: 55, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
      }, 91);
      assert.equal(partialPhone.status, 400);
      assert.equal(partialPhone.body.code, 'PUBLIC_PHONE_INVALID');
      assert.equal(Object.hasOwn(partialPhone.body, 'pedido'), false);
      const replayedOrder = await pool.query("SELECT tracking_token FROM pedidos WHERE submission_id = 'unique-point-without-orders'");
      assert.deepEqual(replayedOrder.rows, [{ tracking_token: null }]);
    });
  });
});

test('POST /public/pedidos guarda notas sólo en el pedido y permite borrarlas en el siguiente', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre) VALUES (55, 1, 'Bidón')");
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const first = await postPedido(baseUrl, {
        empresa_id: 1,
        cliente: 'Cliente notas',
        telefono: '3515550099',
        direccion: 'Calle Notas 99',
        ciudad: 'Córdoba',
        notas: 'Departamento 4 B',
        submission_id: 'note-order-first',
        items: [{ producto_id: 55, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
      }, 92);
      assert.equal(first.status, 200);

      const stored = await pool.query(`
        SELECT p.punto_entrega_id, p.notas AS pedido_notas, pe.notas AS punto_notas
          FROM pedidos p
          JOIN puntos_entrega pe
            ON pe.id = p.punto_entrega_id
           AND pe.empresa_id = p.empresa_id
         WHERE p.empresa_id = 1
           AND p.submission_id = 'note-order-first'
      `);
      assert.deepEqual(stored.rows, [{
        punto_entrega_id: stored.rows[0].punto_entrega_id,
        pedido_notas: 'Departamento 4 B',
        punto_notas: null,
      }]);

      const second = await postPedido(baseUrl, {
        empresa_id: 1,
        punto_entrega_id: stored.rows[0].punto_entrega_id,
        cliente: 'Cliente notas',
        telefono: '3515550099',
        direccion: 'Calle Notas 99',
        ciudad: 'Córdoba',
        notas: '',
        submission_id: 'note-order-cleared',
        items: [{ producto_id: 55, producto: 'Bidón', cantidad: 1, precio_unitario: 100 }],
      }, 93);
      assert.equal(second.status, 200);

      const cleared = await pool.query(`
        SELECT p.notas AS pedido_notas, pe.notas AS punto_notas
          FROM pedidos p
          JOIN puntos_entrega pe
            ON pe.id = p.punto_entrega_id
           AND pe.empresa_id = p.empresa_id
         WHERE p.empresa_id = 1
           AND p.submission_id = 'note-order-cleared'
      `);
      assert.deepEqual(cleared.rows, [{ pedido_notas: null, punto_notas: null }]);
    });
  });
});

test('POST /public/pedidos usa precio canónico server-side en pedido e intención Cloud', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, precio) VALUES (55, 1, 'Bidón canónico', 1200)");
    const enqueued = [];
    const app = buildApp(pool, { enqueueWppMessage: async payload => { enqueued.push(payload); } });

    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, {
        ...payload({ producto_id: 55, producto: 'Nombre manipulado' }, 9010),
        items: [{ producto_id: 55, producto: 'Nombre manipulado', cantidad: 2, precio_unitario: 999999 }],
      }, 94);
      assert.equal(result.status, 200);
      assert.equal(result.body.pedido.monto, '2400');
    });

    const saved = await pool.query('SELECT producto, cantidad, precio_unitario FROM items_pedido');
    assert.deepEqual(saved.rows, [{ producto: 'Bidón canónico', cantidad: '2', precio_unitario: '1200' }]);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].utility_template.parameters.items_block, '2 x Bidón canónico — $ 2.400');
    assert.equal(enqueued[0].utility_template.parameters.total, '$ 2.400');
  });
});

test('POST /public/pedidos usa identidad de producto autoritativa con PostgreSQL real', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      await t.test('rechaza ID inexistente aunque el nombre coincida localmente, sin mutaciones', async () => {
        await resetData(pool);
        await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
        const result = await postPedido(baseUrl, payload({ producto_id: 999, producto: 'BIDÓN' }, 1), 1);
        assert.equal(result.status, 400);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('rechaza ID cross-tenant aunque el nombre coincida localmente, sin fuga ni fallback', async () => {
        await resetData(pool);
        await pool.query(`INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES
          (55, 1, 'Bidón', true, NULL, NULL),
          (77, 2, 'Bidón ajeno', true, NULL, NULL)`);
        const result = await postPedido(baseUrl, payload({ producto_id: 77, producto: 'Bidón' }, 2), 2);
        assert.equal(result.status, 400);
        assert.equal(result.body?.error, 'Producto inválido');
        assert.equal(result.body?.code, 'PRODUCT_IDENTITY_CONFLICT');
        assert.equal(Object.hasOwn(result.body || {}, 'producto'), false);
        assert.equal(Object.hasOwn(result.body || {}, 'producto_id'), false);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('rechaza dos homónimos normalizados para un item legacy, sin mutaciones', async () => {
        await resetData(pool);
        await pool.query(`INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES
          (55, 1, 'Bidón', true, NULL, NULL),
          (56, 1, ' bidón ', true, NULL, NULL)`);
        const result = await postPedido(baseUrl, payload({ producto: ' BIDÓN ' }, 3), 3);
        assert.equal(result.status, 409);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('nombre legacy único con case/espacios persiste ID y nombre canónicos', async () => {
        await resetData(pool);
        await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón Premium', true, NULL, NULL)");
        const result = await postPedido(baseUrl, payload({ producto: '  BIDÓN PREMIUM  ' }, 4), 4);
        assert.equal(result.status, 200);
        const items = await pool.query('SELECT producto_id, producto FROM items_pedido ORDER BY id');
        assert.deepEqual(items.rows, [{ producto_id: 55, producto: 'Bidón Premium' }]);
      });

      await t.test('ID canónico válido gana aunque el nombre apunte a un homónimo', async () => {
        await resetData(pool);
        await pool.query(`INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES
          (55, 1, 'Bidón A', true, NULL, NULL),
          (56, 1, 'Bidón B', true, NULL, NULL)`);
        const result = await postPedido(baseUrl, payload({ producto_id: 55, producto: 'Bidón B' }, 5), 5);
        assert.equal(result.status, 200);
        const items = await pool.query('SELECT producto_id, producto FROM items_pedido ORDER BY id');
        assert.deepEqual(items.rows, [{ producto_id: 55, producto: 'Bidón A' }]);
      });

      await t.test('rechaza producto inactivo por ID sin fallback', async () => {
        await resetData(pool);
        await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', false, NULL, NULL)");
        const result = await postPedido(baseUrl, payload({ producto_id: 55, producto: 'Bidón' }, 7), 7);
        assert.equal(result.status, 400);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('retry idempotente conserva el pedido aunque el producto se inactive después', async () => {
        await resetData(pool);
        await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
        const body = { ...payload({ producto_id: 55, producto: 'Bidón' }, 9), submission_id: 'idem-product-9' };
        const first = await postPedido(baseUrl, body, 9);
        assert.equal(first.status, 200);
        assert.equal(first.body.created, true);
        await pool.query('UPDATE productos SET activo = false WHERE id = 55');
        const second = await postPedido(baseUrl, body, 99);
        assert.equal(second.status, 200);
        assert.equal(second.body.created, false);
        assert.equal(second.body.pedido.id, first.body.pedido.id);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 1, items: 1, promociones: 0, puntos_entrega: 1 });
      });

      for (const [label, producto_id] of [
        ['string', '55'],
        ['boolean', true],
        ['decimal', 55.5],
        ['unsafe', Number.MAX_SAFE_INTEGER + 1],
        ['cero', 0],
        ['negativo', -1],
      ]) {
        await t.test(`rechaza producto_id ${label} y nunca hace fallback por nombre`, async () => {
          await resetData(pool);
          await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
          const result = await postPedido(baseUrl, payload({ producto_id, producto: 'Bidón' }, `6-${label}`), 10 + Math.floor(Math.random() * 100));
          assert.equal(result.status, 400);
          assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
        });
      }
    });
  });
});

test('POST /public/pedidos serializa submission_id antes de crear puntos_entrega', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");

    const bothReachedSubmissionLock = deferred();
    const releaseSubmissionLocks = deferred();
    let submissionLockAttempts = 0;
    let pointInserts = 0;
    const controlledPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            if (String(sql).includes('pg_advisory_xact_lock') && String(params?.[0] || '').includes('same-submission-concurrent')) {
              submissionLockAttempts += 1;
              if (submissionLockAttempts === 2) bothReachedSubmissionLock.resolve();
              await releaseSubmissionLocks.promise;
            }
            const result = await client.query(sql, params);
            if (String(sql).includes('INSERT INTO puntos_entrega')) {
              pointInserts += 1;
            }
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    let wppCalls = 0;
    let strategyCalls = 0;
    const app = buildApp(pool, {
      pool: controlledPool,
      enqueueWppMessage: async () => { wppCalls += 1; },
      ejecutarEstrategiaVecinosFn: async () => { strategyCalls += 1; },
    });

    await withServer(app, async baseUrl => {
      const body = {
        ...payload({ producto_id: 55, producto: 'Bidón' }, 30),
        submission_id: 'same-submission-concurrent',
      };
      const first = postPedido(baseUrl, body, 30);
      const second = postPedido(baseUrl, body, 31);
      await bothReachedSubmissionLock.promise;
      releaseSubmissionLocks.resolve();
      const responses = await Promise.all([first, second]);

      assert.deepEqual(responses.map(result => result.status), [200, 200]);
      assert.deepEqual(responses.map(result => result.body.created).sort(), [false, true]);
      assert.equal(responses[0].body.pedido.id, responses[1].body.pedido.id);
    });

    assert.equal(submissionLockAttempts, 2, 'ambos POST deben llegar al lock de submission_id');
    assert.equal(pointInserts, 1, 'sólo el ganador puede intentar crear el punto');
    assert.deepEqual(await mutationCounts(pool), {
      pedidos: 1,
      items: 1,
      promociones: 0,
      puntos_entrega: 1,
    });
    assert.equal(wppCalls, 1);
    assert.equal(strategyCalls, 1);
  });
});

test('POST /public/pedidos retry secuencial no vuelve a tocar el punto ni repite postcommit', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
    let pointStatements = 0;
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            if (String(sql).includes('puntos_entrega')) pointStatements += 1;
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    let wppCalls = 0;
    let strategyCalls = 0;
    const app = buildApp(pool, {
      pool: observedPool,
      enqueueWppMessage: async () => { wppCalls += 1; },
      ejecutarEstrategiaVecinosFn: async () => { strategyCalls += 1; },
    });

    await withServer(app, async baseUrl => {
      const body = { ...payload({ producto_id: 55, producto: 'Bidón' }, 32), submission_id: 'sequential-retry' };
      const first = await postPedido(baseUrl, body, 32);
      assert.equal(first.status, 200);
      assert.equal(first.body.created, true);
      const statementsAfterCreate = pointStatements;
      await pool.query('UPDATE productos SET activo = false WHERE id = 55');

      const retry = await postPedido(baseUrl, body, 33);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.created, false);
      assert.equal(retry.body.pedido.id, first.body.pedido.id);
      assert.equal(pointStatements, statementsAfterCreate);
    });

    assert.deepEqual(await mutationCounts(pool), { pedidos: 1, items: 1, promociones: 0, puntos_entrega: 1 });
    assert.equal(wppCalls, 1);
    assert.equal(strategyCalls, 1);
  });
});

test('POST /public/pedidos aísla submission_id por tenant resuelto por servidor', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón 1',true,NULL,NULL),(77,2,'Bidón 2',true,NULL,NULL)");
    const app = buildApp(pool, {
      resolveEmpresaIdFn: async req => Number(req.headers['x-test-tenant']),
    });

    const tenantOneLock = await pool.connect();
    try {
      await tenantOneLock.query('BEGIN');
      await tenantOneLock.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pedido:1:shared-across-tenants']);

      await withServer(app, async baseUrl => {
        const tenant2Body = {
          ...payload({ producto_id: 77, producto: 'Bidón 2' }, 34),
          empresa_id: 999,
          submission_id: 'shared-across-tenants',
        };
        const tenant2 = await Promise.race([
          postPedido(baseUrl, tenant2Body, 34, { 'x-test-tenant': '2' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('bloqueo cross-tenant')), 750)),
        ]);
        assert.equal(tenant2.status, 200);
        assert.equal(tenant2.body.created, true);

        await tenantOneLock.query('ROLLBACK');
        const tenant1Body = {
          ...payload({ producto_id: 55, producto: 'Bidón 1' }, 35),
          empresa_id: 999,
          submission_id: 'shared-across-tenants',
        };
        const tenant1 = await postPedido(baseUrl, tenant1Body, 35, { 'x-test-tenant': '1' });
        assert.equal(tenant1.status, 200);
        assert.equal(tenant1.body.created, true);
      });
    } finally {
      await tenantOneLock.query('ROLLBACK').catch(() => {});
      tenantOneLock.release();
    }

    const rows = await pool.query('SELECT empresa_id, submission_id FROM pedidos ORDER BY empresa_id');
    assert.deepEqual(rows.rows, [
      { empresa_id: 1, submission_id: 'shared-across-tenants' },
      { empresa_id: 2, submission_id: 'shared-across-tenants' },
    ]);
    assert.deepEqual(await mutationCounts(pool), { pedidos: 2, items: 2, promociones: 0, puntos_entrega: 2 });
  });
});

test('POST /public/pedidos revierte el punto si falla antes de insertar el pedido', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
    let failNextPedidoInsert = true;
    const failingPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            if (failNextPedidoInsert && String(sql).includes('INSERT INTO pedidos')) {
              failNextPedidoInsert = false;
              throw new Error('controlled failure after point');
            }
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { pool: failingPool });

    await withServer(app, async baseUrl => {
      const body = { ...payload({ producto_id: 55, producto: 'Bidón' }, 36), submission_id: 'rollback-point' };
      const failed = await postPedido(baseUrl, body, 36);
      assert.equal(failed.status, 500);
      assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });

      const retry = await postPedido(baseUrl, body, 37);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.created, true);
    });

    assert.deepEqual(await mutationCounts(pool), { pedidos: 1, items: 1, promociones: 0, puntos_entrega: 1 });
  });
});

test('POST /public/pedidos mantiene orden submission-producto y nombres estable para evitar deadlock', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Alpha',true,NULL,NULL),(56,1,'Beta',true,NULL,NULL)");
    const lockOrders = [];
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        const locks = [];
        lockOrders.push(locks);
        return {
          async query(sql, params) {
            if (String(sql).includes('pg_advisory_xact_lock')) {
              if (params?.length === 1) locks.push(`submission:${params[0]}`);
              else if (String(params?.[1] || '').startsWith('whatsapp-general-phone:')) locks.push(`phone:${params[1]}`);
              else locks.push(`product:${params[1]}`);
            }
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { pool: observedPool });

    await withServer(app, async baseUrl => {
      const base = payload({ producto: 'Alpha' }, 38);
      const a = { ...base, submission_id: 'lock-order-a', items: [
        { producto: 'Alpha', cantidad: 1, precio_unitario: 100 },
        { producto: 'Beta', cantidad: 1, precio_unitario: 100 },
      ] };
      const b = { ...base, telefono: '3515550039', direccion: 'Calle 39', submission_id: 'lock-order-b', items: [
        { producto: 'Beta', cantidad: 1, precio_unitario: 100 },
        { producto: 'Alpha', cantidad: 1, precio_unitario: 100 },
      ] };
      const responses = await Promise.race([
        Promise.all([postPedido(baseUrl, a, 38), postPedido(baseUrl, b, 39)]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock o espera no acotada')), 1500)),
      ]);
      assert.deepEqual(responses.map(result => result.status), [200, 200]);
    });

    assert.equal(lockOrders.length, 2);
    for (const locks of lockOrders) {
      assert.match(locks[0], /^submission:/);
      assert.deepEqual(locks.filter(lock => lock.startsWith('product:') && !lock.startsWith('product:point:')), ['product:alpha', 'product:beta']);
      const pointLockIndex = locks.findIndex(lock => lock.startsWith('product:point:'));
      const lastProductIndex = locks.findLastIndex(lock => lock.startsWith('product:') && !lock.startsWith('product:point:'));
      assert.ok(pointLockIndex > lastProductIndex, JSON.stringify(locks));
    }
  });
});

test('POST /public/pedidos no ejecuta postcommit ni reintenta ante COMMIT ambiguo', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
    let connectCalls = 0;
    let rollbackAfterCommit = 0;
    let releasedWithError = false;
    let wppCalls = 0;
    let strategyCalls = 0;
    const ambiguousPool = {
      async connect() {
        connectCalls += 1;
        const client = await pool.connect();
        let commitAttempted = false;
        return {
          async query(sql, params) {
            if (sql === 'COMMIT') {
              commitAttempted = true;
              await client.query(sql, params);
              throw new Error('private commit socket detail');
            }
            if (sql === 'ROLLBACK' && commitAttempted) rollbackAfterCommit += 1;
            return client.query(sql, params);
          },
          release(error) {
            releasedWithError = !!error;
            client.release(error);
          },
        };
      },
    };
    const app = buildApp(pool, {
      pool: ambiguousPool,
      enqueueWppMessage: async () => { wppCalls += 1; },
      ejecutarEstrategiaVecinosFn: async () => { strategyCalls += 1; },
    });
    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, {
        ...payload({ producto_id: 55, producto: 'Bidón' }, 8),
        submission_id: 'ambiguous-commit',
      }, 8);
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'TRANSACTION_OUTCOME_UNKNOWN');
      assert.doesNotMatch(JSON.stringify(result.body), /private|socket/i);
    });
    assert.equal(connectCalls, 1);
    assert.equal(rollbackAfterCommit, 0);
    assert.equal(releasedWithError, true);
    assert.equal(wppCalls, 0);
    assert.equal(strategyCalls, 0);
    assert.deepEqual(await mutationCounts(pool), { pedidos: 1, items: 1, promociones: 0, puntos_entrega: 1 });
  });
});

test('POST /public/pedidos serializa identidad legacy con writers y aísla tenants', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);

    await t.test('writer que crea ambigüedad primero hace esperar y fallar cerrado al POST', async () => {
      await resetData(pool);
      await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL),(56,1,'Otro',true,NULL,NULL)");
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        const writerRows = async (sql, params = []) => (await writer.query(sql, params)).rows;
        await lockProductIdentityNamespaces(writerRows, { empresaId: 1, names: ['Bidón'] });
        await writer.query("UPDATE productos SET nombre = ' bidón ' WHERE id = 56");
        const app = buildApp(pool);
        await withServer(app, async baseUrl => {
          let settled = false;
          const posting = postPedido(baseUrl, payload({ producto: 'BIDÓN' }, 20), 20)
            .finally(() => { settled = true; });
          await new Promise(resolve => setTimeout(resolve, 80));
          assert.equal(settled, false);
          await writer.query('COMMIT');
          const result = await posting;
          assert.equal(result.status, 409);
          assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
        });
      } finally {
        await writer.query('ROLLBACK').catch(() => {});
        writer.release();
      }
    });

    await t.test('POST que gana conserva identidad estable y el rename espera', async () => {
      await resetData(pool);
      await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL),(56,1,'Otro',true,NULL,NULL)");
      const productLocked = deferred();
      const continuePost = deferred();
      const instrumentedPool = {
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql, params) {
              const result = await client.query(sql, params);
              if (String(sql).includes('FROM productos') && String(sql).includes('FOR SHARE')) {
                productLocked.resolve();
                await continuePost.promise;
              }
              return result;
            },
            release(error) { client.release(error); },
          };
        },
      };
      const app = buildApp(pool, { pool: instrumentedPool });
      await withServer(app, async baseUrl => {
        const posting = postPedido(baseUrl, payload({ producto: 'BIDÓN' }, 21), 21);
        await productLocked.promise;
        const writer = await pool.connect();
        try {
          let writerSettled = false;
          const renaming = (async () => {
            await writer.query('BEGIN');
            const rows = async (sql, params = []) => (await writer.query(sql, params)).rows;
            await lockProductIdentityNamespaces(rows, { empresaId: 1, names: ['Bidón'] });
            await writer.query("UPDATE productos SET nombre = 'bidón' WHERE id = 56");
            await writer.query('COMMIT');
          })().finally(() => { writerSettled = true; });
          await new Promise(resolve => setTimeout(resolve, 80));
          assert.equal(writerSettled, false);
          continuePost.resolve();
          const result = await posting;
          assert.equal(result.status, 200);
          const persisted = await pool.query('SELECT producto_id, producto FROM items_pedido');
          assert.deepEqual(persisted.rows, [{ producto_id: 55, producto: 'Bidón' }]);
          await renaming;
        } finally {
          continuePost.resolve();
          await writer.query('ROLLBACK').catch(() => {});
          writer.release();
        }
      });
    });

    await t.test('mismo nombre en tenants distintos no se bloquea', async () => {
      await resetData(pool);
      await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL),(77,2,'Bidón',true,NULL,NULL)");
      const tenant2 = await pool.connect();
      try {
        await tenant2.query('BEGIN');
        const rows = async (sql, params = []) => (await tenant2.query(sql, params)).rows;
        await lockProductIdentityNamespaces(rows, { empresaId: 2, names: ['Bidón'] });
        const app = buildApp(pool);
        await withServer(app, async baseUrl => {
          const result = await Promise.race([
            postPedido(baseUrl, payload({ producto: 'BIDÓN' }, 22), 22),
            new Promise((_, reject) => setTimeout(() => reject(new Error('bloqueo cross-tenant')), 500)),
          ]);
          assert.equal(result.status, 200);
        });
      } finally {
        await tenant2.query('ROLLBACK');
        tenant2.release();
      }
    });
  });
});

// P0: tenant público, identidad concurrente de punto y orden global.
test('POST /public/pedidos resuelve tenant por canal público y nunca por body', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón 1',true,NULL,NULL),(77,2,'Bidón 2',true,NULL,NULL)");
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      await t.test('slug resuelto gana y body conflictivo falla sin mutación', async () => {
        const body = { ...payload({ producto_id: 77, producto: 'Bidón 2' }, 70), empresa_id: 2 };
        const result = await postPedido(baseUrl, body, 70, { 'x-test-url-query': 'slug=tenant-uno' });
        assert.equal(result.status, 403);
        assert.equal(result.body.code, 'PUBLIC_TENANT_CONFLICT');
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('tenant inexistente falla cerrado antes de mutar', async () => {
        const body = { ...payload({ producto_id: 55, producto: 'Bidón 1' }, 71), empresa_id: 1 };
        const result = await postPedido(baseUrl, body, 71, { 'x-test-url-query': 'slug=no-existe' });
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'PUBLIC_TENANT_UNRESOLVED');
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('slug ambiguo falla cerrado antes de mutar', async () => {
        await pool.query("UPDATE empresas SET landing_slug='tenant-uno' WHERE id=2");
        const body = { ...payload({ producto_id: 55, producto: 'Bidón 1' }, 72), empresa_id: 1 };
        const result = await postPedido(baseUrl, body, 72, { 'x-test-url-query': 'slug=tenant-uno' });
        assert.equal(result.status, 409);
        assert.equal(result.body.code, 'PUBLIC_TENANT_AMBIGUOUS');
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('X-Forwarded-Host de víctima no resuelve tenant sin canal explícito', async () => {
        await pool.query("UPDATE empresas SET landing_slug='tenant-dos' WHERE id=2");
        const body = { ...payload({ producto_id: 77, producto: 'Bidón 2' }, 73), empresa_id: 2 };
        const result = await postPedido(baseUrl, body, 73, {
          'x-test-url-query': '',
          'x-forwarded-host': 'dos.example.test',
          host: 'uno.example.test',
        });
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'PUBLIC_TENANT_UNRESOLVED');
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
      });

      await t.test('empresa pública vencida falla cerrado antes de mutar', async () => {
        await pool.query("UPDATE empresas SET plan_vencimiento = NOW() - INTERVAL '1 minute' WHERE id=1");
        const body = { ...payload({ producto_id: 55, producto: 'Bidón 1' }, 75), empresa_id: 1 };
        const result = await postPedido(baseUrl, body, 75, { 'x-test-url-query': 'empresa_id=1' });
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'PUBLIC_TENANT_UNRESOLVED');
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
        await pool.query('UPDATE empresas SET plan_vencimiento = NULL WHERE id=1');
      });

      await t.test('canal explícito válido gana aunque X-Forwarded-Host apunte a otra empresa', async () => {
        const body = { ...payload({ producto_id: 55, producto: 'Bidón 1' }, 74), empresa_id: 1 };
        const result = await postPedido(baseUrl, body, 74, {
          'x-test-url-query': 'slug=tenant-uno&empresa_id=1',
          'x-forwarded-host': 'dos.example.test',
        });
        assert.equal(result.status, 200);
        const persisted = await pool.query('SELECT empresa_id FROM pedidos');
        assert.deepEqual(persisted.rows, [{ empresa_id: 1 }]);
      });
    });
  });
});

test('POST /public/pedidos comparte un único punto para submissions concurrentes distintas', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL)");
    const app = buildApp(pool);

    await withServer(app, async baseUrl => {
      const base = {
        ...payload({ producto_id: 55, producto: 'Bidón' }, 73),
        telefono: '351 555-0000',
        direccion: '  Calle Compartida 123  ',
      };
      const [first, second] = await Promise.all([
        postPedido(baseUrl, { ...base, submission_id: 'point-a' }, 73),
        postPedido(baseUrl, { ...base, cliente: 'Otro nombre', telefono: '+54 9 351 555 0000', direccion: 'calle compartida 123', submission_id: 'point-b' }, 74),
      ]);
      assert.deepEqual([first.status, second.status], [200, 200]);
    });

    const points = await pool.query('SELECT id FROM puntos_entrega ORDER BY id');
    const orders = await pool.query('SELECT punto_entrega_id FROM pedidos ORDER BY id');
    assert.equal(points.rowCount, 1);
    assert.equal(orders.rowCount, 2);
    assert.deepEqual(new Set(orders.rows.map(row => row.punto_entrega_id)), new Set([points.rows[0].id]));
  });
});

test('POST /public/pedidos bloquea productos antes del namespace de punto y no toca punto antes', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL)");
    const events = [];
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            const text = String(sql);
            if (text.includes('pg_advisory_xact_lock')) events.push(`lock:${params?.[1] || params?.[0]}`);
            if (text.includes('puntos_entrega')) events.push(`point:${text.trim().split(/\s+/).slice(0, 2).join(' ')}`);
            if (text.includes('FROM productos') && text.includes('FOR SHARE')) events.push('product:resolved');
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { pool: observedPool });
    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, { ...payload({ producto: 'Bidón' }, 75), submission_id: 'order-proof' }, 75);
      assert.equal(result.status, 200);
    });
    const productIndex = events.indexOf('product:resolved');
    const pointIndex = events.findIndex(event => event.startsWith('point:'));
    assert.ok(productIndex >= 0, JSON.stringify(events));
    assert.ok(pointIndex > productIndex, JSON.stringify(events));
    assert.ok(events.slice(productIndex + 1, pointIndex).some(event => event.startsWith('lock:point:')), JSON.stringify(events));
  });
});

test('POST /public/pedidos falla cerrado si el resolver productivo está ausente o devuelve inválido', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL)");
    for (const resolver of [null, async () => null]) {
      const app = buildApp(pool, { resolveEmpresaIdFn: resolver });
      await withServer(app, async baseUrl => {
        const result = await postPedido(baseUrl, payload({ producto_id: 55, producto: 'Bidón' }, 76), 76);
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'PUBLIC_TENANT_UNRESOLVED');
      });
      assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 0 });
    }
  });
});

test('namespace de punto está aislado por tenant para la misma identidad', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón 1',true,NULL,NULL),(77,2,'Bidón 2',true,NULL,NULL)");
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))', [1, 'point:5550000:calle común 10']);
      const app = buildApp(pool);
      await withServer(app, async baseUrl => {
        const body = {
          ...payload({ producto_id: 77, producto: 'Bidón 2' }, 77),
          empresa_id: 2,
          telefono: '3515550000',
          direccion: 'Calle Común 10',
          submission_id: 'tenant-two-point',
        };
        const result = await Promise.race([
          postPedido(baseUrl, body, 77),
          new Promise((_, reject) => setTimeout(() => reject(new Error('bloqueo cross-tenant de punto')), 600)),
        ]);
        assert.equal(result.status, 200);
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    const points = await pool.query('SELECT empresa_id FROM puntos_entrega ORDER BY empresa_id');
    assert.deepEqual(points.rows, [{ empresa_id: 2 }]);
  });
});

test('rollback posterior al punto conserva un punto preexistente sin corrupción', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55,1,'Bidón',true,NULL,NULL)");
    await pool.query(`INSERT INTO puntos_entrega
      (empresa_id, cliente, telefono, telefono_normalizado, direccion, notas)
      VALUES (1, 'Original', '3515550000', '3515550000', 'Calle Persistente 1', 'sin cambios')`);
    const failingPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            if (String(sql).includes('INSERT INTO pedidos')) throw new Error('controlled failure after existing point');
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { pool: failingPool });
    await withServer(app, async baseUrl => {
      const body = {
        ...payload({ producto_id: 55, producto: 'Bidón' }, 78),
        telefono: '+54 9 351 555 0000',
        direccion: ' calle persistente 1 ',
        submission_id: 'existing-point-rollback',
      };
      const result = await postPedido(baseUrl, body, 78);
      assert.equal(result.status, 500);
    });
    const points = await pool.query('SELECT cliente, notas FROM puntos_entrega');
    assert.deepEqual(points.rows, [{ cliente: 'Original', notas: 'sin cambios' }]);
    assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0, promociones: 0, puntos_entrega: 1 });
  });
});

test('POST /public/pedidos limita referral VECINO al tenant y a una cadena pedido-punto íntegra', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const app = buildApp(pool);

    async function seedOrigin({ pedidoId, pedidoEmpresaId, puntoId, puntoEmpresaId }) {
      await resetData(pool);
      await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo, deleted_at, promo_config) VALUES (55, 1, 'Bidón', true, NULL, NULL)");
      await pool.query(
        `INSERT INTO puntos_entrega (id, empresa_id, cliente, telefono, telefono_normalizado, direccion)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [puntoId, puntoEmpresaId, `Padrino ${puntoId}`, `351900${puntoId}`, `Origen ${puntoId}`]
      );
      await pool.query(
        `INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, estado, monto, tracking_token)
         VALUES ($1, $2, $3, NOW(), 'entregado', 100, $4)`,
        [pedidoId, pedidoEmpresaId, puntoId, `origin-${pedidoId}`]
      );
    }

    await withServer(app, async baseUrl => {
      await t.test('same-tenant válido conserva referido_por_id', async () => {
        await seedOrigin({ pedidoId: 500, pedidoEmpresaId: 1, puntoId: 10, puntoEmpresaId: 1 });
        const result = await postPedido(baseUrl, {
          ...payload({ producto_id: 55, producto: 'Bidón' }, 501),
          referral_code: 'VECINO-500',
        }, 51);
        assert.equal(result.status, 200);
        const row = await pool.query('SELECT referido_por_id FROM pedidos WHERE id = $1', [result.body.pedido.id]);
        assert.equal(Number(row.rows[0].referido_por_id), 10);
      });

      await t.test('pedido origen cross-tenant se ignora sin premio ajeno', async () => {
        await seedOrigin({ pedidoId: 600, pedidoEmpresaId: 2, puntoId: 20, puntoEmpresaId: 2 });
        const result = await postPedido(baseUrl, {
          ...payload({ producto_id: 55, producto: 'Bidón' }, 601),
          referral_code: 'VECINO-600',
        }, 52);
        assert.equal(result.status, 200);
        const row = await pool.query('SELECT referido_por_id FROM pedidos WHERE id = $1', [result.body.pedido.id]);
        assert.equal(row.rows[0].referido_por_id, null);
        const rewards = await pool.query('SELECT COUNT(*)::int AS count FROM cliente_recompensas');
        assert.equal(rewards.rows[0].count, 0);
      });

      await t.test('histórico corrupto pedido tenant A-punto tenant B se ignora sin premio ajeno', async () => {
        await seedOrigin({ pedidoId: 700, pedidoEmpresaId: 1, puntoId: 20, puntoEmpresaId: 2 });
        const result = await postPedido(baseUrl, {
          ...payload({ producto_id: 55, producto: 'Bidón' }, 701),
          referral_code: 'VECINO-700',
        }, 53);
        assert.equal(result.status, 200);
        const row = await pool.query('SELECT referido_por_id FROM pedidos WHERE id = $1', [result.body.pedido.id]);
        assert.equal(row.rows[0].referido_por_id, null);
        const rewards = await pool.query('SELECT COUNT(*)::int AS count FROM cliente_recompensas');
        assert.equal(rewards.rows[0].count, 0);
      });
    });
  });
});
