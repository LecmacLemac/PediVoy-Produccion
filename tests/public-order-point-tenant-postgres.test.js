import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

import { createPublicLandingRouter } from '../src/routes/publicLanding.js';
import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';
import { createPublicClientAppRouter } from '../src/routes/publicClientApp.js';
import { createTrackingPublicRouter } from '../src/trackingPublic.js';
import { withTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);

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
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      nombre text,
      logo_url text,
      landing_slug text,
      landing_domain text,
      plan_estado text DEFAULT 'active',
      plan_vencimiento timestamptz
    );
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      cliente text,
      telefono text,
      telefono_normalizado text,
      email text,
      direccion text,
      ciudad text,
      provincia text,
      pais text,
      notas text,
      latitud numeric,
      longitud numeric,
      zona_id integer
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      punto_entrega_id integer,
      fecha timestamptz DEFAULT now(),
      fecha_entrega timestamptz,
      estado text,
      chofer_id integer,
      metodo_pago text,
      monto numeric,
      notas text,
      tracking_token text
    );
    CREATE TABLE choferes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      nombre text,
      telefono text
    );
    CREATE TABLE items_pedido (
      id integer PRIMARY KEY,
      pedido_id integer NOT NULL,
      producto text,
      producto_id integer,
      cantidad numeric,
      precio_unitario numeric
    );
    CREATE TABLE pedido_track_points (
      id integer PRIMARY KEY,
      pedido_id integer NOT NULL,
      latitud numeric,
      longitud numeric,
      timestamp timestamptz
    );
    CREATE TABLE pedido_pagos (
      id integer PRIMARY KEY,
      pedido_id integer NOT NULL,
      empresa_id integer NOT NULL,
      estado text,
      updated_at timestamptz
    );
    INSERT INTO empresas (id, nombre, landing_slug) VALUES
      (1, 'Uno', 'uno'),
      (2, 'Dos', 'dos');
    INSERT INTO puntos_entrega (id, empresa_id, cliente, telefono, telefono_normalizado, email, direccion) VALUES
      (10, 1, 'Cliente A', '3531111111', '3531111111', 'shared@example.com', 'A'),
      (20, 2, 'Cliente B', '3531111111', '3531111111', 'shared@example.com', 'B');
    INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, estado, metodo_pago, monto, notas, tracking_token) VALUES
      (99, 1, 10, '2026-09-19T10:00:00Z', 'entregado', 'efectivo', 90, 'Nota vieja A', 'older-a'),
      (100, 1, 10, '2026-09-20T10:00:00Z', 'pendiente', 'efectivo', 100, 'Nota intermedia A', 'valid-a'),
      (102, 1, 10, '2026-09-22T10:00:00Z', 'pendiente', 'efectivo', 102, 'Departamento 4 B', 'latest-a'),
      (101, 1, 20, '2026-09-23T10:00:00Z', 'pendiente', 'efectivo', 101, 'Secreto corrupto A-B', 'corrupt-a-to-b'),
      (200, 2, 20, '2026-09-21T10:00:00Z', 'pendiente', 'efectivo', 200, 'Torre B', 'valid-b'),
      (201, 2, 10, '2026-09-24T10:00:00Z', 'pendiente', 'efectivo', 201, 'Secreto corrupto B-A', 'corrupt-b-to-a');
    INSERT INTO items_pedido (id, pedido_id, producto, producto_id, cantidad, precio_unitario) VALUES
      (1, 100, 'Válido A', 1, 1, 100),
      (2, 101, 'Ajeno B vía A', 2, 1, 101),
      (3, 200, 'Válido B', 3, 1, 200),
      (4, 201, 'Ajeno A vía B', 4, 1, 201);
  `);
}

function buildApp(pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const runTransaction = work => withTransaction(work, { pool, maxRetries: 0, retryDelayMs: 0 });
  app.use('/api/public', createPublicLandingRouter({ query, withTransaction: runTransaction }));
  app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction: runTransaction }));
  app.use('/api/public/app', createPublicClientAppRouter({ query, pool: null }));
  app.use('/api/public', createTrackingPublicRouter({ queryFn: query }));
  return app;
}

function clientCookie(empresaId) {
  const token = jwt.sign({
    type: 'client',
    empresa_id: empresaId,
    telefono: '3531111111',
    telefono_norm: '3531111111',
    email: 'shared@example.com',
    risk_fp: null,
  }, process.env.JWT_SECRET || 'dev');
  return `client_token=${token}`;
}

async function json(base, requestPath, options = {}) {
  const response = await fetch(base + requestPath, options);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function contactJson(base, empresaId, telefono) {
  return json(base, `/public/contacto?empresa_id=${empresaId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefono }),
  });
}

