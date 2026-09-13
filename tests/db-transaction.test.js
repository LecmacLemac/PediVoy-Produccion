import test from 'node:test';
import assert from 'node:assert/strict';

import { withTransaction } from '../src/db.js';

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
        release() { calls.push({ sql: 'RELEASE', params: [] }); },
      };
      clients.push(client);
      return client;
    },
  };
}

test('withTransaction usa una sola conexión y confirma el resultado', async () => {
  const pool = poolWithClients([{
    query: async (sql) => sql === 'SELECT 42 AS value' ? { rows: [{ value: 42 }] } : { rows: [] },
  }]);

  const result = await withTransaction(async (txQuery) => {
    const rows = await txQuery('SELECT 42 AS value');
    return rows[0].value;
  }, { pool });

  assert.equal(result, 42);
  assert.deepEqual(pool.clients[0].calls.map(({ sql }) => sql), [
    'BEGIN', 'SELECT 42 AS value', 'COMMIT', 'RELEASE',
  ]);
});

test('withTransaction revierte, libera y reintenta 40P01 con una conexión nueva', async () => {
  const deadlock = Object.assign(new Error('deadlock'), { code: '40P01' });
  const pool = poolWithClients([
    { query: async (sql) => { if (sql === 'work') throw deadlock; return { rows: [] }; } },
    { query: async () => ({ rows: [{ ok: true }] }) },
  ]);
  let attempts = 0;

  const result = await withTransaction(async (txQuery) => {
    attempts += 1;
    const rows = await txQuery('work');
    return rows[0]?.ok;
  }, { pool, maxRetries: 1, retryDelayMs: 0 });

  assert.equal(result, true);
  assert.equal(attempts, 2);
  assert.deepEqual(pool.clients[0].calls.map(({ sql }) => sql), ['BEGIN', 'work', 'ROLLBACK', 'RELEASE']);
  assert.deepEqual(pool.clients[1].calls.map(({ sql }) => sql), ['BEGIN', 'work', 'COMMIT', 'RELEASE']);
});

test('withTransaction no reintenta errores no serializables', async () => {
  const failure = Object.assign(new Error('constraint'), { code: '23514' });
  const pool = poolWithClients([{ query: async (sql) => { if (sql === 'work') throw failure; return { rows: [] }; } }]);

  await assert.rejects(
    withTransaction(txQuery => txQuery('work'), { pool, maxRetries: 3, retryDelayMs: 0 }),
    error => error === failure,
  );
  assert.equal(pool.clients.length, 1);
  assert.deepEqual(pool.clients[0].calls.map(({ sql }) => sql), ['BEGIN', 'work', 'ROLLBACK', 'RELEASE']);
});
