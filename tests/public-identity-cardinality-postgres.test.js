import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

import { createPublicClientAppRouter } from '../src/routes/publicClientApp.js';
import { withTransaction } from '../src/db.js';
import { lockGeneralPhoneIdentity } from '../src/services/deliveryPointIdentity.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const JWT_SECRET = 'public-cardinality-secret';
const PHONE = '3534277739';
const EMAIL = 'cliente@example.com';

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY,
      nombre text,
      landing_slug text,
      landing_domain text,
      plan_estado text DEFAULT 'active',
      plan_vencimiento timestamptz,
      config_integraciones jsonb DEFAULT '{}'::jsonb
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
      notas text,
      email text,
      zona_id integer
    );
    CREATE TABLE pedidos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      punto_entrega_id integer,
      fecha timestamptz DEFAULT now(),
      estado text,
      metodo_pago text,
      monto numeric,
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
    CREATE TABLE wpp_outbox (
      id serial PRIMARY KEY,
      empresa_id integer,
      telefono text,
      mensaje text,
      transport_origin text,
      status text,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO empresas (id, nombre, landing_slug, config_integraciones)
    VALUES (1, 'Uno', 'uno', '{"whatsapp":{"provider":"company","enabled":true}}');
  `);
}

function buildApp(pool) {
  process.env.JWT_SECRET = JWT_SECRET;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  app.use('/api/public/app', createPublicClientAppRouter({ query, pool, withTransaction }));
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

async function requestJson(base, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function insertProfile(pool, { phone = PHONE, email = EMAIL, cliente = 'Cliente', direccion = 'Calle 1' } = {}) {
  const result = await pool.query(
    `INSERT INTO puntos_entrega
       (empresa_id, cliente, nombre, telefono, telefono_normalizado, direccion, email)
     VALUES (1,$1,$1,$2,$2,$3,$4)
     RETURNING id`,
    [cliente, phone, direccion, email]
  );
  return Number(result.rows[0].id);
}

function cookieFrom(result) {
  return result.headers.get('set-cookie')?.split(';')[0] || '';
}

function decodeCookie(cookie) {
  return jwt.verify(cookie.replace(/^client_token=/, ''), JWT_SECRET);
}

async function waitForAdvisoryWaiter(pool, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS c
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'`);
    if (result.rows[0].c > 0) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('PostgreSQL real: OTP exige cardinalidad 0/1/>1 y revalida antes de sesión', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const zero = await requestJson(base, '/api/public/app/auth/request-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE }, headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      assert.equal(zero.status, 200);
      assert.equal(zero.body.ok, true);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM wpp_outbox')).rows[0].c, 1);

      const createdAfterChallenge = await insertProfile(pool);
      const changed = await requestJson(base, '/api/public/app/auth/verify-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE, code: zero.body.debug_code }, headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      assert.equal(changed.status, 409);
      assert.equal(changed.headers.get('set-cookie'), null);

      const one = await requestJson(base, '/api/public/app/auth/request-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE }, headers: { 'x-forwarded-for': '203.0.113.11' },
      });
      assert.equal(one.status, 200);
      const verified = await requestJson(base, '/api/public/app/auth/verify-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE, code: one.body.debug_code }, headers: { 'x-forwarded-for': '203.0.113.11' },
      });
      assert.equal(verified.status, 200);
      assert.equal(verified.body.profile.id, createdAfterChallenge);
      assert.equal(decodeCookie(cookieFrom(verified)).profile_id, createdAfterChallenge);

      await insertProfile(pool, { cliente: 'Duplicado', direccion: 'Calle 2' });
      const beforeOutbox = (await pool.query('SELECT COUNT(*)::int AS c FROM wpp_outbox')).rows[0].c;
      const duplicate = await requestJson(base, '/api/public/app/auth/request-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE }, headers: { 'x-forwarded-for': '203.0.113.12' },
      });
      assert.equal(duplicate.status, 409);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM wpp_outbox')).rows[0].c, beforeOutbox);
    });
  });
});

test('PostgreSQL real: /me usa profile_id canónico y el fallback por email falla ante duplicados', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const firstId = await insertProfile(pool);
    await insertProfile(pool, { phone: '3539999999', cliente: 'Duplicado email', direccion: 'Calle 2' });
    const app = buildApp(pool);
    await withServer(app, async base => {
      const canonical = jwt.sign({
        type: 'client', empresa_id: 1, profile_id: firstId, telefono: PHONE,
        telefono_norm: PHONE, email: EMAIL, risk_fp: null,
      }, JWT_SECRET);
      const me = await requestJson(base, '/api/public/app/me?empresa_id=1', {
        headers: { cookie: `client_token=${canonical}` },
      });
      assert.equal(me.status, 200);
      assert.equal(me.body.profile.id, firstId);

      const legacy = jwt.sign({
        type: 'client', empresa_id: 1, telefono: 'mail', telefono_norm: '', email: EMAIL, risk_fp: null,
      }, JWT_SECRET);
      const ambiguous = await requestJson(base, '/api/public/app/me?empresa_id=1', {
        headers: { cookie: `client_token=${legacy}` },
      });
      assert.equal(ambiguous.status, 409);
      assert.equal(Object.hasOwn(ambiguous.body, 'profile'), false);
    });
  });
});

