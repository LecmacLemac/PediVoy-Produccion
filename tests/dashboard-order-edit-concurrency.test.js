import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createPedidoEditCoordinator } from '../pedidos/dashboard-order-edit.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('dos aperturas invertidas descartan respuestas obsoletas y guardan el contexto activo', async () => {
  const coordinator = createPedidoEditCoordinator();
  const firstItems = deferred();
  const secondItems = deferred();
  const applied = [];

  const first = coordinator.begin({ id: 41, finalized: true });
  const firstLoad = firstItems.promise.then(items => coordinator.commit(first, () => applied.push({ id: first.id, items })));

  const second = coordinator.begin({ id: 42, finalized: false });
  const secondLoad = secondItems.promise.then(items => coordinator.commit(second, () => applied.push({ id: second.id, items })));

  secondItems.resolve(['pedido-42']);
  await secondLoad;
  firstItems.resolve(['pedido-41']);
  await firstLoad;

  assert.deepEqual(applied, [{ id: 42, items: ['pedido-42'] }]);
  assert.deepEqual(coordinator.capture(), second);
  assert.equal(coordinator.capture().finalized, false);
});

test('contexto capturado de guardado no cambia si se abre otro pedido', () => {
  const coordinator = createPedidoEditCoordinator();
  coordinator.begin({ id: 41, finalized: true });
  const saveContext = coordinator.capture();
  coordinator.begin({ id: 42, finalized: false });

  assert.equal(saveContext.id, 41);
  assert.equal(saveContext.finalized, true);
  assert.equal(coordinator.isActive(saveContext), false);
});

for (const finalized of [false, true]) {
  test(`abrir A, luego B ${finalized ? 'finalizado' : 'no finalizado'} bloquea guardar durante carga y evita mezcla`, () => {
    const coordinator = createPedidoEditCoordinator();
    const applied = [];
    const saveRequests = [];
    const first = coordinator.begin({ id: 41, finalized: !finalized });
    const second = coordinator.begin({ id: 42, finalized });

    const attemptSave = () => {
      const context = coordinator.capture();
      if (!coordinator.canSave(context)) return false;
      saveRequests.push(context.id);
      return true;
    };

    assert.equal(attemptSave(), false);
    assert.deepEqual(saveRequests, []);
    assert.equal(coordinator.commit(first, () => applied.push('pedido-41')), false);
    assert.deepEqual(applied, []);

    assert.equal(coordinator.markReady(second), true);
    assert.equal(attemptSave(), true);
    assert.deepEqual(saveRequests, [42]);
    assert.deepEqual(coordinator.capture(), second);
  });
}

test('dashboard protege showModal, cargas y guardado con el contexto capturado', async () => {
  const source = await readFile(new URL('../pedidos/dashboard.html', import.meta.url), 'utf8');
  const openStart = source.indexOf('window.openPedido = async (id) => {');
  const saveStart = source.indexOf('btnSaveAll.onclick = async () => {');
  const openSource = source.slice(openStart, saveStart);
  const saveSource = source.slice(saveStart, source.indexOf('\n    function buildDashboardQueryParams()', saveStart));

  assert.match(openSource, /pedidoEditCoordinator\.begin/);
  assert.match(openSource, /setModalBusy\(true\)/);
  assert.match(openSource, /if \(!dlg\.open\) dlg\.showModal\(\)/);
  assert.match(openSource, /applyPedidoIdNameHints\(p\)/);
  assert.doesNotMatch(openSource, /await updatePedidoIdNameHints\(p\)/);
  assert.match(openSource, /pedidoEditCoordinator\.markReady\(editContext\)/);
  assert.ok((openSource.match(/pedidoEditCoordinator\.isActive\(editContext\)/g) || []).length >= 3);
  assert.match(saveSource, /const saveContext = pedidoEditCoordinator\.capture\(\)/);
  assert.match(saveSource, /pedidoEditCoordinator\.canSave\(saveContext\)/);
  assert.match(saveSource, /\/api\/pedidos\/\$\{savePedidoId\}/);
  assert.doesNotMatch(saveSource, /\/api\/pedidos\/\$\{editingId\}/);
});
