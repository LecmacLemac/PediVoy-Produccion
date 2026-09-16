import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createGeneralClientFactory } from '../src/wpp/generalClientFactory.js';
import { createGeneralControlRepository } from '../src/wpp/generalControlRepository.js';
import {
  createGeneralSupervisor,
  POST_ACQUISITION_GUARD_DEADLINE_MS,
} from '../src/wpp/generalSupervisor.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function makeHarness({
  initialize, destroy, confirmStopped, forceStop, tryAcquire = async () => true,
  heartbeat, assertOwned, updateOwned, initializeDeadlineMs = 30,
  postAcquisitionGuardDeadlineMs = 5, destroyDeadlineMs = 20,
  shutdownDeadlineMs = 40, markResetStarted, markResetApplied, markResetFailed,
  releaseResult = () => true, onGenerationInvalidated, beforeInitialize, onFatal,
  repository: repositoryOverride,
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
  const repository = repositoryOverride ?? {
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
    fatalExit: error => {
      fatalErrors.push(error);
      onFatal?.(error, calls);
    },
    onGenerationInvalidated,
    beforeInitialize,
    initializeDeadlineMs,
    postAcquisitionGuardDeadlineMs,
    destroyDeadlineMs,
    shutdownDeadlineMs,
  });
  return { supervisor, ownership, clients, calls, fatalErrors };
}

