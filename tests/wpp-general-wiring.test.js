import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import express from 'express';

import { createGeneralRuntime } from '../src/wpp/generalRuntime.js';
import { registerWhatsAppWeb } from '../src/wpp/whatsappWeb.js';
import { createWppDeps } from '../src/bootstrap/createWppDeps.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function makeRepository(overrides = {}) {
  return {
    ensureSchema: async () => {},
    updateOwned: async () => true,
    markResetStarted: async () => true,
    markResetApplied: async () => true,
    markResetFailed: async () => true,
    loadPendingReset: async () => null,
    ...overrides,
  };
}

function makeOwnership({ acquired = true } = {}) {
  let owner = false;
  return {
    ownerId: 'owner:test',
    epoch: 7n,
    get isOwner() { return owner; },
    async tryAcquire() { owner = acquired; return acquired; },
    assertOwned() { return owner; },
    async heartbeat() { return owner; },
    async releaseAfterQuiesced(fn) { await fn(); owner = false; return true; },
  };
}

function makeClientClass() {
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.connected = true;
      this.processHandle = { pid: 99 + clients.length, exitCode: null, signalCode: null };
      this.pupBrowser = {
        isConnected: () => this.connected,
        process: () => this.processHandle,
      };
      clients.push(this);
    }
    async initialize() { this.initializeCalls = (this.initializeCalls ?? 0) + 1; }
    async destroy() {
      this.destroyCalls = (this.destroyCalls ?? 0) + 1;
      this.connected = false;
      this.processHandle.exitCode = 0;
    }
  }
  return { FakeClient, clients };
}

class FakeLocalAuth {
  constructor(options) { this.options = options; }
}

const inertTimers = {
  setTimeout() { return Symbol('timer'); },
  clearTimeout() {},
};

test('owner acquisition creates and initializes exactly one fresh General client', async () => {
  const { FakeClient, clients } = makeClientClass();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership({ acquired: true }),
    handlers: { start: async () => {} },
    handleIncomingMediaMessage: () => {},
    timers: inertTimers,
    fatalExit: () => {},
  });

  assert.equal(await runtime.tick(), true);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].initializeCalls, 1);
  assert.equal(clients[0].options.authStrategy.options.clientId, 'server_session_hidro');
  runtime.stopTimers();
});

test('two competing application runtimes initialize exactly one General client', async () => {
  const shared = { holder: null, epoch: 0n };
  function competingOwnership(ownerId) {
    let owner = false;
    let epoch = null;
    return {
      ownerId,
      get epoch() { return epoch; },
      get isOwner() { return owner; },
      async tryAcquire() {
        if (shared.holder !== null) return false;
        shared.holder = ownerId;
        shared.epoch += 1n;
        epoch = shared.epoch;
        owner = true;
        return true;
      },
      assertOwned() { return owner && shared.holder === ownerId; },
      async heartbeat() { return owner && shared.holder === ownerId; },
      async releaseAfterQuiesced(fn) {
        await fn();
        if (shared.holder !== ownerId) return false;
        shared.holder = null;
        owner = false;
        return true;
      },
    };
  }
  const firstClients = makeClientClass();
  const secondClients = makeClientClass();
  const common = {
    enabled: true,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    timers: inertTimers,
    fatalExit: () => {},
  };
  const first = createGeneralRuntime({
    ...common,
    Client: firstClients.FakeClient,
    ownership: competingOwnership('app:first'),
  });
  const second = createGeneralRuntime({
    ...common,
    Client: secondClients.FakeClient,
    ownership: competingOwnership('app:second'),
  });

  const results = await Promise.all([first.tick(), second.tick()]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(firstClients.clients.length + secondClients.clients.length, 1);
  const created = firstClients.clients[0] ?? secondClients.clients[0];
  assert.equal(created.initializeCalls, 1);
  const snapshots = [first.snapshot(), second.snapshot()];
  assert.equal(snapshots.filter(snapshot => snapshot.isOwner).length, 1);
  assert.equal(snapshots.filter(snapshot => !snapshot.isOwner && snapshot.state === 'standby').length, 1);
  first.stopTimers();
  second.stopTimers();
});

test('follower acquisition initializes no General client', async () => {
  const { FakeClient, clients } = makeClientClass();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership({ acquired: false }),
    handlers: { start: async () => {} },
    handleIncomingMediaMessage: () => {},
    timers: inertTimers,
    fatalExit: () => {},
  });

  assert.equal(await runtime.tick(), false);
  assert.equal(clients.length, 0);
  runtime.stopTimers();
});

