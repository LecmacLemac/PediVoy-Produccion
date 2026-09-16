import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGeneralClientFactory } from '../src/wpp/generalClientFactory.js';
import { createGeneralSupervisor } from '../src/wpp/generalSupervisor.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function makeHarness({
  initialize, destroy, confirmStopped, forceStop, tryAcquire = async () => true,
  heartbeat, assertOwned, updateOwned, initializeDeadlineMs = 30, destroyDeadlineMs = 20,
  shutdownDeadlineMs = 40, markResetStarted, markResetApplied, markResetFailed,
  releaseResult = () => true,
} = {}) {
  const calls = [];
  const clients = [];
  const ownership = {
    ownerId: 'owner-a',
    epoch: 7n,
    isOwner: true,
    tryAcquire: async () => {
      calls.push('acquire');
      const acquired = await tryAcquire();
      ownership.isOwner = acquired;
      return acquired;
    },
    assertOwned: () => {
      calls.push('assert-owned');
      if (assertOwned) return assertOwned(ownership, calls);
      if (!ownership.isOwner) throw Object.assign(new Error('lost'), { code: 'WPP_GENERAL_OWNERSHIP_LOST' });
      return true;
    },
    heartbeat: async () => {
      calls.push('heartbeat');
      if (heartbeat) return heartbeat(ownership, calls);
      if (!ownership.isOwner) throw Object.assign(new Error('lost'), { code: 'WPP_GENERAL_OWNERSHIP_LOST' });
      return true;
    },
    releaseAfterQuiesced: async fn => {
      calls.push('release-begin');
      await fn();
      calls.push('release-done');
      const releaseConfirmed = releaseResult();
      if (releaseConfirmed === true) ownership.isOwner = false;
      return releaseConfirmed;
    },
  };
  const clientFactory = createGeneralClientFactory({
    createClient: ({ generation }) => {
      const raw = Object.assign(new EventEmitter(), {
        id: generation,
        initialize: () => (initialize ? initialize(raw, calls) : Promise.resolve()),
        destroy: () => (destroy ? destroy(raw, calls) : Promise.resolve()),
        confirmStopped: () => (confirmStopped ? confirmStopped(raw, calls) : Promise.resolve(true)),
        forceStop: () => (forceStop ? forceStop(raw, calls) : Promise.resolve(false)),
      });
      clients.push(raw);
      calls.push(`create:${generation}`);
      return raw;
    },
  });
  const repository = {
    updateOwned: async values => {
      calls.push(`state:${values.state}`);
      return updateOwned ? updateOwned(values, calls) : true;
    },
    markResetStarted: async values => {
      calls.push(`reset-start:${values.sequence}`);
      return markResetStarted ? markResetStarted(values, calls) : true;
    },
    markResetApplied: async values => {
      calls.push(`reset-applied:${values.sequence}`);
      return markResetApplied ? markResetApplied(values, calls) : true;
    },
    markResetFailed: async values => {
      calls.push(`reset-failed:${values.sequence}`);
      return markResetFailed ? markResetFailed(values, calls) : true;
    },
  };
  const fatalErrors = [];
  const supervisor = createGeneralSupervisor({
    ownership,
    clientFactory,
    repository,
    fatalExit: error => fatalErrors.push(error),
    initializeDeadlineMs,
    destroyDeadlineMs,
    shutdownDeadlineMs,
  });
  return { supervisor, ownership, clients, calls, fatalErrors };
}

test('concurrent start collapses to one ownership acquisition and one client initialization', async () => {
  const init = deferred();
  const h = makeHarness({ initialize: () => init.promise });

  const first = h.supervisor.start();
  const second = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.filter(call => call === 'acquire').length, 1);
  assert.equal(h.clients.length, 1);
  assert.equal(h.supervisor.snapshot().state, 'initializing');

  init.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(h.supervisor.snapshot().generation, 1);
});

