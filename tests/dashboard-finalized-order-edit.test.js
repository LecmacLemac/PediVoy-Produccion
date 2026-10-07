import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFinalizedOrderControls,
  buildPedidoSavePlan,
  isPedidoFinalizado,
} from '../pedidos/dashboard-order-edit.js';

function control() {
  return { disabled: false, hidden: false, textContent: '' };
}

test('sólo entregado y cancelado se consideran finalizados', () => {
  assert.equal(isPedidoFinalizado('entregado'), true);
  assert.equal(isPedidoFinalizado('cancelado'), true);
  assert.equal(isPedidoFinalizado('pendiente'), false);
  assert.equal(isPedidoFinalizado('en_ruta'), false);
  assert.equal(isPedidoFinalizado('Entregado'), false);
});

test('finalizado omite items y estado/empresa pero envia metodo, chofer y zona', () => {
  const plan = buildPedidoSavePlan({
    finalized: true,
    items: [{ producto: 'Bidón 20L', cantidad: 2, precio_unitario: 1500 }],
    estado: 'pendiente',
    metodoPago: 'transferencia',
    empresaId: 99,
    choferId: 3,
    zonaId: 2,
  });

  assert.equal(plan.updateItems, false);
  assert.deepEqual(plan.pedidoBody, {
    metodo_pago: 'transferencia',
    chofer_id: 3,
    zona_id: 2,
  });
  assert.equal(Object.hasOwn(plan.pedidoBody, 'estado'), false);
  assert.equal(Object.hasOwn(plan.pedidoBody, 'empresa_id'), false);
});

test('no finalizado conserva items y actualizacion completa existente', () => {
  const items = [{ producto: 'Bidón 20L', cantidad: 2, precio_unitario: 1500 }];
  const plan = buildPedidoSavePlan({
    finalized: false,
    items,
    estado: 'entregado',
    metodoPago: 'efectivo',
    empresaId: 7,
    choferId: 3,
    zonaId: 2,
  });

  assert.equal(plan.updateItems, true);
  assert.deepEqual(plan.items, items);
  assert.deepEqual(plan.pedidoBody, {
    estado: 'entregado',
    metodo_pago: 'efectivo',
    empresa_id: 7,
    chofer_id: 3,
    zona_id: 2,
  });
});

test('controles de items, estado y empresa quedan bloqueados en finalizados', () => {
  const estado = control();
  const empresa = control();
  const addItem = control();
  const notice = control();
  notice.hidden = true;
  const itemControls = [control(), control(), control(), control()];
  const itemsBody = { querySelectorAll: () => itemControls };

  applyFinalizedOrderControls({
    finalized: true,
    estado,
    empresa,
    addItem,
    itemsBody,
    notice,
  });

  assert.equal(estado.disabled, true);
  assert.equal(empresa.disabled, true);
  assert.equal(addItem.disabled, true);
  assert.equal(itemControls.every((item) => item.disabled), true);
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /ítems quedan protegidos/i);
  assert.match(notice.textContent, /correcciones administrativas/i);
});
