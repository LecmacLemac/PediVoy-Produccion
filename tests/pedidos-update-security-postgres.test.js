import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';
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

async function invoke(pool, body, user = { uid: 5, role: 'admin', empresa_id: 7 }) {
  const handler = createUpdatePedidoHandler({
    withTransactionFn: work => withTransaction(work, { pool, maxRetries: 0 }),
    notifyEstadoFn: () => Promise.resolve(),
    notifyEnRutaFn: () => Promise.resolve(),
    awardPointsFn: () => Promise.resolve(),
    generateComisionesFn: () => Promise.resolve(),
    postEntregaFn: () => Promise.resolve(),
  });
  const res = responseHarness();
  await handler({ params: { id: '42' }, body, user }, res);
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
    CREATE TABLE choferes (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      activo boolean NOT NULL
    );
    CREATE TABLE zonas_geograficas (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      punto_entrega_id integer,
      monto numeric,
      estado text,
      metodo_pago text,
      chofer_id integer,
      zona_id integer
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      nombre text NOT NULL,
      activo boolean NOT NULL DEFAULT true,
      deleted_at timestamptz,
      config_activo boolean,
      retornable boolean
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL REFERENCES pedidos(id),
      producto text NOT NULL,
      producto_id integer NOT NULL REFERENCES productos(id),
      cantidad numeric NOT NULL,
      precio_unitario numeric NOT NULL
    );
    INSERT INTO usuarios VALUES
      (5, 'admin', 7, true),
      (6, 'super', NULL, true);
    INSERT INTO choferes VALUES
      (9, 7, true),
      (19, 8, true),
      (29, 7, false);
    INSERT INTO zonas_geograficas VALUES
      (4, 7),
      (14, 8);
    INSERT INTO pedidos VALUES
      (42, 7, 12, 3000, 'entregado', 'efectivo', 9, 4),
      (43, 7, 12, 100, 'pendiente', 'efectivo', 9, 4);
    INSERT INTO productos VALUES
      (55, 7, 'Anterior', true, NULL, false, false),
      (66, 7, 'Nuevo', true, NULL, false, false);
    INSERT INTO items_pedido (pedido_id, producto, producto_id, cantidad, precio_unitario)
    VALUES (43, 'Anterior', 55, 1, 100);
  `);
}

async function invokePedido(pool, pedidoId, body, user = { uid: 5, role: 'admin', empresa_id: 7 }) {
  const handler = createUpdatePedidoHandler({
    withTransactionFn: work => withTransaction(work, { pool, maxRetries: 0 }),
    notifyEstadoFn: () => Promise.resolve(),
    notifyEnRutaFn: () => Promise.resolve(),
    awardPointsFn: () => Promise.resolve(),
    generateComisionesFn: () => Promise.resolve(),
    postEntregaFn: () => Promise.resolve(),
  });
  const res = responseHarness();
  await handler({ params: { id: String(pedidoId) }, body, user }, res);
  return res;
}

async function snapshotEditablePedido(pool) {
  return {
    pedido: (await pool.query('SELECT monto, estado, metodo_pago, chofer_id, zona_id FROM pedidos WHERE id = 43')).rows,
    items: (await pool.query('SELECT producto_id, producto, cantidad, precio_unitario FROM items_pedido WHERE pedido_id = 43 ORDER BY id')).rows,
  };
}

test('PostgreSQL real: rollback atómico conserva items, monto y admin si zona cross-tenant falla', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const before = await snapshotEditablePedido(pool);
    const response = await invokePedido(pool, 43, {
      items: [{ producto_id: 66, cantidad: 2, precio_unitario: 75 }],
      estado: 'en_ruta',
      metodo_pago: 'transferencia',
      chofer_id: null,
      zona_id: 14,
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(await snapshotEditablePedido(pool), before);
  });
});

test('PostgreSQL real: guardado completo persiste items, monto y admin en una transacción', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const response = await invokePedido(pool, 43, {
      items: [{ producto_id: 66, cantidad: 2, precio_unitario: 75 }],
      estado: 'en_ruta',
      metodo_pago: 'transferencia',
      chofer_id: null,
      zona_id: null,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await snapshotEditablePedido(pool), {
      pedido: [{ monto: '150', estado: 'en_ruta', metodo_pago: 'transferencia', chofer_id: null, zona_id: null }],
      items: [{ producto_id: 66, producto: 'Nuevo', cantidad: '2', precio_unitario: '75' }],
    });
  });
});

test('PostgreSQL real: actor revocado concurrentemente bloquea el guardado completo sin cambios', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const before = await snapshotEditablePedido(pool);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query('UPDATE usuarios SET activo = false WHERE id = 5');
      const request = invokePedido(pool, 43, {
        items: [{ producto_id: 66, cantidad: 2, precio_unitario: 75 }],
        estado: 'en_ruta',
        metodo_pago: 'transferencia',
        chofer_id: null,
        zona_id: null,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      await revoker.query('COMMIT');
      const response = await request;
      assert.equal(response.statusCode, 403);
      assert.deepEqual(await snapshotEditablePedido(pool), before);
    } finally {
      try { await revoker.query('ROLLBACK'); } catch {}
      revoker.release();
    }
  });
});

test('PostgreSQL real: corrección finalizada valida tenant/links y null limpia con exact-row', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);

    const crossTenant = await invoke(pool, { chofer_id: 19, metodo_pago: 'transferencia' });
    assert.equal(crossTenant.statusCode, 400);
    assert.deepEqual((await pool.query('SELECT metodo_pago, chofer_id, zona_id FROM pedidos WHERE id = 42')).rows, [
      { metodo_pago: 'efectivo', chofer_id: 9, zona_id: 4 },
    ]);

    const inactive = await invoke(pool, { chofer_id: 29 });
    assert.equal(inactive.statusCode, 400);

    const wrongZone = await invoke(pool, { zona_id: 14 });
    assert.equal(wrongZone.statusCode, 400);

    const cleared = await invoke(pool, { empresa_id: 7, metodo_pago: 'cuenta_corriente', chofer_id: null, zona_id: null });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual((await pool.query('SELECT empresa_id, metodo_pago, chofer_id, zona_id FROM pedidos WHERE id = 42')).rows, [
      { empresa_id: 7, metodo_pago: 'cuenta_corriente', chofer_id: null, zona_id: null },
    ]);
  });
});

test('PostgreSQL real: degradación concurrente del actor gana antes de cualquier mutación', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query("UPDATE usuarios SET role = 'user' WHERE id = 5");

      let settled = false;
      const request = invoke(pool, { metodo_pago: 'transferencia' }).then(result => {
        settled = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(settled, false, 'FOR SHARE del actor debe esperar la revocación concurrente');

      await revoker.query('COMMIT');
      const response = await request;
      assert.equal(response.statusCode, 403);
      assert.deepEqual((await pool.query('SELECT metodo_pago FROM pedidos WHERE id = 42')).rows, [
        { metodo_pago: 'efectivo' },
      ]);
    } finally {
      try { await revoker.query('ROLLBACK'); } catch {}
      revoker.release();
    }
  });
});
