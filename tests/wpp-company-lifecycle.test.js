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

test('standby company lifecycle never creates a WhatsApp client', async () => {
  let creates = 0;
  const lifecycle = createCompanyLifecycle({
    ownership: owner({ acquired: false }),
    clientFactory: { create() { creates += 1; } },
  });

  assert.equal(await lifecycle.start(), false);
  assert.equal(creates, 0);
  assert.equal(lifecycle.snapshot().state, 'standby');
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