test('terminal events create one fresh successor and never reuse the destroyed client', async () => {
  const { FakeClient, clients } = makeClientClass();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: inertTimers,
    fatalExit: () => {},
  });
  await runtime.tick();

  clients[0].emit('disconnected', 'network');
  for (let attempt = 0; attempt < 10 && clients.length < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(clients.length, 2);
  assert.equal(clients[0].destroyCalls, 1);
  assert.equal(clients[1].initializeCalls, 1);
  assert.notEqual(clients[0], clients[1]);
  runtime.stopTimers();
});

test('native LocalAuth logout deletion is disabled so only fenced reset can remove the session', async () => {
  let nativeDeletes = 0;
  class DestructiveLocalAuth {
    constructor(options) { this.options = options; }
    async logout() { nativeDeletes += 1; }
  }
  const { FakeClient, clients } = makeClientClass();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: DestructiveLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: inertTimers,
    fatalExit: () => {},
  });
  await runtime.tick();
  await clients[0].options.authStrategy.logout();
  assert.equal(nativeDeletes, 0);
  runtime.stopTimers();
});

test('profile lock fences the generation without deleting files or creating a successor', async () => {
  const { FakeClient, clients } = makeClientClass();
  let removals = 0;
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    fs: { promises: { rm: async () => { removals += 1; } } },
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: inertTimers,
    fatalExit: () => {},
  });
  await runtime.tick();

  clients[0].emit('error', new Error('browser is already running (SingletonLock)'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removals, 0);
  assert.equal(clients.length, 1);
  assert.equal(runtime.snapshot().state, 'fenced');
  runtime.stopTimers();
});

test('handlers and incoming media are generation-scoped and disabled in QR-only mode', async () => {
  const { FakeClient, clients } = makeClientClass();
  const handlerClients = [];
  const mediaMessages = [];
  let outboxRuns = 0;
  const firstOutboxRun = deferred();
  const media = message => { mediaMessages.push(message); };
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    handlers: { start: async client => { handlerClients.push(client); } },
    handleIncomingMediaMessage: media,
    timers: inertTimers,
    fatalExit: () => {},
  });
  runtime.setOutboxProcessor({
    processOutbox: async () => {
      outboxRuns += 1;
      if (outboxRuns === 1) await firstOutboxRun.promise;
    },
  });
  await runtime.tick();
  clients[0].emit('message', 'before-ready');
  assert.equal(clients[0].listenerCount('message'), 0);
  assert.deepEqual(mediaMessages, []);
  clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  await runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handlerClients.length, 1);
  assert.equal(outboxRuns, 1);
  assert.equal(clients[0].listenerCount('message'), 1);
  clients[0].emit('message', 'active-first');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(mediaMessages, ['active-first']);
  firstOutboxRun.resolve();
  await new Promise(resolve => setImmediate(resolve));

  clients[0].emit('disconnected', 'network');
  for (let attempt = 0; attempt < 10 && clients.length < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  clients[0].emit('ready');
  clients[0].emit('message', 'stale-first');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  assert.equal(handlerClients.length, 1);
  assert.deepEqual(mediaMessages, ['active-first']);

  clients[1].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  for (let attempt = 0; attempt < 10 && handlerClients.length < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(handlerClients.length, 2);
  assert.notEqual(handlerClients[0], handlerClients[1]);
  assert.equal(clients[1].listenerCount('message'), 1);
  clients[1].emit('message', 'active-second');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(mediaMessages, ['active-first', 'active-second']);
  runtime.stopTimers();

  const qr = makeClientClass();
  const qrRuntime = createGeneralRuntime({
    enabled: true,
    qrOnly: true,
    Client: qr.FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    handlers: { start: async client => { handlerClients.push(client); } },
    handleIncomingMediaMessage: media,
    timers: inertTimers,
    fatalExit: () => {},
  });
  await qrRuntime.tick();
  qr.clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await qrRuntime.tick();
  assert.equal(qr.clients[0].listenerCount('message'), 0);
  assert.equal(handlerClients.length, 2);
  qrRuntime.stopTimers();
});

