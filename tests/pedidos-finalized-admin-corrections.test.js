import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function buildHandler({ currentPedido, onUpdate, sideEffects = {}, superUser = false }) {
  const calls = [];
  const handler = createUpdatePedidoHandler({
    withTransactionFn: async (work) => work(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM usuarios')) return [{
        id: superUser ? 6 : 5,
        role: superUser ? 'super' : 'admin',
        empresa_id: superUser ? null : 7,
        activo: true,
      }];
      if (sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) return [currentPedido];
      if (sql.includes('FROM choferes')) return [{ id: 9 }];
      if (sql.includes('FROM zonas_geograficas')) return [{ id: 4 }];
      if (sql.includes('UPDATE pedidos')) return onUpdate?.(sql, params) ?? [{ ...currentPedido }];
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
    isSuperFn: () => superUser,
    getEmpresaIdFromTokenFn: () => 7,
    notifyEstadoFn: sideEffects.notifyEstadoFn || (() => Promise.resolve()),
    notifyEnRutaFn: sideEffects.notifyEnRutaFn || (() => Promise.resolve()),
    awardPointsFn: sideEffects.awardPointsFn || (() => Promise.resolve()),
    generateComisionesFn: sideEffects.generateComisionesFn || (() => Promise.resolve()),
    postEntregaFn: sideEffects.postEntregaFn || (() => Promise.resolve()),
  });
  return { handler, calls };
}

async function invoke(handler, body, { superUser = false } = {}) {
  const req = {
    params: { id: '42' },
    body,
    user: superUser ? { uid: 6, role: 'super', empresa_id: null } : { uid: 5, role: 'admin', empresa_id: 7 },
  };
  const res = responseHarness();
  await handler(req, res);
  return res;
}

test('backend permite correccion administrativa tenant-scoped de pedido finalizado', async () => {
  const currentPedido = {
    id: 42,
    empresa_id: 7,
    punto_entrega_id: 12,
    monto: 3000,
    estado: 'entregado',
  };
  const { handler, calls } = buildHandler({
    currentPedido,
    onUpdate(sql, params) {
      assert.doesNotMatch(sql, /estado\s*=/);
      assert.doesNotMatch(sql.split('WHERE')[0], /empresa_id\s*=/);
      assert.match(sql, /metodo_pago\s*=/);
      assert.match(sql, /chofer_id\s*=/);
      assert.match(sql, /zona_id\s*=/);
      assert.deepEqual(params, ['transferencia', 9, 4, 42, 7]);
      return [{ ...currentPedido, metodo_pago: 'transferencia', chofer_id: 9, zona_id: 4 }];
    },
  });

  const res = await invoke(handler, { metodo_pago: 'transferencia', chofer_id: 9, zona_id: 4 });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true });
  const select = calls.find(call => call.sql.includes('FROM pedidos') && call.sql.includes('FOR UPDATE'));
  assert.deepEqual(select.params, [42, 7]);
});

const finalizedPedido = {
  id: 42,
  empresa_id: 7,
  punto_entrega_id: 12,
  monto: 3000,
  estado: 'entregado',
};

const finalizedNoOps = [
  ['estado canónico actual', { estado: 'entregado' }],
  ['estado null', { estado: null }],
  ['estado omitido', {}],
  ['empresa_id entero actual', { empresa_id: 7 }],
  ['empresa_id null', { empresa_id: null }],
  ['empresa_id omitido', {}],
];

