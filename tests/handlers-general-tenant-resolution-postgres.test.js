import test from 'node:test';
import assert from 'node:assert/strict';

import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
import {
  deliveryPointIdentity,
  lockDeliveryPointIdentity,
} from '../src/services/deliveryPointIdentity.js';

const PHONE = '5493511111111';
const WA_ID = `${PHONE}@c.us`;
const AMBIGUOUS_REPLY = /canal|enlace|empresa|soporte/i;

function fakeClient(from = WA_ID) {
  let listener;
  return {
    replies: [],
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage(_to, text) { this.replies.push(String(text)); },
    async send(body, suffix = 'msg') {
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
    CREATE TABLE empresas (id integer PRIMARY KEY, nombre text);
    CREATE TABLE referentes (
      id integer PRIMARY KEY, empresa_id integer, activo boolean, deleted_at timestamptz
    );
    CREATE TABLE choferes (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, nombre text, telefono text, activo boolean
    );
    CREATE TABLE usuarios (
      id integer PRIMARY KEY, role text, empresa_id integer, chofer_id integer,
      referente_id integer, username text, telefono text, activo boolean
    );
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, cliente text, telefono text,
      telefono_normalizado text, direccion text, zona_id integer
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
    CREATE TABLE comprobantes_transferencia (
      id serial PRIMARY KEY, empresa_id integer NOT NULL, telefono text,
      fecha timestamptz DEFAULT now(), monto numeric, banco_origen text,
      banco_destino text, nro_operacion text, nombre text,
      fecha_operacion timestamptz, fecha_transf timestamptz
    );
    INSERT INTO empresas VALUES (1, 'Empresa Uno'), (2, 'Empresa Dos');
    INSERT INTO productos VALUES
      (101, 1, 'Bidón Uno', 100, false, false),
      (202, 2, 'Bidón Dos', 200, false, false);
  `);
}

async function reset(pool) {
  await pool.query(`
    TRUNCATE comprobantes_transferencia, items_pedido, pedidos, puntos_entrega, usuarios, choferes, referentes RESTART IDENTITY;
    SELECT setval(pg_get_serial_sequence('pedidos', 'id'), 100, true);
  `);
}

async function seedPointWithHistory(pool, {
  id, empresaId, telefono, cliente, direccion, productId, price,
}) {
  const pedidoId = empresaId * 10 + id;
  await pool.query(`
    INSERT INTO puntos_entrega
      (id, empresa_id, cliente, telefono, telefono_normalizado, direccion, zona_id)
    VALUES ($1,$2,$3,$4,$4,$5,$6)
  `, [id, empresaId, cliente, telefono, direccion, empresaId * 10]);
  await pool.query(`
    INSERT INTO pedidos
      (id, empresa_id, punto_entrega_id, fecha, fecha_entrega, estado, cantidad,
       cantidad_entregada, monto, metodo_pago)
    VALUES ($1,$2,$3,now() - interval '2 days',now() - interval '2 days',
            'entregado',1,1,$4,'efectivo')
  `, [pedidoId, empresaId, id, price]);
  await pool.query(`
    INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
    VALUES ($1,$2,$3,1,$4)
  `, [pedidoId, productId, empresaId === 1 ? 'Bidón Uno' : 'Bidón Dos', price]);
}

async function mutationCounts(pool) {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE estado='pendiente')::int AS pedidos,
      (SELECT COUNT(*)::int FROM items_pedido it JOIN pedidos p ON p.id=it.pedido_id WHERE p.estado='pendiente') AS items
    FROM pedidos
  `);
  return result.rows[0];
}

async function waitForAdvisoryWaiters(pool, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
    `);
    if (result.rows[0].count >= expected) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

async function beginPointWriter(pool, { id = 20, empresaId = 2, telefono = PHONE } = {}) {
  const client = await pool.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  await client.query('BEGIN');
  const identity = deliveryPointIdentity({
    normalizePhoneFn: value => String(value || '').replace(/\D+/g, ''),
    telefono,
    direccion: 'Dirección concurrente',
  });
  await lockDeliveryPointIdentity(q, { empresaId, identity });
  await client.query(`
    INSERT INTO puntos_entrega
      (id, empresa_id, cliente, telefono, telefono_normalizado, direccion, zona_id)
    VALUES ($1,$2,'Concurrente',$3,$3,'Dirección concurrente',20)
  `, [id, empresaId, telefono]);
  return {
    async commit() { await client.query('COMMIT'); client.release(); },
    async rollback() { await client.query('ROLLBACK'); client.release(); },
  };
}

async function holdReplenishmentNamespace(pool, empresaId, puntoId) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
    [empresaId, `whatsapp-reposicion:punto:${puntoId}`]
  );
  return async () => {
    await client.query('COMMIT');
    client.release();
  };
}

async function startHandlers(pool) {
  const { host, port, user, database } = pool.options;
  process.env.DATABASE_URL = `postgresql://${user}@${host}:${port}/${database}`;
  delete process.env.OPENAI_API_KEY;
  const handlers = await import(`../src/handlers.js?general-tenant=${Date.now()}-${Math.random()}`);
  const db = await import('../src/db.js');
  return { handlers: handlers.default, db };
}

test('PostgreSQL real: General resuelve teléfono de forma unívoca y fail-closed', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createSchema(pool);
    const { handlers, db } = await startHandlers(pool);
    try {
      await t.test('A: mismo teléfono en dos empresas responde neutro y no lee datos por reposición', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Nombre Uno', direccion: 'Dirección Uno', productId: 101, price: 90 });
        await seedPointWithHistory(pool, { id: 20, empresaId: 2, telefono: PHONE, cliente: 'Nombre Dos', direccion: 'Dirección Dos', productId: 202, price: 180 });
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('necesitas reposición', 'cross-tenant');

        assert.equal(replies.length, 1);
        assert.match(replies[0], AMBIGUOUS_REPLY);
        assert.doesNotMatch(replies[0], /Nombre Uno|Nombre Dos|Dirección Uno|Dirección Dos|Bidón Uno|Bidón Dos/);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0 });
      });

      await t.test('B: una empresa y un punto crea una sola reposición', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Nombre Uno', direccion: 'Dirección Uno', productId: 101, price: 90 });
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('necesitas reposición', 'unique');

        assert.equal(replies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 1);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 1, items: 1 });
        const created = await pool.query("SELECT empresa_id, punto_entrega_id FROM pedidos WHERE estado='pendiente'");
        assert.deepEqual(created.rows, [{ empresa_id: 1, punto_entrega_id: 10 }]);
      });

      await t.test('C: worker empresarial ignora homónimo externo y opera sólo en tenant fijo', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Nombre Uno', direccion: 'Dirección Uno', productId: 101, price: 90 });
        await seedPointWithHistory(pool, { id: 20, empresaId: 2, telefono: PHONE, cliente: 'Nombre Dos', direccion: 'Dirección Dos', productId: 202, price: 180 });
        const client = fakeClient();
        handlers.start(client, { empresaId: 1 });

        const replies = await client.send('necesitas reposición', 'fixed-worker');

        assert.equal(replies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 1);
        const created = await pool.query("SELECT empresa_id, punto_entrega_id FROM pedidos WHERE estado='pendiente'");
        assert.deepEqual(created.rows, [{ empresa_id: 1, punto_entrega_id: 10 }]);
      });

      await t.test('D1: varios puntos de una empresa prefieren el único teléfono exacto normalizado', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Exacto', direccion: 'Dirección Exacta', productId: 101, price: 90 });
        await seedPointWithHistory(pool, { id: 11, empresaId: 1, telefono: '3511111111', cliente: 'Sólo Sufijo', direccion: 'Dirección Sufijo', productId: 101, price: 90 });
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('necesitas reposición', 'exact');

        assert.equal(replies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 1);
        const created = await pool.query("SELECT punto_entrega_id FROM pedidos WHERE estado='pendiente'");
        assert.deepEqual(created.rows, [{ punto_entrega_id: 10 }]);
      });

      await t.test('D1b: ver pedidos usa el punto exacto resuelto y no mezcla otro sufijo del tenant', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Exacto', direccion: 'Dirección Exacta', productId: 101, price: 90 });
        await seedPointWithHistory(pool, { id: 11, empresaId: 1, telefono: '3511111111', cliente: 'Sólo Sufijo', direccion: 'Dirección Sufijo', productId: 101, price: 80 });
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('ver pedidos', 'exact-orders');

        assert.equal(replies.length, 1);
        assert.match(replies[0], /Exacto|Dirección Exacta/);
        assert.doesNotMatch(replies[0], /Sólo Sufijo|Dirección Sufijo/);
      });

      await t.test('D1c: ver comprobantes usa el teléfono exacto resuelto y no mezcla otro sufijo del tenant', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Exacto', direccion: 'Dirección Exacta', productId: 101, price: 90 });
        await seedPointWithHistory(pool, { id: 11, empresaId: 1, telefono: '3511111111', cliente: 'Sólo Sufijo', direccion: 'Dirección Sufijo', productId: 101, price: 80 });
        await pool.query(`
          INSERT INTO comprobantes_transferencia
            (empresa_id, telefono, monto, nro_operacion, nombre)
          VALUES (1, $1, 90, 'EXACTA', 'Comprobante Exacto'),
                 (1, '3511111111', 80, 'SUFIJO', 'Comprobante Sufijo')
        `, [PHONE]);
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('ver comprobantes', 'exact-receipts');

        assert.equal(replies.length, 1);
        assert.match(replies[0], /EXACTA|Comprobante Exacto/);
        assert.doesNotMatch(replies[0], /SUFIJO|Comprobante Sufijo/);
      });

      await t.test('D2: ambigüedad residual dentro de una empresa falla cerrado sin elegir último id', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: '03511111111', cliente: 'Punto A', direccion: 'Dirección A', productId: 101, price: 90 });
        await seedPointWithHistory(pool, { id: 11, empresaId: 1, telefono: '3511111111', cliente: 'Punto B', direccion: 'Dirección B', productId: 101, price: 90 });
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('necesitas reposición', 'same-tenant-ambiguous');

        assert.equal(replies.length, 1);
        assert.match(replies[0], AMBIGUOUS_REPLY);
        assert.doesNotMatch(replies[0], /Punto A|Punto B|Dirección A|Dirección B/);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0 });
      });

      await t.test('G: cero coincidencias conserva no reconocido sin mutación', async () => {
        await reset(pool);
        const client = fakeClient();
        handlers.start(client);

        const replies = await client.send('necesitas reposición', 'unknown');

        assert.equal(replies.length, 1);
        assert.match(replies[0], /proveedor|canal oficial/i);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0 });
      });

      await t.test('E1: writer cross-tenant primero hace revalidar y fallar ambiguo a General', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Nombre Uno', direccion: 'Dirección Uno', productId: 101, price: 90 });
        const writer = await beginPointWriter(pool);
        const client = fakeClient();
        handlers.start(client);

        const run = client.send('necesitas reposición', 'writer-first');
        assert.equal(await waitForAdvisoryWaiters(pool, 1), true, 'General debe esperar el lock global del teléfono');
        await writer.commit();
        const replies = await run;

        assert.equal(replies.length, 1);
        assert.match(replies[0], AMBIGUOUS_REPLY);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 0, items: 0 });
      });

      await t.test('E2: General primero termina serialmente antes de que el writer vuelva multiempresa', async () => {
        await reset(pool);
        await seedPointWithHistory(pool, { id: 10, empresaId: 1, telefono: PHONE, cliente: 'Nombre Uno', direccion: 'Dirección Uno', productId: 101, price: 90 });
        const releaseReplenishment = await holdReplenishmentNamespace(pool, 1, 10);
        const client = fakeClient();
        handlers.start(client);

        const generalRun = client.send('necesitas reposición', 'general-first');
        assert.equal(await waitForAdvisoryWaiters(pool, 1), true, 'General debe sostener phone y esperar reposición');
        const writerPromise = beginPointWriter(pool);
        assert.equal(await waitForAdvisoryWaiters(pool, 2), true, 'writer debe esperar el lock global sostenido por General');
        await releaseReplenishment();
        const replies = await generalRun;
        const writer = await writerPromise;
        await writer.commit();

        assert.equal(replies.filter(reply => /Reposición Automática Generada/.test(reply)).length, 1);
        assert.deepEqual(await mutationCounts(pool), { pedidos: 1, items: 1 });
        const tenants = await pool.query(`
          SELECT COUNT(DISTINCT empresa_id)::int AS c
            FROM puntos_entrega
           WHERE RIGHT(regexp_replace(telefono,'\\D','','g'),10)=$1
        `, [PHONE.slice(-10)]);
        assert.equal(tenants.rows[0].c, 2);
      });
    } finally {
      await db.pool.end();
    }
  });
});
