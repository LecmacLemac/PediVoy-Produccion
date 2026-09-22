import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompanyLifecycle } from '../src/wpp/companyLifecycle.js';

function owner({ acquired = true } = {}) {
  return {
    isOwner: false,
    async tryAcquire() { this.isOwner = acquired; return acquired; },
    assertOwned() { if (!this.isOwner) throw new Error('not owner'); return true; },
    async heartbeat() { return this.assertOwned(); },
    async releaseAfterQuiesced(fn) { await fn(); this.isOwner = false; return true; },
  };
}

function fakeClient(name, order, { confirmed = true, forceStopped = false } = {}) {
  return {
    name,
    removeAllListeners() { order.push(`${name}:listeners-removed`); },
    async initialize() { order.push(`${name}:initialize`); },
    async destroy() { order.push(`${name}:destroy`); },
    async confirmStopped() { order.push(`${name}:confirm`); return confirmed; },
    async forceStop() { order.push(`${name}:force`); return forceStopped; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('standby company lifecycle never creates a WhatsApp client', async () => {
  let creates = 0;
  let prerequisites = 0;
  const lifecycle = createCompanyLifecycle({
    ownership: owner({ acquired: false }),
    clientFactory: { create() { creates += 1; } },
  });

  assert.equal(await lifecycle.start({
    beforeInitialize: async () => { prerequisites += 1; },
  }), false);
  assert.equal(prerequisites, 0);
  assert.equal(creates, 0);
  assert.equal(lifecycle.snapshot().state, 'standby');
});

test('owner runs prerequisites after lock acquisition and before client creation', async () => {
  const order = [];
  const ownership = owner();
  const originalAcquire = ownership.tryAcquire;
  ownership.tryAcquire = async function tryAcquire() {
    order.push('acquire');
    return originalAcquire.call(this);
  };
  const lifecycle = createCompanyLifecycle({
    ownership,
    clientFactory: {
      create() {
        order.push('create');
        return fakeClient('client-1', order);
      },
    },
  });

  await lifecycle.start({
    beforeInitialize: async () => { order.push('prerequisites'); },
  });

  assert.deepEqual(order, ['acquire', 'prerequisites', 'create', 'client-1:initialize']);
});

test('restart creates generation N+1 only after generation N stop is confirmed', async () => {
  const order = [];
  let sequence = 0;
  const lifecycle = createCompanyLifecycle({
    ownership: owner(),
    clientFactory: {
      create() {
        sequence += 1;
        order.push(`create:${sequence}`);
        return fakeClient(`client-${sequence}`, order);
      },
    },
  });

  await lifecycle.start();
  await lifecycle.restart('disconnect');

  assert.deepEqual(order, [
    'create:1', 'client-1:initialize',
    'client-1:listeners-removed', 'client-1:destroy', 'client-1:confirm',
    'create:2', 'client-2:initialize',
  ]);
  assert.equal(lifecycle.snapshot().generation, 2);
});

test('unconfirmed stop fences lifecycle and prevents profile deletion or recreation', async () => {
  const order = [];
  let creates = 0;
  let deletes = 0;
  const lifecycle = createCompanyLifecycle({
    ownership: owner(),
    clientFactory: {
      create() {
        creates += 1;
        return fakeClient(`client-${creates}`, order, { confirmed: false, forceStopped: false });
      },
    },
    deleteSession: async () => { deletes += 1; },
  });

  await lifecycle.start();
  await assert.rejects(lifecycle.reset('marker-1'), /stop could not be confirmed/i);

  assert.equal(creates, 1);
  assert.equal(deletes, 0);
  assert.equal(lifecycle.snapshot().state, 'fenced');
});

test('reset deletes the profile only after forced stop is confirmed', async () => {
  const order = [];
  let creates = 0;
  const lifecycle = createCompanyLifecycle({
    ownership: owner(),
    clientFactory: {
      create() {
        creates += 1;
        order.push(`create:${creates}`);
        return fakeClient(`client-${creates}`, order, {
          confirmed: creates !== 1,
          forceStopped: creates === 1,
        });
      },
    },
    deleteSession: async () => { order.push('delete-session'); },
  });

  await lifecycle.start();
  await lifecycle.reset('marker-2');

  assert.deepEqual(order, [
    'create:1', 'client-1:initialize',
    'client-1:listeners-removed', 'client-1:destroy', 'client-1:confirm', 'client-1:force',
    'delete-session', 'create:2', 'client-2:initialize',
  ]);
});

test('shutdown closes the gate, drains active work, stops the client, then unlocks', async () => {
  const order = [];
  const workRelease = deferred();
  const ownership = owner();
  ownership.releaseAfterQuiesced = async fn => {
    await fn();
    order.push('unlock');
    ownership.isOwner = false;
    return true;
  };
  const lifecycle = createCompanyLifecycle({
    ownership,
    clientFactory: { create: () => fakeClient('client-1', order) },
    drainDeadlineMs: 100,
  });
  await lifecycle.start();

  const work = lifecycle.withActiveClient(async () => {
    order.push('work-start');
    await workRelease.promise;
    order.push('work-end');
  });
  await new Promise(resolve => setImmediate(resolve));

  const shutdown = lifecycle.shutdown();
  await assert.rejects(lifecycle.withActiveClient(async () => {}), { code: 'WPP_COMPANY_NOT_OWNER' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['client-1:initialize', 'work-start']);

  workRelease.resolve();
  await work;
  assert.equal(await shutdown, true);
  assert.deepEqual(order, [
    'client-1:initialize', 'work-start', 'work-end',
    'client-1:listeners-removed', 'client-1:destroy', 'client-1:confirm', 'unlock',
  ]);
});

test('active work drain timeout fails closed without destroying or unlocking', async () => {
  const order = [];
  const workRelease = deferred();
  const ownership = owner();
  ownership.releaseAfterQuiesced = async fn => {
    await fn();
    order.push('unlock');
    ownership.isOwner = false;
    return true;
  };
  const lifecycle = createCompanyLifecycle({
    ownership,
    clientFactory: { create: () => fakeClient('client-1', order) },
    drainDeadlineMs: 5,
  });
  await lifecycle.start();
  const work = lifecycle.withActiveClient(async () => {
    order.push('work-start');
    await workRelease.promise;
    order.push('work-end');
  });
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(lifecycle.shutdown(), /active work drain deadline exceeded/i);
  assert.equal(lifecycle.snapshot().state, 'fenced');
  assert.equal(lifecycle.snapshot().gateOpen, false);
  assert.equal(ownership.isOwner, true);
  assert.deepEqual(order, ['client-1:initialize', 'work-start']);

  workRelease.resolve();
  await work;
});

test('ownership loss closes the gate and drains admitted work before teardown', async () => {
  const order = [];
  const workRelease = deferred();
  const lifecycle = createCompanyLifecycle({
    ownership: owner(),
    clientFactory: { create: () => fakeClient('client-1', order) },
    drainDeadlineMs: 100,
  });
  await lifecycle.start();
  const work = lifecycle.withActiveClient(async () => {
    order.push('work-start');
    await workRelease.promise;
    order.push('work-end');
  });
  await new Promise(resolve => setImmediate(resolve));

  const loss = lifecycle.ownershipLost();
  await assert.rejects(lifecycle.withActiveClient(async () => {}), { code: 'WPP_COMPANY_NOT_OWNER' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['client-1:initialize', 'work-start']);

  workRelease.resolve();
  await work;
  assert.equal(await loss, false);
  assert.deepEqual(order, [
    'client-1:initialize', 'work-start', 'work-end',
    'client-1:listeners-removed', 'client-1:destroy', 'client-1:confirm',
  ]);
});
