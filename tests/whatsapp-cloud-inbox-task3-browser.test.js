import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = '/usr/bin/google-chrome';
const browserTest = existsSync(chromePath) ? test : test.skip;
const ids = Object.freeze({
  urgent: '11111111-1111-4111-8111-111111111111',
  high: '22222222-2222-4222-8222-222222222222',
  normal: '33333333-3333-4333-8333-333333333333',
  failed: '44444444-4444-4444-8444-444444444444',
  unknown: '55555555-5555-4555-8555-555555555555',
  queued: '66666666-6666-4666-8666-666666666666',
  sending: '77777777-7777-4777-8777-777777777777',
  resolved: '88888888-8888-4888-8888-888888888888',
  tenantB: '99999999-9999-4999-8999-999999999999',
});

const counters = Object.freeze({ total: 8, pending: 3, inProcess: 2, review: 2, resolved: 1 });

function conversation(conversationId, participantSuffix, overrides = {}) {
  return {
    conversationId,
    participant: `*********${participantSuffix}`,
    lastMessageAt: '2026-10-07T12:00:00Z',
    lastMessageType: 'text',
    lastDirection: 'inbound',
    lastDeliveryStatus: 'received',
    workflowStatus: 'pending',
    priority: 'normal',
    unreadCount: 1,
    version: 4,
    ...overrides,
  };
}

function operationalConversations() {
  return [
    conversation(ids.urgent, '0101', { priority: 'urgent', unreadCount: 3, lastMessageAt: '2026-10-07T08:00:00Z' }),
    conversation(ids.high, '0102', { priority: 'high', unreadCount: 2, lastMessageAt: '2026-10-07T09:00:00Z' }),
    conversation(ids.normal, '0103', { unreadCount: 1, lastMessageAt: '2026-10-07T10:00:00Z' }),
    conversation(ids.failed, '0104', { lastDirection: 'outbound', lastDeliveryStatus: 'failed', unreadCount: 0, lastMessageAt: '2026-10-07T11:00:00Z' }),
    conversation(ids.unknown, '0105', { lastDirection: 'outbound', lastDeliveryStatus: 'outcome_unknown', unreadCount: 0, lastMessageAt: '2026-10-07T11:10:00Z' }),
    conversation(ids.queued, '0106', { lastDirection: 'outbound', lastDeliveryStatus: 'queued', unreadCount: 0, lastMessageAt: '2026-10-07T11:20:00Z' }),
    conversation(ids.sending, '0107', { lastDirection: 'outbound', lastDeliveryStatus: 'sending', unreadCount: 0, lastMessageAt: '2026-10-07T11:30:00Z' }),
    conversation(ids.resolved, '0108', { workflowStatus: 'resolved', unreadCount: 0, lastMessageAt: '2026-10-07T11:40:00Z' }),
  ];
}

function message(id, text = `mensaje ${id}`) {
  return {
    id: String(id), direction: 'inbound', type: 'text', text,
    deliveryStatus: 'received', messageAt: '2026-10-07T12:01:00Z',
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`timeout esperando ${label}`);
}

async function respondJson(request, { status = 200, body = {}, delayMs = 0 } = {}) {
  if (delayMs) await delay(delayMs);
  try {
    await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
  } catch (error) {
    if (!request.isInterceptResolutionHandled()) throw error;
  }
}

function endpoint(url) {
  const prefix = '/api/admin/whatsapp-cloud/conversations/';
  if (!url.pathname.startsWith(prefix)) return null;
  const segments = url.pathname.slice(prefix.length).split('/');
  if (segments.length !== 2) return null;
  const [conversationId, action] = segments;
  if (!['messages', 'read', 'state'].includes(action)) return null;
  return { conversationId: decodeURIComponent(conversationId), action };
}

