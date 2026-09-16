import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { startServer } from '../src/bootstrap/startServer.js';
import { registerWhatsAppWeb } from '../src/wpp/whatsappWeb.js';
import { registerWppCronAndRoutes } from '../src/wpp/cronRoutes.js';
import { AsteriskAmiListener } from '../src/integrations/asterisk/amiListener.js';
import { createGeneralSupervisor } from '../src/wpp/generalSupervisor.js';
import { createGeneralClientFactory } from '../src/wpp/generalClientFactory.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function makeServerHarness({
  wppShutdown,
  configureApp,
  deadlineMs = 1000,
  timers,
  asteriskListener = { start() {} },
  asteriskEnabled = false,
} = {}) {
  const signals = new EventEmitter();
  const closeConfirmation = deferred();
  const exits = [];
  const server = {
    closeCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      closeConfirmation.promise.then(() => callback(), callback);
    },
  };
  const app = {
    locals: wppShutdown ? { wppGeneralShutdown: wppShutdown } : {},
    get() {},
    post() {},
    listen(_port, callback) {
      callback();
      return server;
    },
  };
  configureApp?.(app);
  const returned = startServer(app, {
    PORT: 0,
    processTarget: signals,
    exit: code => { exits.push(code); },
    deadlineMs,
    ...(timers ? { timers } : {}),
    asteriskListener,
    getAsteriskConfigFn: () => ({ enabled: asteriskEnabled }),
    logger: { log() {}, error() {} },
  });
  return { signals, closeConfirmation, exits, server, returned };
}

test('SIGTERM closes HTTP admission and waits for confirmed WPP quiescence before success', async () => {
  const destroyConfirmation = deferred();
  const calls = [];
  let gateOpen = true;
  let released = false;
  let shutdownPromise;
  const wppShutdown = () => {
    calls.push('timers-stopped');
    gateOpen = false;
    calls.push('gate-closed');
    shutdownPromise ??= (async () => {
      calls.push('destroy');
      await destroyConfirmation.promise;
      calls.push('stop-confirmed');
      released = true;
      calls.push('released');
      return true;
    })();
    return shutdownPromise;
  };
  const h = makeServerHarness({ wppShutdown });

  h.signals.emit('SIGTERM');

  assert.equal(h.returned, h.server);
  assert.equal(h.server.closeCalls, 1);
  assert.equal(gateOpen, false);
  assert.deepEqual(calls, ['timers-stopped', 'gate-closed', 'destroy']);
  assert.equal(released, false);
  assert.deepEqual(h.exits, []);

  h.closeConfirmation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.exits, []);
  assert.equal(released, false);

  destroyConfirmation.resolve();
  await h.returned.shutdown();

  assert.equal(released, true);
  assert.deepEqual(calls, [
    'timers-stopped', 'gate-closed', 'destroy', 'stop-confirmed', 'released',
  ]);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
});

test('concurrent SIGTERM and SIGINT share one shutdown flight', async () => {
  const stopped = deferred();
  let h;
  let shutdownCalls = 0;
  const wppShutdown = () => {
    shutdownCalls += 1;
    if (shutdownCalls === 1) h.signals.emit('SIGINT');
    return stopped.promise;
  };
  h = makeServerHarness({ wppShutdown });

  h.signals.emit('SIGTERM');

  assert.equal(h.server.closeCalls, 1);
  assert.equal(shutdownCalls, 1);
  assert.equal(h.returned.shutdown(), h.returned.shutdown());

  h.closeConfirmation.resolve();
  stopped.resolve(true);
  await h.returned.shutdown();

  assert.deepEqual(h.exits, [0]);
});

