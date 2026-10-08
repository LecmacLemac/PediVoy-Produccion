import test from 'node:test';
import assert from 'node:assert/strict';

import { enqueueAlquilerWhatsapp } from '../src/adm/alquileresController.js';
import { encolarMensajeWhatsapp } from '../src/estrategias.js';
import { queueFacturaWhatsapp } from '../src/services/facturaDeliveryService.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

function getInsertValuesByColumn(insert) {
  const columnsMatch = insert.text.match(/INSERT INTO wpp_outbox\s*\(([^)]+)\)/i);
  const valuesMatch = insert.text.match(/VALUES\s*\(([\s\S]*?)\)\s*RETURNING/i);
  assert.ok(columnsMatch, 'el INSERT declara columnas de wpp_outbox');
  assert.ok(valuesMatch, 'el INSERT declara valores antes de RETURNING');

  const columns = columnsMatch[1].split(',').map(column => column.trim());
  const expressions = valuesMatch[1].split(',').map(expression => expression.trim());
  assert.equal(expressions.length, columns.length);

  return Object.fromEntries(columns.map((column, index) => {
    const placeholder = expressions[index].match(/^\$(\d+)/);
    return [column, placeholder ? insert.values[Number(placeholder[1]) - 1] : expressions[index]];
  }));
}

for (const [name, run, expectedWindow] of [
  ['estrategias', pool => encolarMensajeWhatsapp(7, '3515550000', 'campaña', pool), 24 * 60],
  ['alquileres', pool => enqueueAlquilerWhatsapp({ empresaId: 7, telefono: '3515550000', mensaje: 'recordatorio alquiler' }, pool), 10],
  ['factura', pool => queueFacturaWhatsapp(pool, {
    empresaId: 7,
    telefono: '3515550000',
    factura: {
      tipo_comprobante: 'Factura C', punto_venta: 1, numero_comprobante: 2,
      receptor_razon_social: 'Cliente', importe_total: 100, cae: '123',
    },
    publicUrl: 'https://example.test/public/facturas/1/pdf?token=test',
  }), 5],
]) {
  test(`${name}: productor usa la frontera transaccional y conserva su ventana`, async () => {
    const pool = createWppEnqueueTestPool({
      configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:token' } },
    });
    const result = await run(pool);
    const recent = pool.calls.find(call => /FROM wpp_outbox/.test(call.text) && !/INSERT INTO/.test(call.text));
    const insert = pool.calls.find(call => /INSERT INTO wpp_outbox/.test(call.text));

    assert.equal(result.queued, true);
    assert.equal(result.transportOrigin, 'cloud');
    assert.equal(recent.values[4], expectedWindow);
    assert.equal(recent.sensitive, true);
    assert.equal(insert.sensitive, true);
    assert.equal(pool.calls[0].text, 'BEGIN');
    assert.equal(pool.calls.at(-1).text, 'COMMIT');
  });
}

test('productor propaga COMMIT ambiguo sin reintentar ni duplicar el INSERT', async () => {
  let inserts = 0;
  const pool = createWppEnqueueTestPool({
    onQuery: async ({ text }) => {
      if (/INSERT INTO wpp_outbox/.test(text)) inserts += 1;
      if (text === 'COMMIT') throw new Error('commit result unavailable');
      if (text === 'ROLLBACK') assert.fail('no debe hacer rollback después de intentar COMMIT');
      return undefined;
    },
  });

  await assert.rejects(
    encolarMensajeWhatsapp(7, '3515550000', 'campaña commit ambiguo', pool),
    error => error?.code === 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN',
  );
  assert.equal(inserts, 1);
  assert.equal(pool.calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), false);
});

test('estrategias conserva contrato duplicate_24h al usar dedupe compartida', async () => {
  const pool = createWppEnqueueTestPool({
    recentRows: [{ id: 70, status: 'pending', transport_origin: 'company' }],
  });
  const result = await encolarMensajeWhatsapp(7, '3515550000', 'campaña', pool);
  assert.equal(result.queued, false);
  assert.equal(result.reason, 'duplicate_24h');
});

test('alquileres conserva contrato duplicate_10m al usar dedupe compartida', async () => {
  const pool = createWppEnqueueTestPool({
    recentRows: [{ id: 71, status: 'pending', transport_origin: 'company' }],
  });
  const result = await enqueueAlquilerWhatsapp({
    empresaId: 7,
    telefono: '3515550000',
    mensaje: 'recordatorio alquiler',
  }, pool);
  assert.equal(result.queued, false);
  assert.equal(result.reason, 'duplicate_10m');
});

