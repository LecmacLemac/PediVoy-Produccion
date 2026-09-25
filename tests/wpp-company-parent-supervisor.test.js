import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createCompanyWorkerSupervisor as createSupervisor,
  listLinuxDescendantPids,
  readLinuxProcessIdentity,
  snapshotLinuxProcessTree,
  terminateLinuxProcessSnapshot,
  terminateLinuxProcessTree,
} from '../src/wpp/companyWorkerSupervisor.js';

function createCompanyWorkerSupervisor(options = {}) {
  return createSupervisor({
    processIdentityPolicy: 'linux-proc',
    identityCaptureAttempts: 1,
    captureProcessIdentity: async pid => ({ pid, startTime: String(pid) }),
    captureProcessTree: async pid => ({
      parent: { pid, startTime: String(pid) },
      descendants: [],
      complete: true,
      errors: [],
    }),
    ...options,
  });
}

function fakeChild(pid, onKill) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode: null,
    kill(signal) {
      child.killed = true;
      onKill(signal, child);
      return true;
    },
  });
  return child;
}

function exitChild(child, code = 0, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('exit', code, signal);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let now = 0;
  let sequence = 0;
  const scheduled = [];
  return {
    scheduled,
    now: () => now,
    setTimeout(callback, milliseconds) {
      const timer = {
        callback,
        at: now + milliseconds,
        sequence: sequence++,
        active: true,
        unref() {},
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.active = false;
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = scheduled
          .filter(timer => timer.active && timer.at <= target)
          .sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0];
        if (!next) break;
        now = next.at;
        next.active = false;
        next.callback();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

test('parent runs one-shot startup preparation before the first company worker starts', async () => {
  const timers = fakeTimers();
  const events = [];
  const supervisor = createCompanyWorkerSupervisor({
    beforeFirstStart: () => events.push('cleanup'),
    spawnWorker: empresaId => {
      events.push(`spawn:${empresaId}`);
      return fakeChild(600 + empresaId, (signal, child) => {
        if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
      });
    },
    shouldAutoStart: () => true,
    startupStaggerDelayMs: 10,
    timers,
    logger: { warn() {} },
  });

  assert.deepEqual(supervisor.scheduleBootRecovery([4, 5]), { scheduled: 2 });
  assert.deepEqual(events, ['cleanup', 'spawn:4']);
  await timers.advance(10);
  assert.deepEqual(events, ['cleanup', 'spawn:4', 'spawn:5']);
  assert.equal(supervisor.ensure(6).started, true);
  assert.deepEqual(events, ['cleanup', 'spawn:4', 'spawn:5', 'spawn:6']);
  await supervisor.shutdown();
});

test('shutdown prevents startup preparation and worker creation', async () => {
  const events = [];
  const supervisor = createCompanyWorkerSupervisor({
    beforeFirstStart: () => events.push('cleanup'),
    spawnWorker: empresaId => {
      events.push(`spawn:${empresaId}`);
      return fakeChild(700 + empresaId, () => {});
    },
    shouldAutoStart: () => true,
    logger: { warn() {} },
  });

  assert.equal(await supervisor.shutdown(), true);
  assert.deepEqual(supervisor.ensure(1), { started: false, reason: 'shutting_down' });
  assert.deepEqual(supervisor.scheduleBootRecovery([2]), { scheduled: 0, reason: 'shutting_down' });
  assert.deepEqual(events, []);
});

test('explicit boot preparation runs once even while automatic worker starts are disabled', () => {
  const events = [];
  const supervisor = createCompanyWorkerSupervisor({
    beforeFirstStart: () => events.push('cleanup'),
    spawnWorker: empresaId => {
      events.push(`spawn:${empresaId}`);
      return fakeChild(800 + empresaId, () => {});
    },
    shouldAutoStart: () => false,
    logger: { warn() {} },
  });

  assert.equal(supervisor.prepareStartup(), true);
  assert.equal(supervisor.prepareStartup(), true);
  assert.deepEqual(supervisor.ensure(1), { started: false, reason: 'disabled' });
  assert.deepEqual(events, ['cleanup']);
});

test('boot recovery staggers company worker starts in order with a safe default delay', async () => {
  const timers = fakeTimers();
  const spawned = [];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      spawned.push(empresaId);
      return fakeChild(100 + empresaId, () => {});
    },
    shouldAutoStart: () => true,
    timers,
    logger: { warn() {} },
  });

  assert.deepEqual(supervisor.scheduleBootRecovery([1, 2, 7, 8]), { scheduled: 4 });
  assert.deepEqual(spawned, [1]);

  await timers.advance(11999);
  assert.deepEqual(spawned, [1]);
  await timers.advance(1);
  assert.deepEqual(spawned, [1, 2]);
  await timers.advance(12000);
  assert.deepEqual(spawned, [1, 2, 7]);
  await timers.advance(12000);
  assert.deepEqual(spawned, [1, 2, 7, 8]);
});

