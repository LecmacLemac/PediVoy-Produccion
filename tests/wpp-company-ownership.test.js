import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createCompanyOwnership, CompanyOwnershipLostError } from '../src/wpp/companyOwnership.js';

function makeClient({ locked = true } = {}) {
  const calls = [];
  const releases = [];
  const client = Object.assign(new EventEmitter(), {
    calls,
    releases,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked }] };
      if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }] };
      if (/SELECT 1/i.test(sql)) return { rows: [{ '?column?': 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release(error) { releases.push(error); },
  });
  return client;
}

const makePool = client => ({ connect: async () => client });

test('company ownership uses a dedicated two-key advisory lock', async () => {
  const client = makeClient();
  const ownership = createCompanyOwnership({ pool: makePool(client), empresaId: 42 });

  assert.equal(await ownership.tryAcquire(), true);
  assert.equal(ownership.isOwner, true);
  assert.match(client.calls[0].sql, /pg_try_advisory_lock\(\$1, \$2\)/i);
  assert.equal(client.calls[0].params[1], 42);
  assert.equal(client.releases.length, 0);
});

test('company lock loser becomes standby and releases the dedicated connection', async () => {
  const client = makeClient({ locked: false });
  const ownership = createCompanyOwnership({ pool: makePool(client), empresaId: 7 });

  assert.equal(await ownership.tryAcquire(), false);
  assert.equal(ownership.isOwner, false);
  assert.deepEqual(client.releases, [undefined]);
  assert.throws(() => ownership.assertOwned(), CompanyOwnershipLostError);
});

test('company ownership connection loss fails closed and notifies once', async () => {
  const client = makeClient();
  const losses = [];
  const ownership = createCompanyOwnership({
    pool: makePool(client), empresaId: 9, onOwnershipLost: error => losses.push(error),
  });
  await ownership.tryAcquire();

  client.emit('error', new Error('socket closed'));
  client.emit('error', new Error('duplicate'));

  assert.equal(ownership.isOwner, false);
  assert.equal(losses.length, 1);
  assert.throws(() => ownership.assertOwned(), CompanyOwnershipLostError);
  assert.equal(client.releases.length, 1);
});

test('company unlock failure poisons the dedicated connection and fails closed', async () => {
  const unlockError = new Error('unlock failed');
  const client = makeClient();
  client.query = async (sql, params = []) => {
    client.calls.push({ sql: String(sql), params });
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }] };
    if (/pg_advisory_unlock/i.test(sql)) throw unlockError;
    throw new Error(`unexpected query: ${sql}`);
  };
  const ownership = createCompanyOwnership({ pool: makePool(client), empresaId: 12 });
  await ownership.tryAcquire();

  await assert.rejects(ownership.releaseAfterQuiesced(async () => true), error => error === unlockError);
  assert.equal(ownership.isOwner, false);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof CompanyOwnershipLostError);
  assert.equal(client.releases[0].cause, unlockError);
});

test('company ownership releases only after successful quiescence', async () => {
  const client = makeClient();
  const ownership = createCompanyOwnership({ pool: makePool(client), empresaId: 11 });
  await ownership.tryAcquire();
  const primary = new Error('chromium still alive');

  await assert.rejects(ownership.releaseAfterQuiesced(async () => { throw primary; }), error => error === primary);
  assert.equal(ownership.isOwner, true);
  assert.equal(client.calls.filter(call => /pg_advisory_unlock/i.test(call.sql)).length, 0);
  assert.equal(client.releases.length, 0);

  assert.equal(await ownership.releaseAfterQuiesced(async () => true), true);
  assert.equal(ownership.isOwner, false);
  assert.match(client.calls.at(-1).sql, /pg_advisory_unlock\(\$1, \$2\)/i);
  assert.deepEqual(client.releases, [undefined]);
});
