import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createWppClientAdapter } from '../src/wpp/clientAdapter.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fakeRawClient({ initialize, browser } = {}) {
  const raw = new EventEmitter();
  raw.initialize = initialize ?? (async () => {});
  raw.destroy = async () => {};
  raw.pupBrowser = browser;
  raw.sendMessage = function sendMessage() { return this; };
  return raw;
}

test('unresolved initialize is never reported stopped', async () => {
  const pending = deferred();
  const raw = fakeRawClient({ initialize: () => pending.promise });
  const adapter = createWppClientAdapter({ rawClient: raw });

  adapter.initialize();
  assert.equal(await adapter.confirmStopped(), false);
  assert.equal(await adapter.forceStop(), false);
  pending.resolve();
  await adapter.initialize();
});

test('forceStop kills and confirms a known Chromium process while initialize is pending', async () => {
  const pending = deferred();
  let alive = true;
  const kills = [];
  const processHandle = { pid: 40, exitCode: null, signalCode: null };
  const raw = fakeRawClient({
    initialize: () => pending.promise,
    browser: { isConnected: () => true, process: () => processHandle },
  });
  const adapter = createWppClientAdapter({
    rawClient: raw,
    kill: (pid, signal) => { kills.push([pid, signal]); alive = false; },
    processAlive: () => alive,
    wait: async () => {},
  });

  adapter.initialize();
  assert.equal(await adapter.forceStop(), true);
  assert.deepEqual(kills, [[40, 'SIGKILL']]);
  pending.resolve();
  await adapter.initialize();
});

test('missing browser evidence remains uncertain after destroy', async () => {
  const raw = fakeRawClient();
  const adapter = createWppClientAdapter({ rawClient: raw });

  await adapter.initialize();
  await adapter.destroy();
  assert.equal(await adapter.confirmStopped(), false);
  assert.equal(await adapter.forceStop(), false);
});

test('disconnected browser without a process handle remains uncertain after destroy', async () => {
  const raw = fakeRawClient({
    browser: { isConnected: () => false, process: () => null },
  });
  const adapter = createWppClientAdapter({ rawClient: raw });

  await adapter.initialize();
  await adapter.destroy();
  assert.equal(await adapter.confirmStopped(), false);
});

test('known browser process must actually exit before stop is confirmed', async () => {
  const processHandle = { pid: 41, exitCode: null, signalCode: null };
  const browser = { isConnected: () => false, process: () => processHandle };
  const raw = fakeRawClient({ browser });
  const adapter = createWppClientAdapter({
    rawClient: raw,
    processAlive: () => true,
  });

  await adapter.initialize();
  await adapter.destroy();
  assert.equal(await adapter.confirmStopped(), false);

  processHandle.exitCode = 0;
  assert.equal(await adapter.confirmStopped(), true);
});

test('forceStop SIGKILLs a known Chromium process and confirms its exit', async () => {
  let alive = true;
  const kills = [];
  const processHandle = { pid: 42, exitCode: null, signalCode: null };
  const raw = fakeRawClient({
    browser: { isConnected: () => false, process: () => processHandle },
  });
  const adapter = createWppClientAdapter({
    rawClient: raw,
    kill: (pid, signal) => { kills.push([pid, signal]); alive = false; },
    processAlive: () => alive,
    wait: async () => {},
  });

  await adapter.initialize();
  assert.equal(await adapter.forceStop(), true);
  assert.deepEqual(kills, [[42, 'SIGKILL']]);
});

test('adapter preserves the normal client surface with the raw receiver', () => {
  const raw = fakeRawClient();
  const adapter = createWppClientAdapter({ rawClient: raw });
  assert.equal(adapter.sendMessage(), raw);
});