test('parent shutdown cancels pending boot recovery starts', async () => {
  const timers = fakeTimers();
  const spawned = [];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      spawned.push(empresaId);
      return fakeChild(400 + empresaId, (signal, child) => {
        if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
      });
    },
    shouldAutoStart: () => true,
    startupStaggerDelayMs: 100,
    timers,
    logger: { warn() {} },
  });

  supervisor.scheduleBootRecovery([1, 2, 3]);
  assert.deepEqual(spawned, [1]);
  assert.equal(await supervisor.shutdown(), true);

  await timers.advance(1000);
  assert.deepEqual(spawned, [1]);
  assert.deepEqual(supervisor.scheduleBootRecovery([4]), { scheduled: 0, reason: 'shutting_down' });
});

test('parent shutdown disables respawns, SIGTERMs every worker, then SIGKILLs only stragglers', async () => {
  const calls = [];
  const children = [
    fakeChild(101, (signal, child) => {
      calls.push(`101:${signal}`);
      if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
    }),
    fakeChild(102, (signal, child) => {
      calls.push(`102:${signal}`);
      if (signal === 'SIGKILL') queueMicrotask(() => exitChild(child, 0, signal));
    }),
  ];
  let spawnIndex = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[spawnIndex++],
    shouldAutoStart: () => true,
    respawnDelayMs: 1,
    shutdownDeadlineMs: 5,
    terminateProcessTree: (target, snapshot, options) => terminateLinuxProcessTree(target, snapshot, {
      ...options,
      readIdentity: async pid => ({ pid, startTime: String(pid) }),
    }),
    logger: { warn() {} },
  });

  assert.equal(supervisor.ensure(1).started, true);
  assert.equal(supervisor.ensure(2).started, true);
  assert.equal(await supervisor.shutdown(), true);

  assert.deepEqual(calls, ['101:SIGTERM', '102:SIGTERM', '102:SIGKILL']);
  assert.deepEqual(supervisor.snapshot(), { shuttingDown: true, workers: 0, respawns: 0 });

  exitChild(children[0], 0, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(spawnIndex, 2, 'shutdown must suppress all respawns');
  assert.deepEqual(supervisor.ensure(3), { started: false, reason: 'shutting_down' });
});

test('supervisor espera el drain de lifecycle de 20s y no fuerza SIGKILL antes de 30s', async () => {
  const timers = fakeTimers();
  const signals = [];
  const child = fakeChild(501, (signal, self) => {
    signals.push(signal);
    if (signal === 'SIGTERM') timers.setTimeout(() => exitChild(self, 0, signal), 20000);
  });
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    shutdownDeadlineMs: 30000,
    timers,
    logger: { warn() {} },
  });
  supervisor.ensure(1);
  const shutdown = supervisor.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(19999);
  assert.deepEqual(signals, ['SIGTERM']);
  await timers.advance(1);
  assert.equal(await shutdown, true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('escalamiento mata descendientes Chromium y worker, y confirma el parent', async () => {
  const timers = fakeTimers();
  const calls = [];
  const child = fakeChild(601, signal => calls.push(`worker:${signal}`));
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    shutdownDeadlineMs: 10,
    timers,
    terminateProcessTree: async target => {
      calls.push(`tree:${target.pid}`);
      exitChild(target, 0, 'SIGKILL');
      return true;
    },
    logger: { warn() {} },
  });
  supervisor.ensure(1);
  const shutdown = supervisor.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(10);
  assert.equal(await shutdown, true);
  assert.deepEqual(calls, ['worker:SIGTERM', 'tree:601']);
});

test('error enumerando descendientes no rompe supervisor ni declara éxito con parent vivo', async () => {
  const timers = fakeTimers();
  const child = fakeChild(701, () => {});
  const warnings = [];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    shutdownDeadlineMs: 10,
    timers,
    captureProcessTree: async () => ({ parent: { pid: 701, startTime: '1' }, descendants: [] }),
    terminateProcessTree: async () => { throw new Error('/proc denied'); },
    logger: { warn: (...args) => warnings.push(args) },
  });
  supervisor.ensure(1);
  const shutdown = supervisor.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(10);
  assert.equal(await shutdown, false);
  assert.equal(warnings.length > 0, true);
});