function statefulResetRepository() {
  const row = {
    owner_id: 'owner-a',
    epoch: 7n,
    state: 'standby',
    operation: null,
    reset_requested_seq: 1n,
    reset_started_seq: 0n,
    reset_applied_seq: 0n,
    reset_failed_seq: 0n,
    reset_failure_error: null,
  };
  const query = async (sql, params) => {
    const owned = row.owner_id === params[0] && row.epoch === BigInt(params[1]);
    if (/SET\s+state\s*=\s*\$3/i.test(sql)) {
      if (!owned) return { rows: [], rowCount: 0 };
      row.state = params[2];
      row.operation = params[3];
      return { rows: [], rowCount: 1 };
    }
    const sequence = BigInt(params[2]);
    if (/SET\s+reset_started_seq\s*=\s*\$3/i.test(sql)) {
      const canStart = row.reset_started_seq < sequence
        || (row.reset_started_seq === sequence
          && row.reset_failed_seq === sequence
          && row.reset_failure_error !== null);
      if (!owned || !canStart || row.reset_applied_seq >= sequence
        || row.reset_requested_seq < sequence) return { rows: [], rowCount: 0 };
      row.reset_started_seq = sequence;
      row.operation = 'reset';
      row.reset_failure_error = null;
      return { rows: [], rowCount: 1 };
    }
    if (/SET\s+reset_applied_seq\s*=\s*\$3/i.test(sql)) {
      if (!owned || row.operation !== 'reset' || row.reset_applied_seq >= sequence
        || row.reset_started_seq !== sequence) return { rows: [], rowCount: 0 };
      row.reset_applied_seq = sequence;
      row.operation = null;
      row.reset_failure_error = null;
      return { rows: [], rowCount: 1 };
    }
    if (/SET\s+reset_failed_seq\s*=\s*\$3/i.test(sql)) {
      if (!owned || row.operation !== 'reset' || row.reset_applied_seq >= sequence
        || row.reset_started_seq !== sequence) return { rows: [], rowCount: 0 };
      row.reset_failed_seq = sequence;
      row.operation = null;
      row.reset_failure_error = params[3];
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unsupported stateful repository query: ${sql}`);
  };
  return { repository: createGeneralControlRepository(query), row };
}

test('concurrent start collapses to one ownership acquisition and one client initialization', async () => {
  const init = deferred();
  const h = makeHarness({ initialize: () => init.promise, initializeDeadlineMs: 1000 });

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

test('reset preserves the real repository reset operation through fresh initialization', async () => {
  const control = statefulResetRepository();
  const h = makeHarness({ repository: control.repository });
  await h.supervisor.start();

  assert.equal(await h.supervisor.reset(1n, async () => {}), true);
  assert.equal(control.row.reset_applied_seq, 1n);
  assert.equal(control.row.operation, null);
  assert.equal(control.row.reset_failure_error, null);
});

test('post-acquisition guard default deadline is five seconds', () => {
  assert.equal(POST_ACQUISITION_GUARD_DEADLINE_MS, 5000);
});

test('post-acquisition initialization guard uses its dedicated deadline', async () => {
  const h = makeHarness({
    beforeInitialize: () => new Promise(() => {}),
    initializeDeadlineMs: 1000,
    postAcquisitionGuardDeadlineMs: 5,
  });

  await assert.rejects(
    Promise.race([
      h.supervisor.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test wait expired')), 40)),
    ]),
    /initialization guard deadline exceeded/i,
  );
  assert.equal(h.calls.includes('release-done'), true);
  assert.equal(h.ownership.isOwner, false);
  assert.equal(h.clients.length, 0);
  assert.equal(h.supervisor.snapshot().state, 'standby');
});

test('unconfirmed quiesced release after a blocked initialization guard is fatal', async t => {
  for (const releaseConfirmed of [false, undefined]) {
    await t.test(String(releaseConfirmed), async () => {
      const h = makeHarness({
        beforeInitialize: async () => false,
        releaseResult: () => releaseConfirmed,
      });

      await assert.rejects(h.supervisor.start(), /release after initialization guard failed/i);
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(h.clients.length, 0);
      assert.equal(h.ownership.isOwner, true);
      assert.equal(h.supervisor.snapshot().state, 'fenced');
      assert.equal(h.fatalErrors.length, 1);
      assert.match(h.fatalErrors[0].message, /release after initialization guard failed/i);
    });
  }
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

test('failed or hung teardown fences reset, becomes fatal, and never deletes or replaces', async t => {
  for (const [name, options] of [
    ['destroy rejected', { destroy: async () => { throw new Error('destroy rejected'); } }],
    ['destroy hung', { destroy: () => new Promise(() => {}) }],
    ['stop unconfirmed', { confirmStopped: async () => false }],
  ]) {
    await t.test(name, async () => {
      const h = makeHarness(options);
      await h.supervisor.start();
      const deletions = [];

      await assert.rejects(h.supervisor.reset(3n, async () => deletions.push('delete')), /destroy|stop/);
      await new Promise(resolve => setImmediate(resolve));

      assert.deepEqual(deletions, []);
      assert.equal(h.clients.length, 1);
      assert.equal(h.calls.includes('release-begin'), false);
      assert.equal(h.supervisor.snapshot().state, 'fenced');
      assert.equal(h.calls.includes('reset-failed:3'), true);
      assert.equal(h.fatalErrors.length, 1);
    });
  }
});

test('destroy rejection persists the terminal fence before bounded force-stop and fatal', async () => {
  const forced = deferred();
  const h = makeHarness({
    destroy: async raw => {
      h.calls.push(`destroy:${raw.id}`);
      throw new Error('destroy rejected');
    },
    forceStop: async raw => {
      h.calls.push(`force:${raw.id}`);
      await forced.promise;
      return true;
    },
  });
  await h.supervisor.start();

  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:')), [
    'state:fenced',
    'force:1',
  ]);
  assert.equal(h.fatalErrors.length, 0);
  assert.equal(h.clients.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);

  forced.resolve();
  await assert.rejects(restart, /destroy rejected/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
});

test('unconfirmed stop force-stops and fatals exactly once after reset fencing', async () => {
  const h = makeHarness({
    confirmStopped: async raw => {
      h.calls.push(`stopped:${raw.id}`);
      return false;
    },
    forceStop: async raw => {
      h.calls.push(`force:${raw.id}`);
      return true;
    },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.reset(4n, async () => h.calls.push('delete')), /stop could not be confirmed/i);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:')), [
    'state:fenced',
    'force:1',
  ]);
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.clients.length, 1);
  assert.equal(h.calls.includes('delete'), false);
  assert.equal(h.calls.includes('release-begin'), false);
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

test('a terminal restart failure cannot be overwritten by late client events', async () => {
  const h = makeHarness({
    destroy: async () => { throw new Error('destroy rejected'); },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.restart('manual'), /destroy rejected/);
  h.clients[0].emit('ready');
  h.clients[0].emit('qr', 'late-code');
  h.clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().ready, false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.calls.filter(call => ['state:ready', 'state:awaiting_qr', 'state:authenticated'].includes(call)).length, 0);
});

test('failed persistence of a terminal restart fence triggers fatal lease-loss handling', async () => {
  const lifecycleError = new Error('destroy rejected');
  const h = makeHarness({
    destroy: async () => { throw lifecycleError; },
    updateOwned: async values => values.state !== 'fenced',
    forceStop: async () => true,
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

test('fatal teardown handling is bounded when terminal fence persistence hangs', async () => {
  const h = makeHarness({
    destroy: async () => { throw new Error('destroy rejected'); },
    updateOwned: values => values.state === 'fenced' ? new Promise(() => {}) : true,
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    shutdownDeadlineMs: 10,
  });
  await h.supervisor.start();

  await assert.rejects(
    Promise.race([
      h.supervisor.restart('manual'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test wait expired')), 50)),
    ]),
    /destroy rejected/,
  );
  await new Promise(resolve => setTimeout(resolve, 15));

  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /terminal fence persistence deadline exceeded/i);
  assert.match(h.fatalErrors[0].cause?.message, /destroy rejected/i);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('terminal fence persistence does not mutate a frozen rejection', async () => {
  const lifecycleError = new Error('destroy rejected');
  const persistenceError = Object.freeze(new Error('fence persistence rejected'));
  const h = makeHarness({
    destroy: async () => { throw lifecycleError; },
    updateOwned: async values => {
      if (values.state === 'fenced') throw persistenceError;
      return true;
    },
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.restart('manual'), /destroy rejected/);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /fence persistence rejected/);
  assert.equal(h.fatalErrors[0].cause, lifecycleError);
  assert.equal(Object.hasOwn(persistenceError, 'cause'), false);
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

test('a stale generation restart cannot invalidate or close the ready successor', async () => {
  const invalidated = [];
  const h = makeHarness({
    onGenerationInvalidated: eventGeneration => invalidated.push(eventGeneration),
  });
  await h.supervisor.start();
  await h.supervisor.restart('manual');
  h.clients[1].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().generation, 2);
  assert.equal(h.supervisor.snapshot().gateOpen, true);
  assert.deepEqual(invalidated, [1]);

  assert.equal(await h.supervisor.restart('stale', { expectedGeneration: 1 }), false);

  assert.equal(h.supervisor.snapshot().generation, 2);
  assert.equal(h.supervisor.snapshot().ready, true);
  assert.equal(h.supervisor.snapshot().gateOpen, true);
  assert.deepEqual(invalidated, [1]);
  assert.equal(h.clients.length, 2);
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

test('profile-lock reset failure persistence does not mutate a frozen rejection', async () => {
  const resetStarted = deferred();
  const originalCause = new Error('original persistence cause');
  const persistenceError = Object.freeze(new Error('frozen reset persistence failure', { cause: originalCause }));
  const h = makeHarness({
    markResetStarted: () => resetStarted.promise,
    markResetFailed: async () => { throw persistenceError; },
  });
  await h.supervisor.start();

  const reset = h.supervisor.reset(15n, async () => h.calls.push('delete'));
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  resetStarted.resolve(true);

  await assert.rejects(reset, error => {
    assert.match(error.message, /frozen reset persistence failure/);
    assert.equal(error.cause, originalCause);
    return true;
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('delete'), false);
  assert.equal(h.calls.filter(call => call === 'reset-failed:15').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(persistenceError.cause, originalCause);
  assert.equal(Object.hasOwn(persistenceError, 'resetFailurePersistenceAttempted'), false);
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

test('lease-loss destroy rejection uses bounded force-stop before fatal', async () => {
  const h = makeHarness({
    destroy: async () => { throw new Error('destroy rejected'); },
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  await h.supervisor.leaseLost(new Error('lease lost'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
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

test('restart waits for active generation work to drain before teardown', async () => {
  const workStarted = deferred();
  const workRelease = deferred();
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  const work = h.supervisor.withActiveClient(async () => {
    workStarted.resolve();
    await workRelease.promise;
    return 'sent';
  });
  await workStarted.promise;
  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('destroy:1'), false);
  workRelease.resolve();
  assert.equal(await work, 'sent');
  assert.equal(await restart, true);
  assert.deepEqual(h.calls.filter(call => /^(destroy|stopped):/.test(call)), ['destroy:1', 'stopped:1']);
});

test('active-work drain timeout fences before force-stop without starting normal destroy', async () => {
  const workStarted = deferred();
  const workRelease = deferred();
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    destroyDeadlineMs: 5,
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  const work = h.supervisor.withActiveClient(async () => {
    workStarted.resolve();
    await workRelease.promise;
    return 'sent';
  });
  await workStarted.promise;

  await assert.rejects(h.supervisor.reset(5n, async () => h.calls.push('delete')), /active work drain deadline exceeded/i);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('destroy:1'), false);
  assert.deepEqual(h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:')), [
    'state:fenced',
    'force:1',
  ]);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.clients.length, 1);

  workRelease.resolve();
  assert.equal(await work, 'sent');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.includes('destroy:1'), false);
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
});

test('restart drains active work accepted before its ownership heartbeat completes', async () => {
  const heartbeat = deferred();
  const h = makeHarness({
    heartbeat: () => heartbeat.promise,
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  const work = h.supervisor.withActiveClient(() => 'sent');
  await new Promise(resolve => setImmediate(resolve));
  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('destroy:1'), false);
  heartbeat.resolve(true);
  assert.equal(await work, 'sent');
  assert.equal(await restart, true);
  assert.equal(h.fatalErrors.length, 0);
});

test('terminal profile-lock fencing cancels active work awaiting its ownership heartbeat', async () => {
  const heartbeat = deferred();
  const h = makeHarness({ heartbeat: () => heartbeat.promise });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  let invoked = 0;

  const work = h.supervisor.withActiveClient(() => { invoked += 1; });
  await new Promise(resolve => setImmediate(resolve));
  h.clients[0].emit('error', new Error('Chromium profile lock'));
  heartbeat.resolve(true);

  await assert.rejects(work, { code: 'WPP_NOT_OWNER' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked, 0);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.fatalErrors.length, 0);
});

test('authenticated current-client access is authoritative and generation fenced', async () => {
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();
  h.clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));

  const current = await h.supervisor.withCurrentClient(1, context => context.client.id);
  assert.equal(current, 1);
  assert.equal(h.calls.at(-1), 'heartbeat');

  await h.supervisor.restart('next-generation');
  await assert.rejects(
    h.supervisor.withCurrentClient(1, () => 'unsafe'),
    { code: 'WPP_NOT_OWNER' },
  );
});

test('withCurrentClient serializes asynchronous generation work ahead of restart', async () => {
  const workStarted = deferred();
  const workRelease = deferred();
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  const work = h.supervisor.withCurrentClient(1, async () => {
    workStarted.resolve();
    await workRelease.promise;
    return 'repaired';
  });
  await workStarted.promise;
  const restart = h.supervisor.restart('manual');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.calls.includes('destroy:1'), false);
  workRelease.resolve();
  assert.equal(await work, 'repaired');
  assert.equal(await restart, true);
  assert.equal(h.clients.length, 2);
});

test('withCurrentClient preserves the authoritative heartbeat failure as its cause', async () => {
  const heartbeatError = new Error('database heartbeat timed out');
  let failHeartbeat = false;
  const h = makeHarness({
    heartbeat: async () => {
      if (failHeartbeat) throw heartbeatError;
      return true;
    },
  });
  await h.supervisor.start();
  failHeartbeat = true;

  await assert.rejects(
    h.supervisor.withCurrentClient(1, () => 'unsafe'),
    error => {
      assert.equal(error.code, 'WPP_NOT_OWNER');
      assert.equal(error.cause, heartbeatError);
      return true;
    },
  );
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

test('force-stop fallback does not mutate a frozen rejection', async () => {
  const forceStopError = Object.freeze(new Error('force stop exploded'));
  const h = makeHarness({
    initialize: () => new Promise(() => {}),
    forceStop: async raw => {
      h.calls.push(`force:${raw.id}`);
      throw forceStopError;
    },
    initializeDeadlineMs: 40,
    destroyDeadlineMs: 5,
    shutdownDeadlineMs: 10,
  });
  const start = h.supervisor.start();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await h.supervisor.shutdown(), false);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /force stop exploded/);
  assert.match(h.fatalErrors[0].cause?.message, /shutdown deadline exceeded/i);
  assert.equal(Object.hasOwn(forceStopError, 'cause'), false);
  await assert.rejects(start, /initialize deadline/);
});

test('shutdown destroy rejection persists shutdown_failed fence before force-stop and fatal', async () => {
  const updates = [];
  const h = makeHarness({
    destroy: async raw => {
      h.calls.push(`destroy:${raw.id}`);
      throw new Error('destroy rejected');
    },
    updateOwned: async values => { updates.push(values); return true; },
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    onFatal: (_error, calls) => calls.push('fatal'),
  });
  await h.supervisor.start();

  assert.equal(await h.supervisor.shutdown(), false);
  await new Promise(resolve => setImmediate(resolve));

  const terminalUpdate = updates.find(values => values.operation === 'shutdown_failed');
  assert.equal(terminalUpdate?.state, 'fenced');
  assert.deepEqual(
    h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:') || call === 'fatal'),
    ['state:fenced', 'force:1', 'fatal'],
  );
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
  assert.equal(h.clients.length, 1);
});

test('shutdown unconfirmed stop persists shutdown_failed fence before force-stop and fatal', async () => {
  const updates = [];
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return false; },
    updateOwned: async values => { updates.push(values); return true; },
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    onFatal: (_error, calls) => calls.push('fatal'),
  });
  await h.supervisor.start();

  assert.equal(await h.supervisor.shutdown(), false);
  await new Promise(resolve => setImmediate(resolve));

  const terminalUpdate = updates.find(values => values.operation === 'shutdown_failed');
  assert.equal(terminalUpdate?.state, 'fenced');
  assert.deepEqual(
    h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:') || call === 'fatal'),
    ['state:fenced', 'force:1', 'fatal'],
  );
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
  assert.equal(h.clients.length, 1);
});

test('shutdown active-work drain timeout fences before force-stop without normal destroy or successor', async () => {
  const updates = [];
  const workStarted = deferred();
  const workRelease = deferred();
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    updateOwned: async values => { updates.push(values); return true; },
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    onFatal: (_error, calls) => calls.push('fatal'),
    destroyDeadlineMs: 5,
    shutdownDeadlineMs: 40,
  });
  await h.supervisor.start();
  h.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  const work = h.supervisor.withActiveClient(async () => {
    workStarted.resolve();
    await workRelease.promise;
    return 'sent';
  });
  await workStarted.promise;

  assert.equal(await h.supervisor.shutdown(), false);
  await new Promise(resolve => setImmediate(resolve));

  const terminalUpdate = updates.find(values => values.operation === 'shutdown_failed');
  assert.equal(terminalUpdate?.state, 'fenced');
  assert.deepEqual(
    h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:') || call === 'fatal'),
    ['state:fenced', 'force:1', 'fatal'],
  );
  assert.equal(h.calls.includes('destroy:1'), false);
  assert.equal(h.calls.includes('release-begin'), false);
  assert.equal(h.clients.length, 1);
  assert.equal(h.fatalErrors.length, 1);

  workRelease.resolve();
  assert.equal(await work, 'sent');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.includes('destroy:1'), false);
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
});

test('shutdown fence persistence failure still force-stops boundedly and calls fatal once', async t => {
  for (const [name, failPersistence] of [
    ['rejection', () => { throw new Error('persistence rejected'); }],
    ['timeout', () => new Promise(() => {})],
  ]) {
    await t.test(name, async () => {
      const updates = [];
      const h = makeHarness({
        destroy: async () => { throw new Error('destroy rejected'); },
        updateOwned: values => {
          updates.push(values);
          return values.operation === 'shutdown_failed' ? failPersistence() : true;
        },
        forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
        onFatal: (_error, calls) => calls.push('fatal'),
        destroyDeadlineMs: 5,
        shutdownDeadlineMs: 10,
      });
      await h.supervisor.start();

      assert.equal(await h.supervisor.shutdown(), false);
      await new Promise(resolve => setImmediate(resolve));

      const terminalUpdate = updates.find(values => values.operation === 'shutdown_failed');
      assert.equal(terminalUpdate?.state, 'fenced');
      assert.deepEqual(
        h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:') || call === 'fatal'),
        ['state:fenced', 'force:1', 'fatal'],
      );
      assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
      assert.equal(h.fatalErrors.length, 1);
      assert.equal(h.calls.includes('release-begin'), false);
      assert.equal(h.clients.length, 1);
    });
  }
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

test('initialize cleanup failure persists its fence before bounded force-stop and fatal', async () => {
  const h = makeHarness({
    initialize: async () => { throw new Error('initialize rejected'); },
    destroy: async raw => {
      h.calls.push(`destroy:${raw.id}`);
      throw new Error('cleanup rejected');
    },
    forceStop: async raw => {
      h.calls.push(`force:${raw.id}`);
      return true;
    },
  });

  await assert.rejects(h.supervisor.start(), /initialize rejected/);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(h.calls.filter(call => call === 'state:fenced' || call.startsWith('force:')), [
    'state:fenced',
    'force:1',
  ]);
  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.clients.length, 1);
  assert.equal(h.calls.includes('release-begin'), false);
});

test('a terminal initialize failure cannot be overwritten by late client events', async () => {
  const h = makeHarness({
    initialize: async () => { throw new Error('initialize rejected'); },
    destroy: async () => { throw new Error('cleanup rejected'); },
  });

  await assert.rejects(h.supervisor.start(), /initialize rejected/);
  h.clients[0].emit('ready');
  h.clients[0].emit('qr', 'late-code');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().ready, false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.equal(h.calls.filter(call => ['state:ready', 'state:awaiting_qr'].includes(call)).length, 0);
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

test('a failed session deletion can retry the same reset sequence after confirmed teardown', async () => {
  const failures = [];
  const writes = [];
  let deletionAttempts = 0;
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
    markResetFailed: async values => { failures.push(values); return true; },
    updateOwned: async values => { writes.push(values); return true; },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.reset(23n, async () => {
    deletionAttempts += 1;
    throw new Error('quarantine rejected');
  }), /quarantine rejected/);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].sequence, 23n);
  assert.match(failures[0].error.message, /quarantine rejected/);
  assert.deepEqual(h.calls.slice(-2), ['reset-failed:23', 'state:fenced']);
  assert.equal(writes.at(-1).state, 'fenced');
  assert.equal(writes.at(-1).operation, 'reset_failed');
  assert.equal(writes.at(-1).lastError, 'quarantine rejected');
  assert.equal(await h.supervisor.reset(23n, async () => { deletionAttempts += 1; }), true);
  assert.equal(deletionAttempts, 2);
  assert.equal(h.clients.length, 2);
  assert.equal(h.clients[1].id, 2);
  assert.equal(h.calls.filter(call => call === 'reset-start:23').length, 2);
  assert.equal(h.calls.filter(call => call === 'reset-applied:23').length, 1);
});

test('a terminal reset failure is persisted after failure metadata and cannot be overwritten by late client events', async () => {
  const invalidated = [];
  const writes = [];
  const h = makeHarness({
    destroy: async () => { throw new Error('destroy rejected'); },
    onGenerationInvalidated: generation => invalidated.push(generation),
    updateOwned: async values => { writes.push(values); return true; },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.reset(23n, async () => {}), /destroy rejected/);
  h.clients[0].emit('ready');
  h.clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.supervisor.snapshot().ready, false);
  assert.equal(h.supervisor.snapshot().gateOpen, false);
  assert.deepEqual(invalidated, [1]);
  assert.equal(h.calls.filter(call => ['state:ready', 'state:authenticated'].includes(call)).length, 0);
  assert.deepEqual(h.calls.slice(-3), ['reset-start:23', 'reset-failed:23', 'state:fenced']);
  assert.deepEqual(writes.at(-1), {
    ownerId: 'owner-a',
    epoch: 7n,
    state: 'fenced',
    operation: 'reset_failed',
    lastError: 'destroy rejected',
  });
});

test('failed fenced publication after reset failure metadata triggers fatal lease loss exactly once', async () => {
  const resetError = new Error('destroy rejected');
  const h = makeHarness({
    destroy: async () => { throw resetError; },
    updateOwned: async values => values.state !== 'fenced',
    forceStop: async () => true,
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.reset(23n, async () => {}), error => error === resetError);
  await new Promise(resolve => setImmediate(resolve));
  await h.supervisor.leaseLost(new Error('duplicate'));

  assert.deepEqual(h.calls.slice(-2), ['reset-failed:23', 'state:fenced']);
  assert.equal(h.supervisor.snapshot().state, 'fenced');
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /state update/i);
  assert.equal(h.fatalErrors[0].cause, resetError);
});

test('failed persistence of a terminal reset failure triggers fatal lease-loss handling', async () => {
  const resetError = new Error('destroy rejected');
  const h = makeHarness({
    destroy: async () => { throw resetError; },
    markResetFailed: async () => false,
    forceStop: async () => true,
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

test('fatal teardown handling is bounded when reset failure metadata persistence hangs', async () => {
  const h = makeHarness({
    destroy: async () => { throw new Error('destroy rejected'); },
    markResetFailed: () => new Promise(() => {}),
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    shutdownDeadlineMs: 10,
  });
  await h.supervisor.start();

  await assert.rejects(
    Promise.race([
      h.supervisor.reset(26n, async () => {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test wait expired')), 50)),
    ]),
    /destroy rejected/,
  );
  await new Promise(resolve => setTimeout(resolve, 15));

  assert.equal(h.calls.filter(call => call === 'force:1').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.match(h.fatalErrors[0].message, /reset failure persistence deadline exceeded/i);
  assert.match(h.fatalErrors[0].cause?.message, /destroy rejected/i);
});

test('reset deletion deadline triggers supervisor fatal handling exactly once', async () => {
  const timeoutError = Object.assign(new Error('General session deletion deadline exceeded'), { timedOut: true });
  const h = makeHarness({
    destroy: async raw => { h.calls.push(`destroy:${raw.id}`); },
    confirmStopped: async raw => { h.calls.push(`stopped:${raw.id}`); return true; },
  });
  await h.supervisor.start();

  await assert.rejects(h.supervisor.reset(24n, async () => { throw timeoutError; }), timeoutError);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fatalErrors.length, 1);
  await h.supervisor.leaseLost(new Error('duplicate'));

  assert.equal(h.calls.filter(call => call === 'reset-failed:24').length, 1);
  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.fatalErrors[0], timeoutError);
});

test('reset deletion timeout starts fatal recovery before failure persistence completes', async () => {
  const persistence = deferred();
  const timeoutError = Object.assign(new Error('General session deletion deadline exceeded'), { timedOut: true });
  const h = makeHarness({
    markResetFailed: () => persistence.promise,
    forceStop: async raw => { h.calls.push(`force:${raw.id}`); return true; },
    shutdownDeadlineMs: 10,
    destroyDeadlineMs: 5,
  });
  await h.supervisor.start();

  const reset = h.supervisor.reset(25n, async () => { throw timeoutError; });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(h.fatalErrors.length, 1);
  assert.equal(h.fatalErrors[0], timeoutError);
  assert.equal(h.supervisor.snapshot().gateOpen, false);

  persistence.resolve(true);
  await assert.rejects(reset, timeoutError);
  assert.equal(h.fatalErrors.length, 1);
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