test('PostgreSQL real: identidad única elige el último pedido sólo dentro del punto resuelto', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const apiA = await json(base, '/api/public/pedidos/ultimo?empresa_id=1&telefono=3531111111');
      assert.equal(apiA.status, 200);
      assert.equal(apiA.body.id, 102);

      const apiB = await json(base, '/api/public/pedidos/ultimo?empresa_id=2&telefono=3531111111');
      assert.equal(apiB.status, 200);
      assert.equal(apiB.body.id, 200);

      const legacyA = await json(base, '/public/ultimo-pedido?empresa_id=1&telefono=3531111111');
      assert.equal(legacyA.status, 200);
      assert.equal(legacyA.body.pedido.id, 102);

      const legacyB = await json(base, '/public/ultimo-pedido?empresa_id=2&telefono=3531111111');
      assert.equal(legacyB.status, 200);
      assert.equal(legacyB.body.pedido.id, 200);
    });
  });
});

test('PostgreSQL real: contacto elige el punto del pedido más reciente; últimos pedidos siguen fail-closed', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO puntos_entrega
        (id, empresa_id, cliente, telefono, telefono_normalizado, email, direccion, ciudad, notas, latitud, longitud)
      VALUES (11, 1, 'Cliente reciente', '3531111111', '3531111111', 'otro@example.com', 'Dirección reciente', 'Villa María', 'nota interna', -32.4, -63.2);
      INSERT INTO pedidos
        (id, empresa_id, punto_entrega_id, fecha, estado, metodo_pago, monto, notas, tracking_token)
      VALUES (103, 1, 11, '2026-09-25T10:00:00Z', 'pendiente', 'efectivo', 999, 'Departamento 7 C', 'secret');
    `);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const partial = await contactJson(base, 1, '1');
      assert.equal(partial.status, 400);
      assert.doesNotMatch(JSON.stringify(partial.body), /Cliente reciente|Dirección reciente|nota interna|otro@example.com|999|secret/i);

      const contacto = await contactJson(base, 1, '3531111111');
      assert.equal(contacto.status, 200);
      assert.deepEqual(contacto.body, {
        ok: true,
        found: true,
        contacto: {
          id: 11,
          cliente: 'Cliente R.',
          direccion: 'Dirección reciente',
          ciudad: 'Villa María',
          provincia: null,
          pais: null,
          notas: 'Departamento 7 C',
        },
      });
      assert.match(String(contacto.headers.get('cache-control') || ''), /no-store/);
      assert.doesNotMatch(JSON.stringify(contacto.body), /Cliente reciente|nota interna|otro@example.com|999|secret|latitud|longitud|zona_id/i);

      for (const pathName of [
        '/public/ultimo-pedido?empresa_id=1&telefono=3531111111',
        '/api/public/pedidos/ultimo?empresa_id=1&telefono=3531111111',
      ]) {
        const result = await json(base, pathName);
        assert.equal(result.status, 409, pathName);
        assert.match(JSON.stringify(result.body), /ambigua|ambiguo/i);
        assert.doesNotMatch(JSON.stringify(result.body), /Cliente reciente|Dirección reciente|999|103/);
      }
    });
  });
});

test('PostgreSQL real: contacto recupera sólo la nota del último pedido del punto y tenant seleccionados', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO puntos_entrega
        (id, empresa_id, cliente, telefono, telefono_normalizado, direccion, notas)
      VALUES
        (12, 1, 'Sin pedidos', '3532222222', '3532222222', 'Calle 12', 'Nota interna no pública');
    `);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const tenantA = await contactJson(base, 1, '3531111111');
      assert.equal(tenantA.status, 200);
      assert.equal(tenantA.body.contacto.id, 10);
      assert.equal(tenantA.body.contacto.notas, 'Departamento 4 B');
      assert.doesNotMatch(JSON.stringify(tenantA.body), /Torre B|Secreto corrupto|Nota vieja A|Nota intermedia A/);

      await pool.query(`
        INSERT INTO pedidos
          (id, empresa_id, punto_entrega_id, fecha, estado, metodo_pago, monto, notas, tracking_token)
        VALUES
          (104, 1, 10, '2026-09-26T10:00:00Z', 'pendiente', 'efectivo', 110, '', 'latest-empty-a')
      `);
      const clearedLatest = await contactJson(base, 1, '3531111111');
      assert.equal(clearedLatest.status, 200);
      assert.equal(clearedLatest.body.contacto.notas, '');
      assert.doesNotMatch(JSON.stringify(clearedLatest.body), /Departamento 4 B|Nota vieja A|Nota intermedia A/);

      const tenantB = await contactJson(base, 2, '3531111111');
      assert.equal(tenantB.status, 200);
      assert.equal(tenantB.body.contacto.id, 20);
      assert.equal(tenantB.body.contacto.notas, 'Torre B');
      assert.doesNotMatch(JSON.stringify(tenantB.body), /Departamento 4 B|Secreto corrupto/);

      const withoutOrders = await contactJson(base, 1, '3532222222');
      assert.equal(withoutOrders.status, 200);
      assert.equal(withoutOrders.body.contacto.id, 12);
      assert.equal(withoutOrders.body.contacto.notas, null);
      assert.doesNotMatch(JSON.stringify(withoutOrders.body), /Nota interna no pública/);
    });
  });
});

