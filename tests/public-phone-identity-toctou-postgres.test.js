import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';
import { createPublicLandingRouter } from '../src/routes/publicLanding.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { lockGeneralPhoneIdentity } from '../src/services/deliveryPointIdentity.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const PHONE = '3534277739';

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      nombre text,
      landing_slug text,
      landing_domain text,
      plan_estado text DEFAULT 'active',
      plan_vencimiento timestamptz,
      config_operativa jsonb DEFAULT '{}'::jsonb
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
      fecha timestamptz DEFAULT now(),
      estado text,
      monto numeric,
      tracking_token text
    );
    INSERT INTO empresas (id, nombre, landing_slug) VALUES
      (1, 'Uno', 'uno'),
      (2, 'Dos', 'dos');
    INSERT INTO puntos_entrega
      (id, empresa_id, cliente, telefono, telefono_normalizado, direccion)
    VALUES
      (10, 1, 'Original', '${PHONE}', '${PHONE}', 'Calle original'),
      (20, 2, 'Otro tenant', '${PHONE}', '${PHONE}', 'Calle ajena');
    INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, estado, monto, tracking_token)
    VALUES
      (100, 1, 10, '2026-09-20T10:00:00Z', 'pendiente', 100, 'original'),
      (101, 1, 10, '2026-09-21T10:00:00Z', 'entregado', 101, 'latest'),
      (200, 2, 20, '2026-09-22T10:00:00Z', 'pendiente', 200, 'other');
  `);
}

function buildApp(pool, { withTransaction } = {}) {
  const app = express();
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const runTransaction = withTransaction || (work => dbWithTransaction(work, {
    pool,
    maxRetries: 0,
    retryDelayMs: 0,
  }));
  app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction: runTransaction }));
  app.use('/api/public', createPublicLandingRouter({ query, withTransaction: runTransaction }));
  return app;
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

async function requestJson(base, path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

async function beginDuplicateWriter(pool, { empresaId = 1, cliente = 'Duplicado' } = {}) {
  const client = await pool.connect();
  await client.query('BEGIN');
  const query = async (sql, params = []) => (await client.query(sql, params)).rows;
  await lockGeneralPhoneIdentity(query, {
    normalizePhoneFn: value => value,
    telefono: PHONE,
  });
  await client.query(
    `INSERT INTO puntos_entrega
       (empresa_id, cliente, telefono, telefono_normalizado, direccion)
     VALUES ($1, $2, $3, $3, 'Calle duplicada')`,
    [empresaId, cliente, PHONE]
  );
  return client;
}

function readerBarrierTransaction(pool) {
  let resolveRead;
  let releaseRead;
  const readResolved = new Promise(resolve => { resolveRead = resolve; });
  const mayContinue = new Promise(resolve => { releaseRead = resolve; });
  let paused = false;
  return {
    readResolved,
    releaseRead,
    withTransaction: work => dbWithTransaction(async txQuery => work(async (sql, params = []) => {
      const rows = await txQuery(sql, params);
      if (!paused && /FROM puntos_entrega[\s\S]*LIMIT 2/i.test(sql)) {
        paused = true;
        resolveRead();
        await mayContinue;
      }
      return rows;
    }), { pool, maxRetries: 0, retryDelayMs: 0 }),
  };
}

async function assertPending(promise, waitMs = 100) {
  const state = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('pending'), waitMs)),
  ]);
  assert.equal(state, 'pending');
}

const endpoints = [
  {
    name: 'contacto',
    path: `/public/contacto?empresa_id=1&telefono=${PHONE}`,
    assertUnique(response) {
      assert.equal(response.status, 200);
      assert.equal(response.body.found, true);
      assert.equal(response.body.contacto.id, 10);
    },
  },
  {
    name: 'último pedido legacy',
    path: `/public/ultimo-pedido?empresa_id=1&telefono=${PHONE}`,
    assertUnique(response) {
      assert.equal(response.status, 200);
      assert.equal(response.body.pedido.id, 101);
    },
  },
  {
    name: 'último pedido legacy con contacto_id concordante',
    path: `/public/ultimo-pedido?empresa_id=1&telefono=${PHONE}&contacto_id=10`,
    assertUnique(response) {
      assert.equal(response.status, 200);
      assert.equal(response.body.pedido.id, 101);
    },
  },
  {
    name: 'último pedido landing',
    path: `/api/public/pedidos/ultimo?empresa_id=1&telefono=${PHONE}`,
    assertUnique(response) {
      assert.equal(response.status, 200);
      assert.equal(response.body.id, 101);
    },
  },
];

for (const endpoint of endpoints) {
  test(`PostgreSQL real: ${endpoint.name}, writer primero espera lock y lector relee ambigüedad`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await fixture(pool);
      const writer = await beginDuplicateWriter(pool);
      try {
        await withServer(buildApp(pool), async base => {
          const responsePromise = requestJson(base, endpoint.path);
          await assertPending(responsePromise);
          await writer.query('COMMIT');
          const response = await responsePromise;
          assert.equal(response.status, 409);
          assert.equal(response.body.code, 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS');
          assert.doesNotMatch(JSON.stringify(response.body), /Original|Duplicado|Calle|101/);
        });
      } finally {
        writer.release();
      }
    });
  });

  test(`PostgreSQL real: ${endpoint.name}, lector primero mantiene snapshot serial antes del writer`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await fixture(pool);
      const barrier = readerBarrierTransaction(pool);
      await withServer(buildApp(pool, { withTransaction: barrier.withTransaction }), async base => {
        const responsePromise = requestJson(base, endpoint.path);
        await barrier.readResolved;
        const writerPromise = beginDuplicateWriter(pool);
        await assertPending(writerPromise);
        barrier.releaseRead();
        const response = await responsePromise;
        endpoint.assertUnique(response);
        const writer = await writerPromise;
        await writer.query('COMMIT');
        writer.release();
      });
    });
  });
}

for (const endpoint of endpoints) {
  test(`PostgreSQL real: ${endpoint.name} coordina writer de otro tenant sin mezclar datos`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await fixture(pool);
      const writer = await beginDuplicateWriter(pool, { empresaId: 2, cliente: 'Duplicado tenant dos' });
      try {
        await withServer(buildApp(pool), async base => {
          const responsePromise = requestJson(base, endpoint.path);
          await assertPending(responsePromise);
          await writer.query('COMMIT');
          const response = await responsePromise;
          endpoint.assertUnique(response);
          assert.doesNotMatch(JSON.stringify(response.body), /Otro tenant|Duplicado tenant dos|200/);
        });
      } finally {
        writer.release();
      }
    });
  });
}

test('PostgreSQL real: contacto_id es sólo concordancia opcional de la identidad telefónica canónica', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withServer(buildApp(pool), async base => {
      const matching = await requestJson(base, `/public/ultimo-pedido?empresa_id=1&telefono=${PHONE}&contacto_id=10`);
      assert.equal(matching.status, 200);
      assert.equal(matching.body.pedido.id, 101);
      assert.equal(matching.body.pedido.tracking_url, '/pedidos/seguimiento.html?t=latest');
      assert.equal(Object.hasOwn(matching.body.pedido, 'tracking_token'), false);

      for (const contactoId of ['20', '11', '0', '-1', '10.0', '10x', '9007199254740992']) {
        const response = await requestJson(base,
          `/public/ultimo-pedido?empresa_id=1&telefono=${PHONE}&contacto_id=${encodeURIComponent(contactoId)}`);
        assert.ok([400, 403].includes(response.status), contactoId);
        assert.doesNotMatch(JSON.stringify(response.body), /latest|original|other|pedido|tracking/i);
      }
      const repeated = await requestJson(base,
        `/public/ultimo-pedido?empresa_id=1&telefono=${PHONE}&contacto_id=10&contacto_id=10`);
      assert.equal(repeated.status, 400);
      assert.equal(repeated.body.code, 'PUBLIC_CONTACT_ID_INVALID');

      const withoutId = await requestJson(base, `/public/ultimo-pedido?empresa_id=1&telefono=${PHONE}`);
      assert.equal(withoutId.status, 200);
      assert.equal(withoutId.body.pedido.id, 101);
      assert.equal(Object.hasOwn(withoutId.body.pedido, 'tracking_token'), false);
    });
  });
});

test('PostgreSQL real: cero identidad conserva contrato en los tres endpoints', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withServer(buildApp(pool), async base => {
      const missing = '3530000000';
      const contacto = await requestJson(base, `/public/contacto?empresa_id=1&telefono=${missing}`);
      assert.deepEqual(contacto, { status: 200, body: { ok: true, found: false } });
      const legacy = await requestJson(base, `/public/ultimo-pedido?empresa_id=1&telefono=${missing}`);
      assert.equal(legacy.status, 404);
      assert.match(legacy.body.error, /contacto no encontrado/i);
      const landing = await requestJson(base, `/api/public/pedidos/ultimo?empresa_id=1&telefono=${missing}`);
      assert.deepEqual(landing, { status: 200, body: {} });
    });
  });
});

for (const endpoint of endpoints) {
  test(`${endpoint.name}: COMMIT ambiguo de lectura responde 503 sanitizado`, async () => {
    let workCalls = 0;
    const query = async (sql) => {
      if (/FROM empresas/i.test(sql)) return [{ id: 1 }];
      if (/pg_advisory_xact_lock/i.test(sql)) return [];
      if (/FROM puntos_entrega[\s\S]*LIMIT 2/i.test(sql)) return [{ id: 10, empresa_id: 1 }];
      if (/SELECT id, cliente/i.test(sql)) return [{ id: 10, cliente: 'Privado' }];
      if (/FROM pedidos p/i.test(sql)) return [{ id: 101, estado: 'pendiente', tracking_token: 'private-token' }];
      return [];
    };
    const withTransaction = async work => {
      workCalls += 1;
      await work(query);
      const error = new Error(`detalle SQL privado ${PHONE}`);
      error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
      throw error;
    };
    const app = express();
    app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction }));
    app.use('/api/public', createPublicLandingRouter({ query, withTransaction }));
    await withServer(app, async base => {
      const response = await requestJson(base, endpoint.path);
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'TRANSACTION_OUTCOME_UNKNOWN');
      assert.doesNotMatch(JSON.stringify(response.body), /detalle SQL|private-token|Privado|3534277739/);
    });
    assert.equal(workCalls, 1);
  });
}

for (const endpoint of endpoints) {
  test(`${endpoint.name}: error SQL no expone detalle ni teléfono en respuesta o log`, async t => {
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')));
    const query = async (sql) => {
      if (/FROM empresas/i.test(sql)) return [{ id: 1 }];
      return [];
    };
    const withTransaction = async () => {
      const error = new Error(`syntax error SQL telefono ${PHONE}`);
      error.code = '42601';
      throw error;
    };
    const app = express();
    app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction }));
    app.use('/api/public', createPublicLandingRouter({ query, withTransaction }));
    await withServer(app, async base => {
      const response = await requestJson(base, endpoint.path);
      assert.equal(response.status, 500);
      assert.doesNotMatch(JSON.stringify(response.body), /syntax|SQL|3534277739/);
    });
    assert.doesNotMatch(logs.join('\n'), /syntax|SQL|3534277739/);
  });
}

for (const endpoint of endpoints) {
  test(`PostgreSQL real: ${endpoint.name} revalida plan vigente dentro de la transacción`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await fixture(pool);
      let transactionCalls = 0;
      const withTransaction = async work => {
        transactionCalls += 1;
        await pool.query("UPDATE empresas SET plan_estado = 'suspended' WHERE id = 1");
        return dbWithTransaction(work, { pool, maxRetries: 0, retryDelayMs: 0 });
      };
      await withServer(buildApp(pool, { withTransaction }), async base => {
        const response = await requestJson(base, endpoint.path);
        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'PUBLIC_TENANT_UNRESOLVED');
        assert.doesNotMatch(JSON.stringify(response.body), /Original|latest|101/);
      });
      assert.equal(transactionCalls, 1);
    });
  });
}