test('failed WPP destroy exits nonzero without releasing ownership', async () => {
  let released = false;
  let stopTimersCalls = 0;
  let shutdownCalls = 0;
  const runtime = {
    repository: {},
    supervisor: {
      snapshot: () => ({ state: 'fenced' }),
      shutdown: () => {
        shutdownCalls += 1;
        return Promise.reject(new Error('destroy failed'));
      },
    },
    getState: () => ({ isReadyWpp: false }),
    start: async () => false,
    stopTimers: () => { stopTimersCalls += 1; },
  };
  const h = makeServerHarness({
    configureApp: app => registerWhatsAppWeb(app, {
      ENABLE_WPP: false,
      query: async () => [],
      qrcode: { toDataURL: async () => '' },
      withAuth: (_req, _res, next) => next(),
      isSuper: () => true,
      generalRuntime: runtime,
      registerCronAndRoutesFn: () => {},
    }),
  });

  h.signals.emit('SIGTERM');
  assert.equal(stopTimersCalls, 1);
  assert.equal(shutdownCalls, 1);
  h.closeConfirmation.resolve();
  const result = await h.returned.shutdown();

  assert.equal(result, false);
  assert.equal(released, false);
  assert.deepEqual(h.exits, [1]);
});

test('hung WPP destroy hits the fatal deadline without releasing ownership', async () => {
  const scheduled = [];
  const cleared = [];
  let released = false;
  const h = makeServerHarness({
    wppShutdown: () => new Promise(() => {}),
    timers: {
      setTimeout(callback, milliseconds) {
        scheduled.push({ callback, milliseconds });
        return scheduled.length;
      },
      clearTimeout(timer) { cleared.push(timer); },
    },
    deadlineMs: 75,
  });

  h.signals.emit('SIGTERM');
  h.closeConfirmation.resolve();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].milliseconds, 75);
  assert.equal(released, false);

  scheduled[0].callback();
  const result = await h.returned.shutdown();

  assert.equal(result, false);
  assert.equal(released, false);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(cleared, []);
});

test('registration installs no process listeners and publishes one idempotent shutdown handle', async () => {
  const signalsBefore = {
    term: process.listenerCount('SIGTERM'),
    int: process.listenerCount('SIGINT'),
  };
  const stopped = deferred();
  let timerStops = 0;
  let supervisorStops = 0;
  const runtime = {
    repository: {},
    supervisor: {
      snapshot: () => ({ state: 'ready' }),
      shutdown: () => {
        supervisorStops += 1;
        return stopped.promise;
      },
    },
    getState: () => ({ isReadyWpp: false }),
    start: async () => false,
    stopTimers: () => { timerStops += 1; },
  };
  const app = { locals: {}, get() {}, post() {} };

  const returned = registerWhatsAppWeb(app, {
    ENABLE_WPP: false,
    query: async () => [],
    qrcode: { toDataURL: async () => '' },
    withAuth: (_req, _res, next) => next(),
    isSuper: () => true,
    generalRuntime: runtime,
    registerCronAndRoutesFn: () => {},
  });
  const first = app.locals.wppGeneralShutdown();
  const second = returned.shutdown();

  assert.equal(returned, runtime);
  assert.equal(typeof app.locals.wppGeneralShutdown, 'function');
  assert.equal(returned.shutdown, app.locals.wppGeneralShutdown);
  assert.equal(first, second);
  assert.equal(timerStops, 1);
  assert.equal(supervisorStops, 1);
  assert.equal(process.listenerCount('SIGTERM'), signalsBefore.term);
  assert.equal(process.listenerCount('SIGINT'), signalsBefore.int);

  stopped.resolve(true);
  assert.equal(await first, true);
});

test('registration shutdown remains single-flight during synchronous timer cancellation', async () => {
  let nested;
  let timerStops = 0;
  let supervisorStops = 0;
  const runtime = {
    repository: {},
    supervisor: {
      snapshot: () => ({ state: 'ready' }),
      shutdown: async () => { supervisorStops += 1; return true; },
    },
    getState: () => ({ isReadyWpp: false }),
    start: async () => false,
    stopTimers: () => {
      timerStops += 1;
      if (timerStops === 1) nested = runtime.shutdown();
    },
  };
  const app = { locals: {}, get() {}, post() {} };
  registerWhatsAppWeb(app, {
    ENABLE_WPP: false,
    query: async () => [],
    qrcode: { toDataURL: async () => '' },
    withAuth: (_req, _res, next) => next(),
    isSuper: () => true,
    generalRuntime: runtime,
    registerCronAndRoutesFn: () => {},
  });

  const shutdown = runtime.shutdown();

  assert.equal(shutdown, nested);
  assert.equal(await shutdown, true);
  assert.equal(timerStops, 1);
  assert.equal(supervisorStops, 1);
});