test('PostgreSQL real: writer que duplica teléfono entre request y verify serializa y hace fallar cerrado', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await insertProfile(pool);
    const app = buildApp(pool);
    await withServer(app, async base => {
      const challenge = await requestJson(base, '/api/public/app/auth/request-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE }, headers: { 'x-forwarded-for': '203.0.113.20' },
      });
      assert.equal(challenge.status, 200);

      const writer = await pool.connect();
      await writer.query('BEGIN');
      const writerQuery = async (sql, params = []) => (await writer.query(sql, params)).rows;
      await lockGeneralPhoneIdentity(writerQuery, { normalizePhoneFn: value => value, telefono: PHONE });
      await writer.query(
        `INSERT INTO puntos_entrega
          (empresa_id, cliente, nombre, telefono, telefono_normalizado, direccion, email)
         VALUES (1,'Duplicado carrera','Duplicado carrera',$1,$1,'Calle carrera','race@example.com')`,
        [PHONE]
      );

      const verifyPromise = requestJson(base, '/api/public/app/auth/verify-otp?empresa_id=1', {
        method: 'POST', body: { telefono: PHONE, code: challenge.body.debug_code }, headers: { 'x-forwarded-for': '203.0.113.20' },
      });
      assert.equal(await waitForAdvisoryWaiter(pool), true);
      await writer.query('COMMIT');
      writer.release();

      const verified = await verifyPromise;
      assert.equal(verified.status, 409);
      assert.equal(verified.headers.get('set-cookie'), null);
    });
  });
});

test('PostgreSQL real: writer de email que gana antes del callback OAuth serializa y bloquea la sesión', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await insertProfile(pool);
    const app = buildApp(pool);
    const originalFetch = globalThis.fetch;
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
    try {
      await withServer(app, async base => {
        globalThis.fetch = async (url, options) => {
          if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
          if (String(url).includes('/token')) return { ok: true, json: async () => ({ access_token: 'access' }) };
          if (String(url).includes('/userinfo')) return { ok: true, json: async () => ({ email: EMAIL, name: 'Cliente' }) };
          throw new Error(`fetch inesperado: ${url}`);
        };
        const start = await requestJson(base, '/api/public/app/auth/google/start?empresa_id=1');
        assert.equal(start.status, 302);
        const state = new URL(start.headers.get('location')).searchParams.get('state');

        const writer = await pool.connect();
        await writer.query('BEGIN');
        await writer.query(
          'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
          [1, `public-client:email:${EMAIL}`]
        );
        await writer.query(
          `INSERT INTO puntos_entrega
            (empresa_id, cliente, nombre, telefono, telefono_normalizado, direccion, email)
           VALUES (1,'Duplicado OAuth','Duplicado OAuth','3539999999','3539999999','Calle OAuth',$1)`,
          [EMAIL]
        );

        const callbackPromise = requestJson(base, `/api/public/app/auth/google/callback?state=${state}&code=ok`);
        assert.equal(await waitForAdvisoryWaiter(pool), true);
        await writer.query('COMMIT');
        writer.release();

        const callback = await callbackPromise;
        assert.equal(callback.status, 409);
        assert.equal(callback.headers.get('set-cookie'), null);
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REDIRECT_URI;
    }
  });
});

test('PostgreSQL real: OAuth callback no crea sesión con email ambiguo y sí liga profile_id único', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const firstId = await insertProfile(pool);
    const app = buildApp(pool);
    const originalFetch = globalThis.fetch;
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost/callback';
    try {
      await withServer(app, async base => {
        async function oauthAttempt() {
          globalThis.fetch = async (url, options) => {
            if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
            if (String(url).includes('/token')) return { ok: true, json: async () => ({ access_token: 'access' }) };
            if (String(url).includes('/userinfo')) return { ok: true, json: async () => ({ email: EMAIL, name: 'Cliente' }) };
            throw new Error(`fetch inesperado: ${url}`);
          };
          const start = await requestJson(base, '/api/public/app/auth/google/start?empresa_id=1');
          assert.equal(start.status, 302);
          const state = new URL(start.headers.get('location')).searchParams.get('state');
          return requestJson(base, `/api/public/app/auth/google/callback?state=${state}&code=ok`);
        }

        const unique = await oauthAttempt();
        assert.equal(unique.status, 302);
        assert.equal(decodeCookie(cookieFrom(unique)).profile_id, firstId);

        await insertProfile(pool, { phone: '3539999999', cliente: 'Duplicado', direccion: 'Calle 2' });
        const ambiguous = await oauthAttempt();
        assert.equal(ambiguous.status, 409);
        assert.equal(ambiguous.headers.get('set-cookie'), null);
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REDIRECT_URI;
    }
  });
});
