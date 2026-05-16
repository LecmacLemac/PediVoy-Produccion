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

test('POST /public/push/subscribe guarda suscripción válida', async () => {
  const seen = { inserted: false, linkedPedido: false };
  const query = async (sql, params = []) => {
    if (sql.includes('INSERT INTO push_subs')) {
      seen.inserted = true;
      assert.equal(params[0], 'https://example.com/push/abc');
      return [{ id: 99 }];
    }
    if (sql.includes('INSERT INTO push_sub_pedidos')) {
      seen.linkedPedido = true;
      return [];
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
        subscription: {
          endpoint: 'https://example.com/push/abc',
          keys: { p256dh: 'aaa', auth: 'bbb' },
        },
      }),
    });

    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(seen.inserted, true);
    assert.equal(seen.linkedPedido, true);
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
