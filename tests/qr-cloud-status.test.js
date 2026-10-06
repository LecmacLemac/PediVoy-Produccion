import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../pedidos/qr.html', import.meta.url), 'utf8');

function companyWhatsappLoaderSource() {
  const start = source.indexOf('async function loadCompanyWhatsappQr');
  const end = source.indexOf('\n    function openCompanyIaEditor()', start);
  assert.ok(start >= 0 && end > start, 'loader de WhatsApp por empresa no encontrado');
  return source.slice(start, end);
}

function createElement(initial = {}) {
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    value: '',
    ...initial,
  };
}

function createHarness() {
  const qrBox = createElement();
  const result = createElement({ querySelector: selector => selector === '.public-qr-image' ? qrBox : null });
  const status = createElement();
  const text = createElement();
  const refreshState = createElement();
  const health = createElement();
  const metrics = createElement();
  const checklist = createElement();
  const refresh = createElement({ innerHTML: 'Actualizar' });
  const reset = createElement();
  const download = createElement();
  const copyWorker = createElement();
  const companySelect = createElement({ value: '1' });
  const elements = new Map([
    ['#publicQrEmpresa', companySelect],
    ['#companyWppResult', result],
    ['#companyWppStatus', status],
    ['#companyWppText', text],
    ['#companyWppRefreshState', refreshState],
    ['#companyWppHealth', health],
    ['#companyWppMetrics', metrics],
    ['#companyIaChecklist', checklist],
    ['#btnRefreshCompanyWpp', refresh],
    ['#btnResetCompanyWpp', reset],
    ['#btnDownloadCompanyWpp', download],
    ['#btnCopyWorkerCmd', copyWorker],
  ]);
  let scheduled = 0;
  const toasts = [];

  const context = {
    isCompanyWppLoading: false,
    currentCompanyWpp: null,
    $: selector => elements.get(selector) || null,
    stopCompanyWppRefresh() {},
    scheduleCompanyWppRefresh() { scheduled += 1; },
    authFetch: async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'WhatsApp administrado por Cloud; no usa QR ni sesión Web.',
        empresa_id: 1,
        status: 'cloud_managed',
      }),
    }),
    selectedCompany: () => ({ id: 1, nombre: 'AguaHidro.com' }),
    escapeHtml: value => String(value ?? ''),
    renderCompanyWppDetails() { throw new Error('no debe renderizar diagnóstico Web en modo Cloud'); },
    toast(message) { toasts.push(message); },
    console: { error() {} },
  };

  vm.runInNewContext(companyWhatsappLoaderSource(), context, { filename: 'qr-company-loader.js' });
  return {
    context,
    elements: { qrBox, status, text, refreshState, health, metrics, checklist, refresh, reset, download, copyWorker },
    scheduled: () => scheduled,
    toasts,
  };
}

test('empresa con WhatsApp Cloud muestra Cloud habilitado y no presenta QR Web', async () => {
  const harness = createHarness();

  await harness.context.loadCompanyWhatsappQr();

  assert.equal(harness.elements.status.textContent, 'Cloud habilitado');
  assert.match(harness.elements.status.className, /connected/);
  assert.match(harness.elements.qrBox.innerHTML, /Cloud API/i);
  assert.match(harness.elements.text.textContent, /no (usa|requiere) QR/i);
  assert.match(harness.elements.health.innerHTML, /WhatsApp Cloud activo/i);
  assert.match(harness.elements.metrics.innerHTML, /Canal/);
  assert.match(harness.elements.metrics.innerHTML, /Cloud/i);
  assert.equal(harness.elements.reset.disabled, true);
  assert.equal(harness.elements.download.disabled, true);
  assert.equal(harness.elements.copyWorker.disabled, true);
  assert.equal(harness.scheduled(), 0);
  assert.deepEqual(harness.toasts, []);
});