test('restart during initialize and reset during restart execute in serial order with fresh generations', async () => {
  const initial = deferred();
  const restarted = deferred();
  const resetInit = deferred();
  const initByGeneration = new Map([[1, initial], [2, restarted], [3, resetInit]]);
  const h = makeHarness({
    initialize: raw => {
      h.calls.push(`init:${raw.id}`);
      return initByGeneration.get(raw.id).promise;
    },
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });

  const start = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  const restart = h.supervisor.restart('connection-lost');
  const deletions = [];
  const reset = h.supervisor.reset(9n, async () => { deletions.push('deleted'); h.calls.push('delete'); });

  assert.deepEqual(h.calls.filter(call => /^(create|init|destroy|delete)/.test(call)), ['create:1', 'init:1']);
  initial.resolve();
  await start;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call => /^(create|init|destroy|stopped|delete)/.test(call)), [
    'create:1', 'init:1', 'destroy:1', 'stopped:1', 'create:2', 'init:2',
  ]);

  restarted.resolve();
  await restart;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call => /^(create|init|destroy|stopped|delete)/.test(call)), [
    'create:1', 'init:1', 'destroy:1', 'stopped:1', 'create:2', 'init:2',
    'destroy:2', 'stopped:2', 'delete', 'create:3', 'init:3',
  ]);

  resetInit.resolve();
  await reset;
  assert.deepEqual(deletions, ['deleted']);
  assert.equal(h.supervisor.snapshot().generation, 3);
  assert.equal(new Set(h.clients).size, 3);
});

test('failed or hung destroy fences reset without deleting, releasing ownership, or creating a successor', async t => {
  for (const [name, destroy] of [
    ['rejected', async () => { throw new Error('destroy rejected'); }],
    ['hung', () => new Promise(() => {})],
  ]) {
    await t.test(name, async () => {
      const h = makeHarness({ destroy });
      await h.supervisor.start();
      const deletions = [];

      await assert.rejects(h.supervisor.reset(3n, async () => deletions.push('delete')), /destroy/);

      assert.deepEqual(deletions, []);
      assert.equal(h.clients.length, 1);
      assert.equal(h.calls.includes('release-begin'), false);
      assert.equal(h.supervisor.snapshot().state, 'fenced');
      assert.equal(h.calls.includes('reset-failed:3'), true);
    });
  }
});

test('restart revalidates ownership immediately before creating its successor', async () => {
  let checks = 0;
  const h = makeHarness({
    assertOwned: async () => {
      checks += 1;
      return checks < 3;
    },
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.restart('manual'), { code: 'WPP_NOT_OWNER' });

  assert.equal(checks, 3);
  assert.equal(h.clients.length, 1);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
});

test('restart state-fence rejection triggers fatal lease-loss cleanup', async () => {
  const h = makeHarness({
    updateOwned: async values => values.state !== 'restarting',
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.restart('manual'), { code: 'WPP_NOT_OWNER' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.calls.filter(call => call === 'destroy:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('failed persistence of a terminal restart fence triggers fatal lease-loss handling', async () => {
  const lifecycleError = new Error('destroy rejected');
  const h = makeHarness({
    destroy: async () => { throw lifecycleError; },
    updateOwned: async values => values.state !== 'fenced',
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.restart('manual'), /destroy rejected/);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /fence rejected state update/i);
  assert.equal(h.fatalErrors[0].cause, lifecycleError);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('restart keeps the send gate closed while it waits behind initialization', async () => {
  const initial = deferred();
  const h = makeHarness({ initialize: raw => raw.id === 1 ? initial.promise : Promise.resolve() });
  const start = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));

  const restart = h.supervisor.restart('manual');
  h.clients[0].emit('ready');

  assert.equal(h.supervisor.snapshot().ready, false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);

  initial.resolve();
  await start;
  await restart;
});

test('events from stale generations cannot reopen the gate or enqueue another restart', async () => {
  const secondInit = deferred();
  const h = makeHarness({
    initialize: raw => raw.id === 2 ? secondInit.promise : Promise.resolve(),
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.supervisor.snapshot().state, 'ready');
  assert.equal(h.supervisor.snapshot().gateOpen, true);

  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.supervisor.snapshot().generation, 2);
  assert.equal(h.supervisor.snapshot().gateOpen, false);

  h.clients[0].emit('ready');
  h.clients[0].emit('error', new Error('stale error'));
  h.clients[0].emit('disconnected', 'stale disconnect');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.supervisor.snapshot().state, 'initializing');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.clients.length, 2);

  h.clients[1].emit('ready');
  secondInit.resolve();
  await restart;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.supervisor.snapshot().state, 'ready');
  assert.equal(h.supervisor.snapshot().gateOpen, true);
});

test('an event-triggered restart is fenced to the generation that emitted it', async () => {
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  const manualRestart = h.supervisor.restart('manual');
  h.clients[0].emit('disconnected', 'connection lost');

  await manualRestart;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().generation, 2);
  assert.equal(h.clients.length, 2);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), ['destroy:1']);
});