test('a ready successor never exposes the previous active generation before maintenance catches up', async () => {
  const { FakeClient, clients } = makeClientClass();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    handlers: { start: async () => {} },
    timers: inertTimers,
    fatalExit: () => {},
  });

  await runtime.tick();
  clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  for (let attempt = 0; attempt < 10 && runtime.getState().wppClient === null; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const firstActiveClient = runtime.getState().wppClient;
  assert.notEqual(firstActiveClient, null);

  await runtime.supervisor.restart('manual');
  clients[1].emit('ready');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(runtime.snapshot().generation, 2);
  assert.equal(runtime.snapshot().ready, true);
  assert.notEqual(runtime.getState().wppClient, firstActiveClient);
  assert.equal(runtime.getState().wppClient, null);
  runtime.stopTimers();
});

test('handler completion is revalidated before exposing a client or attaching media', async () => {
  const handlerStarted = deferred();
  const handlerRelease = deferred();
  const first = new EventEmitter();
  const second = new EventEmitter();
  let active = { client: first, generation: 1, epoch: 1n };
  let snapshot = {
    isOwner: true,
    ownerId: 'owner:test',
    epoch: 1n,
    generation: 1,
    state: 'ready',
    ready: true,
    gateOpen: true,
  };
  let outboxRuns = 0;
  const supervisor = {
    snapshot: () => snapshot,
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async fn => {
      if (!snapshot.ready || !snapshot.gateOpen) {
        throw Object.assign(new Error('not active'), { code: 'WPP_NOT_OWNER' });
      }
      return fn(active);
    },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor,
    handlers: {
      start: async () => {
        handlerStarted.resolve();
        await handlerRelease.promise;
      },
    },
    handleIncomingMediaMessage: () => {},
    timers: inertTimers,
  });
  runtime.setOutboxProcessor({ processOutbox: async () => { outboxRuns += 1; } });

  await runtime.tick();
  await handlerStarted.promise;
  snapshot = { ...snapshot, generation: 2, state: 'restarting', ready: false, gateOpen: false };
  active = { client: second, generation: 2, epoch: 1n };
  handlerRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(first.listenerCount('message'), 0);
  assert.equal(outboxRuns, 0);
  assert.equal(runtime.getState().wppClient, null);
  runtime.stopTimers();
});

test('ready applies the sendSeen no-op patch to each fresh generation', async () => {
  const { FakeClient, clients } = makeClientClass();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: inertTimers,
    fatalExit: () => {},
  });
  await runtime.tick();
  let evaluated = 0;
  let installed = 0;
  clients[0].pupPage = {
    evaluate: async callback => { evaluated += 1; assert.equal(typeof callback, 'function'); },
    evaluateOnNewDocument: async callback => { installed += 1; assert.equal(typeof callback, 'function'); },
  };
  clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(evaluated, 1);
  assert.equal(installed, 1);
  runtime.stopTimers();
});

test('authenticated fallback promotes the same operational generation to ready after 8 seconds', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].pupPage = {
    evaluate: async callback => String(callback).includes('runtimeReady')
      ? { connected: true, runtimeReady: true }
      : undefined,
  };

  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled[0].milliseconds, 8000);
  await scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.snapshot().ready, true);
  assert.equal(runtime.snapshot().gateOpen, true);
  runtime.stopTimers();
});

