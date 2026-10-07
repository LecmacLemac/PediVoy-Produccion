import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdatePedidoItemsHandler } from '../src/routes/pedidosItems.js';
import { withTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function invoke(pool) {
  const handler = createUpdatePedidoItemsHandler({
    withTransaction: work => withTransaction(work, { pool, maxRetries: 0 }),
  });
  const res = responseHarness();
  await handler({
    params: { id: '42' },
    body: { items: [{ producto_id: 66, cantidad: 3, precio_unitario: 40 }] },
    user: { uid: 5, role: 'admin', empresa_id: 7 },
  }, res);
  return res;
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE usuarios (
      id integer PRIMARY KEY,
      role text NOT NULL,
      empresa_id integer,
      activo boolean NOT NULL
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      chofer_id integer,
      estado text NOT NULL,
      monto numeric NOT NULL
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      nombre text NOT NULL,
      activo boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL REFERENCES pedidos(id),
      producto text NOT NULL,
      producto_id integer NOT NULL REFERENCES productos(id),
      cantidad numeric NOT NULL,
      precio_unitario numeric NOT NULL
    );
    INSERT INTO usuarios VALUES (5, 'admin', 7, true);
    INSERT INTO pedidos VALUES (42, 7, NULL, 'pendiente', 10);
    INSERT INTO productos VALUES
      (55, 7, 'Anterior', true, NULL),
      (66, 7, 'Nuevo', true, NULL);
    INSERT INTO items_pedido (pedido_id, producto, producto_id, cantidad, precio_unitario)
    VALUES (42, 'Anterior', 55, 1, 10);
  `);
}

async function assertPedidoUnchanged(pool) {
  assert.deepEqual((await pool.query(
    'SELECT producto_id, producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id = 42 ORDER BY id'
  )).rows, [{ producto_id: 55, producto: 'Anterior', cantidad: '1', precio_unitario: '10' }]);
  assert.deepEqual((await pool.query('SELECT monto FROM pedidos WHERE id = 42')).rows, [{ monto: '10' }]);
}

for (const credentialChange of [
  { name: 'revocación', sql: 'UPDATE usuarios SET activo = false WHERE id = 5' },
  { name: 'degradación', sql: "UPDATE usuarios SET role = 'user' WHERE id = 5" },
  { name: 'movimiento cross-tenant', sql: 'UPDATE usuarios SET empresa_id = 8 WHERE id = 5' },
]) {
  test(`PostgreSQL real: ${credentialChange.name} concurrente bloquea PUT items sin mutación parcial`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      const changer = await pool.connect();
      try {
        await changer.query('BEGIN');
        await changer.query(credentialChange.sql);

        let settled = false;
        const request = invoke(pool).then(result => {
          settled = true;
          return result;
        });
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(settled, false, 'FOR SHARE del actor debe esperar el cambio concurrente');

        await changer.query('COMMIT');
        const response = await request;
        assert.equal(response.statusCode, 403);
        await assertPedidoUnchanged(pool);
      } finally {
        try { await changer.query('ROLLBACK'); } catch {}
        changer.release();
      }
    });
  });
}
