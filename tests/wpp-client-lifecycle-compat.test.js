import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as lifecycle from '../src/wpp/clientLifecycle.js';
import * as sessions from '../src/wpp/sessionUtils.js';

test('legacy direct General client lifecycle is no longer exported', () => {
  assert.equal(lifecycle.createWppClientLifecycle, undefined);
});

test('session utilities expose paths but no Singleton lock deletion helper', () => {
  assert.equal(typeof sessions.getWppSessionBasePath, 'function');
  assert.equal(typeof sessions.getWppSessionDir, 'function');
  assert.equal(sessions.limpiarLocksSesion, undefined);
});

test('runtime sources never delete Chromium Singleton lock files', async () => {
  const workerSource = await readFile(new URL('../src/wppWorker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(workerSource, /unlinkSync\([^\n]*Singleton|SingletonLock[\s\S]{0,300}unlinkSync/);
});
