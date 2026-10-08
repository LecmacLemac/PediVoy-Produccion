import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';

import { grantReferralReward } from '../src/estrategias.js';
import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

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
      empresa_id integer NOT NULL,
      nombre text NOT NULL,
      activo boolean DEFAULT true,
      deleted_at timestamptz,
      promo_config jsonb,
      config_activo jsonb DEFAULT '{}'::jsonb,
      retornable boolean DEFAULT false
    );
    CREATE TABLE zonas_geograficas (id serial PRIMARY KEY, empresa_id integer NOT NULL, dias_entrega jsonb DEFAULT '[]'::jsonb);
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
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
    CREATE TABLE cliente_recompensas (
      id serial PRIMARY KEY,
      cliente_id integer,
      producto_id integer,
      cantidad integer DEFAULT 1,
      reclamado boolean DEFAULT false,
      fecha_ganado timestamptz DEFAULT now(),
      fecha_reclamado timestamptz,
      origen_pedido_id integer,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE cliente_retornables_saldos (empresa_id integer, punto_entrega_id integer, producto_id integer, saldo numeric);
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
    INSERT INTO empresas (id, landing_slug) VALUES (1, 'uno'), (2, 'dos');
  `);
}

function transactionRunner(pool) {
  return async work => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(async (sql, params = []) => (await client.query(sql, params)).rows, client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function seedValidReferral(pool, { rewardProductId = 55 } = {}) {
  await pool.query(
    "INSERT INTO productos (id, empresa_id, nombre, activo) VALUES ($1, 1, 'Premio', true), (99, 1, 'Base', true)",
    [rewardProductId]
  );
  await pool.query(`
    INSERT INTO puntos_entrega (id, empresa_id, cliente, telefono, telefono_normalizado, direccion)
      VALUES (10, 1, 'Padrino', '3511111111', '3511111111', 'Origen'),
             (20, 1, 'Vecino', '3512222222', '3512222222', 'Destino');
    INSERT INTO pedidos (id, empresa_id, punto_entrega_id, estado) VALUES (100, 1, 10, 'entregado');
    INSERT INTO pedidos (id, empresa_id, punto_entrega_id, referido_por_id, estado) VALUES (200, 1, 20, 10, 'entregado');
  `);
}

test('otorgamiento VECINO usa fecha_ganado y crea exactamente una recompensa', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);

    const result = await grantReferralReward({
      pedidoId: 200,
      empresaId: 1,
      productoId: 55,
      withTransactionFn: transactionRunner(pool),
    });

    assert.equal(result.created, true);
    const rewards = await pool.query(`
      SELECT cliente_id, producto_id, cantidad, reclamado,
             fecha_ganado IS NOT NULL AS fecha_ok, origen_pedido_id
        FROM cliente_recompensas
    `);
    assert.deepEqual(rewards.rows, [{
      cliente_id: 10,
      producto_id: 55,
      cantidad: 1,
      reclamado: false,
      fecha_ok: true,
      origen_pedido_id: 200,
    }]);
  });
});

test('otorgamiento VECINO falla cerrado para producto o relaciones cross-tenant/inactivas', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    const run = transactionRunner(pool);

    for (const [label, mutate] of [
      ['producto cross-tenant', () => pool.query('UPDATE productos SET empresa_id = 2 WHERE id = 55')],
      ['producto inactivo', () => pool.query('UPDATE productos SET activo = false WHERE id = 55')],
      ['producto eliminado', () => pool.query('UPDATE productos SET deleted_at = now() WHERE id = 55')],
      ['punto referido cross-tenant', () => pool.query('UPDATE puntos_entrega SET empresa_id = 2 WHERE id = 20')],
      ['punto padrino cross-tenant', () => pool.query('UPDATE puntos_entrega SET empresa_id = 2 WHERE id = 10')],
      ['pedido referido cross-tenant', () => pool.query('UPDATE pedidos SET empresa_id = 2 WHERE id = 200')],
      ['pedido padrino corrupto', () => pool.query('UPDATE pedidos SET empresa_id = 2 WHERE id = 100')],
    ]) {
      await t.test(label, async () => {
        await pool.query('TRUNCATE cliente_recompensas, pedidos, puntos_entrega, productos RESTART IDENTITY');
        await seedValidReferral(pool);
        await mutate();
        const result = await grantReferralReward({ pedidoId: 200, empresaId: 1, productoId: 55, withTransactionFn: run });
        assert.equal(result.created, false);
        assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM cliente_recompensas')).rows[0].c, 0);
      });
    }
  });
});

test('otorgamiento VECINO concurrente y retry crea como máximo una recompensa por pedido origen', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    const args = { pedidoId: 200, empresaId: 1, productoId: 55, withTransactionFn: transactionRunner(pool) };
    const results = await Promise.all([grantReferralReward(args), grantReferralReward(args)]);
    const retry = await grantReferralReward(args);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(retry.created, false);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM cliente_recompensas WHERE origen_pedido_id = 200')).rows[0].c, 1);
  });
});

test('COMMIT ambiguo de otorgamiento no se compensa ni duplica al reconciliar/reintentar', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    const committedThenUnknown = async work => {
      const result = await transactionRunner(pool)(work);
      assert.equal(result.created, true);
      const error = new Error('commit outcome unknown');
      error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
      throw error;
    };
    await assert.rejects(
      grantReferralReward({ pedidoId: 200, empresaId: 1, productoId: 55, withTransactionFn: committedThenUnknown }),
      error => error?.code === 'TRANSACTION_OUTCOME_UNKNOWN'
    );
    const retry = await grantReferralReward({
      pedidoId: 200,
      empresaId: 1,
      productoId: 55,
      withTransactionFn: transactionRunner(pool),
    });
    assert.equal(retry.created, false);
    assert.equal(retry.reason, 'already_granted');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM cliente_recompensas WHERE origen_pedido_id = 200')).rows[0].c, 1);
  });
});

function buildApp(pool, overrides = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    pool: overrides.pool || pool,
    geocodeIfNeeded: async () => null,
    normalizePhone: value => String(value || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => null,
    enqueueOrderConfirmationWppMessage: async () => null,
    enqueueWppMessage: async () => null,
    sendSmsViaIfttt: async () => null,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => null,
    ejecutarEstrategiaVecinosFn: async () => null,
    resolveEmpresaIdFn: async () => 1,
  });
  return app;
}

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function postPedido(baseUrl, suffix, submissionId = null) {
  const response = await fetch(`${baseUrl}/public/pedidos?empresa_id=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.88.0.${suffix}` },
    body: JSON.stringify({
      empresa_id: 1,
      cliente: 'Padrino',
      telefono: '3511111111',
      direccion: 'Origen',
      submission_id: submissionId,
      items: [{ producto_id: 99, producto: 'Base', cantidad: 1, precio_unitario: 1000 }],
    }),
  });
  return { status: response.status, body: await response.json() };
}

test('consumo VECINO válido persiste producto canónico una vez y reclama exactamente la recompensa', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    await pool.query(`INSERT INTO cliente_recompensas
      (cliente_id, producto_id, cantidad, reclamado, fecha_ganado, origen_pedido_id)
      VALUES (10, 55, 1, false, now(), 200)`);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, 1, 'reward-valid');
      assert.equal(result.status, 200);
    });
    const rewardItems = await pool.query("SELECT producto_id, cantidad FROM items_pedido WHERE producto LIKE '🎁 PREMIO:%'");
    assert.deepEqual(rewardItems.rows, [{ producto_id: 55, cantidad: '1' }]);
    const reward = await pool.query('SELECT reclamado, fecha_reclamado IS NOT NULL AS fecha_ok, origen_pedido_id FROM cliente_recompensas');
    assert.deepEqual(reward.rows, [{ reclamado: true, fecha_ok: true, origen_pedido_id: 200 }]);
  });
});

test('consumo VECINO excluye recompensa con producto cross-tenant sin agregar item ni reclamar', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    await pool.query("INSERT INTO productos (id, empresa_id, nombre, activo) VALUES (77, 2, 'Premio ajeno', true)");
    await pool.query('INSERT INTO cliente_recompensas (cliente_id, producto_id, cantidad, reclamado, fecha_ganado) VALUES (10, 77, 1, false, now())');
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, 2, 'reward-cross-tenant');
      assert.equal(result.status, 200);
    });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM items_pedido WHERE producto LIKE '🎁 PREMIO:%'")).rows[0].c, 0);
    assert.equal((await pool.query('SELECT reclamado FROM cliente_recompensas')).rows[0].reclamado, false);
  });
});

test('consumo VECINO excluye recompensa ligada a punto cross-tenant/corrupto', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    await pool.query(`
      INSERT INTO puntos_entrega (id, empresa_id, cliente, telefono, telefono_normalizado, direccion)
      VALUES (30, 2, 'Ajeno', '3513333333', '3513333333', 'Ajena');
      INSERT INTO cliente_recompensas (cliente_id, producto_id, cantidad, reclamado, fecha_ganado)
      VALUES (30, 55, 1, false, now())
    `);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, 4, 'reward-cross-point');
      assert.equal(result.status, 200);
    });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM items_pedido WHERE producto LIKE '🎁 PREMIO:%'")).rows[0].c, 0);
    assert.equal((await pool.query('SELECT reclamado FROM cliente_recompensas')).rows[0].reclamado, false);
  });
});

test('dos POST concurrentes consumen una recompensa una sola vez sin deadlock ni movimiento duplicado', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    await pool.query('INSERT INTO cliente_recompensas (cliente_id, producto_id, cantidad, reclamado, fecha_ganado) VALUES (10, 55, 1, false, now())');
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const responses = await Promise.all([
        postPedido(baseUrl, 5, 'reward-race-a'),
        postPedido(baseUrl, 6, 'reward-race-b'),
      ]);
      assert.deepEqual(responses.map(response => response.status), [200, 200]);
    });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM items_pedido WHERE producto LIKE '🎁 PREMIO:%'")).rows[0].c, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM pedidos WHERE submission_id IN ($1,$2)', ['reward-race-a', 'reward-race-b'])).rows[0].c, 2);
    assert.equal((await pool.query('SELECT reclamado FROM cliente_recompensas')).rows[0].reclamado, true);
  });
});

test('otorgamiento y consumo concurrentes respetan el orden global sin deadlock ni duplicación', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    const app = buildApp(pool);
    await withServer(app, async baseUrl => {
      const [grant, order] = await Promise.all([
        grantReferralReward({ pedidoId: 200, empresaId: 1, productoId: 55, withTransactionFn: transactionRunner(pool) }),
        postPedido(baseUrl, 7, 'grant-consume-race'),
      ]);
      assert.equal(grant.created, true);
      assert.equal(order.status, 200);
    });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS c FROM cliente_recompensas WHERE origen_pedido_id = 200')).rows[0].c, 1);
    assert.ok((await pool.query("SELECT COUNT(*)::int AS c FROM items_pedido WHERE producto LIKE '🎁 PREMIO:%'")).rows[0].c <= 1);
  });
});

test('mismatch exact-row al reclamar revierte pedido, items y recompensa', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedValidReferral(pool);
    await pool.query('INSERT INTO cliente_recompensas (cliente_id, producto_id, cantidad, reclamado, fecha_ganado) VALUES (10, 55, 1, false, now())');
    const controlledPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            if (String(sql).includes('UPDATE cliente_recompensas')) return { rows: [] };
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildApp(pool, { pool: controlledPool });
    await withServer(app, async baseUrl => {
      const result = await postPedido(baseUrl, 3, 'reward-mismatch');
      assert.equal(result.status, 500);
    });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM pedidos WHERE submission_id = 'reward-mismatch'")).rows[0].c, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS c FROM items_pedido ip JOIN pedidos p ON p.id=ip.pedido_id WHERE p.submission_id='reward-mismatch'")).rows[0].c, 0);
    assert.equal((await pool.query('SELECT reclamado FROM cliente_recompensas')).rows[0].reclamado, false);
  });
});

test('queries de cliente_recompensas usan esquema canónico, tenant predicates y exact-row claim', () => {
  const estrategias = fs.readFileSync(new URL('../src/estrategias.js', import.meta.url), 'utf8');
  const createPedido = fs.readFileSync(new URL('../src/routes/publicLegacyCreatePedido.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${estrategias}\n${createPedido}`, /fecha_generado/);
  assert.match(estrategias, /fecha_ganado/);
  assert.match(estrategias, /origen_pedido_id/);
  assert.match(createPedido, /pe\.empresa_id\s*=\s*\$2/);
  assert.match(createPedido, /p\.empresa_id\s*=\s*\$2/);
  assert.match(createPedido, /FOR UPDATE OF cr/);
  assert.match(createPedido, /RETURNING cr\.id|RETURNING id/);
});