test('a profile-lock event wins a race with an already queued restart', async () => {
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  const restart = h.supervisor.restart('manual');
  h.clients[0].emit('error', new Error('Chromium profile lock'));

  assert.equal(await restart, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), []);
  assert.equal(h.calls.filter(call => call === 'state:fenced').length, 1);
});

test('a profile-lock event wins a race with an already queued reset without deleting the profile', async () => {
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  const deletions = [];

  const reset = h.supervisor.reset(10n, async () => {
    deletions.push('deleted');
    h.calls.push('delete');
  });
  h.clients[0].emit('error', new Error('Chromium profile lock'));

  assert.equal(await reset, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deletions, []);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), []);
  assert.equal(h.calls.filter(call => call.startsWith('reset-')).length, 0);
  assert.equal(h.calls.filter(call => call === 'state:fenced').length, 1);
});

test('a profile-lock event aborts a reset awaiting state publication before profile deletion', async () => {
  const resettingPublished = deferred();
  const h = makeHarness({
    updateOwned: values => values.state === 'resetting' ? resettingPublished.promise : true,
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  const deletions = [];

  const reset = h.supervisor.reset(11n, async () => deletions.push('deleted'));
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  resettingPublished.resolve(true);

  assert.equal(await reset, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deletions, []);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), []);
  assert.equal(h.calls.filter(call => call.startsWith('reset-start:')).length, 0);
});

test('a profile-lock event aborts a reset after its start fence without deleting the profile', async () => {
  const resetStarted = deferred();
  const h = makeHarness({
    markResetStarted: () => resetStarted.promise,
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
  });
  await h.supervisor.start();
  const deletions = [];

  const reset = h.supervisor.reset(12n, async () => deletions.push('deleted'));
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  resetStarted.resolve(true);

  assert.equal(await reset, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deletions, []);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), []);
  assert.equal(h.calls.filter(call => call === 'reset-failed:12').length, 1);
});

