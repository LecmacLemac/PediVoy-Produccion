import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUD_DEADLINES,
  normalizeCloudDeadline,
} from '../src/whatsappCloud/deadlines.js';
import { createWhatsAppCloudGraphClient } from '../src/whatsappCloud/graphClient.js';
import { createWhatsAppCloudConsumer } from '../src/whatsappCloud/consumer.js';
import { createWhatsAppCloudWorkerRuntime } from '../src/whatsappCloud/runtime.js';

const LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

function successfulPayload() {
  return {
    phoneNumberId: '123',
    accessToken: 'secret',
    to: '3515550000',
    text: 'hola',
  };
}

function createTimerProbe({ fire = false } = {}) {
  const calls = [];
  const cleared = [];
  const setTimeoutImpl = (callback, delay) => {
    const handle = {
      unrefCalls: 0,
      unref() { this.unrefCalls += 1; },
      hasRef() { return this.unrefCalls === 0; },
    };
    calls.push({ callback, delay, handle });
    if (fire) queueMicrotask(callback);
    return handle;
  };
  return {
    calls,
    cleared,
    setTimeoutImpl,
    clearTimeoutImpl: handle => cleared.push(handle),
  };
}

test('política lease Cloud usa default y límites operativos explícitos', () => {
  assert.deepEqual(CLOUD_DEADLINES.lease, { default: 120_000, min: 1_000, max: 900_000 });
});

test('normalizador Cloud acepta sólo enteros decimales dentro de límites explícitos', () => {
  for (const [name, policy] of Object.entries(CLOUD_DEADLINES)) {
    assert.equal(normalizeCloudDeadline(name, policy.min), policy.min);
    assert.equal(normalizeCloudDeadline(name, policy.max), policy.max);
    assert.equal(normalizeCloudDeadline(name, String(policy.min)), policy.min);
    assert.equal(normalizeCloudDeadline(name, ` ${policy.max} `), policy.max);

    for (const dangerous of [NaN, Infinity, -1, 0, '', 'abc', '10ms', '1e3', '1.5', 2 ** 40]) {
      assert.equal(normalizeCloudDeadline(name, dangerous), policy.default, `${name}: ${String(dangerous)}`);
    }
    assert.equal(normalizeCloudDeadline(name, policy.min - 1), policy.default);
    assert.equal(normalizeCloudDeadline(name, policy.max + 1), policy.default);
  }
});

test('timeouts Graph peligrosos usan default seguro sin warnings ni outcome prematuro', { concurrency: false }, async () => {
  const warnings = [];
  const onWarning = warning => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    for (const timeoutMs of [NaN, Infinity, -1, 0, 'invalid', '10ms', 2 ** 40]) {
      const client = createWhatsAppCloudGraphClient({
        timeoutMs,
        fetchImpl: async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.safe' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      });
      assert.deepEqual(await client.sendText(successfulPayload()), { outcome: 'sent', messageId: 'wamid.safe' });
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings.filter(warning => /^Timeout.*Warning$/.test(warning.name)), []);
  } finally {
    process.off('warning', onWarning);
  }
});

test('timer de deadline Graph hace unref y se limpia al resolver', async () => {
  const probe = createTimerProbe();
  const client = createWhatsAppCloudGraphClient({
    timeoutMs: CLOUD_DEADLINES.graph.min,
    setTimeoutImpl: probe.setTimeoutImpl,
    clearTimeoutImpl: probe.clearTimeoutImpl,
    fetchImpl: async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.safe' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.deepEqual(await client.sendText(successfulPayload()), { outcome: 'sent', messageId: 'wamid.safe' });
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0].delay, CLOUD_DEADLINES.graph.min);
  assert.equal(probe.calls[0].handle.unrefCalls, 1);
  assert.equal(probe.calls[0].handle.hasRef(), false);
  assert.deepEqual(probe.cleared, [probe.calls[0].handle]);
});

test('timer de cancelación de body hace unref, resuelve deadline y se limpia', async () => {
  const probe = createTimerProbe({ fire: true });
  const client = createWhatsAppCloudGraphClient({
    cancelTimeoutMs: CLOUD_DEADLINES.cancel.min,
    setTimeoutImpl: probe.setTimeoutImpl,
    clearTimeoutImpl: probe.clearTimeoutImpl,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      body: { cancel: () => new Promise(() => {}) },
    }),
  });

  assert.deepEqual(await client.sendText(successfulPayload()), {
    outcome: 'retryable_rejected',
    errorCode: 'cloud_rate_limited',
  });
  assert.equal(probe.calls.length, 2);
  const cancelTimer = probe.calls[1];
  assert.equal(cancelTimer.delay, CLOUD_DEADLINES.cancel.min);
  assert.equal(cancelTimer.handle.unrefCalls, 1);
  assert.equal(cancelTimer.handle.hasRef(), false);
  assert.ok(probe.cleared.includes(cancelTimer.handle));
});