test('unconfirmed WPP shutdown result is fatal', async t => {
  for (const result of [false, undefined, null]) {
    await t.test(String(result), async () => {
      const h = makeServerHarness({ wppShutdown: () => result });

      h.signals.emit('SIGTERM');
      h.closeConfirmation.resolve();

      assert.equal(await h.returned.shutdown(), false);
      assert.deepEqual(h.exits, [1]);
    });
  }
});

test('HTTP server close failure is fatal', async () => {
  const h = makeServerHarness({ wppShutdown: async () => true });

  h.signals.emit('SIGTERM');
  h.closeConfirmation.reject(new Error('HTTP close failed'));

  assert.equal(await h.returned.shutdown(), false);
  assert.deepEqual(h.exits, [1]);
});

test('registration rejects an unconfirmed supervisor shutdown result', async t => {
  for (const result of [undefined, null]) {
    await t.test(String(result), async () => {
      const runtime = {
        repository: {},
        supervisor: {
          snapshot: () => ({ state: 'ready' }),
          shutdown: () => result,
        },
        getState: () => ({ isReadyWpp: false }),
        start: async () => false,
        stopTimers() {},
      };
      const app = { locals: {}, get() {}, post() {} };
      registerWhatsAppWeb(app, {
        ENABLE_WPP: false,
        query: async () => [],
        qrcode: { toDataURL: async () => '' },
        withAuth: (_req, _res, next) => next(),
        isSuper: () => true,
        generalRuntime: runtime,
        registerCronAndRoutesFn: () => {},
      });

      assert.equal(await runtime.shutdown(), false);
    });
  }
});

