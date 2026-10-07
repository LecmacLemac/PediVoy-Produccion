import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdatePedidoItemsHandler } from '../src/routes/pedidosItems.js';

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function invoke(handler, pedidoId, user = { uid: 5, role: 'admin', empresa_id: 7 }) {
  const res = responseHarness();
  await handler({
    params: { id: pedidoId },
    body: { items: [{ producto_id: 11, cantidad: 1, precio_unitario: 25 }] },
    user,
  }, res);
  return res;
}

for (const pedidoId of ['042', '42.0', ' 42', '42 ', '4.2e1', '+42', '0', '-42', '2147483648']) {
  test(`PUT items rechaza ID no canónico ${JSON.stringify(pedidoId)} antes de actor/SQL`, async () => {
    let transactions = 0;
    const handler = createUpdatePedidoItemsHandler({
      withTransaction: async () => { transactions += 1; },
    });

    const res = await invoke(handler, pedidoId);

    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /ID de pedido inválido/);
    assert.equal(transactions, 0);
  });
}

test('PUT items acepta ID decimal positivo canónico int4 y revalida actor antes del pedido', async () => {
  const calls = [];
  const handler = createUpdatePedidoItemsHandler({
    withTransaction: async work => work(async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM usuarios/.test(sql)) return [{ id: 5, role: 'admin', empresa_id: 7, activo: true }];
      if (/FROM pedidos/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [{ id: 42, empresa_id: 7, estado: 'pendiente' }];
      }
      if (/FROM productos/.test(sql)) return [{ id: 11, nombre: 'Bidón' }];
      if (/DELETE FROM items_pedido/.test(sql)) return [];
      if (/INSERT INTO items_pedido/.test(sql)) return [{ id: 99 }];
      if (/UPDATE pedidos/.test(sql)) return [{ id: 42 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
  });

  const res = await invoke(handler, '42');

  assert.equal(res.statusCode, 200);
  assert.match(calls[0].sql, /FROM usuarios/);
  assert.match(calls[0].sql, /FOR SHARE/);
  assert.deepEqual(calls[0].params, [5]);
  assert.match(calls[1].sql, /FROM pedidos/);
  assert.deepEqual(calls[1].params, [42, 7]);
});

for (const actor of [
  null,
  { id: 5, role: 'admin', empresa_id: 7, activo: false },
  { id: 5, role: 'user', empresa_id: 7, activo: true },
  { id: 5, role: 'admin', empresa_id: 8, activo: true },
  { id: 5, role: 'super', empresa_id: 7, activo: true },
]) {
  test(`PUT items rechaza actor revalidado ${JSON.stringify(actor)} antes de mutar`, async () => {
    const calls = [];
    const handler = createUpdatePedidoItemsHandler({
      withTransaction: async work => work(async (sql, params = []) => {
        calls.push({ sql, params });
        if (/FROM usuarios/.test(sql)) return actor ? [actor] : [];
        throw new Error(`No debe consultar después del actor: ${sql}`);
      }),
    });

    const res = await invoke(handler, '42');

    assert.equal(res.statusCode, 403);
    assert.equal(calls.some(call => /DELETE FROM items_pedido|INSERT INTO items_pedido|UPDATE pedidos/.test(call.sql)), false);
  });
}

test('PUT items rechaza pedido sin tenant canónico antes de productos o escrituras', async () => {
  const calls = [];
  const handler = createUpdatePedidoItemsHandler({
    withTransaction: async work => work(async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM usuarios/.test(sql)) return [{ id: 6, role: 'super', empresa_id: null, activo: true }];
      if (/FROM pedidos/.test(sql)) return [{ id: 42, empresa_id: 0, estado: 'pendiente' }];
      throw new Error(`No debe consultar después del pedido inválido: ${sql}`);
    }),
  });

  const res = await invoke(handler, '42', { uid: 6, role: 'super', empresa_id: null });

  assert.equal(res.statusCode, 409);
  assert.equal(calls.some(call => /FROM productos|DELETE FROM items_pedido|INSERT INTO items_pedido|UPDATE pedidos/.test(call.sql)), false);
});

test('PUT items exige super canónico y permite alcance global sin mover tenant', async () => {
  const calls = [];
  const handler = createUpdatePedidoItemsHandler({
    withTransaction: async work => work(async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM usuarios/.test(sql)) return [{ id: 6, role: 'super', empresa_id: null, activo: true }];
      if (/FROM pedidos/.test(sql) && /FOR UPDATE/.test(sql)) {
        return [{ id: 42, empresa_id: 7, estado: 'pendiente' }];
      }
      if (/FROM productos/.test(sql)) return [{ id: 11, nombre: 'Bidón' }];
      if (/DELETE FROM items_pedido/.test(sql)) return [];
      if (/INSERT INTO items_pedido/.test(sql)) return [{ id: 99 }];
      if (/UPDATE pedidos/.test(sql)) return [{ id: 42 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
  });

  const res = await invoke(handler, '42', { uid: 6, role: 'super', empresa_id: null });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.find(call => /FROM pedidos/.test(call.sql)).params, [42, null]);
  assert.deepEqual(calls.find(call => /UPDATE pedidos/.test(call.sql)).params, [42, 7]);
});