test('authenticated fallback exhaustion restarts the stuck generation exactly once', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    authenticatedFallbackMaxAttempts: 2,
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].inject = async () => {};
  clients[0].pupPage = {
    evaluate: async callback => String(callback).includes('runtimeReady')
      ? { connected: true, runtimeReady: false }
      : undefined,
  };

  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));
  await scheduled[0].callback();
  await scheduled[1].callback();
  for (let attempt = 0; attempt < 10 && clients.length < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(clients.length, 2);
  assert.equal(clients[0].destroyCalls, 1);
  assert.equal(runtime.snapshot().generation, 2);
  runtime.stopTimers();
});

test('an external supervisor restart cancels the old generation fallback timer', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  const cleared = [];
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: {
      setTimeout(callback, milliseconds) {
        const id = scheduled.length + 1;
        scheduled.push({ id, callback, milliseconds });
        return id;
      },
      clearTimeout(id) { cleared.push(id); },
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled.length, 1);

  await runtime.supervisor.restart('manual');

  assert.deepEqual(cleared, [scheduled[0].id]);
  assert.equal(clients.length, 2);
  runtime.stopTimers();
});

test('authenticated fallback timer from a stale generation cannot promote its successor', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  const readyPublications = [];
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository({
      updateOwned: async values => {
        if (values.state === 'ready') readyPublications.push(values);
        return true;
      },
    }),
    ownership: makeOwnership(),
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].pupPage = { evaluate: async () => ({ connected: true, runtimeReady: true }) };
  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));
  const staleTimer = scheduled[0];

  clients[0].emit('disconnected', 'network');
  for (let attempt = 0; attempt < 10 && clients.length < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(clients.length, 2);
  await staleTimer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readyPublications.length, 0);
  assert.equal(runtime.snapshot().ready, false);
  runtime.stopTimers();
});

test('authenticated fallback reinjects a missing runtime before promoting ready', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  let runtimePresent = false;
  let injections = 0;
  let syncFinishes = 0;
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].inject = async () => { injections += 1; runtimePresent = true; };
  clients[0].pupPage = {
    evaluate: async callback => {
      if (String(callback).includes('runtimeReady')) {
        return { connected: true, runtimeReady: runtimePresent };
      }
      if (String(callback).includes('onAppStateHasSyncedEvent')) syncFinishes += 1;
      return true;
    },
  };

  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));
  await scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(injections, 1);
  assert.equal(syncFinishes, 1);
  assert.equal(runtime.snapshot().ready, true);
  runtime.stopTimers();
});

test('ownership loss during a fallback probe prevents later reinjection work', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  const probe = deferred();
  const probeStarted = deferred();
  let injections = 0;
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].inject = async () => { injections += 1; };
  clients[0].pupPage = {
    evaluate: async callback => {
      if (!String(callback).includes('runtimeReady')) return undefined;
      probeStarted.resolve();
      return probe.promise;
    },
  };
  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));

  const fallback = scheduled[0].callback();
  await probeStarted.promise;
  const loss = runtime.supervisor.leaseLost(new Error('ownership lost during probe'));
  probe.resolve({ connected: true, runtimeReady: false });
  await fallback;
  await loss;

  assert.equal(injections, 0);
  assert.equal(runtime.snapshot().state, 'fenced');
  runtime.stopTimers();
});

test('authenticated fallback in flight cannot promote after runtime shutdown', async () => {
  const { FakeClient, clients } = makeClientClass();
  const scheduled = [];
  const probe = deferred();
  const probeStarted = deferred();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership: makeOwnership(),
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
    fatalExit: () => {},
  });
  await runtime.tick();
  clients[0].pupPage = {
    evaluate: async callback => {
      if (!String(callback).includes('runtimeReady')) return undefined;
      probeStarted.resolve();
      return probe.promise;
    },
  };

  clients[0].emit('authenticated');
  await new Promise(resolve => setImmediate(resolve));
  const fallback = scheduled[0].callback();
  await probeStarted.promise;
  runtime.stopTimers();
  probe.resolve({ connected: true, runtimeReady: true });
  await fallback;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(runtime.snapshot().ready, false);
  assert.equal(runtime.snapshot().gateOpen, false);
});

