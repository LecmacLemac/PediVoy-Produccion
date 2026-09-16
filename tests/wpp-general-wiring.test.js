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
  let outboxRuns = 0;
  const firstOutboxRun = deferred();
  const media = () => {};
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
  assert.equal(clients[0].listenerCount('message'), 1);
  clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  await runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handlerClients.length, 1);
  assert.equal(outboxRuns, 1);
  firstOutboxRun.resolve();
  await new Promise(resolve => setImmediate(resolve));

  clients[0].emit('disconnected', 'network');
  for (let attempt = 0; attempt < 10 && clients.length < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  clients[0].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  assert.equal(handlerClients.length, 1);

  clients[1].emit('ready');
  await new Promise(resolve => setImmediate(resolve));
  await runtime.tick();
  for (let attempt = 0; attempt < 10 && handlerClients.length < 2; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(handlerClients.length, 2);
  assert.notEqual(handlerClients[0], handlerClients[1]);
  assert.equal(clients[1].listenerCount('message'), 1);
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

test('pending reset uses the exact sequence and deletes only the fixed General session directory', async () => {
  const { FakeClient, clients } = makeClientClass();
  const resetCalls = [];
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
    fs: { promises: { rm: async (target, options) => { removals.push([target, options]); } } },
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
  assert.deepEqual(removals, [[
    path.join('/srv/app', '.wwebjs_auth', 'session-server_session_hidro'),
    { recursive: true, force: true },
  ]]);
  assert.equal(clients.length, 0);
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
    reset: async (_sequence, deleteSessionFn) => deleteSessionFn(),
  };
  const runtime = createGeneralRuntime({
    enabled: true,
    path,
    fs: { promises: { rm: () => deletion.promise } },
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

test('ownership loss during reset deletion terminates immediately before deletion can continue', async () => {
  const { FakeClient } = makeClientClass();
  const deletion = deferred();
  const deletionStarted = deferred();
  const fatalErrors = [];
  let loseOwnership;
  const ownership = makeOwnership();
  const runtime = createGeneralRuntime({
    enabled: true,
    Client: FakeClient,
    LocalAuth: FakeLocalAuth,
    path,
    repository: makeRepository({
      loadPendingReset: async () => ({ reset_requested_seq: 19n, reset_applied_seq: 0n }),
    }),
    ownershipFactory: ({ onOwnershipLost }) => {
      loseOwnership = onOwnershipLost;
      return ownership;
    },
    fs: {
      promises: {
        rm: async () => {
          deletionStarted.resolve();
          await deletion.promise;
        },
      },
    },
    timers: inertTimers,
    fatalExit: error => { fatalErrors.push(error); },
  });

  await runtime.tick();
  await deletionStarted.promise;
  loseOwnership(new Error('advisory connection lost'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fatalErrors.length, 1);
  deletion.resolve();
  await new Promise(resolve => setImmediate(resolve));
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