test('messaging forwards logical utility intent and rejects caller Graph metadata', async () => {
  const { enqueueWppMessage } = await import('../src/services/messaging.js');
  const pool = createWppEnqueueTestPool({ configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'p', access_token_encrypted: 'e' } } });
  const utility_template = { key: 'order_en_route', parameters: { customer_name: 'Ana', address: 'A', tracking_token: 'tok' } };
  await enqueueWppMessage({ empresa_id: 7, phone: '3515550000', message: 'Web', utility_template }, pool);
  const inserted = getInsertValuesByColumn(pool.calls.find(c => /INSERT INTO/.test(c.text)));
  assert.equal(inserted.notification_correlation_id, null);
  assert.equal(inserted.cloud_template_key, 'order_en_route');
  for (const extra of [
    { name: 'physical' },
    { language: 'es_AR' },
    { transport_origin: 'cloud' },
    { components: [] },
    { empresaId: 8 },
  ]) {
    const before = pool.calls.length;
    await assert.rejects(enqueueWppMessage({ empresa_id: 7, phone: '3515550000', message: 'Web', ...extra }, pool), { code: 'cloud_template_payload_invalid' });
    assert.equal(pool.calls.length, before);
  }
});

test('messaging exposes producer-specific required-template wrappers without a policy token', async () => {
  const messaging = await import('../src/services/messaging.js');
  const cases = [
    ['enqueueOrderConfirmationWppMessage', 'order_confirmation', 'order_confirmation:101', {
      customer_name: 'Ana', items_block: '1 x Agua — $ 1', total: '$ 1', address: 'A',
      delivery_date: 'Jueves 8', delivery_window: 'A coordinar', driver_name: 'A asignar', driver_phone: 'No informado',
    }],
    ['enqueueOrderEnRouteWppMessage', 'order_en_route', 'order_en_route:102', { customer_name: 'Ana', address: 'A', tracking_token: 'tok' }],
    ['enqueueTransferPaymentWppMessage', 'transfer_payment', 'transfer_payment:103', {
      customer_name: 'Ana', amount: '$ 1', alias: 'A', cbu: '1', bank: 'B', holder: 'H', company_name: 'E',
    }],
  ];
  for (const [name, key, notificationCorrelationId, parameters] of cases) {
    assert.equal(typeof messaging[name], 'function');
    const pool = createWppEnqueueTestPool({
      configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'p', access_token_encrypted: 'e' } },
    });
    await messaging[name]({
      empresa_id: 7,
      phone: '3515550000',
      message: 'Web',
      notification_correlation_id: notificationCorrelationId,
      utility_template: { key, parameters },
    }, pool);
    const inserted = getInsertValuesByColumn(pool.calls.find(call => /INSERT INTO/.test(call.text)));
    assert.equal(inserted.notification_correlation_id, notificationCorrelationId);
    assert.equal(inserted.cloud_template_key, key);
  }
  assert.equal(Object.keys(messaging).some(name => /capability|token/i.test(name)), false);
});

test('messaging proactive wrappers reject a missing durable notification identity before DB', async () => {
  const messaging = await import('../src/services/messaging.js');
  for (const name of [
    'enqueueOrderConfirmationWppMessage',
    'enqueueOrderEnRouteWppMessage',
    'enqueueTransferPaymentWppMessage',
  ]) {
    const pool = createWppEnqueueTestPool();
    await assert.rejects(
      messaging[name]({ empresa_id: 7, phone: '3515550000', message: 'Web' }, pool),
      { code: 'notification_correlation_id_requerido' },
    );
    assert.equal(pool.calls.length, 0);
  }
});

test('messaging generic API rejects caller-controlled required-template flags before DB', async () => {
  const { enqueueWppMessage } = await import('../src/services/messaging.js');
  for (const extra of [{ require_utility_template: true }, { requireUtilityTemplate: true }]) {
    const pool = createWppEnqueueTestPool();
    await assert.rejects(
      enqueueWppMessage({ empresa_id: 7, phone: '3515550000', message: 'Web', ...extra }, pool),
      { code: 'cloud_template_payload_invalid' },
    );
    assert.equal(pool.calls.length, 0);
  }
});
