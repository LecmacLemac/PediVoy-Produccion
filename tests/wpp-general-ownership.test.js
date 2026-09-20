import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGeneralOwnership, OwnershipLostError } from '../src/wpp/generalOwnership.js';

function makeClient(handler) {
  const calls = [];
  const releases = [];
  return Object.assign(new EventEmitter(), {
    calls,
    releases,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return handler(String(sql), params, calls.length);
    },
    release(error) {
      releases.push(error);
    },
  });
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

test('tryAcquire casts the advisory-lock key as bigint before publishing ownership', async () => {
  let lockAcquired = false;
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) {
      assert.match(sql, /pg_try_advisory_lock\(CAST\(\$1 AS bigint\)\)/i);
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

  assert.equal(await ownership.tryAcquire(), true);
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

test('releaseAfterQuiesced clears the fenced row, unlocks, and releases the client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '5' }], rowCount: 1 };
    if (/SET owner_id = NULL/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'owner-e' });
  await ownership.acquire();

  assert.equal(await ownership.releaseAfterQuiesced(async () => {}), true);
  assert.match(client.calls.at(-1).sql, /pg_advisory_unlock\(CAST\(\$1 AS bigint\)\)/i);
  assert.deepEqual(client.releases, [undefined]);
  assert.throws(() => ownership.assertOwned(), OwnershipLostError);
});

test('reused pooled client is released once for each successful checkout', async () => {
  let nextEpoch = 20;
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) {
      nextEpoch += 1;
      return { rows: [{ epoch: String(nextEpoch) }], rowCount: 1 };
    }
    if (/SET owner_id = NULL/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const pool = makePool(client);
  const ownership = createGeneralOwnership({ pool, ownerId: 'reused-client' });

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    assert.equal(await ownership.tryAcquire(), true);
    assert.equal(ownership.isOwner, true);
    assert.equal(client.listenerCount('error'), 1);

    assert.equal(await ownership.releaseAfterQuiesced(async () => {}), true);
    assert.equal(ownership.isOwner, false);
    assert.equal(ownership.epoch, null);
    assert.equal(client.listenerCount('error'), 0);
    assert.equal(client.releases.length, cycle);
    assert.throws(() => ownership.assertOwned(), OwnershipLostError);
  }

  assert.equal(pool.connectCount, 2);
  assert.deepEqual(client.releases, [undefined, undefined]);
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

  await assert.rejects(ownership.releaseAfterQuiesced(async () => {}), error => error === primary);
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
  assert.match(client.calls.at(-1).sql, /pg_advisory_unlock\(CAST\(\$1 AS bigint\)\)/i);
  assert.deepEqual(client.releases, [primary]);
});


test('two contenders produce exactly one advisory-lock winner', async () => {
  let locked = false;
  const makeContenderClient = epoch => makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) {
      if (locked) return { rows: [{ locked: false }], rowCount: 1 };
      locked = true;
      return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const firstClient = makeContenderClient('10');
  const secondClient = makeContenderClient('11');
  const first = createGeneralOwnership({ pool: makePool(firstClient), ownerId: 'first' });
  const second = createGeneralOwnership({ pool: makePool(secondClient), ownerId: 'second' });

  const results = await Promise.all([first.tryAcquire(), second.tryAcquire()]);

  assert.deepEqual(results, [true, false]);
  assert.equal(first.isOwner, true);
  assert.equal(second.isOwner, false);
  assert.deepEqual(secondClient.releases, [undefined]);
});

test('dedicated client error fails closed and notifies ownership loss exactly once', async () => {
  const losses = [];
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '13' }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'owner-error', onOwnershipLost: error => losses.push(error),
  });
  await ownership.tryAcquire();

  const connectionError = new Error('socket closed');
  client.emit('error', connectionError);
  assert.doesNotThrow(() => client.emit('error', new Error('duplicate socket error')));

  assert.equal(ownership.isOwner, false);
  assert.throws(() => ownership.assertOwned(), OwnershipLostError);
  assert.equal(losses.length, 1);
  assert.ok(losses[0] instanceof OwnershipLostError);
  assert.equal(losses[0].cause, connectionError);
  assert.deepEqual(client.releases, [losses[0]]);
});

