import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectCompanyRuntime,
  confirmCompanyRuntime,
  repairCompanyRuntimeBridge,
  resumeSyncedInitialization,
  resumeSyncedInitializationFromDevTools,
  runStartupSyncAssistant,
  isRuntimeBridgeError,
  createSingleFlight,
  createBackoffRecovery,
  createNonOverlappingTask,
} from '../src/wpp/companyRuntime.js';

function fakeClient({
  browserConnected = true,
  pageClosed = false,
  snapshots = [],
  evaluateError = null,
} = {}) {
  let index = 0;
  return {
    pupBrowser: { isConnected: () => browserConnected },
    pupPage: {
      isClosed: () => pageClosed,
      evaluate: async () => {
        if (evaluateError) throw evaluateError;
        const value = snapshots[Math.min(index, snapshots.length - 1)];
        index += 1;
        return value;
      },
    },
  };
}

const healthySnapshot = {
  appState: 'CONNECTED',
  hasGetChat: true,
  hasSendMessage: true,
  hasGetMessageModel: true,
};

test('runtime conectado sin WWebJS no está como saludable', async () => {
  const client = fakeClient({ snapshots: [{ ...healthySnapshot, hasGetChat: false }] });

  const health = await inspectCompanyRuntime(client);

  assert.equal(health.healthy, false);
  assert.equal(health.reason, 'runtime_bridge_missing');
});

test('sonda bloqueada vence por timeout y no sostiene heartbeat falso', async () => {
  const client = {
    pupBrowser: { isConnected: () => true },
    pupPage: {
      isClosed: () => false,
      evaluate: async () => new Promise(() => {}),
    },
  };

  const health = await inspectCompanyRuntime(client, { timeoutMs: 5 });

  assert.equal(health.healthy, false);
  assert.equal(health.reason, 'probe_timeout');
});

test('runtime requiere navegador, pagina y bridge de envio operativos', async () => {
  const healthy = await inspectCompanyRuntime(fakeClient({ snapshots: [healthySnapshot] }));
  const closed = await inspectCompanyRuntime(fakeClient({ pageClosed: true, snapshots: [healthySnapshot] }));
  const browserDown = await inspectCompanyRuntime(fakeClient({ browserConnected: false, snapshots: [healthySnapshot] }));

  assert.equal(healthy.healthy, true);
  assert.equal(closed.reason, 'page_closed');
  assert.equal(browserDown.reason, 'browser_disconnected');
});

test('runtime reconoce estado conectado de la arquitectura WAWebSocketModel', async () => {
  const originalWindow = globalThis.window;
  const client = {
    pupBrowser: { isConnected: () => true },
    pupPage: {
      isClosed: () => false,
      evaluate: async fn => {
        globalThis.window = {
          WWebJS: {
            getChat() {},
            sendMessage() {},
            getMessageModel() {},
          },
          require: name => name === 'WAWebSocketModel'
            ? { Socket: { state: 'CONNECTED' } }
            : null,
        };
        try {
          return fn();
        } finally {
          globalThis.window = originalWindow;
        }
      },
    },
  };

  const health = await inspectCompanyRuntime(client);

  assert.equal(health.healthy, true);
  assert.equal(health.appStateSource, 'WAWebSocketModel');
});

test('doble sonda evita recuperar por una navegacion transitoria', async () => {
  const client = fakeClient({
    snapshots: [
      { ...healthySnapshot, hasSendMessage: false },
      healthySnapshot,
    ],
  });
  let waits = 0;

  const health = await confirmCompanyRuntime(client, {
    delayMs: 1,
    wait: async () => { waits += 1; },
  });

  assert.equal(health.healthy, true);
  assert.equal(waits, 1);
  assert.equal(health.attempts, 2);
});

test('repara WWebJS sin reiniciar el navegador cuando Store sigue conectado', async () => {
  let injected = false;
  const loadUtils = () => {};
  const client = {
    pupBrowser: { isConnected: () => true },
    pupPage: {
      isClosed: () => false,
      evaluate: async fn => {
        if (fn === loadUtils) {
          injected = true;
          return;
        }
        return injected
          ? healthySnapshot
          : { ...healthySnapshot, hasGetChat: false, hasSendMessage: false, hasGetMessageModel: false };
      },
    },
  };

  const health = await repairCompanyRuntimeBridge(client, loadUtils);

  assert.equal(injected, true);
  assert.equal(health.healthy, true);
  assert.equal(health.repaired, true);
});

test('no intenta inyectar bridge si WhatsApp no está conectado', async () => {
  let injections = 0;
  const client = fakeClient({ snapshots: [{ ...healthySnapshot, appState: 'UNPAIRED' }] });

  const health = await repairCompanyRuntimeBridge(client, () => { injections += 1; });

  assert.equal(health.healthy, false);
  assert.equal(health.reason, 'app_not_connected');
  assert.equal(injections, 0);
});