async function withInbox(options, work) {
  const app = express();
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const requests = { lists: [], messages: [], reads: [], states: [], counts: { read: 0, state: 0 } };
  try {
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport(options.viewport || { width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setCookie({ name: 'pedivoy_session', value: 'browser-test-session', url: baseUrl, sameSite: 'Lax' });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      try {
        if (url.pathname === '/api/me') {
          await respondJson(request, { body: { user: options.user || { role: 'admin', empresa_id: 7 } } });
          return;
        }
        if (url.pathname === '/api/empresas') {
          await respondJson(request, { body: options.companies || [] });
          return;
        }
        if (url.pathname === '/api/admin/whatsapp-cloud/conversations') {
          const entry = { url: url.toString(), params: Object.fromEntries(url.searchParams.entries()) };
          requests.lists.push(entry);
          const response = options.listResponse
            ? await options.listResponse({ url, index: requests.lists.length - 1, requests })
            : { body: { conversations: operationalConversations(), counters, nextCursor: null } };
          await respondJson(request, response);
          return;
        }
        const target = endpoint(url);
        if (target?.action === 'messages') {
          const entry = { ...target, url: url.toString(), params: Object.fromEntries(url.searchParams.entries()) };
          requests.messages.push(entry);
          const response = options.messagesResponse
            ? await options.messagesResponse({ ...entry, index: requests.messages.length - 1, requests })
            : { body: { messages: [message(1)], nextCursor: null } };
          await respondJson(request, response);
          return;
        }
        if (target?.action === 'read') {
          const entry = {
            ...target,
            method: request.method(),
            headers: request.headers(),
            body: JSON.parse(request.postData() || '{}'),
            historyTextAtRequest: await page.$eval('#messageHistory', element => element.textContent),
          };
          requests.reads.push(entry);
          requests.counts.read += 1;
          const response = options.readResponse
            ? await options.readResponse({ ...entry, index: requests.reads.length - 1, requests })
            : { body: { conversationId: target.conversationId, lastReadMessageId: '1' } };
          await respondJson(request, response);
          return;
        }
        if (target?.action === 'state') {
          const entry = {
            ...target,
            method: request.method(),
            headers: request.headers(),
            body: JSON.parse(request.postData() || '{}'),
          };
          requests.states.push(entry);
          requests.counts.state += 1;
          const response = options.stateResponse
            ? await options.stateResponse({ ...entry, index: requests.states.length - 1, requests })
            : { body: { conversationId: target.conversationId, workflowStatus: 'pending', priority: 'normal', version: 5 } };
          await respondJson(request, response);
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          await respondJson(request, { status: 404, body: { error: 'not_found' } });
          return;
        }
        await request.continue();
      } catch (error) {
        if (!request.isInterceptResolutionHandled()) {
          await request.abort('failed').catch(() => {});
        }
        throw error;
      }
    });
    await page.goto(`${baseUrl}/pedidos/whatsapp-cloud.html`, { waitUntil: 'networkidle0' });
    await work({ page, requests, baseUrl });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function cardSnapshot(page) {
  return page.$$eval('.conversation-card', cards => cards.map(card => ({
    id: card.dataset.conversationId,
    text: card.textContent.replace(/\s+/g, ' ').trim(),
  })));
}

browserTest('Task 3 renderiza la cola operativa completa en orden con badges, unread y contadores', async () => {
  await withInbox({}, async ({ page, requests }) => {
    await page.waitForSelector('.conversation-card');
    const cards = await cardSnapshot(page);
    assert.deepEqual(cards.map(card => card.id), [
      ids.urgent, ids.high, ids.normal, ids.failed, ids.unknown, ids.queued, ids.sending, ids.resolved,
    ]);
    assert.match(cards[0].text, /Recibido.*Por responder.*Prioridad urgent.*3 sin leer/);
    assert.match(cards[1].text, /Recibido.*Por responder.*Prioridad high.*2 sin leer/);
    assert.match(cards[2].text, /Recibido.*Por responder.*Prioridad normal.*1 sin leer/);
    assert.match(cards[3].text, /Falló.*Revisar/);
    assert.match(cards[4].text, /Resultado incierto.*Revisar/);
    assert.match(cards[5].text, /En cola.*En proceso/);
    assert.match(cards[6].text, /Enviando.*En proceso/);
    assert.match(cards[7].text, /Recibido.*Respondida/);
    assert.deepEqual(await page.$$eval('#queueCounters .counter-chip', chips => chips.map(chip => chip.textContent)), [
      'Total: 8', 'Por responder: 3', 'En proceso: 2', 'Revisar: 2', 'Respondidas: 1',
    ]);
    assert.equal(requests.lists.length, 1);
  });
});

browserTest('Task 3 aplica filtros workflow, priority y unread sin mezclar respuestas stale', async () => {
  const stale = conversation(ids.normal, '0300');
  const current = conversation(ids.urgent, '0301', { priority: 'urgent', unreadCount: 5 });
  await withInbox({
    async listResponse({ url, index }) {
      if (index === 0) return { body: { conversations: operationalConversations(), counters, nextCursor: null } };
      if (url.searchParams.get('unread') === 'true') {
        return { body: { conversations: [current], counters, nextCursor: null } };
      }
      if (url.searchParams.get('priority') === 'urgent') {
        return { delayMs: 10, body: { conversations: [current], counters, nextCursor: null } };
      }
      return { delayMs: 180, body: { conversations: [stale], counters, nextCursor: null } };
    },
  }, async ({ page, requests }) => {
    await page.waitForSelector('.conversation-card');
    await page.select('#workflowFilter', 'pending');
    await waitFor(() => requests.lists.length === 2, 'GET workflow pending');
    await page.select('#priorityFilter', 'urgent');
    await page.waitForSelector(`.conversation-card[data-conversation-id="${ids.urgent}"]`);
    await delay(230);
    assert.deepEqual((await cardSnapshot(page)).map(card => card.id), [ids.urgent]);
    assert.deepEqual(requests.lists[1].params, { limit: '25', workflowStatus: 'pending' });
    assert.deepEqual(requests.lists[2].params, { limit: '25', workflowStatus: 'pending', priority: 'urgent' });

    await page.click('#unreadFilter');
    await waitFor(() => requests.lists.length === 4, 'GET unread true');
    await page.waitForFunction(id => document.querySelector('.conversation-card')?.dataset.conversationId === id, {}, ids.urgent);
    assert.deepEqual(requests.lists[3].params, {
      limit: '25', workflowStatus: 'pending', priority: 'urgent', unread: 'true',
    });
    assert.match((await cardSnapshot(page))[0].text, /5 sin leer/);
    assert.equal(await page.$eval('#workflowFilter', element => element.value), 'pending');
    assert.equal(await page.$eval('#priorityFilter', element => element.value), 'urgent');
    assert.equal(await page.$eval('#unreadFilter', element => element.checked), true);
  });
});

browserTest('Task 3 marca leído una vez después de render exitoso y nunca si falla history', async () => {
  const success = conversation(ids.urgent, '0401', { unreadCount: 2 });
  const failure = conversation(ids.failed, '0402', { unreadCount: 1 });
  await withInbox({
    listResponse: async () => ({ body: { conversations: [success, failure], counters: { ...counters, total: 2 }, nextCursor: null } }),
    messagesResponse: async ({ conversationId }) => conversationId === ids.urgent
      ? { body: { messages: [message(91, 'historial renderizado')], nextCursor: null } }
      : { status: 500, body: { error: 'cloud_inbox_unavailable' } },
  }, async ({ page, requests, baseUrl }) => {
    await page.waitForSelector(`.conversation-card[data-conversation-id="${ids.urgent}"]`);
    await page.click(`.conversation-card[data-conversation-id="${ids.urgent}"]`);
    await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('historial renderizado'));
    await waitFor(() => requests.reads.length === 1, 'POST read exitoso');
    await delay(80);
    assert.equal(requests.reads.length, 1);
    assert.equal(requests.counts.read, 1);
    const read = requests.reads[0];
    assert.equal(read.conversationId, ids.urgent);
    assert.equal(read.method, 'POST');
    assert.deepEqual(read.body, {});
    assert.equal(read.headers['content-type'], 'application/json');
    assert.equal(read.headers.origin, baseUrl);
    assert.match(read.headers.cookie, /pedivoy_session=browser-test-session/);
    assert.match(read.historyTextAtRequest, /historial renderizado/);

    await page.click(`.conversation-card[data-conversation-id="${ids.failed}"]`);
    await page.waitForFunction(() => document.querySelector('#appStatus')?.textContent.includes('No se pudo completar'));
    await delay(80);
    assert.equal(requests.messages.filter(entry => entry.conversationId === ids.failed).length, 1);
    assert.equal(requests.reads.filter(entry => entry.conversationId === ids.failed).length, 0);
  });
});

browserTest('Task 3 controles workflow y priority hacen un PATCH CAS por acción y preservan el borrador', async () => {
  const initial = conversation(ids.normal, '0501', { unreadCount: 0, version: 4 });
  await withInbox({
    listResponse: async () => ({ body: { conversations: [initial], counters: { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 }, nextCursor: null } }),
    stateResponse: async ({ body, index }) => index === 0
      ? { body: { conversationId: ids.normal, workflowStatus: 'pending', priority: body.priority, version: 5 } }
      : { body: { conversationId: ids.normal, workflowStatus: body.workflowStatus, priority: 'high', version: 6 } },
  }, async ({ page, requests }) => {
    await page.waitForSelector('.conversation-card');
    await page.click('.conversation-card');
    await page.waitForSelector('.message-text');
    await page.type('#messageInput', 'borrador que debe sobrevivir');

    await page.select('#conversationPriority', 'high');
    await waitFor(() => requests.states.length === 1, 'PATCH priority');
    await page.waitForFunction(() => document.querySelector('.conversation-card')?.textContent.includes('Prioridad high'));
    assert.deepEqual(requests.states[0].body, { priority: 'high', expectedVersion: 4 });
    assert.equal(requests.states[0].method, 'PATCH');
    assert.equal(await page.$eval('#messageInput', element => element.value), 'borrador que debe sobrevivir');

    await page.click('#conversationWorkflow');
    await waitFor(() => requests.states.length === 2, 'PATCH workflow');
    await page.waitForFunction(() => document.querySelector('.conversation-card')?.textContent.includes('Respondida'));
    assert.deepEqual(requests.states[1].body, { workflowStatus: 'resolved', expectedVersion: 5 });
    assert.equal(requests.states.length, 2, 'cada una de las dos acciones emite exactamente un PATCH');
    assert.equal(requests.counts.state, 2);
    assert.equal(await page.$eval('#conversationWorkflow', element => element.textContent), 'Reabrir conversación');
    assert.equal(await page.$eval('#messageInput', element => element.value), 'borrador que debe sobrevivir');
  });
});

browserTest('Task 3 409 fusiona sólo estado allowlisted, avisa y no reintenta', async () => {
  const initial = conversation(ids.high, '0601', { priority: 'high', unreadCount: 0, version: 7 });
  await withInbox({
    listResponse: async () => ({ body: { conversations: [initial], counters: { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 }, nextCursor: null } }),
    stateResponse: async () => ({
      status: 409,
      body: {
        error: 'stale_conversation_version',
        current: {
          conversationId: ids.high, workflowStatus: 'resolved', priority: 'urgent', version: 8,
          participant: '5493515559999', unreadCount: 99, customerName: 'PII NO PERMITIDA',
        },
      },
    }),
  }, async ({ page, requests }) => {
    await page.waitForSelector('.conversation-card');
    await page.click('.conversation-card');
    await page.waitForSelector('.message-text');
    await page.type('#messageInput', 'borrador local');
    await page.click('#conversationWorkflow');
    await waitFor(() => requests.states.length === 1, 'PATCH stale');
    await page.waitForFunction(() => document.querySelector('#appStatus')?.textContent.includes('otra sesión'));
    await delay(150);
    assert.equal(requests.states.length, 1);
    assert.equal(requests.counts.state, 1);
    assert.deepEqual(requests.states[0].body, { workflowStatus: 'resolved', expectedVersion: 7 });
    const card = (await cardSnapshot(page))[0];
    assert.match(card.text, /\*{9}0601/);
    assert.match(card.text, /Respondida/);
    assert.match(card.text, /Prioridad urgent/);
    assert.doesNotMatch(card.text, /5493515559999|PII NO PERMITIDA|99 sin leer/);
    assert.equal(await page.$eval('#messageInput', element => element.value), 'borrador local');
    assert.equal(await page.$eval('#appStatus', element => element.dataset.tone), 'warning');
  });
});

browserTest('Task 3 cerca PATCH y read tardíos de tenant A para que no muten tenant B', async () => {
  const tenantA = conversation(ids.urgent, '0701', { priority: 'urgent', unreadCount: 4, version: 3 });
  const tenantB = conversation(ids.tenantB, '0901', { priority: 'normal', unreadCount: 3, version: 11 });
  await withInbox({
    user: { role: 'super', empresa_id: null },
    companies: [{ id: 7, nombre: 'Tenant A' }, { id: 9, nombre: 'Tenant B' }],
    async listResponse({ url }) {
      const companyId = url.searchParams.get('empresa_id');
      return companyId === '7'
        ? { body: { conversations: [tenantA], counters: { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 }, nextCursor: null } }
        : { body: { conversations: [tenantB], counters: { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 }, nextCursor: null } };
    },
    readResponse: async ({ conversationId }) => ({
      delayMs: conversationId === ids.urgent ? 250 : 0,
      body: { conversationId, lastReadMessageId: '1' },
    }),
    stateResponse: async ({ conversationId }) => ({
      delayMs: conversationId === ids.urgent ? 250 : 0,
      body: { conversationId, workflowStatus: 'resolved', priority: 'urgent', version: 4 },
    }),
  }, async ({ page, requests }) => {
    await page.waitForSelector('#companySelect');
    await page.select('#companySelect', '7');
    await page.waitForSelector(`.conversation-card[data-conversation-id="${ids.urgent}"]`);
    await page.click(`.conversation-card[data-conversation-id="${ids.urgent}"]`);
    await page.waitForSelector('.message-text');
    await waitFor(() => requests.reads.length === 1, 'read tenant A');
    await page.click('#conversationWorkflow');
    await waitFor(() => requests.states.length === 1, 'PATCH tenant A');

    await page.select('#companySelect', '9');
    await page.waitForSelector(`.conversation-card[data-conversation-id="${ids.tenantB}"]`);
    await page.click(`.conversation-card[data-conversation-id="${ids.tenantB}"]`);
    await page.waitForSelector('.message-text');
    await waitFor(() => requests.reads.length === 2, 'read tenant B');
    await page.waitForFunction(() => !document.querySelector('.conversation-card')?.textContent.includes('sin leer'));
    await page.type('#messageInput', 'borrador exclusivo tenant B');
    const tenantBBeforeLateResponses = (await cardSnapshot(page))[0].text;
    await delay(320);

    const cards = await cardSnapshot(page);
    assert.deepEqual(cards.map(card => card.id), [ids.tenantB]);
    assert.equal(cards[0].text, tenantBBeforeLateResponses);
    assert.match(cards[0].text, /Prioridad normal/);
    assert.doesNotMatch(cards[0].text, /Respondida|Prioridad urgent/);
    assert.equal(await page.$eval('#chatTitle', element => element.textContent), '*********0901');
    assert.equal(await page.$eval('#messageInput', element => element.value), 'borrador exclusivo tenant B');
    assert.equal(await page.$eval('#companySelect', element => element.value), '9');
    assert.deepEqual(await page.$eval('#appStatus', element => ({ hidden: element.hidden, text: element.textContent })), { hidden: true, text: '' });
    assert.equal(requests.states.length, 1);
    assert.deepEqual(requests.counts, { read: 2, state: 1 });
    assert.equal(requests.states[0].conversationId, ids.urgent);
    assert.equal(requests.states[0].body.empresa_id, 7);
    assert.equal(requests.reads[0].conversationId, ids.urgent);
    assert.equal(requests.reads[0].body.empresa_id, 7);
  });
});
