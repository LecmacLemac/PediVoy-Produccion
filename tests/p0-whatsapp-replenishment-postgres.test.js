import test from 'node:test';
import assert from 'node:assert/strict';

import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

function fakeClient(from) {
  let listener;
  return {
    replies: [],
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage(_to, text) { this.replies.push(text); },
    async send(body, suffix) {
      this.replies.length = 0;
      await listener({
        from,
        body,
        id: { _serialized: `${suffix}-${Date.now()}-${Math.random()}`, fromMe: false },
      });
      return [...this.replies];
    },
  };
}

async function createSchema(pool) {
  await pool.query(`
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, cliente text, telefono text,
      direccion text, zona_id integer
    );
    CREATE TABLE pedidos (
      id serial PRIMARY KEY, empresa_id integer NOT NULL, punto_entrega_id integer,
      fecha timestamptz DEFAULT now(), fecha_entrega timestamptz, estado text,
      cantidad numeric, cantidad_entregada numeric, monto numeric, metodo_pago text,
      aviso_recibido integer, sats integer, chofer_id integer, zona_id integer,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, nombre text, precio numeric,
      config_activo boolean DEFAULT false, retornable boolean DEFAULT false
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY, pedido_id integer NOT NULL, producto_id integer,
      producto text, cantidad numeric, precio_unitario numeric
    );
  `);
}

async function seed(pool) {
  await pool.query(`
    TRUNCATE items_pedido, pedidos, productos, puntos_entrega RESTART IDENTITY;
    INSERT INTO puntos_entrega VALUES
      (10, 1, 'Uno', '5493511111111', 'Dirección Uno', 101),
      (20, 2, 'Dos', '5493522222222', 'Dirección Dos', 202);
    INSERT INTO productos VALUES
      (101, 1, 'Bidón', 100, false, false),
      (202, 2, 'Bidón', 200, false, false);
    INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, fecha_entrega, estado, cantidad, cantidad_entregada, monto, metodo_pago)
      VALUES
      (1, 1, 10, now() - interval '2 days', now() - interval '2 days', 'entregado', 2, 2, 180, 'efectivo'),
      (2, 2, 20, now() - interval '2 days', now() - interval '2 days', 'entregado', 1, 1, 180, 'transferencia');
    INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario) VALUES
      (1, 101, 'Bidón', 2, 90),
      (2, 202, 'Bidón', 1, 180);
    SELECT setval(pg_get_serial_sequence('pedidos', 'id'), 100, true);
  `);
}

async function holdReplenishmentNamespace(pool, empresaId, puntoId) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
    [empresaId, `whatsapp-reposicion:punto:${puntoId}`],
  );
  return async () => {
    await client.query('COMMIT');
    client.release();
  };
}

async function waitForAdvisoryWaiters(pool, expected, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await pool.query(`
      SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
    `)).rows[0];
    if (row.count >= expected) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('PostgreSQL real: reposición WhatsApp serializa tenant+punto y trata COMMIT ambiguo', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createSchema(pool);
    await seed(pool);
    const { host, port, user, database } = pool.options;
    process.env.DATABASE_URL = `postgresql://${user}@${host}:${port}/${database}`;
    const handlers = await import(`../src/handlers.js?replenishment=${Date.now()}-${Math.random()}`);
    const db = await import('../src/db.js');

    try {
      await t.test('dos mensajes distintos concurrentes crean una reposición y un set de items', async () => {
        await seed(pool);
        const releaseBlocker = await holdReplenishmentNamespace(pool, 1, 10);
        const first = fakeClient('5493511111111@c.us');
        const second = fakeClient('5493511111111@c.us');
        const contextResolver = async () => ({ resolution: 'unique', role: 'cliente', empresa_id: 1, tenantLocked: true });
        handlers.default.start(first, { contextResolver });
        handlers.default.start(second, { contextResolver });

        const firstRun = first.send('necesitas reposición', 'mensaje-a');
        const secondRun = second.send('necesitas reposición', 'mensaje-b');
        const bothWaited = await waitForAdvisoryWaiters(pool, 2);
        await releaseBlocker();
        const replies = (await Promise.all([firstRun, secondRun])).flat();

        assert.equal(bothWaited, true, 'ambos órdenes deben llegar a la barrera advisory real');
        const pending = await pool.query("SELECT id FROM pedidos WHERE empresa_id=1 AND punto_entrega_id=10 AND estado='pendiente'");
        assert.equal(pending.rowCount, 1);
        const items = await pool.query('SELECT producto_id, cantidad FROM items_pedido WHERE pedido_id=$1', [pending.rows[0].id]);
        assert.deepEqual(items.rows, [{ producto_id: 101, cantidad: '2' }]);
        assert.equal(replies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 1);
        assert.equal(replies.filter(reply => /Ya tenés el pedido/.test(reply)).length, 1);
      });

      await t.test('namespace tenant+punto no bloquea ni mezcla otro tenant', async () => {
        await seed(pool);
        const releaseBlocker = await holdReplenishmentNamespace(pool, 1, 10);
        const tenantTwo = fakeClient('5493522222222@c.us');
        handlers.default.start(tenantTwo, {
          contextResolver: async () => ({ resolution: 'unique', role: 'cliente', empresa_id: 2, tenantLocked: true }),
        });
        const result = await Promise.race([
          tenantTwo.send('necesitas reposición', 'tenant-dos'),
          new Promise(resolve => setTimeout(() => resolve('timeout'), 700)),
        ]);
        await releaseBlocker();
        assert.notEqual(result, 'timeout');
        assert.match(result[0], /Reposición Automática Generada/);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM pedidos WHERE empresa_id=1 AND estado='pendiente'")).rows[0].c, 0);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM pedidos WHERE empresa_id=2 AND punto_entrega_id=20 AND estado='pendiente'")).rows[0].c, 1);
      });

      await t.test('COMMIT ambiguo no confirma creación ni duplica al reintentar', async () => {
        await seed(pool);
        const committedThenUnknown = async work => {
          const result = await db.withTransaction(work, { pool });
          if (result?.newId) {
            const error = new Error('commit outcome unknown');
            error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
            throw error;
          }
          return result;
        };
        const first = fakeClient('5493511111111@c.us');
        handlers.default.start(first, {
          contextResolver: async () => ({ resolution: 'unique', role: 'cliente', empresa_id: 1, tenantLocked: true }),
          replenishmentWithTransaction: committedThenUnknown,
        });
        const originalConsoleError = console.error;
        const capturedErrors = [];
        console.error = (...args) => capturedErrors.push(args);
        let unknownReplies;
        try {
          unknownReplies = await first.send('necesitas reposición', 'ambiguo');
        } finally {
          console.error = originalConsoleError;
        }
        assert.equal(capturedErrors.length, 1);
        assert.equal(unknownReplies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 0);
        assert.equal(unknownReplies.filter(reply => /problema procesando/.test(reply)).length, 1);

        const retry = fakeClient('5493511111111@c.us');
        handlers.default.start(retry, {
          contextResolver: async () => ({ resolution: 'unique', role: 'cliente', empresa_id: 1, tenantLocked: true }),
        });
        const retryReplies = await retry.send('necesitas reposición', 'retry-distinto');
        assert.equal(retryReplies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 0);
        assert.equal(retryReplies.filter(reply => /Ya tenés el pedido/.test(reply)).length, 1);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM pedidos WHERE empresa_id=1 AND punto_entrega_id=10 AND estado='pendiente'")).rows[0].c, 1);
        assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM items_pedido WHERE pedido_id > 2')).rows[0].c, 1);
      });
    } finally {
      await db.pool.end();
    }
  });
});
