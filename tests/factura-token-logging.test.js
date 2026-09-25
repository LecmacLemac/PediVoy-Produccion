import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../src/db.js';
import { queueFacturaWhatsapp } from '../src/services/facturaDeliveryService.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

test('sensitive outbox DB failure never logs capability in parameters or error text', async () => {
  const originalConnect = pool.connect;
  const originalError = console.error;
  const logs = [];
  const tokenMarker = 'capability-must-not-be-logged';
  pool.connect = async () => { throw new Error(`failing row: ${tokenMarker}`); };
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(query('INSERT INTO wpp_outbox', [tokenMarker], { sensitive: true }));
    assert.ok(!JSON.stringify(logs).includes(tokenMarker));
  } finally { pool.connect = originalConnect; console.error = originalError; }
});

test('invoice queue marks token-bearing DB call sensitive and hides downstream errors', async () => {
  let sensitive;
  const transactionPool = createWppEnqueueTestPool({
    onQuery(request) {
      if (/INSERT INTO wpp_outbox/.test(request.text)) {
        sensitive = request.sensitive;
        throw new Error('token-secret-from-driver');
      }
      return undefined;
    },
  });
  await assert.rejects(queueFacturaWhatsapp(transactionPool, { empresaId: 7, telefono: '123456', factura: {}, publicUrl: 'https://example.test/public/facturas/10/pdf?token=test' }),
  error => !error.message.includes('token-secret-from-driver'));
  assert.equal(sensitive, true);
});