test('cron shutdown cancels every timer and prevents post-stop rescheduling', async () => {
  let nextTimer = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const clearedTimeouts = [];
  const clearedIntervals = [];
  let campaignCalls = 0;
  const timers = {
    setTimeout(callback) {
      const id = `timeout-${++nextTimer}`;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id) { clearedTimeouts.push(id); },
    setInterval(callback) {
      const id = `interval-${++nextTimer}`;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { clearedIntervals.push(id); },
  };
  const app = { post() {} };

  const cron = registerWppCronAndRoutes(app, {
    query: async () => [],
    ejecutarReposicionPredictiva: async () => { campaignCalls += 1; },
    timers,
  });
  const dailyCallbacks = [...timeouts.values()];

  assert.equal(timeouts.size, 6);
  assert.equal(intervals.size, 2);
  const firstStop = cron.shutdown();
  const secondStop = cron.stop();
  assert.equal(firstStop, secondStop);
  assert.equal(await firstStop, true);
  assert.equal(new Set(clearedTimeouts).size, 6);
  assert.equal(new Set(clearedIntervals).size, 2);

  dailyCallbacks[1]();
  assert.equal(campaignCalls, 0);
  assert.equal(intervals.size, 2);
});

test('cron shutdown drains an already-dispatched asynchronous job', async () => {
  const job = deferred();
  const intervalCallbacks = [];
  const cron = registerWppCronAndRoutes({ post() {} }, {
    query: async () => [],
    ejecutarCampaniaBaseImportadaAuto: () => job.promise,
    timers: {
      setTimeout: () => Symbol('timeout'),
      clearTimeout() {},
      setInterval(callback) { intervalCallbacks.push(callback); return Symbol('interval'); },
      clearInterval() {},
    },
  });
  intervalCallbacks[0]();

  let settled = false;
  const stopping = cron.shutdown().then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  job.resolve();
  assert.equal(await stopping, true);
});

test('synchronously throwing cron work admitted at shutdown fails closed through process exit', async () => {
  const failure = new Error('sync cron failure');
  const intervalCallbacks = [];
  let cron;
  const runtime = {
    repository: {},
    supervisor: { snapshot: () => ({ state: 'ready' }), shutdown: async () => true },
    getState: () => ({ isReadyWpp: false }),
    start: async () => false,
    stopTimers() {},
  };
  const h = makeServerHarness({
    configureApp: app => registerWhatsAppWeb(app, {
      ENABLE_WPP: false,
      query: async () => [],
      qrcode: { toDataURL: async () => '' },
      withAuth: (_req, _res, next) => next(),
      isSuper: () => true,
      generalRuntime: runtime,
      ejecutarCampaniaBaseImportadaAuto: () => { throw failure; },
      registerCronAndRoutesFn: (cronApp, deps) => {
        cron = registerWppCronAndRoutes(cronApp, {
          ...deps,
          timers: {
            setTimeout: () => Symbol('timeout'),
            clearTimeout() {},
            setInterval(callback) { intervalCallbacks.push(callback); return Symbol('interval'); },
            clearInterval() {},
          },
        });
        return cron;
      },
    }),
  });

  intervalCallbacks[0]();
  const cronStop = cron.shutdown();
  h.signals.emit('SIGTERM');
  h.closeConfirmation.resolve();

  await assert.rejects(cronStop, error => error === failure);
  assert.equal(await h.returned.shutdown(), false);
  assert.deepEqual(h.exits, [1]);
});

test('asynchronously rejected cron work in flight at shutdown fails closed through process exit', async () => {
  const job = deferred();
  const failure = new Error('async cron failure');
  const intervalCallbacks = [];
  let cron;
  const runtime = {
    repository: {},
    supervisor: { snapshot: () => ({ state: 'ready' }), shutdown: async () => true },
    getState: () => ({ isReadyWpp: false }),
    start: async () => false,
    stopTimers() {},
  };
  const h = makeServerHarness({
    configureApp: app => registerWhatsAppWeb(app, {
      ENABLE_WPP: false,
      query: async () => [],
      qrcode: { toDataURL: async () => '' },
      withAuth: (_req, _res, next) => next(),
      isSuper: () => true,
      generalRuntime: runtime,
      ejecutarCampaniaBaseImportadaAuto: () => job.promise,
      registerCronAndRoutesFn: (cronApp, deps) => {
        cron = registerWppCronAndRoutes(cronApp, {
          ...deps,
          timers: {
            setTimeout: () => Symbol('timeout'),
            clearTimeout() {},
            setInterval(callback) { intervalCallbacks.push(callback); return Symbol('interval'); },
            clearInterval() {},
          },
        });
        return cron;
      },
    }),
  });

  intervalCallbacks[0]();
  const cronStop = cron.shutdown();
  h.signals.emit('SIGTERM');
  h.closeConfirmation.resolve();
  job.reject(failure);

  await assert.rejects(cronStop, error => error === failure);
  assert.equal(await h.returned.shutdown(), false);
  assert.deepEqual(h.exits, [1]);
});

test('completed historical cron failures do not poison a later shutdown', async () => {
  const failure = new Error('completed cron failure');
  const intervalCallbacks = [];
  const cron = registerWppCronAndRoutes({ post() {} }, {
    query: async () => [],
    ejecutarCampaniaBaseImportadaAuto: async () => { throw failure; },
    timers: {
      setTimeout: () => Symbol('timeout'),
      clearTimeout() {},
      setInterval(callback) { intervalCallbacks.push(callback); return Symbol('interval'); },
      clearInterval() {},
    },
  });

  intervalCallbacks[0]();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await cron.shutdown(), true);
});