test('profile-lock reset failure persistence robustly handles primitive rejections', async () => {
  const resetStarted = deferred();
  const h = makeHarness({
    markResetStarted: () => resetStarted.promise,
    markResetFailed: async () => { throw 'reset persistence exploded'; },
  });
  await h.supervisor.start();

  const reset = h.supervisor.reset(14n, async () => h.calls.push('delete'));
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  resetStarted.resolve(true);

  await assert.rejects(reset, error => {
    assert.equal(error instanceof Error, true);
    assert.match(error.message, /reset persistence exploded/);
    assert.match(error.cause?.message, /profile lock/i);
    return true;
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('delete'), false);
  assert.equal(h.calls.filter(call => call === 'reset-failed:14').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /reset persistence exploded/);
});

test('a profile-lock event during reset teardown prevents profile deletion and replacement', async () => {
  const destroying = deferred();
  const h = makeHarness({
    destroy: async raw => {
      h.calls.push(`destroy:${raw.id}`);
      await destroying.promise;
    },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  const deletions = [];

  const reset = h.supervisor.reset(13n, async () => deletions.push('deleted'));
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  destroying.resolve();

  assert.equal(await reset, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deletions, []);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), ['destroy:1']);
  assert.equal(h.calls.filter(call => call === 'reset-failed:13').length, 1);
});

test('a profile-lock event aborts a restart already awaiting state publication', async () => {
  const restartingPublished = deferred();
  const h = makeHarness({
    updateOwned: values => values.state === 'restarting' ? restartingPublished.promise : true,
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  restartingPublished.resolve(true);

  assert.equal(await restart, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), []);
});

test('a profile-lock event during restart teardown prevents a replacement client', async () => {
  const destroying = deferred();
  const h = makeHarness({
    destroy: async raw => {
      h.calls.push(`destroy:${raw.id}`);
      await destroying.promise;
    },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  destroying.resolve();

  assert.equal(await restart, false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().generation, 1);
  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.calls.filter(call => call.startsWith('destroy:')), ['destroy:1']);
  assert.equal(h.calls.filter(call => call === 'state:fenced').length, 1);
});

test('profile-lock errors fence the generation without filesystem deletion or replacement', async () => {
  const h = makeHarness({ destroy: async raw => { h.calls.push(`destroy:${raw.id}`); } });
  await h.supervisor.start();
  h.clients[0].rm = () => { throw new Error('rm must not run'); };
  h.clients[0].unlink = () => { throw new Error('unlink must not run'); };

  h.clients[0].emit('error', new Error('Chromium profile lock: browser already running (SingletonLock)'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.clients.length, 1);
  assert.equal(h.calls.some(call => call.startsWith('destroy:')), false);
  assert.match(h.supervisor.snapshot().lastError.message, /profile lock/i);
});

test('a terminal profile-lock fence cannot be swallowed by a later ready event', async () => {
  const fencedPublished = deferred();
  const h = makeHarness({
    updateOwned: values => values.operation === 'profile_lock' ? fencedPublished.promise : true,
  });
  await h.supervisor.start();

  h.clients[0].emit('error', new Error('Chromium profile lock'));
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('ready');
  fencedPublished.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().ready, false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.calls.filter(call => call === 'state:ready').length, 0);
});

test('a follower creates no client and rejects restart and reset without side effects', async () => {
  const h = makeHarness({ tryAcquire: async () => false });

  assert.equal(await h.supervisor.start(), false);
  await assert.rejects(h.supervisor.restart('manual'), { code: 'WPP_NOT_OWNER' });
  await assert.rejects(h.supervisor.reset(4n, async () => h.calls.push('delete')), { code: 'WPP_NOT_OWNER' });

  assert.equal(h.clients.length, 0);
  assert.equal(h.calls.includes('delete'), false);
  assert.equal(h.calls.some(call => call.startsWith('state:')), false);
});

test('heartbeat false and duplicate loss triggers close the gate and run fatal cleanup once', async () => {
  const h = makeHarness({
    heartbeat: async () => false,
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  const heartbeat = h.supervisor.heartbeatOnce();
  const duplicate = h.supervisor.leaseLost(new Error('duplicate'));
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  await Promise.allSettled([heartbeat, duplicate]);

  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.filter(call => call === 'destroy:1').length, 1);
  assert.equal(h.calls.filter(call => call === 'stopped:1').length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
});

test('heartbeat rejection fences immediately and performs fatal cleanup once', async () => {
  const h = makeHarness({ heartbeat: async () => { throw new Error('heartbeat rejected'); } });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(h.supervisor.heartbeatOnce(), /heartbeat rejected/);
  await h.supervisor.leaseLost(new Error('again'));

  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('a false repository event update is ownership loss', async () => {
  const h = makeHarness({ updateOwned: async values => values.state !== 'ready' });
  await h.supervisor.start();

  h.clients[0].emit('ready');
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.fatalErrors.length, 1);
});

test('ready keeps the gate closed until its fenced publication succeeds', async () => {
  const readyPublished = deferred();
  const h = makeHarness({
    updateOwned: values => values.state === 'ready' ? readyPublished.promise : true,
  });
  await h.supervisor.start();

  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().gateOpen, false);
  await assert.rejects(h.supervisor.withActiveClient(() => 'unsafe'), { code: 'WPP_NOT_OWNER' });

  readyPublished.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.supervisor.snapshot().gateOpen, true);
});

test('client events publish in order and a newer event prevents ready from reopening the gate', async () => {
  const readyPublished = deferred();
  const publications = [];
  const h = makeHarness({
    updateOwned: async values => {
      if (values.state === 'ready') {
        publications.push('ready:start');
        await readyPublished.promise;
        publications.push('ready:end');
      } else if (values.state === 'awaiting_qr') {
        publications.push('qr');
      }
      return true;
    },
  });
  await h.supervisor.start();

  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('qr', 'next-code');

  assert.deepEqual(publications, ['ready:start']);
  assert.equal(h.supervisor.snapshot().gateOpen, false);

  readyPublished.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(publications, ['ready:start', 'ready:end', 'qr']);
  assert.equal(h.supervisor.snapshot().state, 'awaiting_qr');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
});

test('withActiveClient revalidates ownership immediately before invoking the callback', async () => {
  const h = makeHarness();
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  const seen = await h.supervisor.withActiveClient(context => ({
    id: context.client.id,
    generation: context.generation,
    epoch: context.epoch,
  }));
  assert.deepEqual(seen, { id: 1, generation: 1, epoch: 7n });
  assert.equal(h.calls.at(-1), 'heartbeat');

  h.ownership.isOwner = false;
  let invoked = 0;
  await assert.rejects(h.supervisor.withActiveClient(() => { invoked += 1; }), { code: 'WPP_NOT_OWNER' });
  assert.equal(invoked, 0);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
});

test('successful shutdown stops and confirms before release and rejects later commands', async () => {
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  const shutdown = h.supervisor.shutdown();
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  await assert.rejects(h.supervisor.restart('too-late'), { code: 'WPP_NOT_OWNER' });
  assert.equal(await shutdown, true);

  const lifecycle = h.calls.filter(call => /^(destroy|stopped|release)/.test(call));
  assert.deepEqual(lifecycle, ['destroy:1', 'stopped:1', 'release-begin', 'release-done']);
  assert.equal(h.supervisor.snapshot().state, 'stopped');
});

test('shutdown accepts only an explicitly confirmed ownership release', async t => {
  for (const releaseConfirmed of [false, undefined]) {
    await t.test(String(releaseConfirmed), async () => {
      const h = makeHarness({ releaseResult: () => releaseConfirmed });
      await h.supervisor.start();

      assert.equal(await h.supervisor.shutdown(), false);
      assert.equal(h.supervisor.snapshot().state, 'fenced');
      assert.equal(h.ownership.isOwner, true);
      assert.equal(h.fatalErrors.length, 1);
      assert.match(h.fatalErrors[0].message, /release could not be confirmed/i);
    });
  }
});

test('shutdown deadline settles a hung initialize, force-stops, and calls fatal once without release', async () => {
  const h = makeHarness({
    initialize: () => new Promise(() => {}),
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    initializeDeadlineMs: 80,
    destroyDeadlineMs: 5,
    shutdownDeadlineMs: 10,
  });
  const start = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await h.supervisor.shutdown(), false);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);

  await assert.rejects(start, /initialize deadline/);
  assert.equal(h.fatalErrors.length, 1);
});

test('unconfirmed force stop is reported as the fatal shutdown failure', async () => {
  const h = makeHarness({
    initialize: () => new Promise(() => {}),
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return false; },
    initializeDeadlineMs: 40,
    destroyDeadlineMs: 5,
    shutdownDeadlineMs: 10,
  });
  const start = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await h.supervisor.shutdown(), false);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /force stop could not be confirmed/i);
  assert.equal(h.calls.includes('release-begin'), false);

  await assert.rejects(start, /initialize deadline/);
});

