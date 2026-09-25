import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhatsappPhone } from '../src/core/format.js';
import { normalizeWppOutboxPayload } from '../src/wpp/enqueue.js';

const cases = [
  ['3534277739', '5493534277739'],
  ['353 427 7739', '5493534277739'],
  ['03534277739', '5493534277739'],
  ['+54 9 353 427 7739', '5493534277739'],
  ['54 9 353 427 7739', '5493534277739'],
  ['5493534277739', '5493534277739'],
  ['54 353 427 7739', '5493534277739'],
  ['353 15 427 7739', '5493534277739'],
  ['0353 15 427 7739', '5493534277739'],
  ['3534277739@c.us', '5493534277739'],
];

test('normalizeWhatsappPhone canonicaliza números argentinos para WhatsApp', () => {
  for (const [input, expected] of cases) {
    assert.equal(normalizeWhatsappPhone(input), expected, input);
  }
});

test('normalizeWhatsappPhone no inventa destino si faltan dígitos', () => {
  assert.equal(normalizeWhatsappPhone('4277739'), '4277739');
  assert.equal(normalizeWhatsappPhone('1534277739'), '1534277739');
  assert.equal(normalizeWhatsappPhone(''), '');
});

test('frontera compartida de outbox usa normalización WhatsApp centralizada', () => {
  assert.deepEqual(normalizeWppOutboxPayload({ phone: '353 427 7739', message: ' hola ' }), {
    phone: '5493534277739',
    message: 'hola',
  });
  assert.deepEqual(normalizeWppOutboxPayload({ phone: '987654321098765@lid', message: 'respuesta' }), {
    phone: '987654321098765@lid',
    message: 'respuesta',
  });
});
