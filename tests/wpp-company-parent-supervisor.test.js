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