test('pending reset quarantines and deletes only the fixed General session directory', async () => {
  const { FakeClient, clients } = makeClientClass();
  const resetCalls = [];
  const renames = [];
  const removals = [];
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async (sequence, deleteSessionFn) => {
      resetCalls.push(sequence);
      await deleteSessionFn();
      return true;
    },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    cwd: '/srv/app',
    uuid: () => 'reset-uuid',
    fs: {
      renameSync: (source, target) => { renames.push([source, target]); },
      promises: {
        rm: async (target, options) => { removals.push([target, options]); },
      },
    },
    repository: makeRepository({
      loadPendingReset: async ({ ownerId, epoch }) => ({
        owner_id: ownerId,
        epoch,
        reset_requested_seq: 31n,
        reset_applied_seq: 30n,
      }),
    }),
    supervisor,
    timers: inertTimers,
  });

  await runtime.tick();
  await runtime.tick();
  assert.deepEqual(resetCalls, [31n]);
  const canonical = path.join('/srv/app', '.wwebjs_auth', 'session-server_session_hidro');
  const quarantine = `${canonical}.reset-reset-uuid`;
  assert.deepEqual(renames, [[canonical, quarantine]]);
  assert.deepEqual(removals, [[
    quarantine,
    { recursive: true, force: true },
  ]]);
  assert.equal(clients.length, 0);
  runtime.stopTimers();
});

test('missing canonical session is a successful reset without recursive removal', async () => {
  let removals = 0;
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async (_sequence, deleteSessionFn) => deleteSessionFn(),
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    path,
    fs: {
      renameSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      promises: {
        rm: async () => { removals += 1; },
      },
    },
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 32n, reset_applied_seq: 31n }),
    }),
    supervisor,
    timers: inertTimers,
  });

  await runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removals, 0);
  runtime.stopTimers();
});

test('failed reset sequence is attempted again on the next maintenance tick', async () => {
  let attempts = 0;
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async sequence => {
      attempts += 1;
      assert.equal(sequence, 44n);
      if (attempts === 1) throw new Error('transient reset failure');
      return true;
    },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 44n, reset_applied_seq: 43n }),
    }),
    supervisor,
    logger: { error() {}, warn() {} },
    timers: inertTimers,
  });

  await runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  await runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  runtime.stopTimers();
});

test('session deletion deadline bounds removal after synchronous quarantine', async () => {
  const removal = deferred();
  const scheduled = [];
  const failures = [];
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async (_sequence, deleteSessionFn) => {
      try {
        return await deleteSessionFn();
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    path,
    fs: {
      renameSync: () => {},
      promises: {
        rm: () => removal.promise,
      },
    },
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 8n, reset_applied_seq: 7n }),
    }),
    supervisor,
    logger: { error() {}, warn() {} },
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  await runtime.tick();
  for (let attempt = 0; attempt < 10 && scheduled.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(scheduled[0]?.milliseconds, 30000);
  scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].timedOut, true);
  removal.resolve();
  runtime.stopTimers();
});

test('a timed-out reset cannot rename a successor session when quarantine completes late', async () => {
  const renameStarted = deferred();
  const renameRelease = deferred();
  const removalStarted = deferred();
  const removalRelease = deferred();
  const scheduled = [];
  const canonical = path.join('/srv/app', '.wwebjs_auth', 'session-server_session_hidro');
  const quarantine = `${canonical}.reset-late-rename`;
  const entries = new Map([[canonical, 'original']]);
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async (_sequence, deleteSessionFn) => deleteSessionFn(),
  };
  const move = (source, target) => {
    if (!entries.has(source)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    entries.set(target, entries.get(source));
    entries.delete(source);
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    path,
    cwd: '/srv/app',
    uuid: () => 'late-rename',
    fs: {
      renameSync: move,
      promises: {
        rename: async (source, target) => {
          renameStarted.resolve();
          await renameRelease.promise;
          move(source, target);
        },
        rm: async target => {
          removalStarted.resolve();
          await removalRelease.promise;
          entries.delete(target);
        },
      },
    },
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 11n, reset_applied_seq: 10n }),
    }),
    supervisor,
    logger: { error() {}, warn() {} },
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  await runtime.tick();
  await Promise.race([renameStarted.promise, removalStarted.promise]);
  assert.equal(scheduled[0]?.milliseconds, 30000);
  scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));

  entries.set(canonical, 'successor');
  renameRelease.resolve();
  removalRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(entries.get(canonical), 'successor');
  assert.equal(entries.has(quarantine), false);
  runtime.stopTimers();
});

