import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueWppOutbox, enqueueWppTransferPaymentNotificationInTransaction } from '../src/wpp/enqueue.js';
import { empresaWhatsappConfigLockNamespace } from '../src/wpp/companyConfigLock.js';

function flag(t, value) {
  const previous = process.env.SCHEDULED_MENUS_ENABLED;
  if (value === undefined) delete process.env.SCHEDULED_MENUS_ENABLED;
  else process.env.SCHEDULED_MENUS_ENABLED = value;
  t.after(() => previous === undefined ? delete process.env.SCHEDULED_MENUS_ENABLED : process.env.SCHEDULED_MENUS_ENABLED = previous);
}
const input = { empresaId: 7, phone: '3515550000', message: 'Aviso sintético', notificationCorrelationId: 'transfer_payment:71' };
function fixture(lockResult) {
  const calls = [];
  const client = {
    async query(input, values) {
      const query = typeof input === 'string' ? { text: input, values } : input;
      calls.push(query);
      if (/pg_(?:try_)?advisory_xact_lock\(\$1::integer/.test(query.text)) return lockResult;
      if (/SELECT config_integraciones/.test(query.text)) return { rows: [{ config_integraciones: {} }] };
      if (/INSERT INTO wpp_outbox/.test(query.text)) return { rows: [{ id: 1, status: 'pending' }] };
      return { rows: [] };
    },
    release() { calls.push({ text: 'RELEASE' }); },
  };
  return { client, calls, connect: async () => client };
}

test('menús: configuración ocupada aborta con 40001 antes de leer config o escribir outbox; caller conserva rollback', async t => {
  flag(t, '1');
  const pool = fixture({ rows: [{ locked: false }] });
  await assert.rejects(enqueueWppTransferPaymentNotificationInTransaction(input, { client: pool.client, transactionOwner: 'caller' }), { code: '40001' });
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].text, 'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked');
  assert.deepEqual(pool.calls[0].values, [empresaWhatsappConfigLockNamespace, 7]);
});

for (const result of [{ rows: [] }, { rows: [null] }, { rows: { length: 1, 0: { locked: true } } }, { rows: [{ locked: 'true' }] }, { rows: [{ locked: 1 }] }, { rows: [{ locked: true }, { locked: true }] }, {}]) {
  test(`menús: resultado advisory malformado falla cerrado ${JSON.stringify(result)}`, async t => {
    flag(t, '1');
    const pool = fixture(result);
    await assert.rejects(enqueueWppTransferPaymentNotificationInTransaction(input, { client: pool.client, transactionOwner: 'caller' }), { code: '40001' });
    assert.equal(pool.calls.length, 1);
  });
}

test('menús: enqueue dueño hace rollback y libera conexión ante configuración ocupada', async t => {
  flag(t, '1');
  const pool = fixture({ rows: [{ locked: false }] });
  const { notificationCorrelationId, ...plain } = input;
  await assert.rejects(enqueueWppOutbox(plain, pool), { code: '40001' });
  assert.deepEqual(pool.calls.map(q => q.text), ['BEGIN', 'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked', 'ROLLBACK', 'RELEASE']);
});

for (const value of [undefined, '0', 'true']) {
  test(`flag-off ${value}: conserva exactamente advisory bloqueante legacy`, async t => {
    flag(t, value);
    const pool = fixture({ rows: [{ locked: null }] });
    const result = await enqueueWppTransferPaymentNotificationInTransaction(input, { client: pool.client, transactionOwner: 'caller' });
    assert.equal(result.queued, true);
    assert.equal(pool.calls[0].text, 'SELECT pg_advisory_xact_lock($1::integer, $2::integer) AS locked');
    assert.deepEqual(pool.calls[0].values, [empresaWhatsappConfigLockNamespace, 7]);
    assert.equal(pool.calls.some(q => /try_advisory/.test(q.text)), false);
  });
}

test('menús: true booleano admite lectura y encolado dentro de la transacción del caller', async t => {
  flag(t, '1');
  const pool = fixture({ rows: [{ locked: true }] });
  assert.equal((await enqueueWppTransferPaymentNotificationInTransaction(input, { client: pool.client, transactionOwner: 'caller' })).queued, true);
  assert.equal(pool.calls[0].text, 'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked');
  assert.equal(pool.calls.some(q => ['BEGIN', 'COMMIT', 'ROLLBACK', 'RELEASE'].includes(q.text)), false);
});
