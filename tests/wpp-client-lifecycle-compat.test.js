import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as lifecycle from '../src/wpp/clientLifecycle.js';
import * as sessions from '../src/wpp/sessionUtils.js';

test('legacy direct General client lifecycle is no longer exported', () => {
  assert.equal(lifecycle.createWppClientLifecycle, undefined);
});

test('session utilities expose paths and controlled Chromium lock cleanup', async () => {
  assert.equal(typeof sessions.getWppSessionBasePath, 'function');
  assert.equal(typeof sessions.getWppSessionDir, 'function');
  assert.equal(typeof sessions.removeChromiumSingletonLocks, 'function');
  assert.equal(sessions.limpiarLocksSesion, undefined);

  const sessionDir = await mkdtemp(join(tmpdir(), 'wpp-session-'));
  await writeFile(join(sessionDir, 'SingletonLock'), 'stale');
  await writeFile(join(sessionDir, 'SingletonSocket'), 'stale');
  await writeFile(join(sessionDir, 'SingletonCookie'), 'stale');
  const removed = sessions.removeChromiumSingletonLocks({ fs: await import('node:fs'), path: await import('node:path'), sessionDir });
  assert.deepEqual(removed, ['SingletonLock', 'SingletonSocket', 'SingletonCookie']);
});

test('empresa runtime never removes Chromium Singleton locks during startup or recovery', async () => {
  const workerSource = await readFile(new URL('../src/wppWorker.js', import.meta.url), 'utf8');
  const generalSource = await readFile(new URL('../src/wpp/generalRuntime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(workerSource, /removeChromiumSingletonLocks|unlinkSync\([^\n]*Singleton/);
  assert.match(generalSource, /removeChromiumSingletonLocks/);
  assert.doesNotMatch(generalSource, /unlinkSync\([^\n]*Singleton/);
});
