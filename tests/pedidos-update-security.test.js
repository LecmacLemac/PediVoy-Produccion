import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function buildHarness({
  actor = { id: 5, role: 'admin', empresa_id: 7, activo: true },
  pedido = { id: 42, empresa_id: 7, punto_entrega_id: 12, monto: 3000, estado: 'entregado' },
  chofer = { id: 9 },
  zona = { id: 4 },
} = {}) {
  const calls = [];
  const handler = createUpdatePedidoHandler({
    withTransactionFn: async work => work(async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM usuarios/.test(sql)) return actor ? [actor] : [];
      if (/FROM pedidos/.test(sql) && /FOR UPDATE/.test(sql)) return pedido ? [pedido] : [];
      if (/FROM choferes/.test(sql)) return chofer ? [chofer] : [];
      if (/FROM zonas_geograficas/.test(sql)) return zona ? [zona] : [];
      if (/UPDATE pedidos/.test(sql)) return [{ ...pedido }];
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
    notifyEstadoFn: () => Promise.resolve(),
    notifyEnRutaFn: () => Promise.resolve(),
    awardPointsFn: () => Promise.resolve(),
    generateComisionesFn: () => Promise.resolve(),
    postEntregaFn: () => Promise.resolve(),
  });
  return { handler, calls };
}

async function invoke(handler, body, user = { uid: 5, role: 'admin', empresa_id: 7 }, pedidoId = '42') {
  const req = { params: { id: pedidoId }, body, user };
  const res = responseHarness();
  await handler(req, res);
  return res;
}

for (const pedidoId of ['042', '42.0', ' 42', '42 ', '4.2e1', '0', '-42', '2147483648']) {
  test(`rechaza ID de pedido no canónico ${JSON.stringify(pedidoId)} antes de actor/SQL`, async () => {
    const h = buildHarness();
    const res = await invoke(h.handler, { metodo_pago: 'efectivo' }, undefined, pedidoId);
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /ID de pedido inválido/);
    assert.deepEqual(h.calls, []);
  });
}

test('acepta ID decimal positivo canónico dentro de int4', async () => {
  const h = buildHarness();
  const res = await invoke(h.handler, { metodo_pago: 'efectivo' }, undefined, '42');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls.find(call => /FROM pedidos/.test(call.sql)).params, [42, 7]);
});

