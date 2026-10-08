import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChainedRefreshScheduler,
  mergeCanonicalConversationRefresh,
  mergeLiveHistory,
} from '../pedidos/whatsapp-cloud-ui.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    timers,
    async runOnly() {
      assert.equal(timers.size, 1, 'debe existir un único timeout encadenado');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      await Promise.resolve();
      return timer.delay;
    },
  };
}

test('Task 6 merge canónico actualiza e inserta sin duplicar ni perder páginas antiguas', () => {
  const oldFirst = { conversationId: 'a', participant: '*********0001', version: 1, priority: 'normal', queueBucket: 0, queuePriorityRank: 2, queueActivityKey: '10', lastMessageId: '10' };
  const older = { conversationId: 'b', participant: '*********0002', version: 1, priority: 'normal', queueBucket: 3, queuePriorityRank: 0, queueActivityKey: '-5', lastMessageId: '5' };
  const updated = { ...oldFirst, version: 2, priority: 'urgent', queuePriorityRank: 0, queueActivityKey: '20', privateField: 'no' };
  const inserted = { ...oldFirst, conversationId: 'c', participant: '*********0003', queueActivityKey: '30', lastMessageId: '30' };
  const result = mergeCanonicalConversationRefresh({
    current: [oldFirst, older],
    incomingFirstPage: [inserted, updated, updated],
    previousFirstPageIds: ['a'],
  });
  assert.deepEqual(result.conversations.map(item => item.conversationId), ['a', 'c', 'b']);
  assert.equal(result.conversations.find(item => item.conversationId === 'a').version, 2);
  assert.equal(Object.hasOwn(result.conversations.find(item => item.conversationId === 'a'), 'privateField'), false);
  assert.deepEqual(result.firstPageIds, ['c', 'a']);
});

test('Task 6 merge history deduplica correlaciones y nunca retrocede estados', () => {
  const current = [
    { id: '1', providerMessageId: 'wamid-a', direction: 'outbound', deliveryStatus: 'delivered', messageAt: '2026-10-08T10:00:00Z', text: 'uno' },
    { id: '2', idempotencyKey: 'key-b', direction: 'outbound', deliveryStatus: 'failed', messageAt: '2026-10-08T10:01:00Z', text: 'dos' },
    { id: '3', direction: 'inbound', deliveryStatus: 'received', messageAt: '2026-10-08T10:02:00Z', text: 'tres' },
  ];
  const incoming = [
    { id: '1', providerMessageId: 'wamid-a', direction: 'outbound', deliveryStatus: 'sent', messageAt: '2026-10-08T10:00:00Z', text: 'uno stale' },
    { id: '9', idempotencyKey: 'key-b', direction: 'outbound', deliveryStatus: 'sent', messageAt: '2026-10-08T10:01:00Z', text: 'dos duplicado' },
    { id: '4', direction: 'inbound', deliveryStatus: 'received', messageAt: '2026-10-08T10:03:00Z', text: 'cuatro' },
  ];
  const merged = mergeLiveHistory(current, incoming);
  assert.deepEqual(merged.messages.map(item => item.id), ['1', '2', '3', '4']);
  assert.equal(merged.messages[0].deliveryStatus, 'delivered');
  assert.equal(merged.messages[1].deliveryStatus, 'failed');
  assert.deepEqual(merged.newMessageIds, ['4']);
});

test('Task 6 scheduler aplica backoff acotado con jitter inyectable y resetea tras éxito', async () => {
  const clock = fakeClock();
  const outcomes = [new Error('uno'), new Error('dos'), null, null];
  const scheduler = createChainedRefreshScheduler({
    isVisible: () => true,
    canRun: () => true,
    cycle: async () => {
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
    },
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    jitter: ({ failures }) => failures * 10,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  await assert.rejects(scheduler.start(), /uno/);
  await Promise.resolve();
  assert.equal(await clock.runOnly(), 2_010);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await clock.runOnly(), 4_000, 'backoff queda limitado al máximo');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await clock.runOnly(), 1_000, 'éxito resetea backoff');
});

test('Task 6 pause aborta el ciclo actual, invalida su generación y no duplica timer al reanudar', async () => {
  const clock = fakeClock();
  const signals = [];
  const pending = deferred();
  let calls = 0;
  const scheduler = createChainedRefreshScheduler({
    isVisible: () => true,
    canRun: () => true,
    cycle: ({ signal, generation }) => {
      calls += 1;
      signals.push({ signal, generation });
      return calls === 1 ? pending.promise : Promise.resolve();
    },
    baseDelayMs: 5_000,
    maxDelayMs: 20_000,
    jitter: () => 0,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  scheduler.start();
  assert.equal(signals[0].signal.aborted, false);
  scheduler.pause();
  assert.equal(signals[0].signal.aborted, true);
  scheduler.resume();
  scheduler.resume();
  assert.equal(calls, 2);
  assert.ok(signals[1].generation > signals[0].generation);
  pending.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(clock.timers.size, 1);
});

test('Task 6 scheduler corre sólo visible, encadena timeout y nunca solapa ciclos', async () => {
  const clock = fakeClock();
  let visible = false;
  let valid = true;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const first = deferred();
  const scheduler = createChainedRefreshScheduler({
    isVisible: () => visible,
    canRun: () => valid,
    cycle: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (calls === 1) await first.promise;
      inFlight -= 1;
    },
    baseDelayMs: 10_000,
    maxDelayMs: 40_000,
    jitter: () => 0,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  scheduler.start();
  assert.equal(calls, 0);
  assert.equal(clock.timers.size, 0);

  visible = true;
  const firstRun = scheduler.resume();
  assert.equal(calls, 1, 'reanudar visible ejecuta ciclo inmediato');
  assert.equal(clock.timers.size, 0, 'no agenda mientras hay ciclo en vuelo');
  scheduler.resume();
  assert.equal(calls, 1, 'resume duplicado no solapa');

  first.resolve();
  await firstRun;
  await Promise.resolve();
  assert.equal(clock.timers.size, 1);
  assert.equal(await clock.runOnly(), 10_000);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(maxInFlight, 1);

  visible = false;
  scheduler.pause();
  assert.equal(clock.timers.size, 0);
  valid = false;
  visible = true;
  scheduler.resume();
  assert.equal(calls, 2);
});