test('PostgreSQL real: limita consultas repetidas de contacto por IP y empresa', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const previousMax = process.env.PUBLIC_CONTACT_RATE_LIMIT_MAX;
    const previousWindow = process.env.PUBLIC_CONTACT_RATE_LIMIT_WINDOW_MS;
    process.env.PUBLIC_CONTACT_RATE_LIMIT_MAX = '1';
    process.env.PUBLIC_CONTACT_RATE_LIMIT_WINDOW_MS = '60000';
    try {
      const app = buildApp(pool);
      await withServer(app, async base => {
        const first = await contactJson(base, 1, '3531111111');
        assert.equal(first.status, 200);
        const second = await contactJson(base, 1, '3531111111');
        assert.equal(second.status, 429);
        assert.equal(second.body.code, 'PUBLIC_CONTACT_RATE_LIMITED');
      });
    } finally {
      if (previousMax === undefined) delete process.env.PUBLIC_CONTACT_RATE_LIMIT_MAX;
      else process.env.PUBLIC_CONTACT_RATE_LIMIT_MAX = previousMax;
      if (previousWindow === undefined) delete process.env.PUBLIC_CONTACT_RATE_LIMIT_WINDOW_MS;
      else process.env.PUBLIC_CONTACT_RATE_LIMIT_WINDOW_MS = previousWindow;
    }
  });
});

