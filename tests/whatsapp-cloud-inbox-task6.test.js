import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureVisibleScrollAnchor,
  createChainedRefreshScheduler,
  mergeCanonicalConversationRefresh,
  mergeLiveHistory,
  reconcileSearchConversationRefresh,
  restoreVisibleScrollAnchor,
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

function fakeScrollContainer({ top = 100, bottom = 400, scrollTop = 240, messages = [] } = {}) {
  return {
    scrollTop,
    getBoundingClientRect: () => ({ top, bottom }),
    querySelectorAll: () => messages.map(message => ({
      dataset: { messageId: message.id },
      getBoundingClientRect: () => ({ top: message.top, bottom: message.bottom }),
    })),
  };
}

test('Task 6 captura el primer mensaje parcial o visible como ancla opaca', () => {
  const container = fakeScrollContainer({ messages: [
    { id: 'dto-oculto', top: 20, bottom: 90 },
    { id: 'dto-parcial', top: 80, bottom: 130 },
    { id: 'dto-visible', top: 140, bottom: 190 },
  ] });
  assert.deepEqual(captureVisibleScrollAnchor(container), {
    messageId: 'dto-parcial', offsetTop: -20, previousTop: 240,
  });
});

test('Task 6 restaura el mismo píxel del ancla y usa previousTop si desaparece', () => {
  const anchor = { messageId: 'dto-ancla', offsetTop: 15, previousTop: 240 };
  const moved = fakeScrollContainer({ scrollTop: 240, messages: [
    { id: 'dto-ancla', top: 175, bottom: 225 },
  ] });
  assert.equal(restoreVisibleScrollAnchor(moved, anchor), true);
  assert.equal(moved.scrollTop, 300, 'compensa los 60 px agregados antes del ancla');

  const missing = fakeScrollContainer({ scrollTop: 999, messages: [] });
  assert.equal(restoreVisibleScrollAnchor(missing, anchor), false);
  assert.equal(missing.scrollTop, 240);
});

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

test('Task 6 merge canónico retira sólo bajas autoritativas y preserva páginas no revalidadas', () => {
  const current = ['a', 'b', 'old'].map((conversationId, index) => ({
    conversationId, participant: `*********000${index + 1}`, workflowStatus: 'pending', priority: 'normal',
    unreadCount: 1, lastMessageId: String(30 - index), lastMessageAt: `2026-10-08T10:0${index}:00Z`,
  }));
  const result = mergeCanonicalConversationRefresh({
    current,
    incomingFirstPage: [{ ...current[1], unreadCount: 2 }],
    previousFirstPageIds: ['a', 'b'],
    authoritativeRemovedIds: ['a'],
  });
  assert.deepEqual(result.conversations.map(item => item.conversationId).sort(), ['b', 'old']);
  assert.equal(result.conversations.find(item => item.conversationId === 'b').unreadCount, 2);
});

test('Task 6 search activo usa canónico coincidente, marca ausentes stale y quita filtros incumplidos', () => {
  const result = reconcileSearchConversationRefresh({
    searchResults: [
      { conversationId: 'a', unreadCount: 1, priority: 'normal', workflowStatus: 'pending', version: 1 },
      { conversationId: 'b', unreadCount: 2, priority: 'high', workflowStatus: 'pending', version: 1 },
      { conversationId: 'c', unreadCount: 3, priority: 'normal', workflowStatus: 'pending', version: 1 },
    ],
    canonical: [{ conversationId: 'a', unreadCount: 0, priority: 'urgent', workflowStatus: 'resolved', version: 4 }],
    authoritativeRemovedIds: ['c'],
  });
  assert.deepEqual(result.map(item => [item.conversationId, item.searchStale]), [['a', false], ['b', true]]);
  assert.deepEqual(result[0], {
    conversationId: 'a', unreadCount: 0, priority: 'urgent', workflowStatus: 'resolved', version: 4, searchStale: false,
  });
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
  assert.equal(merged.messages[1].deliveryStatus, 'sent');
  assert.deepEqual(merged.newMessageIds, ['4']);
  assert.equal(merged.changed, true);
});

test('Task 6 lattice delivery preserva éxitos ante fallos tardíos y permite éxito posterior al fallo', () => {
  const statuses = ['queued', 'pending', 'accepted', 'sending', 'sent', 'delivered', 'read'];
  for (let index = 1; index < statuses.length; index += 1) {
    const previous = statuses[index];
    const stale = statuses[index - 1];
    const merged = mergeLiveHistory(
      [{ id: '1', direction: 'outbound', deliveryStatus: previous, messageAt: '2026-10-08T10:00:00Z' }],
      [{ id: '1', direction: 'outbound', deliveryStatus: stale, messageAt: '2026-10-08T10:00:00Z' }],
    );
    assert.equal(merged.messages[0].deliveryStatus, previous, `${previous} no retrocede a ${stale}`);
  }
  for (const failure of ['failed', 'error', 'outcome_unknown']) {
    for (const success of ['sent', 'delivered', 'read']) {
      assert.equal(mergeLiveHistory(
        [{ id: '1', deliveryStatus: success, messageAt: '2026-10-08T10:00:00Z' }],
        [{ id: '1', deliveryStatus: failure, messageAt: '2026-10-08T10:00:00Z' }],
      ).messages[0].deliveryStatus, success);
      assert.equal(mergeLiveHistory(
        [{ id: '1', deliveryStatus: failure, messageAt: '2026-10-08T10:00:00Z' }],
        [{ id: '1', deliveryStatus: success, messageAt: '2026-10-08T10:00:00Z' }],
      ).messages[0].deliveryStatus, success);
    }
  }
});

test('Task 6 merge history idéntico informa unchanged', () => {
  const message = { id: '1', direction: 'outbound', deliveryStatus: 'delivered', messageAt: '2026-10-08T10:00:00Z', text: 'igual' };
  const merged = mergeLiveHistory([message], [{ ...message }]);
  assert.equal(merged.changed, false);
  assert.deepEqual(merged.newMessageIds, []);
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

test('Task 6 pause conserva single-flight hasta settlement y reanuda inmediatamente después', async () => {
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
  assert.equal(calls, 1, 'abort ignorado no habilita un segundo ciclo concurrente');
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'resume pendiente corre al asentarse el ciclo abortado');
  assert.ok(signals[1].generation > signals[0].generation);
  await new Promise(resolve => setImmediate(resolve));
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