test('shutdown destroy failure never releases ownership', async t => {
  for (const [name, destroy] of [
    ['rejected', async () => { throw new Error('destroy rejected'); }],
    ['hung', () => new Promise(() => {})],
  ]) {
    await t.test(name, async () => {
      const h = makeHarness({ destroy, destroyDeadlineMs: 5, shutdownDeadlineMs: 20 });
      await h.supervisor.start();

      assert.equal(await h.supervisor.shutdown(), false);
      assert.equal(h.calls.includes('release-done'), false);
      assert.equal(h.ownership.isOwner, true);
      assert.equal(h.fatalErrors.length, 1);
    });
  }
});

test('initialize failure or timeout closes the gate and cleans the failed client', async t => {
  for (const [name, initialize] of [
    ['rejected', async () => { throw new Error('initialize rejected'); }],
    ['timed out', () => new Promise(() => {})],
  ]) {
    await t.test(name, async () => {
      const h = makeHarness({
        initialize,
        initializeDeadlineMs: 5,
        destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
        confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
      });

      await assert.rejects(h.supervisor.start(), /initialize/);
      assert.equal(h.calls.filter(call => call === 'destroy:1').length, 1);
      assert.equal(h.calls.filter(call => call === 'stopped:1').length, 1);
      assert.equal(h.supervisor.snapshot().gateOpen, false);
      assert.equal(h.supervisor.snapshot().state, 'fenced');
      await assert.rejects(h.supervisor.withActiveClient(() => {}), { code: 'WPP_NOT_OWNER' });
      await assert.rejects(h.supervisor.start(), { code: 'WPP_NOT_OWNER' });
    });
  }
});

