import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../pedidos/estadisticas-core.js', import.meta.url), 'utf8');

class FakeElement {
  constructor({ value = '', textContent = '', hidden = false } = {}) {
    this.value = value;
    this.textContent = textContent;
    this.hidden = hidden;
    this.options = [];
    this.selectedIndex = 0;
    this.listeners = {};
  }
  replaceChildren(...options) {
    this.options = options;
    const selected = options.findIndex((option) => option.selected);
    this.selectedIndex = selected >= 0 ? selected : 0;
    this.value = options[this.selectedIndex]?.value || '';
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
}

function jsonResponse(body, status = 200) {
  return {
    status,
    async text() { return JSON.stringify(body); },
  };
}

function buildHarness(me) {
  const elements = new Map([
    ['#empSel', new FakeElement()],
    ['#empWrap', new FakeElement()],
    ['#rolePill', new FakeElement()],
    ['#summaryEmpresa', new FakeElement()],
    ['#summaryPeriodo', new FakeElement()],
    ['#summaryChofer', new FakeElement()],
    ['#summaryEstado', new FakeElement()],
    ['#fFilChofer', new FakeElement()],
    ['#fFrom', new FakeElement()],
    ['#fTo', new FakeElement()],
    ['#btnCalcular', new FakeElement()],
    ['#btnExport', new FakeElement()],
    ['#tbBody', new FakeElement()],
  ]);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url === '/api/me') return jsonResponse({ user: me });
    if (url === '/api/empresas') return jsonResponse([
      { id: 1, nombre: 'Empresa Uno' },
      { id: 7, nombre: 'Empresa Siete' },
    ]);
    if (url.startsWith('/api/choferes')) return jsonResponse([]);
    if (url.startsWith('/api/productos')) return jsonResponse([]);
    throw new Error(`URL inesperada: ${url}`);
  };
  const document = {
    querySelector(selector) { return elements.get(selector) || null; },
    getElementById(id) { return elements.get(`#${id}`) || null; },
    createElement() { return new FakeElement(); },
  };
  const window = {};
  const context = {
    window,
    document,
    fetch,
    location: { href: '' },
    console,
    Map,
    Date,
    setTimeout,
    dateISO: () => '2026-09-15',
    calcular() {},
    exportCSV() {},
    openTransferModal() {},
  };
  vm.runInNewContext(source, context, { filename: 'estadisticas-core.js' });
  return { window, elements, calls };
}

test('super global sin empresa_id carga todas las empresas y selecciona la primera', async () => {
  const { window, elements, calls } = buildHarness({ role: 'super', empresa_id: null });

  await window.initEstadisticasCore();

  assert.ok(calls.includes('/api/empresas'));
  assert.deepEqual(
    elements.get('#empSel').options.map((option) => [option.value, option.textContent]),
    [['1', 'ID: 1 - Empresa Uno'], ['7', 'ID: 7 - Empresa Siete']],
  );
  assert.equal(elements.get('#empWrap').hidden, false);
  assert.equal(window.__estadisticasCore.isSuper, true);
});

test('usuario tenant requiere empresa_id positiva', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const { window, calls } = buildHarness({ role: 'admin', empresa_id: null });
    await window.initEstadisticasCore();
    assert.deepEqual(calls, ['/api/me']);
    assert.ok(errors.some((args) => String(args[1]?.message || '').includes('Sesión inválida')));
  } finally {
    console.error = originalError;
  }
});
