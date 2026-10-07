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
      (42, 7, 12, 3000, 'entregado', 'efectivo', 9, 4);
  `);
}

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
