import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureCompanyWorkerSchema,
  withCompanySchemaLock,
} from '../src/wpp/companySchema.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createAdvisoryLockPool(events) {
  let owner = null;
  const waiters = [];
  let nextClientId = 0;

  function acquire(clientId) {
    if (owner === null) {
      owner = clientId;
      return Promise.resolve();
    }
    return new Promise(resolve => waiters.push({ clientId, resolve }));
  }

  function unlock(clientId) {
    assert.equal(owner, clientId);
    const next = waiters.shift();
    if (next) {
      owner = next.clientId;
      next.resolve();
    } else {
      owner = null;
    }
  }

  return {
    async connect() {
      const clientId = ++nextClientId;
      return {
        async query(sql, params = []) {
          if (/pg_advisory_lock/.test(sql) && !/unlock/.test(sql)) {
            events.push(`client-${clientId}:lock-wait`);
            await acquire(clientId);
            events.push(`client-${clientId}:lock-acquired`);
            return { rows: [] };
          }
          if (/pg_advisory_unlock/.test(sql)) {
            events.push(`client-${clientId}:unlock`);
            unlock(clientId);
            return { rows: [{ unlocked: true }] };
          }
          events.push(`client-${clientId}:${sql}`);
          return { rows: [] };
        },
        release(error) {
          events.push(`client-${clientId}:release:${error?.message || 'clean'}`);
        },
      };
    },
  };
}

test('company schema migrations are globally serialized across concurrent workers', async () => {
  const events = [];
  const pool = createAdvisoryLockPool(events);
  const firstEntered = deferred();
  const finishFirst = deferred();
  let activeMigrations = 0;
  let maxActiveMigrations = 0;

  const first = withCompanySchemaLock({
    pool,
    migrate: async query => {
      activeMigrations += 1;
      maxActiveMigrations = Math.max(maxActiveMigrations, activeMigrations);
      events.push('migration-1:start');
      firstEntered.resolve();
      await finishFirst.promise;
      await query('migration-1');
      events.push('migration-1:end');
      activeMigrations -= 1;
    },
  });

  await firstEntered.promise;
  const second = withCompanySchemaLock({
    pool,
    migrate: async query => {
      activeMigrations += 1;
      maxActiveMigrations = Math.max(maxActiveMigrations, activeMigrations);
      events.push('migration-2:start');
      await query('migration-2');
      events.push('migration-2:end');
      activeMigrations -= 1;
    },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.includes('migration-2:start'), false);

  finishFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(maxActiveMigrations, 1);
  assert.ok(events.indexOf('migration-1:end') < events.indexOf('migration-2:start'));
  assert.deepEqual(events.filter(event => event.includes(':release:')), [
    'client-1:release:clean',
    'client-2:release:clean',
  ]);
});

test('company schema migration failure rolls back before unlocking and releases a clean client', async () => {
  const failure = new Error('tuple concurrently updated');
  const calls = [];
  let transactionState = 'idle';
  let releasedWith;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql === 'BEGIN') transactionState = 'open';
          if (sql === 'broken migration') {
            transactionState = 'aborted';
            throw failure;
          }
          if (sql === 'ROLLBACK') transactionState = 'idle';
          if (/pg_advisory_unlock/.test(sql)) {
            assert.equal(transactionState, 'idle');
            return { rows: [{ unlocked: true }] };
          }
          return { rows: [] };
        },
        release(error) {
          releasedWith = error;
          assert.equal(transactionState, 'idle');
          calls.push('RELEASE');
        },
      };
    },
  };

  await assert.rejects(
    withCompanySchemaLock({
      pool,
      migrate: async query => {
        await query('BEGIN');
        await query('broken migration');
      },
    }),
    error => error === failure,
  );

  assert.equal(releasedWith, undefined);
  assert.deepEqual(calls.slice(-3), [
    'ROLLBACK',
    'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
    'RELEASE',
  ]);
});

test('company schema migration discards the client when rollback cleanup fails', async () => {
  const failure = new Error('migration failed');
  const rollbackFailure = new Error('rollback failed');
  const calls = [];
  let releasedWith;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql === 'broken migration') throw failure;
          if (sql === 'ROLLBACK') throw rollbackFailure;
          if (/pg_advisory_unlock/.test(sql)) return { rows: [{ unlocked: true }] };
          return { rows: [] };
        },
        release(error) {
          releasedWith = error;
          calls.push('RELEASE');
        },
      };
    },
  };

  await assert.rejects(
    withCompanySchemaLock({
      pool,
      migrate: query => query('broken migration'),
    }),
    error => error === failure,
  );

  assert.equal(releasedWith, rollbackFailure);
  assert.deepEqual(calls.slice(-3), [
    'ROLLBACK',
    'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
    'RELEASE',
  ]);
});

test('company worker runs every schema prerequisite through the locked dedicated client', async () => {
  const calls = [];
  let connectCount = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    },
    release(error) { calls.push({ sql: 'RELEASE', error }); },
  };
  const pool = {
    async connect() {
      connectCount += 1;
      return client;
    },
  };

  await ensureCompanyWorkerSchema({ pool });

  assert.equal(connectCount, 1);
  const sql = calls.map(call => call.sql).join('\n');
  assert.match(sql, /ALTER TABLE empresas[\s\S]*wpp_qr_code/i);
  assert.match(sql, /ALTER TABLE wpp_outbox[\s\S]*claim_owner/i);
  assert.match(sql, /ALTER TABLE comprobantes_transferencia[\s\S]*source_message_id/i);
  assert.match(sql, /BEGIN;[\s\S]*comprobante_operacion_claims[\s\S]*COMMIT;/i);
  assert.deepEqual(calls.slice(-2).map(call => call.sql), [
    'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
    'RELEASE',
  ]);
});