for (const superUser of [false, true]) {
  const role = superUser ? 'super' : 'admin';
  for (const [description, fields] of finalizedNoOps) {
    test(`${role} permite ${description} en finalizado sin escribir estado ni empresa`, async () => {
      const { handler, calls } = buildHandler({
        currentPedido: finalizedPedido,
        superUser,
        onUpdate(sql, params) {
          assert.doesNotMatch(sql, /estado\s*=/);
          assert.doesNotMatch(sql.split('WHERE')[0], /empresa_id\s*=/);
          assert.match(sql, /metodo_pago\s*=/);
          assert.deepEqual(params, ['transferencia', 42, 7]);
          return [{ ...finalizedPedido, metodo_pago: 'transferencia' }];
        },
      });

      const res = await invoke(handler, { ...fields, metodo_pago: 'transferencia' }, { superUser });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.payload, { ok: true });
      const select = calls.find(call => call.sql.includes('FROM pedidos') && call.sql.includes('FOR UPDATE'));
      assert.deepEqual(select.params, [42, superUser ? null : 7]);
    });
  }
}

for (const superUser of [false, true]) {
  const role = superUser ? 'super' : 'admin';
  for (const [field, value] of [['estado', 'pendiente'], ['empresa_id', 8]]) {
    test(`${role} rechaza cambiar ${field} de finalizado sin mutacion parcial`, async () => {
      const { handler, calls } = buildHandler({
        currentPedido: { id: 42, empresa_id: 7, estado: 'cancelado', monto: 0, punto_entrega_id: null },
        superUser,
        onUpdate() {
          assert.fail('no debe ejecutar UPDATE');
        },
      });

      const res = await invoke(
        handler,
        { metodo_pago: 'efectivo', chofer_id: 9, zona_id: 4, [field]: value },
        { superUser }
      );

      assert.equal(res.statusCode, 409);
      assert.match(res.payload.error, field === 'estado' ? /finalizado/i : /tenant/i);
      assert.equal(calls.some(call => call.sql.includes('UPDATE pedidos')), false);
    });
  }
}

const nonCanonicalFinalizedChanges = [
  ['estado con mayúsculas', 'estado', 'ENTREGADO'],
  ['estado con espacios', 'estado', ' entregado '],
  ['empresa_id string decimal', 'empresa_id', '7'],
  ['empresa_id string ambiguo', 'empresa_id', '07'],
  ['empresa_id basura', 'empresa_id', '7x'],
];

for (const superUser of [false, true]) {
  const role = superUser ? 'super' : 'admin';
  for (const [description, field, value] of nonCanonicalFinalizedChanges) {
    test(`${role} rechaza ${description} en finalizado sin escrituras`, async () => {
      const { handler, calls } = buildHandler({
        currentPedido: finalizedPedido,
        superUser,
        onUpdate() {
          assert.fail('no debe ejecutar UPDATE');
        },
      });

      const res = await invoke(
        handler,
        { metodo_pago: 'efectivo', [field]: value },
        { superUser }
      );

      assert.equal(res.statusCode, 409);
      assert.match(res.payload.error, /finalizado|tenant/i);
      assert.equal(calls.some(call => call.sql.includes('UPDATE pedidos')), false);
    });
  }
}

test('pedido no finalizado conserva la actualizacion existente y side effects solo si cambia estado', async () => {
  let notifications = 0;
  const { handler } = buildHandler({
    currentPedido: { id: 42, empresa_id: 7, estado: 'pendiente', monto: 3000, punto_entrega_id: 12 },
    sideEffects: {
      notifyEstadoFn: () => { notifications += 1; return Promise.resolve(); },
    },
    onUpdate(sql, params) {
      assert.doesNotMatch(sql, /estado\s*=/);
      assert.match(sql, /metodo_pago\s*=/);
      assert.match(sql, /chofer_id\s*=/);
      assert.match(sql, /zona_id\s*=/);
      assert.deepEqual(params, ['efectivo', 9, 4, 42, 7]);
      return [{ id: 42, empresa_id: 7, estado: 'pendiente', monto: 3000, punto_entrega_id: 12 }];
    },
  });

  const res = await invoke(handler, {
    estado: 'pendiente',
    metodo_pago: 'efectivo',
    chofer_id: 9,
    zona_id: 4,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(notifications, 0);
});