test('helper /proc enumera recursivamente y mata descendientes antes que el worker', async () => {
  const files = new Map([
    ['/proc/800/task/800/children', '801 802\n'],
    ['/proc/801/task/801/children', '803\n'],
    ['/proc/802/task/802/children', ''],
    ['/proc/803/task/803/children', ''],
  ]);
  const descendants = await listLinuxDescendantPids(800, {
    readText: async path => files.get(path),
  });
  assert.deepEqual(descendants, [803, 801, 802]);

  const signals = [];
  const child = fakeChild(800, signal => signals.push(`800:${signal}`));
  await terminateLinuxProcessTree(child, {
    listDescendants: async () => descendants,
    signalPid: (pid, signal) => signals.push(`${pid}:${signal}`),
  });
  assert.deepEqual(signals, ['803:SIGKILL', '801:SIGKILL', '802:SIGKILL', '800:SIGKILL']);
});

test('clean worker exit does not schedule a respawn', async () => {
  const timers = fakeTimers();
  const spawned = [];
  let child;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      spawned.push(empresaId);
      child = fakeChild(190 + empresaId, () => {});
      return child;
    },
    shouldAutoStart: () => true,
    respawnDelayMs: 1,
    timers,
    logger: { warn() {} },
  });

  supervisor.ensure(7);
  exitChild(child, 0, null);
  await timers.advance(10);

  assert.deepEqual(spawned, [7]);
  assert.equal(supervisor.snapshot().respawns, 0);
});

test('natural worker exit schedules a respawn while parent is running', async () => {
  const children = [
    fakeChild(201, () => {}),
    fakeChild(202, () => {}),
  ];
  let spawnIndex = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[spawnIndex++],
    shouldAutoStart: () => true,
    respawnDelayMs: 1,
    shutdownDeadlineMs: 10,
    logger: { warn() {} },
  });

  supervisor.ensure(7);
  exitChild(children[0], 1, null);
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(spawnIndex, 2);
  assert.equal(supervisor.snapshot().workers, 1);
  await supervisor.shutdown();
});

test('worker spawn error is handled as a failed exit and schedules a respawn', async () => {
  const children = [
    fakeChild(301, () => {}),
    fakeChild(302, () => {}),
  ];
  let spawnIndex = 0;
  const warnings = [];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[spawnIndex++],
    shouldAutoStart: () => true,
    respawnDelayMs: 1,
    shutdownDeadlineMs: 10,
    logger: { warn(...args) { warnings.push(args); } },
  });

  supervisor.ensure(9);
  children[0].emit('error', new Error('spawn failed'));
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(spawnIndex, 2);
  assert.equal(supervisor.snapshot().workers, 1);
  assert.equal(warnings.some(args => args[0] === '[WPP EMPRESA] worker error:'), true);
  await supervisor.shutdown();
});

test('Web to Cloud stops only that active worker and its exit does not respawn', async () => {
  const timers = fakeTimers();
  const calls = [];
  const children = new Map();
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      const child = fakeChild(900 + empresaId, (signal, self) => {
        calls.push(`${empresaId}:${signal}`);
        if (signal === 'SIGTERM') queueMicrotask(() => exitChild(self, 0, signal));
      });
      children.set(empresaId, child);
      return child;
    },
    shouldAutoStart: () => true,
    respawnDelayMs: 10,
    shutdownDeadlineMs: 5,
    timers,
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  supervisor.ensure(2);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), {
    eligible: false,
    stopped: true,
  });
  await timers.advance(100);

  assert.deepEqual(calls, ['1:SIGTERM']);
  assert.equal(children.get(2).killed, false);
  assert.deepEqual(supervisor.ensure(1), { started: false, reason: 'ineligible' });
  assert.equal(supervisor.snapshot().workers, 1);
  assert.equal(supervisor.snapshot().respawns, 0);
  await supervisor.shutdown();
});

test('marking a company ineligible cancels pending respawn and a late callback cannot revive it', async () => {
  const timers = fakeTimers();
  const spawned = [];
  let first;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      spawned.push(empresaId);
      const child = fakeChild(1000 + spawned.length, () => {});
      first ??= child;
      return child;
    },
    shouldAutoStart: () => true,
    respawnDelayMs: 20,
    timers,
    logger: { warn() {} },
  });

  supervisor.ensure(7);
  exitChild(first, 1);
  const lateCallback = timers.scheduled.find(timer => timer.active)?.callback;

  assert.deepEqual(await supervisor.reconcileEligibility('7', false), {
    eligible: false,
    stopped: false,
  });
  lateCallback();
  await timers.advance(100);

  assert.deepEqual(spawned, [7]);
  assert.deepEqual(supervisor.ensure(7), { started: false, reason: 'ineligible' });
});