test('session deletion rejects at its injected 30 second deadline instead of assuming success', async () => {
  const deletion = deferred();
  const scheduled = [];
  const fatalErrors = [];
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async (_sequence, deleteSessionFn) => {
      try {
        return await deleteSessionFn();
      } catch (error) {
        fatalErrors.push(error);
        throw error;
      }
    },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    path,
    fs: {
      renameSync: () => {},
      promises: {
        rm: () => deletion.promise,
      },
    },
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 9n, reset_applied_seq: 8n }),
    }),
    supervisor,
    fatalExit: error => { fatalErrors.push(error); },
    logger: { error() {}, warn() {} },
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  const tick = runtime.tick();
  for (let attempt = 0; attempt < 10 && scheduled.length === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(scheduled[0].milliseconds, 30000);
  scheduled[0].callback();
  await tick;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fatalErrors.length, 1);
  assert.equal(fatalErrors[0].timedOut, true);
  runtime.stopTimers();
});

test('late timed-out removal cannot delete a successor canonical session', async () => {
  const rmRelease = deferred();
  const rmStarted = deferred();
  const scheduled = [];
  const canonical = path.join('/srv/app', '.wwebjs_auth', 'session-server_session_hidro');
  const quarantine = `${canonical}.reset-late-rm`;
  const entries = new Set([canonical]);
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner:test', epoch: 12n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    start: async () => true,
    withActiveClient: async () => false,
    reset: async (_sequence, deleteSessionFn) => deleteSessionFn(),
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    path,
    cwd: '/srv/app',
    uuid: () => 'late-rm',
    fs: {
      renameSync: (source, target) => {
        assert.equal(source, canonical);
        assert.equal(target, quarantine);
        entries.delete(source);
        entries.add(target);
      },
      promises: {
        rm: async target => {
          assert.equal(target, quarantine);
          rmStarted.resolve();
          await rmRelease.promise;
          entries.delete(target);
        },
      },
    },
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 10n, reset_applied_seq: 9n }),
    }),
    supervisor,
    logger: { error() {}, warn() {} },
    fatalExit: () => {},
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  await runtime.tick();
  await rmStarted.promise;
  assert.equal(entries.has(canonical), false);
  assert.equal(entries.has(quarantine), true);
  scheduled[0].callback();
  await new Promise(resolve => setImmediate(resolve));

  entries.add(canonical);
  rmRelease.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.has(canonical), true);
  assert.equal(entries.has(quarantine), false);
  runtime.stopTimers();
});

test('ownership loss waits for bounded supervisor cleanup and calls fatal exactly once', async () => {
  const destroy = deferred();
  let loseOwnership;
  let owner = false;
  const fatalErrors = [];
  class SlowDestroyClient extends EventEmitter {
    constructor() {
      super();
      this.connected = true;
      this.processHandle = { pid: 201, exitCode: null, signalCode: null };
      this.pupBrowser = {
        isConnected: () => this.connected,
        process: () => this.processHandle,
      };
    }
    async initialize() {}
    async destroy() {
      await destroy.promise;
      this.connected = false;
      this.processHandle.exitCode = 0;
    }
  }
  const ownership = {
    ownerId: 'owner:loss-order',
    epoch: 1n,
    get isOwner() { return owner; },
    async tryAcquire() { owner = true; return true; },
    assertOwned() { return owner; },
    async heartbeat() { return owner; },
    async releaseAfterQuiesced(fn) { await fn(); owner = false; return true; },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: SlowDestroyClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownershipFactory: ({ onOwnershipLost }) => {
      loseOwnership = error => {
        owner = false;
        return onOwnershipLost(error);
      };
      return ownership;
    },
    timers: inertTimers,
    fatalExit: error => { fatalErrors.push(error); },
  });

  await runtime.tick();
  const loss = loseOwnership(new Error('advisory connection lost'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fatalErrors.length, 0);

  destroy.resolve();
  await loss;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fatalErrors.length, 1);
  await runtime.supervisor.leaseLost(new Error('duplicate loss'));
  assert.equal(fatalErrors.length, 1);
  runtime.stopTimers();
});

