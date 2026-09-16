import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeneralOwnership, OwnershipLostError } from '../src/wpp/generalOwnership.js';

function makeClient(handler) {
  const calls = [];
  const releases = [];
  return {
    calls,
    releases,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return handler(String(sql), params, calls.length);
    },
    release(error) {
      releases.push(error);
    },
  };
}

function makePool(client) {
  return {
    connectCount: 0,
    async connect() {
      this.connectCount += 1;
      return client;
    },
  };
}

test('acquire uses one dedicated client and publishes an incremented epoch only after locking', async () => {
  let lockAcquired = false;
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) {
      lockAcquired = true;
      return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (/SET epoch = epoch \+ 1/i.test(sql)) {
      assert.equal(lockAcquired, true);
      return { rows: [{ epoch: '12', owner_id: 'owner-a' }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const pool = makePool(client);
  const ownership = createGeneralOwnership({ pool, ownerId: 'owner-a' });

  assert.equal(await ownership.acquire(), true);
  assert.equal(pool.connectCount, 1);
  assert.equal(ownership.epoch, 12n);
  assert.equal(ownership.assertOwned(), true);
  assert.equal(client.releases.length, 0);
});

test('lock loser releases its dedicated client without publishing ownership', async () => {
  const client = makeClient(async sql => {
    assert.match(sql, /pg_try_advisory_lock/i);
    return { rows: [{ locked: false }], rowCount: 1 };
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'owner-b' });

  assert.equal(await ownership.acquire(), false);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.releases, [undefined]);
  assert.throws(() => ownership.assertOwned(), OwnershipLostError);
});

test('fenced heartbeat zero rows loses ownership and poisons the client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '3' }], rowCount: 1 };
    if (/SET heartbeat_at = NOW/i.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'owner-c' });
  await ownership.acquire();

  await assert.rejects(ownership.heartbeat(), OwnershipLostError);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof OwnershipLostError);
  assert.throws(() => ownership.assertOwned(), OwnershipLostError);
});

test('heartbeat deadline fails closed and poisons a hung dedicated client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '4' }], rowCount: 1 };
    if (/SET heartbeat_at = NOW/i.test(sql)) return new Promise(() => {});
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'owner-d', heartbeatDeadlineMs: 5,
  });
  await ownership.acquire();

  await assert.rejects(ownership.heartbeat(), /deadline/i);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
  assert.throws(() => ownership.assertOwned(), OwnershipLostError);
});

test('release clears the fenced row, unlocks, and releases the client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '5' }], rowCount: 1 };
    if (/SET owner_id = NULL/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'owner-e' });
  await ownership.acquire();

  assert.equal(await ownership.release(), true);
  assert.match(client.calls.at(-1).sql, /pg_advisory_unlock/i);
  assert.deepEqual(client.releases, [undefined]);
  assert.throws(() => ownership.assertOwned(), OwnershipLostError);
});

test('release preserves the primary error while still poisoning the client', async () => {
  const primary = new Error('control update failed');
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '6' }], rowCount: 1 };
    if (/SET owner_id = NULL/i.test(sql)) throw primary;
    if (/pg_advisory_unlock/i.test(sql)) throw new Error('unlock also failed');
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'owner-f' });
  await ownership.acquire();

  await assert.rejects(ownership.release(), error => error === primary);
  assert.deepEqual(client.releases, [primary]);
});

test('publish failure unlocks and preserves the publish error', async () => {
  const primary = new Error('publish failed');
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) throw primary;
    if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'owner-g' });

  await assert.rejects(ownership.acquire(), error => error === primary);
  assert.match(client.calls.at(-1).sql, /pg_advisory_unlock/i);
  assert.deepEqual(client.releases, [primary]);
});