test('PostgreSQL real: lista y detalle app no cruzan pedido-punto con teléfonos e emails coincidentes', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const app = buildApp(pool);
    await withServer(app, async base => {
      for (const [empresaId, validId, corruptOwnTenantId, corruptOtherTenantId] of [
        [1, 100, 101, 201],
        [2, 200, 201, 101],
      ]) {
        const headers = { cookie: clientCookie(empresaId) };
        const orders = await json(base, `/api/public/app/orders?empresa_id=${empresaId}`, { headers });
        assert.equal(orders.status, 200);
        assert.deepEqual(orders.body.orders.map(row => Number(row.id)),
          empresaId === 1 ? [102, 100, 99] : [validId]);

        const valid = await json(base, `/api/public/app/orders/${validId}/items?empresa_id=${empresaId}`, { headers });
        assert.equal(valid.status, 200);
        assert.equal(valid.body.items.length, 1);

        for (const pedidoId of [corruptOwnTenantId, corruptOtherTenantId]) {
          const detail = await json(base, `/api/public/app/orders/${pedidoId}/items?empresa_id=${empresaId}`, { headers });
          assert.equal(detail.status, 404, `tenant ${empresaId}, pedido ${pedidoId}`);
          assert.equal(Object.hasOwn(detail.body, 'items'), false);
        }
      }
    });
  });
});

test('PostgreSQL real: tracking con pedido A y punto B falla cerrado sin PII ajena', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await json(base, '/api/public/tracking/corrupt-a-to-b');
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'Pedido no encontrado' });
      assert.doesNotMatch(JSON.stringify(result.body), /Cliente B|3531111111|latitud|longitud/i);
    });
  });
});

test('PostgreSQL real: tracking con pedido A y chofer B falla cerrado sin PII ajena', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO choferes (id, empresa_id, nombre, telefono)
      VALUES (20, 2, 'Chofer B secreto', '5493539999999');
      UPDATE pedidos SET chofer_id = 20 WHERE id = 100;
    `);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await json(base, '/api/public/tracking/valid-a');
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'Pedido no encontrado' });
      assert.doesNotMatch(JSON.stringify(result.body), /Chofer B secreto|5493539999999/i);
    });
  });
});

test('PostgreSQL real: tracking falla cerrado si falta la empresa dueña del pedido', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query('DELETE FROM empresas WHERE id = 1');
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await json(base, '/api/public/tracking/valid-a');
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'Pedido no encontrado' });
    });
  });
});

test('PostgreSQL real: tracking con punto y chofer B usando el mismo ID falla cerrado', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO choferes (id, empresa_id, nombre, telefono)
      VALUES (20, 2, 'Chofer B secreto', '5493539999999');
      UPDATE pedidos SET chofer_id = 20 WHERE id = 101;
    `);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await json(base, '/api/public/tracking/corrupt-a-to-b');
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: 'Pedido no encontrado' });
      assert.doesNotMatch(JSON.stringify(result.body), /Cliente B|Chofer B secreto|3531111111|5493539999999/i);
    });
  });
});

test('PostgreSQL real: tracking permite chofer NULL legítimo sin PII ajena', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await json(base, '/api/public/tracking/valid-a');
      assert.equal(result.status, 200);
      assert.equal(result.body.pedido.cliente, 'Cliente A');
      assert.equal(result.body.pedido.direccion, 'A');
      assert.equal(result.body.pedido.chofer_nombre, null);
      assert.equal(result.body.pedido.chofer_tel, null);
      assert.equal(result.body.driverLocation.location_status, 'sin_ubicacion');
      assert.doesNotMatch(JSON.stringify(result.body), /Cliente B|Chofer B secreto|5493539999999/i);
    });
  });
});

