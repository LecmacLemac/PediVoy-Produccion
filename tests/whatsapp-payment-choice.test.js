import test from 'node:test';
import assert from 'node:assert/strict';

import { createWhatsAppCloudEventHandler } from '../src/whatsappCloud/eventRepository.js';
import { createWhatsAppCloudInboundConsumer } from '../src/whatsappCloud/inboundConsumer.js';
import { createWhatsAppCloudGraphClient } from '../src/whatsappCloud/graphClient.js';
import { buildMetaTemplateComponents } from '../src/whatsappCloud/utilityTemplates.js';

const VALID_INBOUND_ID = 'wamid.payment.inbound-1';
const VALID_CONTEXT_ID = 'wamid.order.confirmation-1';

function event(overrides = {}) {
  return {
    kind: 'message',
    entryId: 'waba-1',
    phoneNumberId: 'phone-1',
    message: {
      id: VALID_INBOUND_ID,
      from: '5493515550001',
      timestamp: '1770000000',
      type: 'button',
      context: { id: VALID_CONTEXT_ID, from: '5493515559999' },
      button: { payload: 'pedivoy_payment_cash_v1', text: 'Efectivo' },
      ...overrides,
    },
  };
}

function eventHandlerHarness() {
  const inserts = [];
  const handler = createWhatsAppCloudEventHandler({
    withTransaction: async work => work(async (sql, params) => {
      if (/FROM empresas/.test(sql)) return [{ empresa_id: 7 }];
      if (/INSERT INTO whatsapp_cloud_events/.test(sql)) {
        inserts.push(params);
        return [{ id: 1 }];
      }
      throw new Error('unexpected query');
    }),
  });
  return { handler, inserts };
}

test('webhook sanitiza button de pago y conserva provider/context IDs exactos sin PII de texto', async () => {
  const { handler, inserts } = eventHandlerHarness();
  assert.deepEqual(await handler([event()]), { accepted: 1, duplicates: 0 });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][3], VALID_INBOUND_ID);
  assert.equal(inserts[0][5], null);
  assert.equal(inserts[0][7], 'button');
  assert.deepEqual(inserts[0][10], {
    button: { payload: 'pedivoy_payment_cash_v1' },
    context: { id: VALID_CONTEXT_ID },
  });
  assert.doesNotMatch(JSON.stringify(inserts[0][10]), /Efectivo|5493515559999/);
});

test('webhook rechaza payload/context/provider IDs alterados y no relaja otros tipos', async () => {
  const invalidMessages = [
    { button: { payload: ' pedivoy_payment_cash_v1', text: 'Efectivo' } },
    { button: { payload: 'pedivoy_payment_cash_v1 ', text: 'Efectivo' } },
    { button: { payload: 'efectivo', text: 'Efectivo' } },
    { button: { payload: 'pedivoy_payment_cash_v1', text: 'Efectivo' }, context: { id: ` ${VALID_CONTEXT_ID}` } },
    { button: { payload: 'pedivoy_payment_cash_v1', text: 'Efectivo' }, context: { id: `${VALID_CONTEXT_ID} ` } },
    { id: ` ${VALID_INBOUND_ID}` },
  ];
  for (const override of invalidMessages) {
    const { handler, inserts } = eventHandlerHarness();
    await assert.rejects(handler([event(override)]), { code: 'invalid_event' });
    assert.equal(inserts.length, 0);
  }
});

test('consumer enruta button sólo al procesador de selección y no al bot de texto', async () => {
  const calls = [];
  const finishes = [];
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'payment-choice-worker',
    claimNext: async () => ({
      id: 91,
      empresa_id: 7,
      message_id: VALID_INBOUND_ID,
      sender_id: '5493515550001',
      message_type: 'button',
      event_data: {
        button: { payload: 'pedivoy_payment_transfer_v1' },
        context: { id: VALID_CONTEXT_ID },
      },
      phone_number_id: 'phone-1',
    }),
    loadTenant: async () => ({ empresaId: 7 }),
    startProcessing: async () => calls.push('start'),
    renewLease: async () => true,
    finish: async update => finishes.push(update),
    processBotMessage: async () => assert.fail('button no debe entrar al bot de texto'),
    processPaymentChoice: async input => {
      calls.push('choice');
      assert.deepEqual({
        empresaId: input.empresaId,
        inboundMessageId: input.messageId,
        outboundMessageId: input.contextMessageId,
        payload: input.buttonPayload,
      }, {
        empresaId: 7,
        inboundMessageId: VALID_INBOUND_ID,
        outboundMessageId: VALID_CONTEXT_ID,
        payload: 'pedivoy_payment_transfer_v1',
      });
      await input.assertLease();
      return { handled: true, outcome: 'accepted' };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(await consumer.processOnce(), { outcome: 'processed', eventId: 91 });
  assert.deepEqual(calls, ['start', 'choice']);
  assert.deepEqual(finishes, [{ id: 91, owner: 'payment-choice-worker', state: 'processed', errorCode: null }]);
});

test('Graph agrega payloads quick reply literales sólo para la plantilla física V3', async () => {
  const requests = [];
  const client = createWhatsAppCloudGraphClient({
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.payment.sent-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const parameters = {
    customer_name: 'Ana', items_block: '1 x Agua', total: '$ 1', address: 'Calle 1',
    delivery_date: 'Hoy', delivery_window: '9 a 12', driver_name: 'Juan', driver_phone: '3515550000',
  };
  const components = buildMetaTemplateComponents({ key: 'order_confirmation', parameters });
  const base = { phoneNumberId: '123', accessToken: 'secret', to: '3515550000' };

  await client.sendTemplate({ ...base, template: { name: 'pedivoy_order_confirmation_v3', language: 'es_AR', components } });
  assert.deepEqual(requests[0].template.components.slice(1), [
    { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'pedivoy_payment_cash_v1' }] },
    { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'pedivoy_payment_transfer_v1' }] },
  ]);
  assert.doesNotMatch(JSON.stringify(requests[0].template.components.slice(1)), /Ana|3515550000|Calle 1/);

  await client.sendTemplate({ ...base, template: { name: 'pedivoy_order_confirmation_v2', language: 'es_AR', components } });
  assert.equal(requests[1].template.components.length, 1);
});
