import test from 'node:test';
import assert from 'node:assert/strict';

import { pool, query, withTransaction } from '../src/db.js';

function poolWithClients(scenarios) {
  const clients = [];
  let connected = 0;
  return {
    clients,
    async connect() {
      const scenario = scenarios[connected++] || {};
      const calls = [];
      const client = {
        calls,
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (scenario.query) return scenario.query(sql, params, calls);
          return { rows: [] };
        },
        release(error) { calls.push({ sql: 'RELEASE', params: [], error }); },
      };
      clients.push(client);
      return client;
    },
  };
}

test('query revierte un batch BEGIN fallido antes de devolver la conexión al pool', async t => {
  const failure = Object.assign(new Error('lock timeout'), { code: '55P03' });
  const calls = [];
  let releasedWith;
  t.mock.method(pool, 'connect', async () => ({
    async query(sql) {
      calls.push(sql);
      if (/^BEGIN;/i.test(sql)) throw failure;
      return { rows: [] };
    },
    release(error) { releasedWith = error; },
  }));

  await assert.rejects(query('BEGIN; SELECT 1; COMMIT;'), error => error === failure);
  assert.deepEqual(calls, ['BEGIN; SELECT 1; COMMIT;', 'ROLLBACK']);
  assert.equal(releasedWith, undefined);
});

test('withTransaction usa una sola conexión y confirma el resultado', async () => {
  const transactionPool = poolWithClients([{
    query: async (sql) => sql === 'SELECT 42 AS value' ? { rows: [{ value: 42 }] } : { rows: [] },
  }]);

  const result = await withTransaction(async (txQuery) => {
    const rows = await txQuery('SELECT 42 AS value');
    return rows[0].value;
  }, { pool: transactionPool });

  assert.equal(result, 42);
  assert.deepEqual(transactionPool.clients[0].calls.map(({ sql }) => sql), [
    'BEGIN', 'SELECT 42 AS value', 'COMMIT', 'RELEASE',
  ]);
});

for (const code of ['40P01', '40001']) {
  test(`withTransaction revierte, libera y reintenta ${code} con una conexión nueva`, async () => {
    const retryableFailure = Object.assign(new Error(`retryable ${code}`), { code });
    const transactionPool = poolWithClients([
      { query: async (sql) => { if (sql === 'work') throw retryableFailure; return { rows: [] }; } },
      { query: async () => ({ rows: [{ ok: true }] }) },
    ]);
    let attempts = 0;

    const result = await withTransaction(async (txQuery) => {
      attempts += 1;
      const rows = await txQuery('work');
      return rows[0]?.ok;
    }, { pool: transactionPool, maxRetries: 1, retryDelayMs: 0 });

    assert.equal(result, true);
    assert.equal(attempts, 2);
    assert.deepEqual(transactionPool.clients[0].calls.map(({ sql }) => sql), ['BEGIN', 'work', 'ROLLBACK', 'RELEASE']);
    assert.deepEqual(transactionPool.clients[1].calls.map(({ sql }) => sql), ['BEGIN', 'work', 'COMMIT', 'RELEASE']);
  });
}

test('withTransaction no reintenta errores no serializables', async () => {
  const failure = Object.assign(new Error('constraint'), { code: '23514' });
  const transactionPool = poolWithClients([{ query: async (sql) => { if (sql === 'work') throw failure; return { rows: [] }; } }]);

  await assert.rejects(
    withTransaction(txQuery => txQuery('work'), { pool: transactionPool, maxRetries: 3, retryDelayMs: 0 }),
    error => error === failure,
  );
  assert.equal(transactionPool.clients.length, 1);
  assert.deepEqual(transactionPool.clients[0].calls.map(({ sql }) => sql), ['BEGIN', 'work', 'ROLLBACK', 'RELEASE']);
});

test('withTransaction keeps row queries and raw writes on one client until commit', async t => {
  const calls = [];
  const rows = [{ id: 1 }];
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows, rowCount: 1 };
    },
    release(error) { calls.push(['RELEASE', error]); },
  };
  const connect = t.mock.method(pool, 'connect', async () => client);
  t.mock.method(pool, 'query', () => assert.fail('Must use the transaction client'));
  const result = await withTransaction(async (txQuery, txClient) => {
    assert.equal(txClient, client);
    assert.equal(await txQuery('SELECT id FROM usuarios FOR SHARE'), rows);
    const write = await txClient.query('UPDATE usuarios SET activo=$1 RETURNING id', [false]);
    assert.equal(write.rowCount, 1);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(connect.mock.callCount(), 1);
  assert.deepEqual(calls, [
    ['BEGIN', undefined],
    ['SELECT id FROM usuarios FOR SHARE', []],
    ['UPDATE usuarios SET activo=$1 RETURNING id', [false]],
    ['COMMIT', undefined],
    ['RELEASE', undefined],
  ]);
});

for (const failureAt of ['BEGIN', 'WORK']) {
  test(`withTransaction rolls back and releases after ${failureAt} fails`, async t => {
    const failure = new Error(failureAt);
    const calls = [];
    t.mock.method(pool, 'connect', async () => ({
      async query(sql) {
        calls.push(sql);
        if (sql === failureAt) throw failure;
        return { rows: [] };
      },
      release(error) { calls.push(error ? ['RELEASE', error] : 'RELEASE'); },
    }));
    await assert.rejects(withTransaction(async txQuery => {
      await txQuery('WORK');
    }), error => error === failure);
    const expected = ['BEGIN', 'WORK', 'COMMIT'];
    assert.deepEqual(calls, [...expected.slice(0, expected.indexOf(failureAt) + 1), 'ROLLBACK', 'RELEASE']);
  });
}

test('withTransaction trata una falla de COMMIT como resultado desconocido sin rollback ni reintento', async () => {
  const commitFailure = Object.assign(new Error('duplicate customer email: persona@example.com'), {
    code: '40001',
  });
  const transactionPool = poolWithClients([{
    query: async (sql) => {
      if (sql === 'COMMIT') throw commitFailure;
      return { rows: [] };
    },
  }]);
  let attempts = 0;

  await assert.rejects(
    withTransaction(async () => {
      attempts += 1;
      return 'possibly-committed';
    }, { pool: transactionPool, maxRetries: 3, retryDelayMs: 0 }),
    error => {
      assert.equal(error.code, 'TRANSACTION_OUTCOME_UNKNOWN');
      assert.equal(error.message, 'No se pudo confirmar el resultado de la transacción');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.doesNotMatch(String(error.stack), /persona@example\.com|duplicate customer email/);
      return true;
    },
  );

  assert.equal(attempts, 1);
  assert.equal(transactionPool.clients.length, 1);
  assert.deepEqual(transactionPool.clients[0].calls.map(({ sql }) => sql), [
    'BEGIN', 'COMMIT', 'RELEASE',
  ]);
  assert.equal(transactionPool.clients[0].calls.at(-1).error, commitFailure);
});

test('withTransaction preserves the original error and discards a client when rollback fails', async t => {
  const failure = new Error('write failed');
  const rollbackFailure = new Error('rollback failed');
  let releasedWith;
  t.mock.method(pool, 'connect', async () => ({
    async query(sql) {
      if (sql === 'ROLLBACK') throw rollbackFailure;
      return { rows: [] };
    },
    release(error) { releasedWith = error; },
  }));
  await assert.rejects(withTransaction(async () => { throw failure; }), error => error === failure);
  assert.equal(releasedWith, rollbackFailure);
});
