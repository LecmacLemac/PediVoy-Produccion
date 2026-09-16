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
    'reset_requested_seq', 'reset_started_seq', 'reset_applied_seq',
    'reset_requested_at', 'reset_started_at', 'reset_applied_at', 'reset_requested_by', 'updated_at',
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(sql, /INSERT INTO wpp_general_control\s*\(id\)[\s\S]*ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
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
  const db = fakeQuery([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = createGeneralControlRepository(db.query);

  assert.equal(await repository.heartbeat({ ownerId: 'stale', epoch: 3n }), false);
  assert.equal(await repository.updateOwned({ ownerId: 'stale', epoch: 3n, state: 'ready', operation: null }), false);
  for (const call of db.calls) {
    assert.match(call.sql, /owner_id\s*=\s*\$1[\s\S]*epoch\s*=\s*\$2/i);
    assert.deepEqual(call.params.slice(0, 2), ['stale', '3']);
  }
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
