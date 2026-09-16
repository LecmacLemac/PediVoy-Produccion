import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createGeneralControlRepository } from '../src/wpp/generalControlRepository.js';

function fakeQuery(results) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return results.shift();
  };
  return { calls, query };
}

test('initDb defines the General singleton control row idempotently', async () => {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS wpp_general_control/i);
  assert.match(sql, /id\s+BOOLEAN\s+PRIMARY KEY\s+DEFAULT TRUE\s+CHECK\s*\(id\)/i);
  for (const column of [
    'epoch', 'owner_id', 'state', 'heartbeat_at', 'operation', 'qr_code', 'last_error',
    'reset_requested_seq', 'reset_started_seq', 'reset_applied_seq', 'reset_failed_seq',
    'reset_requested_at', 'reset_started_at', 'reset_applied_at', 'reset_failed_at',
    'reset_failure_error', 'reset_requested_by', 'updated_at',
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(sql, /INSERT INTO wpp_general_control\s*\(id\)[\s\S]*ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
});

test('ensureSchema applies an idempotent schema contract on every call', async () => {
  const db = fakeQuery(Array.from({ length: 6 }, () => ({ rows: [], rowCount: 0 })));
  const repository = createGeneralControlRepository(db.query);

  await repository.ensureSchema();
  await repository.ensureSchema();

  assert.equal(db.calls.length, 6);
  for (const offset of [0, 3]) {
    assert.match(db.calls[offset].sql, /CREATE TABLE IF NOT EXISTS wpp_general_control/i);
    assert.match(db.calls[offset + 1].sql, /ADD COLUMN IF NOT EXISTS reset_failed_seq/i);
    assert.match(db.calls[offset + 1].sql, /ADD COLUMN IF NOT EXISTS reset_failure_error/i);
    assert.match(db.calls[offset + 2].sql, /ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
    assert.deepEqual(db.calls.slice(offset, offset + 3).map(call => call.params), [[], [], [true]]);
  }
});

test('publishOwner increments epoch atomically with parameterized owner data', async () => {
  const db = fakeQuery([{ rows: [{ epoch: '8', owner_id: 'owner-a' }], rowCount: 1 }]);
  const repository = createGeneralControlRepository(db.query);

  const row = await repository.publishOwner({ ownerId: 'owner-a', executor: { query: db.query } });

  assert.equal(row.epoch, 8n);
  assert.equal(row.owner_id, 'owner-a');
  assert.match(db.calls[0].sql, /epoch\s*=\s*epoch\s*\+\s*1/i);
  assert.deepEqual(db.calls[0].params, ['owner-a']);
  assert.doesNotMatch(db.calls[0].sql, /owner-a/);
});

test('owner writes are fenced and expose zero-row failure', async () => {
  const db = fakeQuery(Array.from({ length: 6 }, () => ({ rows: [], rowCount: 0 })));
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.heartbeat({ ownerId: 'stale', epoch: 3n }), false);
  assert.equal(await repository.updateOwned({ ownerId: 'stale', epoch: 3n, state: 'ready', operation: null }), false);
  assert.equal(await repository.markResetStarted({ ownerId: 'stale', epoch: 3n, sequence: 4n }), false);
  assert.equal(await repository.markResetApplied({ ownerId: 'stale', epoch: 3n, sequence: 4n }), false);
  assert.equal(await repository.markResetFailed({ ownerId: 'stale', epoch: 3n, sequence: 4n, error: 'boom' }), false);
  assert.equal(await repository.releaseOwner({ ownerId: 'stale', epoch: 3n }), false);
  for (const call of db.calls) {
    assert.match(call.sql, /owner_id\s*=\s*\$1[\s\S]*epoch\s*=\s*\$2/i);
    assert.deepEqual(call.params.slice(0, 2), ['stale', '3']);
  }
});

test('getClusterStatus normalizes persisted counters', async () => {
  const db = fakeQuery([{ rows: [{ epoch: '9', reset_requested_seq: '7', reset_failed_seq: '6' }], rowCount: 1 }]);
  const repository = createGeneralControlRepository(db.query);

  const status = await repository.getClusterStatus();

  assert.equal(status.epoch, 9n);
  assert.equal(status.reset_requested_seq, 7n);
  assert.equal(status.reset_failed_seq, 6n);
  assert.match(db.calls[0].sql, /WHERE id = \$1/i);
  assert.deepEqual(db.calls[0].params, [true]);
});

test('reset requests use one atomic globally monotonic sequence', async () => {
  const db = fakeQuery([
    { rows: [{ reset_requested_seq: '41' }], rowCount: 1 },
    { rows: [{ reset_requested_seq: '42' }], rowCount: 1 },
  ]);
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.requestReset({ requestedBy: 'admin-a' }), 41n);
  assert.equal(await repository.requestReset({ requestedBy: 'admin-b' }), 42n);
  for (const call of db.calls) {
    assert.match(call.sql, /reset_requested_seq\s*=\s*reset_requested_seq\s*\+\s*1/i);
    assert.match(call.sql, /RETURNING\s+reset_requested_seq/i);
  }
  assert.deepEqual(db.calls.map(call => call.params), [['admin-a'], ['admin-b']]);
});

test('pending reset persists started, failed, retried, and applied lifecycle', async () => {
  const pending = {
    reset_requested_seq: '42', reset_started_seq: '41', reset_applied_seq: '41', reset_failed_seq: '0',
  };
  const db = fakeQuery([
    { rows: [pending], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [pending], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = createGeneralControlRepository(db.query);

  assert.equal((await repository.loadPendingReset()).reset_requested_seq, 42n);
  assert.equal(await repository.markResetStarted({ ownerId: 'owner-a', epoch: 8n, sequence: 42n }), true);
  assert.equal(await repository.markResetFailed({ ownerId: 'owner-a', epoch: 8n, sequence: 42n, error: 'profile busy' }), true);
  assert.equal((await repository.loadPendingReset()).reset_requested_seq, 42n);
  assert.equal(await repository.markResetStarted({ ownerId: 'owner-a', epoch: 8n, sequence: 42n }), true);
  assert.equal(await repository.markResetApplied({ ownerId: 'owner-a', epoch: 8n, sequence: 42n }), true);
  assert.equal(await repository.loadPendingReset(), null);

  assert.match(db.calls[0].sql, /reset_requested_seq\s*>\s*reset_applied_seq/i);
  assert.match(db.calls[2].sql, /reset_failed_seq\s*=\s*\$3/i);
  assert.match(db.calls[2].sql, /reset_failure_error\s*=\s*\$4/i);
  assert.deepEqual(db.calls[2].params, ['owner-a', '8', '42', 'profile busy']);
  for (const call of [db.calls[1], db.calls[2], db.calls[4], db.calls[5]]) {
    assert.match(call.sql, /owner_id\s*=\s*\$1[\s\S]*epoch\s*=\s*\$2/i);
  }
});
