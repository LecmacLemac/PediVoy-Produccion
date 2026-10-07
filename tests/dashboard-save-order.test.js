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

function createHarness({ itemsOk = true, finalized = false } = {}) {
  const requests = [];
  const errors = [];
  let closed = false;

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
    dlg_itemsBody: { querySelectorAll: () => [row] },
    btnSaveAll: { textContent: 'Guardar' },
    dlg: { close() { closed = true; } },
    $: selector => fields.get(selector),
    setDialogError(message) { errors.push(message); },
    setModalBusy() {},
    parseErrorResponse: async (_response, fallback) => fallback,
    authFetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/items')) return { ok: itemsOk };
      return { ok: true };
    },
    showToast() {},
    loadPedidos: async () => {},
    applyFilters() {},
    buildPedidoSavePlan({ items, estado, metodoPago, empresaId, choferId, zonaId }) {
      return finalized
        ? {
            updateItems: false,
            pedidoBody: { metodo_pago: metodoPago, chofer_id: choferId, zona_id: zonaId },
          }
        : {
            updateItems: true,
            items,
            pedidoBody: {
              estado,
              metodo_pago: metodoPago,
              empresa_id: empresaId,
              chofer_id: choferId,
              zona_id: zonaId,
            },
          };
    },
  };

  vm.runInNewContext(saveHandlerSource(), context, { filename: 'dashboard-save-handler.js' });
  return { context, requests, errors, wasClosed: () => closed };
}

test('al finalizar un pedido guarda los ítems antes de enviar estado entregado', async () => {
  const harness = createHarness();

  await harness.context.btnSaveAll.onclick();

  assert.deepEqual(
    harness.requests.map(request => request.url),
    ['/api/pedidos/42/items', '/api/pedidos/42'],
  );
  assert.equal(JSON.parse(harness.requests[1].options.body).estado, 'entregado');
  assert.equal(harness.wasClosed(), true);
});

test('si falla el guardado de ítems no envía la finalización del pedido', async () => {
  const harness = createHarness({ itemsOk: false });

  await harness.context.btnSaveAll.onclick();

  assert.deepEqual(harness.requests.map(request => request.url), ['/api/pedidos/42/items']);
  assert.match(harness.errors.at(-1), /No se pudieron actualizar los ítems/);
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