test('marking a company ineligible cancels its pending staggered boot start', async () => {
  const timers = fakeTimers();
  const spawned = [];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      spawned.push(empresaId);
      return fakeChild(1100 + empresaId, (signal, child) => {
        if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
      });
    },
    shouldAutoStart: () => true,
    startupStaggerDelayMs: 50,
    timers,
    logger: { warn() {} },
  });

  assert.deepEqual(supervisor.scheduleBootRecovery([1, 2]), { scheduled: 2 });
  await supervisor.reconcileEligibility(2, false);
  await timers.advance(100);

  assert.deepEqual(spawned, [1]);
  assert.deepEqual(supervisor.scheduleBootRecovery([2]), { scheduled: 0, reason: 'ineligible' });
  await supervisor.shutdown();
});

test('Cloud to Web restores eligibility without spawning until ensure is requested', async () => {
  const spawned = [];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: empresaId => {
      spawned.push(empresaId);
      return fakeChild(1200 + empresaId, (signal, child) => {
        if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
      });
    },
    shouldAutoStart: () => true,
    logger: { warn() {} },
  });

  await supervisor.reconcileEligibility(3, false);
  assert.deepEqual(await supervisor.reconcileEligibility('3', true), {
    eligible: true,
    stopped: false,
  });
  assert.deepEqual(spawned, []);
  assert.equal(supervisor.ensure(3).started, true);
  assert.deepEqual(spawned, [3]);
  await supervisor.shutdown();
});

test('compensación del supervisor recrea y confirma sucesor cuando el worker Web previo estaba activo', async () => {
  const children = [
    fakeChild(1301, (signal, child) => {
      if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
    }),
    fakeChild(1302, (signal, child) => {
      if (signal === 'SIGTERM') queueMicrotask(() => exitChild(child, 0, signal));
    }),
  ];
  let index = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[index++],
    shouldAutoStart: () => true,
    logger: { warn() {} },
  });
  supervisor.ensure(5);
  const before = supervisor.getCompanyState(5);
  assert.deepEqual(before, {
    eligible: true,
    active: true,
    pid: 1301,
    respawnPending: false,
    startupPending: false,
  });
  await supervisor.reconcileEligibility(5, false);
  const restored = await supervisor.restoreCompanyState(5, before);
  assert.equal(restored.restored, true);
  assert.equal(restored.successorPid, 1302);
  assert.equal(supervisor.getCompanyState(5).active, true);
  await supervisor.shutdown();
});

test('parent que sale durante grace conserva snapshot y limpia Chromium capturado', async () => {
  const calls = [];
  const child = fakeChild(1400, (signal, self) => {
    calls.push(`parent:${signal}`);
    if (signal === 'SIGTERM') queueMicrotask(() => exitChild(self, 0, signal));
  });
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: async pid => ({ pid, startTime: '10' }),
    captureProcessTree: async () => ({ parent: { pid: 1400, startTime: '10' }, descendants: [{ pid: 1401, startTime: '11' }] }),
    terminateProcessTree: async (_target, snapshot) => {
      calls.push(`tree:${snapshot.descendants[0].pid}`);
      return true;
    },
    logger: { warn() {} },
  });
  supervisor.ensure(1);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.deepEqual(calls, ['parent:SIGTERM', 'tree:1401']);
});

test('snapshot Linux no señala parent con PID reutilizado', async () => {
  const child = fakeChild(1490, signal => assert.fail(`no debe señalar parent reutilizado: ${signal}`));
  const snapshot = {
    parent: { pid: 1490, startTime: 'original' },
    descendants: [],
    complete: true,
    errors: [],
  };

  const result = await terminateLinuxProcessTree(child, snapshot, {
    readIdentity: async pid => ({ pid, startTime: 'reused' }),
    deadlineMs: 0,
  });

  assert.equal(child.killed, false);
  assert.equal(result, true);
});

test('reconcile confirma fin del parent original ante PID reuse sin señalar el proceso nuevo', async () => {
  const timers = fakeTimers();
  const signals = [];
  const child = fakeChild(1491, signal => signals.push(signal));
  const snapshots = [
    {
      parent: { pid: 1491, startTime: 'original' },
      descendants: [{ pid: 1493, startTime: 'original-child' }],
      complete: true,
      errors: [],
    },
    {
      parent: { pid: 1491, startTime: 'reused' },
      descendants: [{ pid: 1999, startTime: 'new-process-child' }],
      complete: true,
      errors: [],
    },
  ];
  const identities = new Map([
    [1491, { pid: 1491, startTime: 'reused' }],
    [1493, { pid: 1493, startTime: 'original-child' }],
    [1999, { pid: 1999, startTime: 'new-process-child' }],
  ]);
  const observedParentIdentities = [
    { pid: 1491, startTime: 'original' },
    { pid: 1491, startTime: 'original' },
    { pid: 1491, startTime: 'original' },
    { pid: 1491, startTime: 'reused' },
  ];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 1,
    killConfirmDeadlineMs: 1,
    timers,
    captureProcessIdentity: async pid => (pid === 1491
      ? observedParentIdentities.shift() ?? { pid, startTime: 'reused' }
      : identities.get(pid) ?? null),
    captureProcessTree: async () => snapshots.shift(),
    terminateProcessTree: (target, snapshot, options) => terminateLinuxProcessTree(target, snapshot, {
      ...options,
      readIdentity: async pid => identities.get(pid) ?? null,
      signalPid: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        identities.set(pid, null);
      },
    }),
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);

  assert.deepEqual(await reconcile, { eligible: false, stopped: true });
  assert.deepEqual(signals, ['SIGTERM', '1493:SIGKILL']);
  assert.equal(identities.get(1999)?.startTime, 'new-process-child');
  assert.equal(supervisor.snapshot().workers, 0);
});