test('PostgreSQL real: tracking válido conserva estado, forma, chofer, items y ubicación', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await pool.query(`
      INSERT INTO choferes (id, empresa_id, nombre, telefono)
      VALUES (10, 1, 'Chofer A', '5493531111111');
      UPDATE pedidos SET chofer_id = 10, estado = 'en_camino' WHERE id = 100;
      INSERT INTO pedido_track_points (id, pedido_id, latitud, longitud, timestamp)
      VALUES (1, 100, -32.4, -63.2, NOW());
      INSERT INTO pedido_pagos (id, pedido_id, empresa_id, estado, updated_at)
      VALUES (1, 100, 1, 'pendiente', NOW());
    `);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const result = await json(base, '/api/public/tracking/valid-a');
      assert.equal(result.status, 200);
      assert.equal(result.body.pedido.estado, 'en_camino');
      assert.equal(result.body.pedido.cliente, 'Cliente A');
      assert.equal(result.body.pedido.chofer_nombre, 'Chofer A');
      assert.equal(result.body.pedido.chofer_tel, '5493531111111');
      assert.equal(result.body.pedido.items[0].producto, 'Válido A');
      assert.equal(result.body.pedido.pago_estado, 'pendiente');
      assert.equal(result.body.driverLocation.latitud, '-32.4');
      assert.equal(result.body.driverLocation.longitud, '-63.2');
      assert.equal(result.body.driverLocation.location_status, 'en_vivo');
    });
  });
});

test('inventario estructural: todos los JOIN públicos pedidos-puntos cierran la cadena tenant', () => {
  const expected = new Map([
    ['src/routes/publicClientApp.js', 2],
    ['src/routes/publicLanding.js', 1],
    ['src/routes/publicLegacyCatalog.js', 1],
    ['src/routes/publicLegacyCreatePedido.js', 2],
    ['src/routes/publicLegacyPedidos.js', 2],
    ['src/trackingPublic.js', 1],
  ]);
  const actual = new Map();
  const routeDir = path.join(root, 'src/routes');
  const publicRouterFiles = fs.readdirSync(routeDir)
    .filter(name => /^public.*\.js$/.test(name))
    .sort()
    .map(name => `src/routes/${name}`);
  const candidates = [...publicRouterFiles, 'src/trackingPublic.js'];
  for (const relative of candidates) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const sqlBlocks = [...source.matchAll(/`([\s\S]*?)`/g)]
      .map(match => match[1])
      .filter(sql => /\bpedidos\b/i.test(sql) && /\bpuntos_entrega\b/i.test(sql) && /\bJOIN\b/i.test(sql));
    if (sqlBlocks.length) actual.set(relative, sqlBlocks.length);
    for (const [index, sql] of sqlBlocks.entries()) {
      assert.match(
        sql,
        /(?:pe\.empresa_id\s*=\s*p\.empresa_id|p\.empresa_id\s*=\s*pe\.empresa_id)/i,
        `${relative} bloque ${index + 1} sin igualdad tenant pedido-punto:\n${sql}`
      );
      if (relative === 'src/trackingPublic.js') {
        assert.match(sql, /c\.empresa_id\s*=\s*p\.empresa_id/i);
        assert.match(sql, /p\.chofer_id\s+IS\s+NULL\s+OR\s+c\.id\s+IS\s+NOT\s+NULL/i);
        assert.match(sql, /JOIN\s+empresas\s+e\s+ON\s+e\.id\s*=\s*p\.empresa_id/i);
      }
    }
  }
  assert.deepEqual(actual, expected);
});

test('recompensa referral post-entrega revalida pedido, vecino y padrino dentro del tenant', () => {
  const source = fs.readFileSync(path.join(root, 'src/estrategias.js'), 'utf8');
  const blocks = [...source.matchAll(/`([\s\S]*?)`/g)]
    .map(match => match[1])
    .filter(sql => /p\.referido_por_id/i.test(sql));
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /(?:vecino|pe)\.empresa_id\s*=\s*p\.empresa_id/i);
  assert.match(blocks[0], /padrino\.empresa_id\s*=\s*p\.empresa_id/i);
  assert.match(blocks[0], /p\.empresa_id\s*=\s*\$2/i);
  assert.match(blocks[0], /(?:vecino|pe)\.empresa_id\s*=\s*\$2/i);
  assert.match(blocks[0], /padrino\.empresa_id\s*=\s*\$2/i);
  assert.match(source, /productos[\s\S]*empresa_id\s*=\s*\$2[\s\S]*deleted_at IS NULL[\s\S]*activo/i);
});
