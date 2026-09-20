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

function statefulResetQuery(overrides = {}) {
  const row = {
    owner_id: 'owner-a',
    epoch: 8n,
    operation: 'reset',
    reset_requested_seq: 42n,
    reset_started_seq: 42n,
    reset_applied_seq: 41n,
    reset_failed_seq: 0n,
    reset_failure_error: null,
    ...overrides,
  };
  const calls = [];
  const ownsAttempt = (sql, params) => {
    const [ownerId, epoch, sequence] = params;
    return row.owner_id === ownerId
      && row.epoch === BigInt(epoch)
      && row.reset_started_seq === BigInt(sequence)
      && row.reset_applied_seq < BigInt(sequence)
      && (!/operation\s*=\s*'reset'/i.test(sql) || row.operation === 'reset');
  };
  const query = async (sql, params) => {
    calls.push({ sql, params });
    const sequence = BigInt(params[2]);
    if (/UPDATE wpp_general_control\s+SET\s+reset_started_seq\s*=\s*\$3/i.test(sql)) {
      const ownsControl = row.owner_id === params[0] && row.epoch === BigInt(params[1]);
      const canStart = row.reset_started_seq < sequence
        || (row.reset_started_seq === sequence
          && row.reset_failed_seq === sequence
          && row.reset_failure_error !== null);
      if (!ownsControl
        || !canStart
        || row.reset_applied_seq >= sequence
        || row.reset_requested_seq < sequence) {
        return { rows: [], rowCount: 0 };
      }
      row.reset_started_seq = sequence;
      row.reset_failure_error = null;
      row.operation = 'reset';
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE wpp_general_control\s+SET\s+reset_failed_seq\s*=\s*\$3/i.test(sql)) {
      if (!ownsAttempt(sql, params)) return { rows: [], rowCount: 0 };
      row.reset_failed_seq = sequence;
      row.reset_failure_error = params[3];
      row.operation = null;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE wpp_general_control\s+SET\s+reset_applied_seq\s*=\s*\$3/i.test(sql)) {
      if (!ownsAttempt(sql, params)) return { rows: [], rowCount: 0 };
      row.reset_applied_seq = sequence;
      row.reset_failure_error = null;
      row.operation = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unsupported stateful reset query: ${sql}`);
  };
  return { calls, query, row };
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

test('owner boolean writes work with default query helpers that return rows only', async () => {
  const db = fakeQuery(Array.from({ length: 6 }, () => [{ ok: 1 }]));
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.heartbeat({ ownerId: 'owner-a', epoch: 3n }), true);
  assert.equal(await repository.updateOwned({ ownerId: 'owner-a', epoch: 3n, state: 'ready', operation: null }), true);
  assert.equal(await repository.markResetStarted({ ownerId: 'owner-a', epoch: 3n, sequence: 4n }), true);
  assert.equal(await repository.markResetApplied({ ownerId: 'owner-a', epoch: 3n, sequence: 4n }), true);
  assert.equal(await repository.markResetFailed({ ownerId: 'owner-a', epoch: 3n, sequence: 4n, error: 'boom' }), true);
  assert.equal(await repository.releaseOwner({ ownerId: 'owner-a', epoch: 3n }), true);
  for (const call of db.calls) {
    assert.match(call.sql, /RETURNING\s+1\s+AS\s+ok/i);
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

  assert.deepEqual(await repository.requestReset({ requestedBy: 'admin-a' }), {
    accepted: true,
    sequence: 41n,
  });
  assert.deepEqual(await repository.requestReset({ requestedBy: 'admin-b' }), {
    accepted: true,
    sequence: 42n,
  });
  for (const call of db.calls) {
    assert.match(call.sql, /reset_requested_seq\s*=\s*reset_requested_seq\s*\+\s*1/i);
    assert.match(call.sql, /RETURNING\s+reset_requested_seq/i);
  }
  assert.deepEqual(db.calls.map(call => call.params), [['admin-a'], ['admin-b']]);
});

test('stale reset completion cannot finish after a newer reset starts', async () => {
  const db = fakeQuery([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.markResetApplied({ ownerId: 'owner-a', epoch: 8n, sequence: 41n }), false);
  assert.equal(await repository.markResetFailed({ ownerId: 'owner-a', epoch: 8n, sequence: 41n, error: 'late' }), false);

  for (const call of db.calls) {
    assert.match(call.sql, /reset_started_seq\s*=\s*\$3/i);
    assert.doesNotMatch(call.sql, /reset_started_seq\s*>=\s*\$3/i);
  }
});

test('duplicate initial reset start is rejected unless the same sequence has a failure marker', async () => {
  const db = fakeQuery([{ rows: [], rowCount: 0 }]);
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.markResetStarted({ ownerId: 'owner-a', epoch: 8n, sequence: 42n }), false);

  assert.match(
    db.calls[0].sql,
    /reset_started_seq\s*<\s*\$3\s+OR\s*\(\s*reset_started_seq\s*=\s*\$3\s+AND\s+reset_failed_seq\s*=\s*\$3\s+AND\s+reset_failure_error\s+IS\s+NOT\s+NULL\s*\)/i,
  );
});

test('accepted reset retry consumes its failure marker so a duplicate retry is rejected', async () => {
  const db = fakeQuery([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = createGeneralControlRepository(db.query);
  const input = { ownerId: 'owner-a', epoch: 8n, sequence: 42n };

  assert.equal(await repository.markResetStarted(input), true);
  assert.equal(await repository.markResetStarted(input), false);

  for (const call of db.calls) {
    assert.match(call.sql, /SET[\s\S]*reset_failed_at\s*=\s*NULL/i);
    assert.match(call.sql, /SET[\s\S]*reset_failure_error\s*=\s*NULL/i);
    assert.match(call.sql, /reset_failure_error\s+IS\s+NOT\s+NULL/i);
  }
});

test('a reset can fail again after its accepted retry', async () => {
  const db = fakeQuery([{ rows: [], rowCount: 1 }]);
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.markResetFailed({
    ownerId: 'owner-a', epoch: 8n, sequence: 42n, error: 'retry failed',
  }), true);

  assert.match(db.calls[0].sql, /SET[\s\S]*reset_failed_seq\s*=\s*\$3/i);
  assert.match(db.calls[0].sql, /reset_failure_error\s*=\s*\$4/i);
  assert.match(db.calls[0].sql, /reset_started_seq\s*=\s*\$3/i);
  assert.deepEqual(db.calls[0].params, ['owner-a', '8', '42', 'retry failed']);
});

test('an active reset failure succeeds once and a duplicate failure is rejected', async () => {
  const db = statefulResetQuery();
  const repository = createGeneralControlRepository(db.query);
  const input = { ownerId: 'owner-a', epoch: 8n, sequence: 42n, error: 'profile busy' };

  assert.equal(await repository.markResetFailed(input), true);
  assert.equal(await repository.markResetFailed(input), false);
  assert.equal(db.row.operation, null);
  assert.equal(db.row.reset_failed_seq, 42n);
});

test('a failed reset cannot be marked applied without an accepted retry', async () => {
  const db = statefulResetQuery();
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.markResetFailed({
    ownerId: 'owner-a', epoch: 8n, sequence: 42n, error: 'profile busy',
  }), true);
  assert.equal(await repository.markResetApplied({
    ownerId: 'owner-a', epoch: 8n, sequence: 42n,
  }), false);
  assert.equal(db.row.reset_applied_seq, 41n);
});

test('an accepted retry re-enters reset and can be applied exactly once', async () => {
  const db = statefulResetQuery({
    operation: null,
    reset_failed_seq: 42n,
    reset_failure_error: 'profile busy',
  });
  const repository = createGeneralControlRepository(db.query);
  const input = { ownerId: 'owner-a', epoch: 8n, sequence: 42n };

  assert.equal(await repository.markResetStarted(input), true);
  assert.equal(db.row.operation, 'reset');
  assert.equal(db.row.reset_failure_error, null);
  assert.equal(await repository.markResetApplied(input), true);
  assert.equal(await repository.markResetApplied(input), false);
  assert.equal(db.row.reset_applied_seq, 42n);
});

test('an accepted retry re-enters reset and can fail exactly once', async () => {
  const db = statefulResetQuery({
    operation: null,
    reset_failed_seq: 42n,
    reset_failure_error: 'profile busy',
  });
  const repository = createGeneralControlRepository(db.query);
  const input = { ownerId: 'owner-a', epoch: 8n, sequence: 42n };

  assert.equal(await repository.markResetStarted(input), true);
  assert.equal(db.row.operation, 'reset');
  assert.equal(await repository.markResetFailed({ ...input, error: 'retry failed' }), true);
  assert.equal(await repository.markResetFailed({ ...input, error: 'retry failed' }), false);
  assert.equal(db.row.reset_failure_error, 'retry failed');
});

test('terminal reset transitions reject a stale exact sequence', async () => {
  const db = statefulResetQuery();
  const repository = createGeneralControlRepository(db.query);
  const stale = { ownerId: 'owner-a', epoch: 8n, sequence: 41n };

  assert.equal(await repository.markResetApplied(stale), false);
  assert.equal(await repository.markResetFailed({ ...stale, error: 'late' }), false);
  assert.equal(db.row.operation, 'reset');
  assert.equal(db.row.reset_applied_seq, 41n);
  assert.equal(db.row.reset_failed_seq, 0n);
});

function assertLegacyUpgradeContract(sql) {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS id\s+BOOLEAN/i);
  assert.match(sql, /UPDATE wpp_general_control[\s\S]*id\s*=\s*COALESCE\s*\(\s*id\s*,\s*TRUE\s*\)/i);
  for (const [column, fallback] of [
    ['epoch', '0'],
    ['state', "'standby'"],
    ['reset_requested_seq', '0'],
    ['reset_started_seq', '0'],
    ['reset_applied_seq', '0'],
    ['reset_failed_seq', '0'],
  ]) {
    assert.match(sql, new RegExp(`${column}\\s*=\\s*COALESCE\\s*\\(\\s*${column}\\s*,\\s*${fallback}\\s*\\)`, 'i'));
    assert.match(sql, new RegExp(`ALTER COLUMN ${column} SET DEFAULT[\\s\\S]*ALTER COLUMN ${column} SET NOT NULL`, 'i'));
  }
  assert.match(sql, /ALTER COLUMN id SET DEFAULT TRUE[\s\S]*ALTER COLUMN id SET NOT NULL/i);
  assert.match(sql, /ALTER COLUMN updated_at SET DEFAULT NOW\(\)[\s\S]*ALTER COLUMN updated_at SET NOT NULL/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS wpp_general_control_singleton_id_uidx[\s\S]*\(id\)/i);
  assert.match(sql, /wpp_general_control_singleton_id[\s\S]*pg_get_constraintdef\s*\(\s*oid\s*\)[\s\S]*DROP CONSTRAINT IF EXISTS wpp_general_control_singleton_id/i);
  assert.match(sql, /IF NOT EXISTS[\s\S]*wpp_general_reset_sequence_order[\s\S]*reset_failed_seq\s*<=\s*reset_started_seq/i);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS wpp_general_reset_sequence_order[\s\S]*ADD CONSTRAINT wpp_general_reset_sequence_order/i);
}

test('legacy singleton schema upgrade enforces the full contract in runtime SQL', async () => {
  const db = fakeQuery(Array.from({ length: 3 }, () => ({ rows: [], rowCount: 0 })));
  const repository = createGeneralControlRepository(db.query);

  await repository.ensureSchema();

  assertLegacyUpgradeContract(db.calls[1].sql);
  assert.deepEqual(db.calls.map(call => call.params), [[], [], [true]]);
});

test('legacy singleton schema upgrade enforces the full contract in initDb', async () => {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  assertLegacyUpgradeContract(sql);
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