test('unconfirmed or failed cron shutdown is fatal through startServer', async t => {
  const cases = [
    ['unconfirmed', () => false],
    ['failed', () => Promise.reject(new Error('cron stop failed'))],
  ];
  for (const [name, cronShutdown] of cases) {
    await t.test(name, async () => {
      const runtime = {
        repository: {},
        supervisor: {
          snapshot: () => ({ state: 'ready' }),
          shutdown: async () => true,
        },
        getState: () => ({ isReadyWpp: false }),
        start: async () => false,
        stopTimers() {},
      };
      const h = makeServerHarness({
        configureApp: app => registerWhatsAppWeb(app, {
          ENABLE_WPP: false,
          query: async () => [],
          qrcode: { toDataURL: async () => '' },
          withAuth: (_req, _res, next) => next(),
          isSuper: () => true,
          generalRuntime: runtime,
          registerCronAndRoutesFn: () => ({ shutdown: cronShutdown }),
        }),
      });

      h.signals.emit('SIGTERM');
      h.closeConfirmation.resolve();

      assert.equal(await h.returned.shutdown(), false);
      assert.deepEqual(h.exits, [1]);
    });
  }
});

test('supervisor shutdown drains an in-flight heartbeat before releasing ownership', async () => {
  const heartbeatReply = deferred();
  const calls = [];
  const fatalErrors = [];
  const ownership = {
    ownerId: 'owner-a',
    epoch: 1n,
    isOwner: true,
    tryAcquire: async () => true,
    assertOwned: async () => true,
    heartbeat: async () => {
      calls.push('heartbeat');
      await heartbeatReply.promise;
      if (!ownership.isOwner) throw new Error('heartbeat observed released ownership');
      calls.push('heartbeat-confirmed');
      return true;
    },
    releaseAfterQuiesced: async confirm => {
      calls.push('release-begin');
      await confirm();
      ownership.isOwner = false;
      calls.push('release-done');
      return true;
    },
  };
  const clientFactory = createGeneralClientFactory({
    createClient: () => Object.assign(new EventEmitter(), {
      initialize: async () => {},
      destroy: async () => { calls.push('destroy'); },
      confirmStopped: async () => { calls.push('stop-confirmed'); return true; },
      forceStop: async () => true,
    }),
  });
  const repository = {
    updateOwned: async () => true,
    markResetStarted: async () => true,
    markResetApplied: async () => true,
    markResetFailed: async () => true,
  };
  const supervisor = createGeneralSupervisor({
    ownership,
    clientFactory,
    repository,
    fatalExit: error => fatalErrors.push(error),
    shutdownDeadlineMs: 1000,
  });
  await supervisor.start();

  const heartbeat = supervisor.heartbeatOnce();
  await new Promise(resolve => setImmediate(resolve));
  const shutdown = supervisor.shutdown();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.includes('release-begin'), false);
  heartbeatReply.resolve();
  assert.equal(await heartbeat, true);
  assert.equal(await shutdown, true);
  assert.deepEqual(calls.slice(-4), ['heartbeat-confirmed', 'destroy', 'stop-confirmed', 'release-begin', 'release-done'].slice(-4));
  assert.equal(fatalErrors.length, 0);
});

test('Asterisk stop disables reconnect before destroying the active socket and is idempotent', async () => {
  const cleared = [];
  const listener = new AsteriskAmiListener(
    { enabled: true, amiUsername: 'user', amiPassword: 'secret' },
    { timers: { setTimeout: () => 99, clearTimeout: id => cleared.push(id) } },
  );
  const observations = [];
  listener.started = true;
  listener.reconnectTimer = 42;
  listener.socket = {
    destroy() {
      observations.push({ started: listener.started, socket: listener.socket });
    },
  };

  const first = listener.stop();
  const second = listener.stop();

  assert.equal(first, second);
  assert.equal(await first, true);

  assert.deepEqual(observations, [{ started: false, socket: null }]);
  assert.deepEqual(cleared, [42]);
  assert.equal(listener.reconnectTimer, null);
});