test('reanuda inicializacion por una sesion DevTools independiente', async () => {
  let evaluateCalls = 0;
  let detachCalls = 0;
  let sentMethod = null;
  const client = {
    pupBrowser: { isConnected: () => true },
    pupPage: {
      isClosed: () => false,
      evaluate: async () => { evaluateCalls += 1; throw new Error('realm ocupado'); },
      createCDPSession: async () => ({
        send: async (method) => {
          sentMethod = method;
          return { result: { value: true } };
        },
        detach: async () => { detachCalls += 1; },
      }),
    },
  };

  const resumed = await resumeSyncedInitialization(client);

  assert.equal(resumed, true);
  assert.equal(sentMethod, 'Runtime.evaluate');
  assert.equal(detachCalls, 1);
  assert.equal(evaluateCalls, 0);
});

test('no reanuda inicializacion si la sesion no esta conectada', async () => {
  const client = {
    pupBrowser: { isConnected: () => true },
    pupPage: {
      isClosed: () => false,
      evaluate: async () => false,
    },
  };

  assert.equal(await resumeSyncedInitialization(client), false);
});

test('reanuda inicializacion por el puerto DevTools sin depender de Puppeteer', async () => {
  let receivedPath = null;
  let receivedExpression = null;

  const resumed = await resumeSyncedInitializationFromDevTools('/sesion/DevToolsActivePort', {
    evaluateDevTools: async (path, expression) => {
      receivedPath = path;
      receivedExpression = expression;
      return true;
    },
  });

  assert.equal(resumed, true);
  assert.equal(receivedPath, '/sesion/DevToolsActivePort');
  assert.match(receivedExpression, /onAppStateHasSyncedEvent/);
});

test('fallo de DevTools no hace caer el supervisor', async () => {
  const resumed = await resumeSyncedInitializationFromDevTools('/tmp/inexistente', {
    evaluateDevTools: async () => { throw new Error('sin puerto'); },
  });

  assert.equal(resumed, false);
});

test('asistente de startup reintenta en proceso independiente hasta reanudar', async () => {
  let attempts = 0;
  let waits = 0;

  const resumed = await runStartupSyncAssistant({
    devToolsPortFile: '/tmp/devtools',
    maxAttempts: 4,
    wait: async () => { waits += 1; },
    resume: async () => {
      attempts += 1;
      return attempts === 3;
    },
  });

  assert.equal(resumed, true);
  assert.equal(attempts, 3);
  assert.equal(waits, 3);
});

test('errores de WWebJS y getChat undefined se clasifican como bridge roto', () => {
  assert.equal(isRuntimeBridgeError(new TypeError("Cannot read properties of undefined (reading 'getChat')")), true);
  assert.equal(isRuntimeBridgeError(new Error('window.WWebJS is not defined')), true);
  assert.equal(isRuntimeBridgeError(new Error('network timeout')), false);
});

test('single flight colapsa recuperaciones concurrentes', async () => {
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runOnce = createSingleFlight(async () => {
    runs += 1;
    await gate;
    return 'recovered';
  });

  const first = runOnce();
  const second = runOnce();
  assert.equal(runs, 1);

  release();
  assert.equal(await first, 'recovered');
  assert.equal(await second, 'recovered');

  assert.equal(await runOnce(), 'recovered');
  assert.equal(runs, 2);
});

test('backoff de recuperación reintenta y colapsa disparos concurrentes', async () => {
  const delays = [];
  const scheduled = [];
  let attempts = 0;
  const recovery = createBackoffRecovery({
    task: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('initialize falló');
      return true;
    },
    delaysMs: [100, 200, 400],
    setTimer: (fn, ms) => { delays.push(ms); scheduled.push(fn); return scheduled.length; },
    clearTimer: () => {},
  });

  const first = recovery.trigger('startup');
  const second = recovery.trigger('disconnected');
  assert.strictEqual(first, second);
  assert.equal(await first, false);
  assert.deepEqual(delays, [100]);

  const scheduledFlight = recovery.trigger('auth_failure');
  assert.deepEqual(delays, [100]);
  assert.equal(attempts, 1);
  await scheduled.shift()();
  assert.equal(await scheduledFlight, false);
  assert.deepEqual(delays, [100, 200]);
  await scheduled.shift()();
  assert.equal(attempts, 3);
  assert.equal(recovery.getState().attempt, 0);
});

test('tarea protegida no solapa ticks async', async () => {
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tick = createNonOverlappingTask(async () => {
    runs += 1;
    await gate;
    return 'ok';
  });

  const first = tick();
  assert.equal(await tick(), undefined);
  assert.equal(runs, 1);
  release();
  assert.equal(await first, 'ok');
  assert.equal(await tick(), 'ok');
  assert.equal(runs, 2);
});