for (const [label, value] of [
  ['string', '9'], ['cero', 0], ['negativo', -1], ['decimal', 1.5], ['NaN', Number.NaN], ['objeto', {}],
]) {
  test(`rechaza chofer_id ${label} sin UPDATE`, async () => {
    const h = buildHarness();
    const res = await invoke(h.handler, { chofer_id: value });
    assert.equal(res.statusCode, 400);
    assert.equal(h.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
  });
}

test('null explícito limpia chofer y zona; omitidos no entran al SET', async () => {
  const h = buildHarness();
  const res = await invoke(h.handler, { chofer_id: null, zona_id: null });
  assert.equal(res.statusCode, 200);
  const update = h.calls.find(call => /UPDATE pedidos/.test(call.sql));
  assert.match(update.sql, /chofer_id = /);
  assert.match(update.sql, /zona_id = /);
  assert.deepEqual(update.params.slice(0, 2), [null, null]);

  const omitted = buildHarness();
  const omittedRes = await invoke(omitted.handler, {});
  assert.equal(omittedRes.statusCode, 200);
  assert.equal(omitted.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
});

test('valida y bloquea chofer y zona del tenant en orden determinista después del pedido', async () => {
  const h = buildHarness();
  const res = await invoke(h.handler, { chofer_id: 9, zona_id: 4 });
  assert.equal(res.statusCode, 200);
  const kinds = h.calls.map(call =>
    /FROM usuarios/.test(call.sql) ? 'actor' :
    /FROM pedidos/.test(call.sql) ? 'pedido' :
    /FROM choferes/.test(call.sql) ? 'chofer' :
    /FROM zonas_geograficas/.test(call.sql) ? 'zona' :
    /UPDATE pedidos/.test(call.sql) ? 'update' : 'otro');
  assert.deepEqual(kinds, ['actor', 'pedido', 'chofer', 'zona', 'update']);
  assert.match(h.calls[2].sql, /empresa_id = \$2/);
  assert.match(h.calls[2].sql, /activo IS TRUE/);
  assert.match(h.calls[2].sql, /FOR SHARE/);
  assert.deepEqual(h.calls[2].params, [9, 7]);
  assert.match(h.calls[3].sql, /empresa_id = \$2/);
  assert.match(h.calls[3].sql, /FOR SHARE/);
  assert.deepEqual(h.calls[3].params, [4, 7]);
});

for (const fixture of [
  { name: 'chofer inexistente/cross-tenant/inactivo', chofer: null, body: { chofer_id: 9 } },
  { name: 'zona inexistente/cross-tenant', zona: null, body: { zona_id: 4 } },
]) {
  test(`rechaza ${fixture.name} sin escrituras`, async () => {
    const h = buildHarness(fixture);
    const res = await invoke(h.handler, fixture.body);
    assert.equal(res.statusCode, 400);
    assert.equal(h.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
  });
}

test('empresa_id sólo selecciona/convalida tenant y jamás entra al SET', async () => {
  for (const user of [
    { uid: 5, role: 'admin', empresa_id: 7 },
    { uid: 6, role: 'super', empresa_id: null },
  ]) {
    const actor = { id: user.uid, role: user.role, empresa_id: user.empresa_id, activo: true };
    const h = buildHarness({ actor });
    const res = await invoke(h.handler, { empresa_id: 7, metodo_pago: 'transferencia' }, user);
    assert.equal(res.statusCode, 200);
    const update = h.calls.find(call => /UPDATE pedidos/.test(call.sql));
    assert.doesNotMatch(update.sql.split('WHERE')[0], /empresa_id\s*=/);
  }
});

for (const [label, value, status] of [
  ['diferente', 8, 409], ['string', '7', 400], ['cero', 0, 400], ['decimal', 7.5, 400],
]) {
  test(`rechaza empresa_id ${label} sin mutación`, async () => {
    const pedido = status === 400
      ? { id: 42, empresa_id: 7, punto_entrega_id: 12, monto: 3000, estado: 'pendiente' }
      : undefined;
    const h = buildHarness({ pedido });
    const res = await invoke(h.handler, { empresa_id: value, metodo_pago: 'efectivo' });
    assert.equal(res.statusCode, status);
    assert.equal(h.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
  });
}

for (const actor of [
  { id: 5, role: 'admin', empresa_id: 7, activo: false },
  { id: 5, role: 'user', empresa_id: 7, activo: true },
  { id: 5, role: 'admin', empresa_id: 8, activo: true },
  { id: 5, role: 'super', empresa_id: 7, activo: true },
]) {
  test(`revalida actor bajo lock y rechaza ${actor.role}/${actor.empresa_id}/${actor.activo}`, async () => {
    const h = buildHarness({ actor });
    const res = await invoke(h.handler, { metodo_pago: 'efectivo' });
    assert.equal(res.statusCode, 403);
    assert.match(h.calls[0].sql, /FROM usuarios/);
    assert.match(h.calls[0].sql, /FOR SHARE/);
    assert.equal(h.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
  });
}

test('admin queda fijado a su empresa y super global puede editar pedido sin trasladarlo', async () => {
  const admin = buildHarness({ pedido: null });
  const adminRes = await invoke(admin.handler, { metodo_pago: 'efectivo' });
  assert.equal(adminRes.statusCode, 404);
  assert.deepEqual(admin.calls.find(call => /FROM pedidos/.test(call.sql)).params, [42, 7]);

  const superUser = { uid: 6, role: 'super', empresa_id: null };
  const superHarness = buildHarness({ actor: { id: 6, role: 'super', empresa_id: null, activo: true } });
  const superRes = await invoke(superHarness.handler, { empresa_id: 7, metodo_pago: 'efectivo' }, superUser);
  assert.equal(superRes.statusCode, 200);
  assert.deepEqual(superHarness.calls.find(call => /FROM pedidos/.test(call.sql)).params, [42, null]);
  assert.doesNotMatch(superHarness.calls.find(call => /UPDATE pedidos/.test(call.sql)).sql.split('WHERE')[0], /empresa_id\s*=/);
});

for (const [field, value] of [
  ['estado', 'ENTREGADO'], ['estado', 'inventado'], ['metodo_pago', 'bitcoin'], ['metodo_pago', ' EFECTIVO '],
]) {
  test(`rechaza payload no canónico ${field}=${JSON.stringify(value)}`, async () => {
    const h = buildHarness({
      pedido: { id: 42, empresa_id: 7, punto_entrega_id: 12, monto: 3000, estado: 'pendiente' },
    });
    const res = await invoke(h.handler, { [field]: value });
    assert.equal(res.statusCode, 400);
    assert.equal(h.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
  });
}

test('acepta cuenta_corriente y vacío/null de método conserva compatibilidad como no-op', async () => {
  const accepted = buildHarness();
  assert.equal((await invoke(accepted.handler, { metodo_pago: 'cuenta_corriente' })).statusCode, 200);
  assert.match(accepted.calls.find(call => /UPDATE pedidos/.test(call.sql)).sql, /metodo_pago/);

  for (const value of ['', null]) {
    const h = buildHarness();
    const res = await invoke(h.handler, { metodo_pago: value });
    assert.equal(res.statusCode, 200);
    assert.equal(h.calls.some(call => /UPDATE pedidos/.test(call.sql)), false);
  }
});