test('timer de drain del consumer hace unref y usa default ante cero', async () => {
  const probe = createTimerProbe({ fire: true });
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => new Promise(() => {}),
    loadConfig: async () => null,
    startDispatch: async () => {},
    finish: async () => {},
    decryptToken: value => value,
    graphClient: { sendText: async () => ({ outcome: 'sent', messageId: 'x' }) },
    setTimeoutImpl: probe.setTimeoutImpl,
    clearTimeoutImpl: probe.clearTimeoutImpl,
    logger: LOGGER,
  });

  void consumer.processOnce();
  assert.equal(await consumer.shutdown({ timeoutMs: 0 }), false);
  assert.equal(probe.calls[0].delay, CLOUD_DEADLINES.drain.default);
  assert.equal(probe.calls[0].handle.unrefCalls, 1);
  assert.deepEqual(probe.cleared, [probe.calls[0].handle]);
});

test('runtime normaliza poll/shutdown, libera el interval y mantiene referenciado el deadline global', async () => {
  const timeoutProbe = createTimerProbe({ fire: true });
  const intervalCalls = [];
  const intervalHandle = {
    unrefCalls: 0,
    unref() { this.unrefCalls += 1; },
    hasRef() { return this.unrefCalls === 0; },
  };
  const exits = [];
  const runtime = createWhatsAppCloudWorkerRuntime({
    consumer: {
      async processOnce() { return { outcome: 'idle' }; },
      async shutdown() { return new Promise(() => {}); },
    },
    closePool: async () => {},
    intervalMs: '10ms',
    shutdownTimeoutMs: Infinity,
    setIntervalImpl: (callback, delay) => {
      intervalCalls.push({ callback, delay });
      return intervalHandle;
    },
    clearIntervalImpl() {},
    setTimeoutImpl: timeoutProbe.setTimeoutImpl,
    clearTimeoutImpl: timeoutProbe.clearTimeoutImpl,
    now: () => 1_000,
    onSignal() {},
    exit: code => exits.push(code),
    logger: LOGGER,
  });

  runtime.start();
  assert.equal(intervalCalls[0].delay, CLOUD_DEADLINES.poll.default);
  assert.equal(intervalHandle.unrefCalls, 1);
  assert.equal(intervalHandle.hasRef(), false);

  assert.equal(await runtime.shutdown(), false);
  assert.equal(timeoutProbe.calls[0].delay, CLOUD_DEADLINES.shutdown.default);
  assert.equal(timeoutProbe.calls.length, 1);
  assert.equal(timeoutProbe.calls[0].handle.unrefCalls, 0);
  assert.equal(timeoutProbe.calls[0].handle.hasRef(), true);
  assert.deepEqual(timeoutProbe.cleared, [timeoutProbe.calls[0].handle]);
  assert.deepEqual(exits, [1]);
});
