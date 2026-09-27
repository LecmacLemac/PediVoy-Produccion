import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPublicLegacyPedidosRouter } from '../src/routes/publicLegacyPedidos.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /public/push/subscribe valida payload inválido', async () => {
  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query: async () => [] }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'not-a-url' }),
    });

    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'payload inválido');
  });
});

test('POST /public/push/subscribe rechaza suscripción sin claves push', async () => {
  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query: async () => [] }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscription: { endpoint: 'https://example.com/push/abc' },
      }),
    });

    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'payload inválido');
  });
});

test('POST /public/push/subscribe rechaza vincular pedido sin tracking token', async () => {
  const seen = { inserted: false, linkedPedido: false };
  const query = async (sql) => {
    if (sql.includes('INSERT INTO push_subs')) seen.inserted = true;
    if (sql.includes('INSERT INTO push_sub_pedidos')) seen.linkedPedido = true;
    return [];
  };

  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 1,
        pedido_id: 55,
        subscription: {
          endpoint: 'https://example.com/push/abc',
          keys: { p256dh: 'aaa', auth: 'bbb' },
        },
      }),
    });

    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.error, 'tracking token requerido');
    assert.equal(seen.inserted, false);
    assert.equal(seen.linkedPedido, false);
  });
});

test('POST /public/push/subscribe guarda suscripción de pedido con tracking token válido', async () => {
  const seen = { verifiedPedido: false, replacedLinks: false };
  const query = async (sql, params = []) => {
    if (sql.includes('FROM pedidos') && sql.includes('tracking_token')) {
      seen.verifiedPedido = true;
      assert.equal(params[0], 1);
      assert.deepEqual(params[1], [55]);
      assert.deepEqual(params[2], ['tok_555555']);
      return [{ id: 55 }];
    }
    if (sql.includes('INSERT INTO push_subs')) {
      seen.replacedLinks = true;
      assert.equal(params[0], 'https://example.com/push/abc');
      assert.deepEqual(params[4], [55]);
      return [{ linked_count: 1 }];
    }
    return [];
  };

  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 1,
        pedido_id: 55,
        tracking_token: 'tok_555555',
        subscription: {
          endpoint: 'https://example.com/push/abc',
          keys: { p256dh: 'aaa', auth: 'bbb' },
        },
      }),
    });

    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.linked, 1);
    assert.equal(seen.verifiedPedido, true);
    assert.equal(seen.replacedLinks, true);
  });
});

test('POST /public/push/subscribe reemplaza vínculos en lote y acepta tokens legacy no vacíos', async () => {
  const seen = { verified: false, replacedAtomically: false };
  const query = async (sql, params = []) => {
    if (sql.includes('FROM pedidos') && sql.includes('unnest')) {
      seen.verified = true;
      assert.equal(params[0], 1);
      assert.deepEqual(params[1], [55, 56]);
      assert.deepEqual(params[2], ['tok_555555', 'x']);
      return [{ id: 55 }, { id: 56 }];
    }
    if (sql.includes('INSERT INTO push_subs')) {
      assert.match(sql, /DELETE FROM push_sub_pedidos/);
      assert.match(sql, /unnest\(\$5::bigint\[\]\)/);
      assert.equal(params[0], 'https://example.com/push/batch');
      assert.equal(params[3], 1);
      assert.deepEqual(params[4], [55, 56]);
      seen.replacedAtomically = true;
      return [{ linked_count: 2 }];
    }
    return [];
  };

  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 1,
        pedidos: [
          { pedido_id: 55, tracking_token: 'tok_555555' },
          { pedido_id: 56, tracking_token: 'x' },
        ],
        subscription: {
          endpoint: 'https://example.com/push/batch',
          keys: { p256dh: 'aaa', auth: 'bbb' },
        },
      }),
    });

    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, linked: 2 });
    assert.equal(seen.verified, true);
    assert.equal(seen.replacedAtomically, true);
  });
});

test('POST /public/push/subscribe rechaza todo el lote si un pedido no pertenece al token', async () => {
  let wrote = false;
  const query = async (sql) => {
    if (sql.includes('FROM pedidos')) return [{ id: 55 }];
    if (sql.includes('INSERT INTO push_subs')) wrote = true;
    return [];
  };
  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 1,
        pedidos: [
          { pedido_id: 55, tracking_token: 'tok_555555' },
          { pedido_id: 56, tracking_token: 'tok_666666' },
        ],
        subscription: {
          endpoint: 'https://example.com/push/batch-invalid',
          keys: { p256dh: 'aaa', auth: 'bbb' },
        },
      }),
    });

    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'tracking token inválido');
    assert.equal(wrote, false);
  });
});

test('POST /public/push/subscribe valida y reemplaza vínculos en una sola transacción', async () => {
  let transactionUsed = false;
  const txQuery = async (sql) => {
    if (sql.includes('FROM pedidos')) return [{ id: 55 }];
    if (sql.includes('INSERT INTO push_subs')) return [{ linked_count: 1 }];
    return [];
  };
  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({
    query: async () => { throw new Error('consulta fuera de transacción'); },
    withTransaction: async (work) => {
      transactionUsed = true;
      return work(txQuery);
    },
  }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 1,
        pedido_id: 55,
        tracking_token: 'tok_555555',
        subscription: {
          endpoint: 'https://example.com/push/transaction',
          keys: { p256dh: 'aaa', auth: 'bbb' },
        },
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(transactionUsed, true);
  });
});

test('POST /public/push/unsubscribe elimina endpoint válido', async () => {
  let deleted = false;
  const app = express();
  app.use(express.json());
  app.use('/public', createPublicLegacyPedidosRouter({ query: async (sql, params = []) => {
    if (sql.includes('DELETE FROM push_subs')) {
      deleted = true;
      assert.equal(params[0], 'https://example.com/push/abc');
    }
    return [];
  } }));

  await withServer(app, async (baseUrl) => {
    const r = await fetch(`${baseUrl}/public/push/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://example.com/push/abc' }),
    });

    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(deleted, true);
  });
});