test('Asterisk cleared reconnect callback cannot reconnect after stop', async () => {
  let reconnectCallback;
  let connectCalls = 0;
  const listener = new AsteriskAmiListener(
    { enabled: true, amiUsername: 'user', amiPassword: 'secret', amiReconnectMs: 5 },
    {
      timers: {
        setTimeout(callback) { reconnectCallback = callback; return 7; },
        clearTimeout() {},
      },
      netModule: {
        createConnection() { connectCalls += 1; throw new Error('must not reconnect'); },
      },
    },
  );
  listener.started = true;
  listener.scheduleReconnect();

  assert.equal(await listener.stop(), true);
  reconnectCallback();

  assert.equal(connectCalls, 0);
  assert.equal(listener.reconnectTimer, null);
});

test('Asterisk stop drains already-dispatched event processing', async () => {
  const processing = deferred();
  const listener = new AsteriskAmiListener({ enabled: true });
  listener.started = true;
  listener.socket = { destroy() {} };
  listener.processMessage = () => processing.promise;
  listener.handleData('Event: Hangup\r\n\r\n');

  let settled = false;
  const stopping = listener.stop().then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  processing.resolve();
  assert.equal(await stopping, true);
});

test('stale Asterisk socket close cannot schedule reconnect for its replacement', () => {
  const scheduled = [];
  const sockets = [];
  const listener = new AsteriskAmiListener(
    { enabled: true, amiReconnectMs: 5 },
    {
      timers: {
        setTimeout(callback) { scheduled.push(callback); return scheduled.length; },
        clearTimeout() {},
      },
      netModule: {
        createConnection(_options, callback) {
          const socket = new EventEmitter();
          socket.write = () => {};
          socket.destroy = () => {};
          sockets.push({ socket, callback });
          return socket;
        },
      },
    },
  );
  listener.started = true;
  listener.connect();
  const stale = sockets[0].socket;
  listener.connect();
  const replacement = sockets[1].socket;

  stale.emit('close');

  assert.equal(listener.socket, replacement);
  assert.equal(scheduled.length, 0);
});

test('unconfirmed Asterisk stop is fatal when the listener started', async () => {
  const h = makeServerHarness({
    wppShutdown: async () => true,
    asteriskEnabled: true,
    asteriskListener: { start: () => true, stop: () => false },
  });

  h.signals.emit('SIGTERM');
  h.closeConfirmation.resolve();

  assert.equal(await h.returned.shutdown(), false);
  assert.deepEqual(h.exits, [1]);
});

test('disabled Asterisk is not stopped during shutdown', async () => {
  let stopCalls = 0;
  const h = makeServerHarness({
    wppShutdown: async () => true,
    asteriskEnabled: false,
    asteriskListener: {
      start: () => { throw new Error('must not start'); },
      stop: () => { stopCalls += 1; return false; },
    },
  });

  h.signals.emit('SIGTERM');
  h.closeConfirmation.resolve();

  assert.equal(await h.returned.shutdown(), true);
  assert.equal(stopCalls, 0);
  assert.deepEqual(h.exits, [0]);
});

test('late HTTP listening callback cannot start Asterisk after shutdown begins', async () => {
  const signals = new EventEmitter();
  let onListening;
  let startCalls = 0;
  const exits = [];
  const server = {
    close(callback) { callback(); },
  };
  const app = {
    locals: { wppGeneralShutdown: async () => true },
    listen(_port, callback) {
      onListening = callback;
      return server;
    },
  };

  const returned = startServer(app, {
    PORT: 0,
    processTarget: signals,
    exit: code => exits.push(code),
    asteriskListener: {
      start() { startCalls += 1; return true; },
      stop: async () => true,
    },
    getAsteriskConfigFn: () => ({ enabled: true }),
    logger: { log() {}, error() {} },
  });

  signals.emit('SIGTERM');
  onListening();

  assert.equal(await returned.shutdown(), true);
  assert.equal(startCalls, 0);
  assert.deepEqual(exits, [0]);
});