test('reconcile falla si el parent original sigue vivo y SIGKILL no se confirma', async () => {
  const timers = fakeTimers();
  const signals = [];
  const child = fakeChild(1492, signal => signals.push(signal));
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 1,
    killConfirmDeadlineMs: 1,
    timers,
    captureProcessIdentity: async pid => ({ pid, startTime: 'original' }),
    captureProcessTree: async () => ({
      parent: { pid: 1492, startTime: 'original' }, descendants: [], complete: true, errors: [],
    }),
    terminateProcessTree: (target, snapshot, options) => terminateLinuxProcessTree(target, snapshot, {
      ...options,
      readIdentity: async pid => ({ pid, startTime: 'original' }),
    }),
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);

  await assert.rejects(reconcile, /stop could not be confirmed/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('snapshot Linux no señala descendiente muerto ni PID reutilizado', async () => {
  const snapshot = {
    parent: { pid: 1500, startTime: '20' },
    descendants: [
      { pid: 1501, startTime: '21' },
      { pid: 1502, startTime: '22' },
    ],
  };
  const signals = [];
  const identities = new Map([
    [1501, null],
    [1502, { pid: 1502, startTime: 'reused' }],
  ]);
  const result = await terminateLinuxProcessSnapshot(snapshot, {
    readIdentity: async pid => identities.get(pid) ?? null,
    signalPid: (pid, signal) => signals.push(`${pid}:${signal}`),
  });
  assert.deepEqual(signals, []);
  assert.equal(result, true);
});

test('/proc stat identity usa starttime y snapshot la conserva para validar PID reuse', async () => {
  const stat = '1601 (chrome helper) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20';
  assert.deepEqual(await readLinuxProcessIdentity(1601, { readText: async () => stat }), {
    pid: 1601,
    startTime: '424242',
  });
  const tree = await snapshotLinuxProcessTree(1600, {
    listDescendants: async () => [1601],
    readIdentity: async pid => ({ pid, startTime: String(pid + 10) }),
  });
  assert.deepEqual(tree, {
    parent: { pid: 1600, startTime: '1610' },
    descendants: [{ pid: 1601, startTime: '1611' }],
    complete: true,
    errors: [],
  });
});

test('supervisor separa grace de confirmación de kill y mantiene el peor caso acotado', () => {
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => fakeChild(1700, () => {}),
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 30000,
    killConfirmDeadlineMs: 5000,
    logger: { warn() {} },
  });
  assert.deepEqual(supervisor._deadlines, {
    gracefulDeadlineMs: 30000,
    killConfirmDeadlineMs: 5000,
    worstCaseMs: 35000,
  });
});

test('shutdown limpia cuatro stragglers en paralelo dentro de grace más una confirmación', async () => {
  const timers = fakeTimers();
  const cleanupStarts = [];
  const children = Array.from({ length: 4 }, (_, index) => fakeChild(1800 + index, () => {}));
  let spawnIndex = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[spawnIndex++],
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 30000,
    killConfirmDeadlineMs: 5000,
    timers,
    captureProcessTree: async pid => ({
      parent: { pid, startTime: String(pid) },
      descendants: [],
      complete: true,
      errors: [],
    }),
    terminateProcessTree: target => new Promise(resolve => {
      cleanupStarts.push(timers.now());
      timers.setTimeout(() => {
        exitChild(target, 0, 'SIGKILL');
        resolve(true);
      }, 5000);
    }),
    logger: { warn() {} },
  });
  for (let empresaId = 1; empresaId <= children.length; empresaId += 1) supervisor.ensure(empresaId);

  const shutdown = supervisor.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleanupStarts, [30000, 30000, 30000, 30000]);
  await timers.advance(4999);
  assert.equal(timers.now(), 34999);
  await timers.advance(1);

  assert.equal(await shutdown, true);
  assert.equal(timers.now(), 35000);
});

