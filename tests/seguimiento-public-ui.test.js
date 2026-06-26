import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../pedidos/seguimiento.html', import.meta.url), 'utf8');

function loadHelpers() {
  const match = html.match(/\/\/ BEGIN seguimiento public helpers([\s\S]*?)\/\/ END seguimiento public helpers/);
  assert.ok(match, 'helper block should be present');
  const context = { helpers: null };
  vm.runInNewContext(`
    const DRIVER_STALE_AFTER_SECONDS = 5 * 60;
    const TRACKING_STEPS = [
      { key: 'recibido', label: 'Recibido' },
      { key: 'confirmado', label: 'Confirmado' },
      { key: 'preparando', label: 'Preparando' },
      { key: 'asignado', label: 'Asignado' },
      { key: 'en_camino', label: 'En camino' },
      { key: 'entregado', label: 'Entregado' }
    ];
    const CANCELLED_STEPS = [
      { key: 'recibido', label: 'Recibido' },
      { key: 'cancelado', label: 'Cancelado' }
    ];
    ${match[1]}
    helpers = {
      normalizeOrderState,
      estadoUi,
      progressStateFor,
      paymentMethodLabel,
      paymentStatusText,
      hasUsableCoordinates,
      shouldUseDriverLocation,
      visibleItemSummary
    };
  `, context);
  return context.helpers;
}

test('seguimiento público permite zoom del navegador y tiene recuperación visible', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/);
  assert.match(html, /id="retryButton"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Retry-After/);
  assert.match(html, /id="toggleDetails"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /seguimiento:pedido:compact:v1/);
});

test('seguimiento público muestra pago desde backend y oculta GPS desactualizado', () => {
  assert.match(html, /pago_estado/);
  assert.match(html, /renderPayment/);
  assert.match(html, /DRIVER_STALE_AFTER_SECONDS = 5 \* 60/);
  assert.match(html, /location_status/);
});

test('seguimiento público mapea estados reales a textos y progreso claros', () => {
  const helpers = loadHelpers();

  assert.equal(helpers.normalizeOrderState('pendiente'), 'recibido');
  assert.equal(helpers.normalizeOrderState('en_ruta'), 'en_camino');
  assert.equal(helpers.estadoUi('preparacion').detail, 'Estamos preparando tu pedido.');
  assert.equal(helpers.estadoUi('entregado').detail, 'Pedido entregado. Gracias por elegirnos.');

  const progress = helpers.progressStateFor('en_camino');
  assert.deepEqual(Array.from(progress.steps, (step) => step.key), [
    'recibido',
    'confirmado',
    'preparando',
    'asignado',
    'en_camino',
    'entregado'
  ]);
  assert.equal(progress.currentIndex, 4);

  const cancelled = helpers.progressStateFor('cancelado');
  assert.deepEqual(Array.from(cancelled.steps, (step) => step.key), ['recibido', 'cancelado']);
  assert.equal(cancelled.currentIndex, 1);
});

test('seguimiento público etiqueta pagos, resume productos y valida coordenadas', () => {
  const helpers = loadHelpers();
  const items = Array.from({ length: 8 }, (_, index) => ({ producto: `Producto ${index + 1}`, cantidad: 1 }));

  assert.equal(helpers.paymentMethodLabel('qr_dinamico'), 'QR / Mercado Pago');
  assert.equal(helpers.paymentMethodLabel('cuenta_corriente'), 'Cuenta corriente');
  assert.equal(helpers.paymentStatusText('acreditado').text, 'Pago validado y acreditado.');

  const collapsed = helpers.visibleItemSummary(items, false, 6);
  assert.equal(collapsed.visibleItems.length, 6);
  assert.equal(collapsed.hiddenCount, 2);

  const expanded = helpers.visibleItemSummary(items, true, 6);
  assert.equal(expanded.visibleItems.length, 8);
  assert.equal(expanded.hiddenCount, 0);

  assert.equal(helpers.hasUsableCoordinates('-32.4', '-63.2'), true);
  assert.equal(helpers.hasUsableCoordinates('', '-63.2'), false);
  assert.equal(helpers.shouldUseDriverLocation({ latitud: '-32.4', longitud: '-63.2', location_age_seconds: 120 }), true);
  assert.equal(helpers.shouldUseDriverLocation({ latitud: '-32.4', longitud: '-63.2', location_age_seconds: 900 }), false);
});