test('async ownership-loss observer rejection is contained after exactly-once notification', async () => {
  const observerError = new Error('observer rejected');
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '15' }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  let notificationCount = 0;
  const ownership = createGeneralOwnership({
    pool: makePool(client),
    ownerId: 'async-observer',
    onOwnershipLost: async () => {
      notificationCount += 1;
      throw observerError;
    },
  });

  try {
    await ownership.tryAcquire();
    client.emit('error', new Error('socket closed'));
    client.emit('error', new Error('duplicate socket error'));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(notificationCount, 1);
    assert.deepEqual(unhandled, []);
    assert.equal(ownership.isOwner, false);
    assert.throws(() => ownership.assertOwned(), OwnershipLostError);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('connect deadline releases a client that arrives late', async () => {
  let resolveConnect;
  const connectPromise = new Promise(resolve => { resolveConnect = resolve; });
  const client = makeClient(async () => { throw new Error('must not query late client'); });
  const ownership = createGeneralOwnership({
    pool: { connect: () => connectPromise }, ownerId: 'late-connect', operationDeadlineMs: 5,
  });

  await assert.rejects(ownership.tryAcquire(), /connect deadline/i);
  resolveConnect(client);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(client.calls.length, 0);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
});

test('advisory lock acquisition deadline poisons its uncertain client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return new Promise(() => {});
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'lock-timeout', operationDeadlineMs: 5,
  });

  await assert.rejects(ownership.tryAcquire(), /advisory lock deadline/i);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
});

test('owner publication deadline poisons the locked client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return new Promise(() => {});
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'publish-timeout', operationDeadlineMs: 5,
  });

  await assert.rejects(ownership.tryAcquire(), /owner publication deadline/i);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
});

test('release waits for successful quiescence before clearing or unlocking', async () => {
  const order = [];
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '14' }], rowCount: 1 };
    if (/SET owner_id = NULL/i.test(sql)) { order.push('clear'); return { rows: [], rowCount: 1 }; }
    if (/pg_advisory_unlock/i.test(sql)) { order.push('unlock'); return { rows: [{ unlocked: true }], rowCount: 1 }; }
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'quiesce-order' });
  await ownership.tryAcquire();

  await ownership.releaseAfterQuiesced(async () => {
    order.push('quiesce-start');
    await Promise.resolve();
    order.push('quiesce-done');
  });

  assert.deepEqual(order, ['quiesce-start', 'quiesce-done', 'clear', 'unlock']);
});

test('failed quiescence preserves healthy ownership and the primary error', async () => {
  const primary = new Error('destroy failed');
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '15' }], rowCount: 1 };
    throw new Error(`release query must not run: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'quiesce-fail' });
  await ownership.tryAcquire();

  await assert.rejects(ownership.releaseAfterQuiesced(async () => { throw primary; }), error => error === primary);

  assert.equal(ownership.assertOwned(), true);
  assert.equal(client.calls.length, 2);
  assert.equal(client.releases.length, 0);
});

test('quiescence deadline preserves healthy ownership without voluntary release', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '16' }], rowCount: 1 };
    throw new Error(`release query must not run: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'quiesce-timeout', quiesceDeadlineMs: 5,
  });
  await ownership.tryAcquire();

  await assert.rejects(ownership.releaseAfterQuiesced(() => new Promise(() => {})), /quiescence deadline/i);

  assert.equal(ownership.assertOwned(), true);
  assert.equal(client.calls.length, 2);
  assert.equal(client.releases.length, 0);
});

test('fenced row clear deadline is bounded and poisons the client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '17' }], rowCount: 1 };
    if (/SET owner_id = NULL/i.test(sql)) return new Promise(() => {});
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'clear-timeout', operationDeadlineMs: 5,
  });
  await ownership.tryAcquire();

  await assert.rejects(ownership.releaseAfterQuiesced(async () => {}), /row clear deadline/i);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
});

test('advisory unlock deadline is bounded and poisons the client', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '18' }], rowCount: 1 };
    if (/SET owner_id = NULL/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/pg_advisory_unlock/i.test(sql)) return new Promise(() => {});
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({
    pool: makePool(client), ownerId: 'unlock-timeout', operationDeadlineMs: 5,
  });
  await ownership.tryAcquire();

  await assert.rejects(ownership.releaseAfterQuiesced(async () => {}), /advisory unlock deadline/i);
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
});

test('release alias also requires an explicit quiescence function', async () => {
  const client = makeClient(async sql => {
    if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (/SET epoch = epoch \+ 1/i.test(sql)) return { rows: [{ epoch: '19' }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const ownership = createGeneralOwnership({ pool: makePool(client), ownerId: 'safe-release' });
  await ownership.tryAcquire();

  await assert.rejects(ownership.release(), /quiesceFn/i);
  assert.equal(ownership.assertOwned(), true);
  assert.equal(client.releases.length, 0);
});