test('recaptura completa resuelve snapshot inicial incompleto y preserva identidades conocidas', async () => {
  const timers = fakeTimers();
  const child = fakeChild(1850, () => {});
  const snapshots = [
    {
      parent: { pid: 1850, startTime: 'root' },
      descendants: [{ pid: 1851, startTime: 'known-before' }],
      complete: false,
      errors: [{ pid: 1852, stage: 'children', code: 'ENOENT', name: 'Error' }],
    },
    {
      parent: { pid: 1850, startTime: 'root' },
      descendants: [{ pid: 1852, startTime: 'known-after' }],
      complete: true,
      errors: [],
    },
  ];
  let terminatedSnapshot;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 1,
    killConfirmDeadlineMs: 1,
    timers,
    captureProcessIdentity: async pid => ({ pid, startTime: 'root' }),
    captureProcessTree: async () => snapshots.shift(),
    terminateProcessTree: async (target, snapshot) => {
      terminatedSnapshot = snapshot;
      exitChild(target, 0, 'SIGKILL');
      return snapshot.complete;
    },
    logger: { warn() {} },
  });
  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);

  assert.deepEqual(await reconcile, { eligible: false, stopped: true });
  assert.equal(terminatedSnapshot.complete, true);
  assert.deepEqual(terminatedSnapshot.descendants, [
    { pid: 1851, startTime: 'known-before' },
    { pid: 1852, startTime: 'known-after' },
  ]);
});

test('dos capturas incompletas mantienen incertidumbre y fallan cerrado', async () => {
  const timers = fakeTimers();
  const child = fakeChild(1860, () => {});
  const snapshots = [
    { parent: { pid: 1860, startTime: 'root' }, descendants: [], complete: false, errors: [{ pid: 1861, code: 'ENOENT' }] },
    { parent: { pid: 1860, startTime: 'root' }, descendants: [], complete: false, errors: [{ pid: 1862, code: 'EACCES' }] },
  ];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 1,
    killConfirmDeadlineMs: 1,
    timers,
    captureProcessIdentity: async pid => ({ pid, startTime: 'root' }),
    captureProcessTree: async () => snapshots.shift(),
    terminateProcessTree: async (target, snapshot) => {
      exitChild(target, 0, 'SIGKILL');
      return snapshot.complete;
    },
    logger: { warn() {} },
  });
  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);

  await assert.rejects(reconcile, /stop could not be confirmed/);
});

test('ENOENT de leaf queda resuelto cuando la recaptura posterior enumera el árbol completo', async () => {
  const timers = fakeTimers();
  const child = fakeChild(1870, () => {});
  const snapshots = [
    {
      parent: { pid: 1870, startTime: 'root' }, descendants: [{ pid: 1871, startTime: 'leaf-a' }],
      complete: false, errors: [{ pid: 1872, stage: 'children', code: 'ENOENT' }],
    },
    {
      parent: { pid: 1870, startTime: 'root' }, descendants: [{ pid: 1871, startTime: 'leaf-a' }],
      complete: true, errors: [],
    },
  ];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    gracefulDeadlineMs: 1,
    killConfirmDeadlineMs: 1,
    timers,
    captureProcessIdentity: async pid => ({ pid, startTime: 'root' }),
    captureProcessTree: async () => snapshots.shift(),
    terminateProcessTree: async (target, snapshot) => {
      assert.equal(snapshot.complete, true);
      exitChild(target, 0, 'SIGKILL');
      return true;
    },
    logger: { warn() {} },
  });
  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(1);

  assert.deepEqual(await reconcile, { eligible: false, stopped: true });
});

test('snapshot /proc conserva identidades capturadas y marca incompleto si otro nodo desaparece', async () => {
  const files = new Map([
    ['/proc/1900/task/1900/children', '1901 1902\n'],
    ['/proc/1901/task/1901/children', '1903\n'],
    ['/proc/1903/task/1903/children', ''],
    ['/proc/1900/stat', '1900 (parent) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 100 20'],
    ['/proc/1901/stat', '1901 (child) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 101 20'],
    ['/proc/1903/stat', '1903 (grandchild) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 103 20'],
  ]);
  const readText = async path => {
    if (files.has(path)) return files.get(path);
    const error = new Error('gone');
    error.code = 'ENOENT';
    throw error;
  };

  const snapshot = await snapshotLinuxProcessTree(1900, { readText });

  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.descendants, [
    { pid: 1903, startTime: '103' },
    { pid: 1901, startTime: '101' },
  ]);
  assert.equal(snapshot.errors.some(error => error.pid === 1902 && error.code === 'ENOENT'), true);

  const signals = [];
  const identities = new Map(snapshot.descendants.map(identity => [identity.pid, identity]));
  const stopped = await terminateLinuxProcessSnapshot(snapshot, {
    readIdentity: async pid => identities.get(pid) ?? null,
    signalPid(pid, signal) {
      signals.push(`${pid}:${signal}`);
      identities.delete(pid);
    },
  });
  assert.deepEqual(signals, ['1903:SIGKILL', '1901:SIGKILL']);
  assert.equal(stopped, false, 'an incomplete topology cannot be confirmed clean');
});

