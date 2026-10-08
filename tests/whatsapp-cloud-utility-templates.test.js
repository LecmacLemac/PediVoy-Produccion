import test from 'node:test';
import assert from 'node:assert/strict';

const helpers = () => import('../src/whatsappCloud/utilityTemplates.js');
test('closed logical intent validates required strings and rejects hostile or extra data', async () => {
  const { buildOrderEnRouteIntent, validateUtilityTemplateIntent } = await helpers();
  const parameters = { customer_name: 'Ana', address: 'Calle 1', tracking_token: 'tok_123' };
  assert.deepEqual(buildOrderEnRouteIntent(parameters), { key: 'order_en_route', parameters });
  for (const bad of [null, [], { ...parameters, name: 'physical' }, { ...parameters, address: '' }, { ...parameters, address: 'x\u0000' }, { ...parameters, customer_name: 'x'.repeat(201) }, { ...parameters, tracking_token: 'https://evil.test' }, Object.create(parameters)]) {
    assert.throws(() => buildOrderEnRouteIntent(bad), { code: 'cloud_template_payload_invalid' });
  }
  for (const bad of [null, [], { key: 'unknown', parameters }, { key: 'order_en_route', parameters, language: 'es_AR' }]) {
    assert.throws(() => validateUtilityTemplateIntent(bad), { code: 'cloud_template_payload_invalid' });
  }
});

test('confirmation and transfer require every semantic field in exact body order', async () => {
  const h = await helpers();
  for (const [builder, key, fields] of [
    ['buildOrderConfirmationIntent', 'order_confirmation', ['customer_name', 'items_block', 'total', 'address', 'delivery_date', 'delivery_window', 'driver_name', 'driver_phone']],
    ['buildTransferPaymentIntent', 'transfer_payment', ['customer_name', 'amount', 'alias', 'cbu', 'bank', 'holder', 'company_name']],
  ]) {
    const parameters = Object.fromEntries(fields.map(f => [f, f]));
    assert.deepEqual(h[builder](parameters), { key, parameters });
    assert.deepEqual(h.UTILITY_TEMPLATE_FIELDS[key], fields);
    for (const field of fields) {
      const missing = { ...parameters }; delete missing[field];
      assert.throws(() => h[builder](missing), { code: 'cloud_template_payload_invalid' });
      for (const value of ['', [], {}, 'a\r', 'x'.repeat(601)]) assert.throws(() => h[builder]({ ...parameters, [field]: value }));
    }
  }
  assert.equal(h.buildOrderConfirmationIntent({ customer_name: 'Ana', items_block: 'a\nb', total: '$1', address: 'A', delivery_date: 'Hoy', delivery_window: 'AM', driver_name: 'B', driver_phone: '1' }).parameters.items_block, 'a\nb');
});

test('mapping is closed and canonical; components preserve body order and opaque URL button', async () => {
  const h = await helpers();
  assert.deepEqual(h.validateTemplateMapping({ name: ' approved_v1 ', language: ' es_AR ' }), { name: 'approved_v1', language: 'es_AR' });
  for (const bad of [null, [], {}, { name: 'UPPER', language: 'es_AR' }, { name: 'x', language: 'es' }, { name: 'x'.repeat(513), language: 'es_AR' }, { name: 'x', language: 'es_AR', components: [] }]) assert.throws(() => h.validateTemplateMapping(bad));
  for (const key of h.UTILITY_TEMPLATE_KEYS) {
    const fields = h.UTILITY_TEMPLATE_FIELDS[key];
    const parameters = Object.fromEntries(fields.map(f => [f, f]));
    const expected = [{ type: 'body', parameters: fields.filter(f => f !== 'tracking_token').map(text => ({ type: 'text', text })) }];
    if (key === 'order_en_route') expected.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'tracking_token' }] });
    assert.deepEqual(h.buildMetaTemplateComponents({ key, parameters }), expected);
  }
});

test('item block reserves whole omission line within 8 lines and 600 UTF-16 units', async () => {
  const { boundOrderItemsBlock } = await helpers();
  assert.equal(boundOrderItemsBlock(['1 x Agua — $1', '2 x Soda — $2']), '1 x Agua — $1\n2 x Soda — $2');
  assert.equal(boundOrderItemsBlock(Array.from({ length: 10 }, (_, i) => `item ${i}`)), 'item 0\nitem 1\nitem 2\nitem 3\nitem 4\nitem 5\nitem 6\n… y 3 productos más');
  assert.equal(boundOrderItemsBlock(['😀'.repeat(300), 'B']), '… y 2 productos más');
  assert.equal(boundOrderItemsBlock('A\r\nB'), 'A\nB');
  assert.equal(boundOrderItemsBlock(['x'.repeat(600)]), 'x'.repeat(600));
  for (const bad of [[], {}, [''], ['a\u0000'], ['\ud800']]) assert.throws(() => boundOrderItemsBlock(bad));
});
