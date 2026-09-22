import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createCompanyWorkerSupervisor } from '../src/wpp/companyWorkerSupervisor.js';

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

function fakeTimers() {
  let now = 0;
  let sequence = 0;
  const scheduled = [];
  return {
    scheduled,
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