test('snapshot incompleto con parent ya salido falla cerrado aunque no queden identidades visibles', async () => {
  const child = fakeChild(1950, () => {});
  exitChild(child, 0, 'SIGTERM');
  const result = await terminateLinuxProcessTree(child, {
    parent: null,
    descendants: [],
    complete: false,
    errors: [{ pid: 1951, code: 'EACCES' }],
  }, {
    readIdentity: async () => null,
  });
  assert.equal(result, false);
});

test('PID reutilizado antes del stop no recibe SIGTERM ni SIGKILL y no recorre descendientes nuevos', async () => {
  const signals = [];
  let treeCaptures = 0;
  const child = fakeChild(2000, signal => signals.push(signal));
  const identities = [
    { pid: 2000, startTime: 'original' },
    { pid: 2000, startTime: 'reused' },
  ];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: async () => identities.shift() ?? { pid: 2000, startTime: 'reused' },
    captureProcessTree: async () => {
      treeCaptures += 1;
      return {
        parent: { pid: 2000, startTime: 'reused' },
        descendants: [{ pid: 2001, startTime: 'new-child' }],
        complete: true,
        errors: [],
      };
    },
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.deepEqual(signals, []);
  assert.equal(treeCaptures, 0);
});

test('worker normal con la misma identidad recibe SIGTERM', async () => {
  const signals = [];
  const child = fakeChild(2010, (signal, self) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => exitChild(self, 0, signal));
  });
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: async pid => ({ pid, startTime: 'same' }),
    captureProcessTree: async pid => ({
      parent: { pid, startTime: 'same' }, descendants: [], complete: true, errors: [],
    }),
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('retry de identidad se cancela al terminar la generación y no adopta un PID reutilizado', async () => {
  const timers = fakeTimers();
  const signals = [];
  let identityReads = 0;
  let treeCaptures = 0;
  const child = fakeChild(2015, signal => signals.push(`parent:${signal}`));
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    identityCaptureAttempts: 2,
    identityCaptureRetryMs: 10,
    timers,
    captureProcessIdentity: async pid => {
      identityReads += 1;
      return identityReads === 1 ? null : { pid, startTime: 'reused' };
    },
    captureProcessTree: async pid => {
      treeCaptures += 1;
      return {
        parent: { pid, startTime: 'reused' },
        descendants: [{ pid: 2016, startTime: 'new-child' }],
        complete: true,
        errors: [],
      };
    },
    terminateProcessTree: async (_target, snapshot) => {
      signals.push(...snapshot.descendants.map(identity => `${identity.pid}:SIGKILL`));
      return true;
    },
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  await new Promise(resolve => setImmediate(resolve));
  exitChild(child, 0, null);
  await timers.advance(10);

  assert.deepEqual(await reconcile, { eligible: false, stopped: true });
  assert.equal(identityReads, 1);
  assert.equal(treeCaptures, 0);
  assert.deepEqual(signals, []);
});

