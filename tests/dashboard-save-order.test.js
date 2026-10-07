import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../pedidos/dashboard.html', import.meta.url), 'utf8');

function saveHandlerSource() {
  const start = source.indexOf('btnSaveAll.onclick = async () => {');
  const end = source.indexOf('\n    function buildDashboardQueryParams()', start);
  assert.ok(start >= 0 && end > start, 'handler de guardado no encontrado');
  return source.slice(start, end);
}

function createHarness({ finalized = false, pedidoResponse } = {}) {
  const requests = [];
  const errors = [];
  let closed = false;
  let activeContext = { id: 42, finalized };
  const busyStates = [];

  const inputs = [
    { value: 'Bidón 20L' },
    { value: '2' },
    { value: '1500' },
  ];
  const row = {
    classList: { add() {}, remove() {} },
    querySelectorAll(selector) {
      assert.equal(selector, 'input');
      return inputs;
    },
    querySelector() {
      return { focus() {} };
    },
  };
  const fields = new Map([
    ['#dlg_empresa_id', { value: '7' }],
    ['#dlg_chofer_id', { value: '3' }],
    ['#dlg_zona_id', { value: '2' }],
    ['#dlg_estado', { value: 'entregado' }],
    ['#dlg_metodo', { value: 'efectivo' }],
  ]);

  const context = {
    saveBusy: false,
    editingId: 42,
    editingPedidoFinalizado: finalized,
    pedidoEditCoordinator: {
      capture: () => activeContext,
      isActive: context => context === activeContext,
      canSave: context => context === activeContext,
    },
    dlg_itemsBody: { querySelectorAll: () => [row] },
    btnSaveAll: { textContent: 'Guardar' },
    dlg: { close() { closed = true; } },
    $: selector => fields.get(selector),
    setDialogError(message) { errors.push(message); },
    setModalBusy(value) { busyStates.push(value); },
    parseErrorResponse: async (_response, fallback) => fallback,
    authFetch: async (url, options) => {
      requests.push({ url, options });
      if (pedidoResponse) return pedidoResponse;
      return { ok: true };
    },
    showToast() {},
    loadPedidos: async () => {},
    applyFilters() {},
    buildPedidoSavePlan({ items, estado, metodoPago, empresaId, choferId, zonaId }) {
      return finalized
        ? {
            pedidoBody: { metodo_pago: metodoPago, chofer_id: choferId, zona_id: zonaId },
          }
        : {
            pedidoBody: {
              items,
              estado,
              metodo_pago: metodoPago,
              chofer_id: choferId,
              zona_id: zonaId,
            },
          };
    },
  };

  vm.runInNewContext(saveHandlerSource(), context, { filename: 'dashboard-save-handler.js' });
  return {
    context,
    requests,
    errors,
    busyStates,
    replaceActiveContext(next) { activeContext = next; },
    wasClosed: () => closed,
  };
}

test('pedido no finalizado se guarda con exactamente un request atómico', async () => {
  const harness = createHarness();

  await harness.context.btnSaveAll.onclick();

  assert.deepEqual(
    harness.requests.map(request => request.url),
    ['/api/pedidos/42'],
  );
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), {
    items: [{ producto: 'Bidón 20L', cantidad: 2, precio_unitario: 1500 }],
    estado: 'entregado',
    metodo_pago: 'efectivo',
    chofer_id: 3,
    zona_id: 2,
  });
  assert.equal(harness.wasClosed(), true);
});

test('un error del guardado atómico muestra un único error sin segundo request', async () => {
  const harness = createHarness({ pedidoResponse: { ok: false } });

  await harness.context.btnSaveAll.onclick();

  assert.deepEqual(harness.requests.map(request => request.url), ['/api/pedidos/42']);
  assert.match(harness.errors.at(-1), /No se pudo actualizar el pedido/);
  assert.equal(harness.wasClosed(), false);
});

test('al corregir un pedido finalizado omite PUT items y envía sólo campos administrativos', async () => {
  const harness = createHarness({ finalized: true });

  await harness.context.btnSaveAll.onclick();

  assert.deepEqual(harness.requests.map(request => request.url), ['/api/pedidos/42']);
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), {
    metodo_pago: 'efectivo',
    chofer_id: 3,
    zona_id: 2,
  });
  assert.equal(harness.wasClosed(), true);
});

test('respuesta fallida obsoleta no pisa el error ni libera el modal del pedido activo', async () => {
  let resolvePedido;
  const pedidoResponse = new Promise(resolve => { resolvePedido = resolve; });
  const harness = createHarness({ finalized: true, pedidoResponse });

  const staleSave = harness.context.btnSaveAll.onclick();
  await Promise.resolve();
  harness.replaceActiveContext({ id: 43, finalized: false });
  resolvePedido({ ok: false });
  await staleSave;

  assert.deepEqual(harness.errors, ['']);
  assert.deepEqual(harness.busyStates, [true]);
  assert.equal(harness.wasClosed(), false);
});