test('failed persistence of a terminal initialize fence triggers fatal lease-loss handling', async () => {
  const lifecycleError = new Error('initialize rejected');
  const h = makeHarness({
    initialize: async () => { throw lifecycleError; },
    updateOwned: async values => values.state !== 'fenced',
  });

  await assert.rejects(h.supervisor.start(), /initialize rejected/);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /fence rejected state update/i);
  assert.equal(h.fatalErrors[0].cause, lifecycleError);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('client factory creates distinct raw clients and generation-tags forwarded events', () => {
  const raws = [];
  const events = [];
  const factory = createGeneralClientFactory({
    createClient: () => {
      const raw = Object.assign(new EventEmitter(), {
        initialize: async () => {},
        destroy: async () => {},
        confirmStopped: async () => true,
      });
      raws.push(raw);
      return raw;
    },
  });

  const first = factory.create({ generation: 11, eventSink: event => events.push(event) });
  const second = factory.create({ generation: 12, eventSink: event => events.push(event) });
  first.client.emit('qr', 'first-code');
  second.client.emit('ready');

  assert.notEqual(first.client, second.client);
  assert.deepEqual(events, [
    { event: 'qr', generation: 11, args: ['first-code'] },
    { event: 'ready', generation: 12, args: [] },
  ]);
});

test('reset authoritatively revalidates ownership immediately before deletion', async () => {
  const h = makeHarness({ heartbeat: async () => false });
  await h.supervisor.start();
  const deletions = [];

  await assert.rejects(h.supervisor.reset(13n, async () => deletions.push('delete')), { code: 'WPP_NOT_OWNER' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(deletions, []);
  assert.equal(h.calls.includes('reset-failed:13'), true);
  assert.equal(h.calls.filter(call => call === 'heartbeat').length, 1);
  assert.equal(h.clients.length, 1);
  assert.equal(h.fatalErrors.length, 1);
});

test('shutdown after lease loss never voluntarily releases uncertain ownership', async () => {
  const h = makeHarness();
  await h.supervisor.start();
  await h.supervisor.leaseLost(new Error('lease uncertain'));

  assert.equal(await h.supervisor.shutdown(), false);
  assert.equal(h.calls.includes('release-begin'), false);
  assert.equal(h.calls.includes('release-done'), false);
  assert.equal(h.fatalErrors.length, 1);
});

test('snapshot is immutable and exposes the documented ownership and gate fields', () => {
  const h = makeHarness();
  const value = h.supervisor.snapshot();

  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.owner, 'owner-a');
  assert.equal(value.epoch, 7n);
  assert.equal(value.gate, false);
  assert.equal(value.state, 'standby');
  assert.equal(value.generation, 0);
  assert.equal(value.ready, false);
  assert.equal(value.lastError, null);
});

test('initialize publication fence rejection happens before client creation', async () => {
  const h = makeHarness({
    updateOwned: async values => values.state !== 'initializing',
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });

  await assert.rejects(h.supervisor.start(), { code: 'WPP_NOT_OWNER' });
  assert.equal(h.clients.length, 0);
  assert.equal(h.calls.filter(call => call === 'destroy:1').length, 0);
  assert.equal(h.calls.filter(call => call === 'stopped:1').length, 0);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
});

test('events cannot reopen the gate after lease loss is requested', async () => {
  const stopped = deferred();
  const h = makeHarness({ destroy: () => stopped.promise });
  await h.supervisor.start();
  const loss = h.supervisor.leaseLost(new Error('lost now'));

  h.clients[0].emit('ready');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.supervisor.snapshot().state, 'fenced');

  stopped.resolve();
  await loss;
});

test('profile-lock event publication false also triggers ownership loss', async () => {
  const h = makeHarness({ updateOwned: async values => values.operation !== 'profile_lock' });
  await h.supervisor.start();

  h.clients[0].emit('error', new Error('profile lock'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('late destroy completion after shutdown timeout cannot release ownership', async () => {
  const destroy = deferred();
  const h = makeHarness({
    destroy: () => destroy.promise,
    destroyDeadlineMs: 50,
    shutdownDeadlineMs: 5,
  });
  await h.supervisor.start();

  assert.equal(await h.supervisor.shutdown(), false);
  destroy.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('release-done'), false);
  assert.equal(h.ownership.isOwner, true);
  assert.equal(h.fatalErrors.length, 1);
});

test('supervisor requires fenced state and reset persistence methods', () => {
  const ownership = {
    tryAcquire: async () => false,
    assertOwned: () => true,
    heartbeat: async () => true,
    releaseAfterQuiesced: async () => true,
  };
  const clientFactory = { create: () => { throw new Error('unused'); } };
  const fatalExit = () => {};
  const validRepository = {
    updateOwned: async () => true,
    markResetStarted: async () => true,
    markResetApplied: async () => true,
    markResetFailed: async () => true,
  };

  for (const method of Object.keys(validRepository)) {
    const repository = { ...validRepository };
    delete repository[method];
    assert.throws(
      () => createGeneralSupervisor({ ownership, clientFactory, repository, fatalExit }),
      new RegExp(`repository\\.${method} is required`),
    );
  }
  assert.throws(
    () => createGeneralSupervisor({ ownership, clientFactory, fatalExit }),
    /repository\.updateOwned is required/,
  );
});

test('supervisor requires every ownership guard capability', () => {
  const validOwnership = {
    tryAcquire: async () => false,
    assertOwned: () => true,
    heartbeat: async () => true,
    releaseAfterQuiesced: async () => true,
  };
  const clientFactory = { create: () => { throw new Error('unused'); } };
  const repository = {
    updateOwned: async () => true,
    markResetStarted: async () => true,
    markResetApplied: async () => true,
    markResetFailed: async () => true,
  };

  for (const method of Object.keys(validOwnership)) {
    const ownership = { ...validOwnership };
    delete ownership[method];
    assert.throws(
      () => createGeneralSupervisor({ ownership, clientFactory, repository, fatalExit: () => {} }),
      new RegExp(`ownership\\.${method} is required`),
    );
  }
});

test('supervisor requires an explicit fatal process terminator', () => {
  const ownership = {
    tryAcquire: async () => false,
    assertOwned: () => true,
    heartbeat: async () => true,
    releaseAfterQuiesced: async () => true,
  };
  const clientFactory = { create: () => { throw new Error('unused'); } };
  const repository = {
    updateOwned: async () => true,
    markResetStarted: async () => true,
    markResetApplied: async () => true,
    markResetFailed: async () => true,
  };

  assert.throws(
    () => createGeneralSupervisor({ ownership, clientFactory, repository }),
    /fatalExit must be a function/,
  );
});

test('ownership and fence checks accept only an explicit true result', async t => {
  await t.test('assertOwned undefined blocks initialization', async () => {
    const h = makeHarness({ assertOwned: async () => undefined });
    await assert.rejects(h.supervisor.start(), { code: 'WPP_NOT_OWNER' });
    assert.equal(h.clients.length, 0);
  });

  await t.test('updateOwned undefined blocks initialization', async () => {
    const h = makeHarness({ updateOwned: async () => undefined });
    await assert.rejects(h.supervisor.start(), { code: 'WPP_NOT_OWNER' });
    assert.equal(h.clients.length, 0);
  });

  await t.test('updateOwned undefined during reset triggers lease-loss cleanup', async () => {
    const h = makeHarness({
      updateOwned: async values => values.state === 'resetting' ? undefined : true,
      destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
      confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
    });
    await h.supervisor.start();

    await assert.rejects(h.supervisor.reset(30n, async () => {}), { code: 'WPP_NOT_OWNER' });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(h.fatalErrors.length, 1);
    assert.equal(h.calls.filter(call => call === 'destroy:1').length, 1);
    assert.equal(h.calls.includes('release-begin'), false);
  });

  await t.test('heartbeat undefined blocks client use', async () => {
    const h = makeHarness({ heartbeat: async () => undefined });
    await h.supervisor.start();
    h.clients[0].emit('ready');
    await new Promise(resolve => setImmediate(resolve));
    let invoked = 0;

    await assert.rejects(
      h.supervisor.withActiveClient(() => { invoked += 1; }),
      { code: 'WPP_NOT_OWNER' },
    );
    assert.equal(invoked, 0);
  });

  await t.test('markResetApplied undefined rejects reset completion', async () => {
    const h = makeHarness({ markResetApplied: async () => undefined });
    await h.supervisor.start();

    await assert.rejects(h.supervisor.reset(31n, async () => {}), { code: 'WPP_NOT_OWNER' });
    assert.equal(h.supervisor.snapshot().gateOpen, false);
  });
});

test('ownership loss between assertion and state publication cannot create a successor', async () => {
  let assertions = 0;
  const h = makeHarness({
    assertOwned: async ownership => {
      assertions += 1;
      if (assertions === 2) ownership.isOwner = false;
      return true;
    },
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.restart('race'), { code: 'WPP_NOT_OWNER' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.clients.length, 1);
  assert.equal(h.calls.filter(call => call === 'destroy:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
});

test('lease loss has a total deadline even behind a hung initialize', async () => {
  const h = makeHarness({
    initialize: () => new Promise(() => {}),
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    initializeDeadlineMs: 80,
    destroyDeadlineMs: 5,
    shutdownDeadlineMs: 10,
  });
  const start = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  const began = Date.now();

  assert.equal(await h.supervisor.leaseLost(new Error('lease lost')), false);

  assert.ok(Date.now() - began < 50);
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
  await assert.rejects(start, /initialize deadline/);
});

test('rejected reset persistence fences trigger fatal lease-loss cleanup', async t => {
  for (const [name, options] of [
    ['start fence', { markResetStarted: async () => false }],
    ['completion fence', { markResetApplied: async () => false }],
  ]) {
    await t.test(name, async () => {
      const h = makeHarness({
        ...options,
        destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
        confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
      });
      await h.supervisor.start();

      await assert.rejects(h.supervisor.reset(21n, async () => h.calls.push('delete')), /reset fence/);
      assert.equal(await h.supervisor.shutdown(), false);

      assert.equal(h.supervisor.snapshot().state, 'fenced');
      assert.equal(h.supervisor.snapshot().gateOpen, false);
      assert.equal(h.fatalErrors.length, 1);
      assert.equal(h.calls.includes('release-begin'), false);
    });
  }
});

test('failed persistence of a terminal reset failure triggers fatal lease-loss handling', async () => {
  const resetError = new Error('destroy rejected');
  const h = makeHarness({
    destroy: async () => { throw resetError; },
    markResetFailed: async () => false,
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.reset(23n, async () => {}), /destroy rejected/);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /reset failure fence rejected persistence/i);
  assert.equal(h.fatalErrors[0].cause, resetError);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('client factory requires an explicit stop confirmation capability', () => {
  const factory = createGeneralClientFactory({
    createClient: () => ({ initialize: async () => {}, destroy: async () => {} }),
  });

  assert.throws(
    () => factory.create({ generation: 1 }),
    /client\.confirmStopped is required/,
  );
});

test('reset keeps the send gate closed until completion is durably applied', async () => {
  const applied = deferred();
  const h = makeHarness({
    initialize: async raw => {
      if (raw.id === 2) raw.emit('ready');
    },
    markResetApplied: () => applied.promise,
  });
  await h.supervisor.start();

  const reset = h.supervisor.reset(22n, async () => {});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'initializing');
  assert.equal(h.supervisor.snapshot().ready, false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);

  applied.resolve(true);
  assert.equal(await reset, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.supervisor.snapshot().gateOpen, true);
});