test('identidad devuelta después del exit se descarta antes de asignarla a la generación', async () => {
  const read = deferred();
  const signals = [];
  let treeCaptures = 0;
  const child = fakeChild(2017, signal => signals.push(signal));
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: () => read.promise,
    captureProcessTree: async () => {
      treeCaptures += 1;
      return { parent: { pid: 2017, startTime: 'late' }, descendants: [], complete: true, errors: [] };
    },
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  const reconcile = supervisor.reconcileEligibility(1, false);
  let settled = false;
  reconcile.then(() => { settled = true; });
  exitChild(child, 0, null);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, true, 'el evento terminal debe resolver la captura sin esperar el read tardío');
  assert.deepEqual(await reconcile, { eligible: false, stopped: true });
  read.resolve({ pid: 2017, startTime: 'late' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(treeCaptures, 0);
  assert.deepEqual(signals, []);
});

test('reemplazo antes del retry cancela la captura vieja y no la mezcla con el nuevo record', async () => {
  const timers = fakeTimers();
  const signals = [];
  const children = [
    fakeChild(2018, signal => signals.push(`old:${signal}`)),
    fakeChild(2018, (signal, self) => {
      signals.push(`new:${signal}`);
      if (signal === 'SIGTERM') queueMicrotask(() => exitChild(self, 0, signal));
    }),
  ];
  let spawnIndex = 0;
  let identityReads = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[spawnIndex++],
    shouldAutoStart: () => true,
    identityCaptureAttempts: 2,
    identityCaptureRetryMs: 20,
    timers,
    captureProcessIdentity: async pid => {
      identityReads += 1;
      return identityReads === 1 ? null : { pid, startTime: 'generation-2' };
    },
    captureProcessTree: async pid => ({
      parent: { pid, startTime: 'generation-2' }, descendants: [], complete: true, errors: [],
    }),
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  await new Promise(resolve => setImmediate(resolve));
  children[0].exitCode = 1;
  assert.equal(supervisor.ensure(1).started, true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(spawnIndex, 2);
  assert.equal(timers.scheduled.filter(timer => timer.active).length, 0, 'el reemplazo debe cancelar el retry viejo');
  await timers.advance(20);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.equal(identityReads, 4, 'solo debe leerse una vez la generación vieja y tres veces la activa');
  assert.deepEqual(signals, ['new:SIGTERM']);
});

test('worker vivo captura identidad en un retry válido después de un null transitorio', async () => {
  const timers = fakeTimers();
  const signals = [];
  let identityReads = 0;
  const child = fakeChild(2019, (signal, self) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => exitChild(self, 0, signal));
  });
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    identityCaptureAttempts: 2,
    identityCaptureRetryMs: 10,
    timers,
    captureProcessIdentity: async pid => {
      identityReads += 1;
      return identityReads === 1 ? null : { pid, startTime: 'stable' };
    },
    captureProcessTree: async pid => ({
      parent: { pid, startTime: 'stable' }, descendants: [], complete: true, errors: [],
    }),
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  await new Promise(resolve => setImmediate(resolve));
  await timers.advance(10);

  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.equal(identityReads, 4);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('identidad inicial no capturable falla cerrado sin señalizar', async () => {
  const signals = [];
  const child = fakeChild(2020, signal => signals.push(signal));
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: async () => null,
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  await assert.rejects(supervisor.reconcileEligibility(1, false), /identity could not be confirmed/i);
  assert.deepEqual(signals, []);
});

test('error leyendo identidad actual falla cerrado sin asumir que el PID desapareció', async () => {
  const signals = [];
  const child = fakeChild(2025, signal => signals.push(signal));
  let reads = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: async pid => {
      reads += 1;
      if (reads === 1) return { pid, startTime: 'original' };
      const error = new Error('/proc denied');
      error.code = 'EACCES';
      throw error;
    },
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  await assert.rejects(supervisor.reconcileEligibility(1, false), /stop could not be confirmed/i);
  assert.deepEqual(signals, []);
});

test('PID desaparecido antes del stop se considera terminado sin señal', async () => {
  const signals = [];
  const child = fakeChild(2030, signal => signals.push(signal));
  const identities = [{ pid: 2030, startTime: 'original' }, null];
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    captureProcessIdentity: async () => identities.shift() ?? null,
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.deepEqual(signals, []);
});

test('respawn conserva identidad por generación y no mezcla la anterior con el sucesor', async () => {
  const timers = fakeTimers();
  const signals = [];
  const children = [fakeChild(2040, () => {}), fakeChild(2040, () => {})];
  const initialIdentities = ['generation-1', 'generation-2'];
  let currentIdentity = 'generation-1';
  let spawnIndex = 0;
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => children[spawnIndex++],
    shouldAutoStart: () => true,
    respawnDelayMs: 1,
    timers,
    captureProcessIdentity: async pid => ({ pid, startTime: initialIdentities.shift() ?? currentIdentity }),
    captureProcessTree: async pid => ({
      parent: { pid, startTime: currentIdentity }, descendants: [], complete: true, errors: [],
    }),
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  exitChild(children[0], 1, null);
  currentIdentity = 'generation-2';
  await timers.advance(1);
  assert.equal(spawnIndex, 2);

  children[1].kill = signal => {
    signals.push(`second:${signal}`);
    if (signal === 'SIGTERM') queueMicrotask(() => exitChild(children[1], 0, signal));
    return true;
  };
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.deepEqual(signals, ['second:SIGTERM']);
});

test('Linux con child.pid ausente falla cerrado sin señalizar', async () => {
  const signals = [];
  const child = fakeChild(undefined, signal => signals.push(signal));
  const supervisor = createCompanyWorkerSupervisor({
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  await assert.rejects(supervisor.reconcileEligibility(1, false), /identity could not be confirmed/i);
  assert.deepEqual(signals, []);
});

test('política no-Linux usa el handle aunque child.pid esté ausente', async () => {
  const signals = [];
  const child = fakeChild(undefined, (signal, self) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => exitChild(self, 0, signal));
  });
  const supervisor = createSupervisor({
    processIdentityPolicy: 'child-handle',
    spawnWorker: () => child,
    shouldAutoStart: () => true,
    logger: { warn() {} },
  });

  supervisor.ensure(1);
  assert.deepEqual(await supervisor.reconcileEligibility(1, false), { eligible: false, stopped: true });
  assert.deepEqual(signals, ['SIGTERM']);
});