test('follower retry and owner heartbeat use injected bounded scheduling', async () => {
  const followerDelays = [];
  const follower = {
    snapshot: () => ({ isOwner: false, state: 'standby' }),
    start: async () => false,
  };
  const followerRuntime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor: follower,
    random: () => 1,
    timers: {
      setTimeout(_callback, milliseconds) { followerDelays.push(milliseconds); return 1; },
      clearTimeout() {},
    },
  });
  await followerRuntime.start();
  assert.deepEqual(followerDelays, [5000]);
  followerRuntime.stopTimers();

  const ownerDelays = [];
  const owner = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner', epoch: 1n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => true,
    withActiveClient: async () => false,
    start: async () => true,
  };
  const ownerRuntime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor: owner,
    timers: {
      setTimeout(_callback, milliseconds) { ownerDelays.push(milliseconds); return 1; },
      clearTimeout() {},
    },
  });
  await ownerRuntime.start();
  assert.deepEqual(ownerDelays, [5000]);
  ownerRuntime.stopTimers();
});

test('owner heartbeats continue while initial client initialization is still pending', async () => {
  const initialization = deferred();
  let owner = false;
  let heartbeats = 0;
  const scheduled = [];
  const supervisor = {
    snapshot: () => ({ isOwner: owner, ownerId: owner ? 'owner' : null, epoch: owner ? 1n : null, state: owner ? 'initializing' : 'standby' }),
    start: async () => { owner = true; await initialization.promise; return true; },
    heartbeatOnce: async () => { heartbeats += 1; return true; },
    withActiveClient: async () => false,
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor,
    random: () => 1,
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  const starting = runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner, true);
  assert.equal(scheduled[0].milliseconds, 5000);
  await scheduled[0].callback();
  assert.equal(heartbeats, 1);
  initialization.resolve();
  await starting;
  runtime.stopTimers();
});

test('follower takeover heartbeats while successor initialization remains pending', async () => {
  const initialization = deferred();
  let owner = false;
  let attempts = 0;
  let heartbeats = 0;
  const scheduled = [];
  const supervisor = {
    snapshot: () => ({ isOwner: owner, ownerId: owner ? 'owner' : null, epoch: owner ? 2n : null, state: owner ? 'initializing' : 'standby' }),
    start: async () => {
      attempts += 1;
      if (attempts === 1) return false;
      owner = true;
      await initialization.promise;
      return true;
    },
    heartbeatOnce: async () => { heartbeats += 1; return true; },
    withActiveClient: async () => false,
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor,
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  assert.equal(await runtime.start(), false);
  const takeover = scheduled.shift().callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner, true);
  assert.equal(scheduled.length, 1);
  await scheduled.shift().callback();
  assert.equal(heartbeats, 1);
  initialization.resolve();
  await takeover;
  runtime.stopTimers();
});

test('runtime and supervisor ownership checks share one non-overlapping heartbeat', async () => {
  const { FakeClient, clients } = makeClientClass();
  const heartbeat = deferred();
  let owner = false;
  let heartbeatCalls = 0;
  let blockHeartbeat = false;
  const ownership = {
    ownerId: 'owner:serialized-heartbeat',
    epoch: 23n,
    get isOwner() { return owner; },
    async tryAcquire() { owner = true; return true; },
    assertOwned() { return owner; },
    async heartbeat() {
      heartbeatCalls += 1;
      if (blockHeartbeat) return heartbeat.promise;
      return true;
    },
    async releaseAfterQuiesced(fn) { await fn(); owner = false; return true; },
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository(),
    ownership,
    timers: inertTimers,
    fatalExit: () => {},
  });

  await runtime.tick();
  clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  blockHeartbeat = true;
  const ticking = runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeatCalls, 2);
  const usingClient = runtime.supervisor.withActiveClient(async () => true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeatCalls, 2);
  heartbeat.resolve(true);
  assert.deepEqual(await Promise.all([ticking, usingClient]), [true, true]);
  runtime.stopTimers();
});

