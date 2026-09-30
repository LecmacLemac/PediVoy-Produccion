import test from 'node:test';
import assert from 'node:assert/strict';

import { ejecutarEstrategiaReferidos, ejecutarEstrategiaVecinos } from '../src/estrategias.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (
      id integer PRIMARY KEY, config_estrategias jsonb,
      landing_slug text, landing_domain text
    );
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, cliente text, telefono text,
      direccion text, latitud numeric, longitud numeric
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, punto_entrega_id integer,
      fecha timestamptz DEFAULT now(), estado text
    );
    INSERT INTO empresas VALUES
      (1, '{"vecinos_activado":true,"referidos_activado":true}', 'uno', 'uno.example'),
      (2, '{"vecinos_activado":true,"referidos_activado":true}', 'dos', 'dos.example');
    INSERT INTO puntos_entrega VALUES
      (10, 1, 'Cliente Uno', '1111111111', 'Calle Uno', -31.4, -64.2),
      (11, 1, 'Vecino Uno', '1111111112', 'Calle Vecino', -31.4001, -64.2001),
      (20, 2, 'Cliente Dos', '2222222222', 'Calle Dos', -32.0, -65.0);
    INSERT INTO pedidos VALUES
      (1, 1, 10, now() - interval '1 day', 'entregado'),
      (2, 2, 20, now() - interval '1 day', 'entregado'),
      (3, 2, 10, now() - interval '1 day', 'entregado'),
      (4, 1, 20, now() - interval '1 day', 'entregado');
  `);
}

function strategyQuery(pool) {
  return async (sql, params = []) => {
    if (/ST_DWithin/.test(sql)) {
      return (await pool.query(
        `SELECT id, cliente, telefono, direccion, latitud, longitud
           FROM puntos_entrega
          WHERE empresa_id = $1 AND id = 11`,
        [params[0]],
      )).rows;
    }
    return (await pool.query(sql, params)).rows;
  };
}

test('PostgreSQL real: vecinos/referidos no leen coordenadas o teléfonos mediante links cross-tenant', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const queryFn = strategyQuery(pool);

    for (const [pedidoId, empresaId] of [[3, 2], [4, 1]]) {
      const sends = [];
      await ejecutarEstrategiaVecinos({ pedidoId, empresaId, queryFn, sendFn: async payload => sends.push(payload) });
      await ejecutarEstrategiaReferidos({ pedidoId, empresaId, queryFn, sendFn: async payload => sends.push(payload) });
      assert.deepEqual(sends, [], `pedido corrupto ${pedidoId} no debe producir mensajes`);
    }

    const vecinos = [];
    await ejecutarEstrategiaVecinos({
      pedidoId: 1,
      empresaId: 1,
      queryFn,
      sendFn: async payload => vecinos.push(payload),
    });
    assert.equal(vecinos.length, 1);
    assert.equal(vecinos[0].empresaId, 1);
    assert.equal(vecinos[0].telefono, '1111111112');
    assert.equal(vecinos[0].meta.latitud, -31.4001);

    const referidos = [];
    await ejecutarEstrategiaReferidos({
      pedidoId: 1,
      empresaId: 1,
      queryFn,
      sendFn: async payload => referidos.push(payload),
    });
    assert.equal(referidos.length, 1);
    assert.equal(referidos[0].empresaId, 1);
    assert.equal(referidos[0].telefono, '1111111111');
    assert.equal(referidos[0].meta.direccion, 'Calle Uno');
  });
});