test('scheduled owner heartbeat never overlaps an in-flight tick heartbeat', async () => {
  const heartbeat = deferred();
  let heartbeatCalls = 0;
  const scheduled = [];
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner', epoch: 1n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => { heartbeatCalls += 1; return heartbeat.promise; },
    withActiveClient: async () => false,
    start: async () => true,
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor,
    timers: {
      setTimeout(callback, milliseconds) { scheduled.push({ callback, milliseconds }); return scheduled.length; },
      clearTimeout() {},
    },
  });

  const starting = runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeatCalls, 1);
  const timerTick = scheduled.shift().callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeatCalls, 1);
  heartbeat.resolve(true);
  await Promise.all([starting, timerTick]);
  runtime.stopTimers();
});

test('runtime tick is non-overlapping and disabled mode creates no ownership or timers', async () => {
  const heartbeat = deferred();
  let heartbeatCalls = 0;
  let scheduled = 0;
  const supervisor = {
    snapshot: () => ({ isOwner: true, ownerId: 'owner', epoch: 1n, state: 'ready', ready: true, gateOpen: true }),
    heartbeatOnce: async () => { heartbeatCalls += 1; return heartbeat.promise; },
    withActiveClient: async () => false,
    start: async () => true,
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    repository: makeRepository(),
    supervisor,
    timers: { setTimeout: () => { scheduled += 1; return 1; }, clearTimeout() {} },
  });
  const first = runtime.tick();
  const second = runtime.tick();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeatCalls, 1);
  heartbeat.resolve(true);
  await first;
  runtime.stopTimers();

  const disabled = createGeneralRuntime({
    enabled: false,
    repository: makeRepository(),
    timers: { setTimeout: () => { scheduled += 1; }, clearTimeout() {} },
  });
  await disabled.start();
  assert.equal(disabled.supervisor, null);
  assert.equal(scheduled, 0);
});

test('registration returns and routes the same runtime repository and supervisor without signals', () => {
  const repository = makeRepository({ getClusterStatus: async () => ({ state: 'standby' }) });
  const supervisor = { snapshot: () => ({ isOwner: false, state: 'standby' }) };
  const runtime = {
    repository,
    supervisor,
    getState: () => ({ isReadyWpp: false }),
    start: () => Promise.resolve(false),
    stopTimers() {},
    tick: async () => false,
    snapshot: () => ({ state: 'standby' }),
  };
  const beforeTerm = process.listenerCount('SIGTERM');
  const beforeInt = process.listenerCount('SIGINT');
  const returned = registerWhatsAppWeb(express(), {
    ENABLE_WPP: false,
    WPP_QR_ONLY: false,
    query: async () => [],
    qrcode: { toDataURL: async () => '' },
    withAuth: (_req, _res, next) => next(),
    isSuper: () => true,
    generalRuntime: runtime,
    registerCronAndRoutesFn: () => {},
  });

  assert.equal(returned, runtime);
  assert.equal(returned.repository, repository);
  assert.equal(returned.supervisor, supervisor);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
});

test('bootstrap composition permits injected singleton and runtime dependencies', () => {
  const injected = {
    generalControlRepository: { id: 'repository' },
    generalSupervisor: { id: 'supervisor' },
    generalOwnership: { id: 'ownership' },
    runtimeDependencies: { timers: inertTimers, ownerId: 'stable:test' },
  };
  const deps = createWppDeps(injected);
  assert.equal(deps.wpp.generalControlRepository, injected.generalControlRepository);
  assert.equal(deps.wpp.generalSupervisor, injected.generalSupervisor);
  assert.equal(deps.wpp.generalOwnership, injected.generalOwnership);
  assert.equal(deps.wpp.runtimeDependencies, injected.runtimeDependencies);
});
