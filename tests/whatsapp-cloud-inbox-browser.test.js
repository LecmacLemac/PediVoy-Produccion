import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = '/usr/bin/google-chrome';
const screenshotDir = process.env.TMPDIR || root;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function assertInsideViewport(box, viewport, label) {
  assert.ok(box.width > 0 && box.height > 0, `${label} debe tener tamaño positivo`);
  assert.ok(box.left >= 0 && box.top >= 0, `${label} debe comenzar dentro del viewport`);
  assert.ok(box.right <= viewport.width && box.bottom <= viewport.height, `${label} debe terminar dentro del viewport`);
}

function overlapArea(first, second) {
  const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  return width * height;
}

async function clickCurrent(page, selector) {
  const clicked = await page.evaluate(target => {
    const element = document.querySelector(target);
    if (!(element instanceof HTMLElement) || element.matches(':disabled') || element.inert) return false;
    element.click();
    return true;
  }, selector);
  assert.equal(clicked, true, `${selector} debe existir y aceptar interacción`);
}

async function openConversationAndWait(page, conversationId = '44') {
  const selector = `.conversation-card[data-conversation-id="${conversationId}"]`;
  await page.waitForFunction(target => {
    const element = document.querySelector(target);
    return element instanceof HTMLElement && !element.matches(':disabled') && !element.inert;
  }, {}, selector);
  await clickCurrent(page, selector);
  await page.waitForFunction(id => {
    const active = document.querySelector(`.conversation-card[data-conversation-id="${id}"]`);
    const input = document.querySelector('#messageInput');
    const history = document.querySelector('#messageHistory');
    const context = document.querySelector('#conversationContext');
    const toggle = document.querySelector('#contextToggle');
    return active?.getAttribute('aria-current') === 'true'
      && input?.disabled === false
      && Boolean(history?.querySelector('.message'))
      && !context?.querySelector('.skeleton')
      && Boolean(context?.querySelector('strong'))
      && toggle instanceof HTMLElement
      && !toggle.matches(':disabled')
      && !toggle.inert;
  }, {}, String(conversationId));
}

async function openOverlayAndWait(page, triggerSelector, panelSelector) {
  await page.waitForFunction(target => {
    const trigger = document.querySelector(target);
    return trigger instanceof HTMLElement
      && !trigger.matches(':disabled')
      && !trigger.inert
      && trigger.getClientRects().length > 0
      && document.querySelector('#inboxLayout')?.dataset.overlayOpen !== 'true';
  }, {}, triggerSelector);
  const opened = await page.evaluate(({ triggerSelector: triggerTarget, panelSelector: panelTarget }) => {
    const trigger = document.querySelector(triggerTarget);
    const panel = document.querySelector(panelTarget);
    if (!(trigger instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
    trigger.click();
    return {
      panelOpen: panel.dataset.open,
      expanded: trigger.getAttribute('aria-expanded'),
      overlayOpen: document.querySelector('#inboxLayout')?.dataset.overlayOpen,
      backdropHidden: document.querySelector('#overlayBackdrop')?.getAttribute('aria-hidden'),
    };
  }, { triggerSelector, panelSelector });
  assert.deepEqual(opened, {
    panelOpen: 'true', expanded: 'true', overlayOpen: 'true', backdropHidden: 'false',
  });
  await page.waitForFunction(target => {
    const panel = document.querySelector(target);
    return panel?.dataset.open === 'true'
      && panel.getAttribute('role') === 'dialog'
      && panel.getAttribute('aria-modal') === 'true'
      && panel.contains(document.activeElement);
  }, {}, panelSelector);
}

async function measureState(page, selectors) {
  return page.evaluate(targets => {
    const boxes = Object.fromEntries(Object.entries(targets).map(([name, selector]) => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [name, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      }];
    }));
    return {
      boxes,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  }, selectors);
}

function assertVisibleLayout(measured, { touch = [], nonOverlapping = [] } = {}) {
  const viewport = { width: measured.viewportWidth, height: measured.viewportHeight };
  assert.ok(measured.scrollWidth <= measured.viewportWidth, 'documento no debe desbordar horizontalmente');
  assert.ok(measured.scrollHeight <= measured.viewportHeight, 'documento no debe superar el alto del viewport');
  for (const [label, box] of Object.entries(measured.boxes)) {
    assert.equal(box.visible, true, `${label} debe estar visible`);
    assertInsideViewport(box, viewport, label);
    assert.ok(box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight, `${label} no debe recortarse`);
  }
  for (const label of touch) {
    const box = measured.boxes[label];
    assert.ok(box.width >= 44 && box.height >= 44, `${label} debe medir al menos 44x44`);
  }
  for (const [firstLabel, secondLabel] of nonOverlapping) {
    assert.equal(overlapArea(measured.boxes[firstLabel], measured.boxes[secondLabel]), 0, `${firstLabel} y ${secondLabel} no deben superponerse`);
  }
}

async function withBrowserPage(viewport, work, {
  replyResponse = null,
  replyDelayMs = 0,
  sendTimeoutMs = 30,
  refreshDelayMs = 8_000,
  messagesResponse = null,
  conversationsResponse = null,
  searchResponse = null,
  contextResponse = null,
  simulatedVisualViewport = null,
  userResponse = { user: { role: 'admin', empresa_id: 7 } },
  companiesResponse = [{ id: 1, nombre: 'Empresa A' }, { id: 2, nombre: 'Empresa B' }],
  waitForConversation = true,
} = {}) {
  const app = express();
  app.post('/api/admin/whatsapp-cloud/conversations/:id/replies', req => {
    req.on('close', () => {});
  });
  app.get('/pedidos/whatsapp-cloud.js', async (_req, res) => {
    const controller = await readFile(path.join(root, 'pedidos/whatsapp-cloud.js'), 'utf8');
    res.type('text/javascript').send(controller
      .replace('const SEND_TIMEOUT_MS = 25_000;', `const SEND_TIMEOUT_MS = ${sendTimeoutMs};`)
      .replace('baseDelayMs: 8_000,', `baseDelayMs: ${refreshDelayMs},`));
  });
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.evaluateOnNewDocument(initialVisualViewport => {
      const nativeRandomUUID = crypto.randomUUID.bind(crypto);
      window.__uuidCalls = 0;
      crypto.randomUUID = () => {
        window.__uuidCalls += 1;
        return nativeRandomUUID();
      };
      if (initialVisualViewport) {
        const listeners = new Map();
        const viewportState = { ...initialVisualViewport };
        const fakeVisualViewport = {
          get width() { return viewportState.width; },
          get height() { return viewportState.height; },
          get offsetTop() { return viewportState.offsetTop || 0; },
          get offsetLeft() { return 0; },
          get pageTop() { return viewportState.offsetTop || 0; },
          get pageLeft() { return 0; },
          get scale() { return 1; },
          addEventListener(type, listener) {
            const registered = listeners.get(type) || new Set();
            registered.add(listener);
            listeners.set(type, registered);
          },
          removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        };
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: fakeVisualViewport });
        window.__setVisualViewport = next => {
          Object.assign(viewportState, next);
          for (const type of ['resize', 'scroll']) {
            for (const listener of listeners.get(type) || []) listener(new Event(type));
          }
        };
      }
    }, simulatedVisualViewport);
    await page.setRequestInterception(true);
    const counts = {
      conversations: 0, messages: 0, contexts: 0, replies: 0, replyKeys: [], apiRequests: [],
      activeConversations: 0, activeMessages: 0, maxActiveConversations: 0, maxActiveMessages: 0,
    };
    page.on('request', async request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) counts.apiRequests.push({ path: url.pathname, method: request.method(), query: url.search });
      if (url.pathname === '/api/me') {
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(userResponse) });
      } else if (url.pathname === '/api/empresas') {
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(companiesResponse) });
      } else if (url.pathname === '/api/admin/whatsapp-cloud/conversations') {
        counts.conversations += 1;
        counts.activeConversations += 1;
        counts.maxActiveConversations = Math.max(counts.maxActiveConversations, counts.activeConversations);
        const fallback = { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null };
        const result = conversationsResponse
          ? await conversationsResponse({ index: counts.conversations - 1, counts, url, request })
          : fallback;
        const status = result?.status || 200;
        const body = Object.hasOwn(result || {}, 'body') ? result.body : result;
        if (!request.isInterceptResolutionHandled()) {
          await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        }
        counts.activeConversations -= 1;
      } else if (url.pathname === '/api/admin/whatsapp-cloud/conversations/search') {
        const result = searchResponse
          ? await searchResponse({ counts, url, request })
          : { conversations: [], nextCursor: null };
        const status = result?.status || 200;
        const body = Object.hasOwn(result || {}, 'body') ? result.body : result;
        await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/read/.test(url.pathname)) {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversationId: url.pathname.split('/').at(-2), lastReadMessageId: '1' }) });
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/messages/.test(url.pathname)) {
        counts.messages += 1;
        counts.activeMessages += 1;
        counts.maxActiveMessages = Math.max(counts.maxActiveMessages, counts.activeMessages);
        const result = messagesResponse
          ? await messagesResponse({ index: counts.messages - 1, counts, url, request })
          : { messages: [
              { id: '1', direction: 'inbound', type: 'text', text: 'hola', deliveryStatus: 'received', messageAt: '2026-10-06T12:00:00Z' },
            ], nextCursor: null };
        const status = result?.status || 200;
        const body = Object.hasOwn(result || {}, 'body') ? result.body : result;
        if (!request.isInterceptResolutionHandled()) {
          await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        }
        counts.activeMessages -= 1;
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/context/.test(url.pathname)) {
        counts.contexts += 1;
        const result = contextResponse
          ? await contextResponse({ index: counts.contexts - 1, counts, url, request })
          : { matchStatus: 'none', customer: null, orders: [] };
        const status = result?.status || 200;
        const body = Object.hasOwn(result || {}, 'body') ? result.body : result;
        if (!request.isInterceptResolutionHandled()) {
          await request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        }
      } else if (url.pathname === '/api/admin/whatsapp-cloud/quick-replies') {
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ quickReplies: [] }) });
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/replies/.test(url.pathname)) {
        counts.replies += 1;
        try {
          counts.replyKeys.push(JSON.parse(request.postData() || '{}').idempotency_key ?? null);
        } catch {
          counts.replyKeys.push(null);
        }
        if (replyResponse) {
          setTimeout(() => request.respond({
            status: replyResponse.status,
            contentType: 'application/json',
            body: JSON.stringify(replyResponse.body),
          }), replyDelayMs);
        } else {
          request.continue();
        }
      } else if (url.pathname.startsWith('/api/')) {
        request.respond({ status: 404, contentType: 'application/json', body: '{}' });
      } else {
        request.continue();
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/pedidos/whatsapp-cloud.html`, {
      waitUntil: refreshDelayMs < 1_000 ? 'domcontentloaded' : 'networkidle0',
    });
    if (waitForConversation) await page.waitForSelector('.conversation-card');
    await work({ page, counts });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('browser móvil mantiene composer visible, foco reversible, timeout incierto y resume visible', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage({ width: 390, height: 844, deviceScaleFactor: 1 }, async ({ page, counts }) => {
    const listLayout = await measureState(page, {
      title: '.brand span', dashboard: '.cloud-nav a[href="dashboard.html"]',
      whatsappCloud: '.cloud-nav a[aria-current="page"]', qr: '.cloud-nav a[href="qr.html"]', salir: '#logout',
      listHeading: '#conversationHeading', refresh: '#refreshConversations', firstConversation: '.conversation-card[data-conversation-id="44"]',
    });
    assertVisibleLayout(listLayout, {
      touch: ['dashboard', 'whatsappCloud', 'qr', 'salir', 'refresh', 'firstConversation'],
      nonOverlapping: [['title', 'dashboard'], ['listHeading', 'refresh']],
    });
    assert.deepEqual(await page.evaluate(() => ({
      chatDisplay: getComputedStyle(document.querySelector('#chatPanel')).display,
      appStatusHidden: document.querySelector('#appStatus').hidden,
    })), { chatDisplay: 'none', appStatusHidden: true });
    console.log('MOBILE_LIST_LAYOUT', JSON.stringify(listLayout));
    await page.screenshot({ path: path.join(screenshotDir, 'whatsapp-cloud-mobile-list-390x844.png') });

    await page.click('.conversation-card[data-conversation-id="44"]');
    await page.waitForSelector('#inboxLayout.mobile-detail');
    await page.waitForFunction(() => document.activeElement?.id === 'backToList');
    await page.waitForFunction(() => document.querySelector('#appStatus').hidden === true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backToList');

    const detailLayout = await measureState(page, {
      title: '.brand span', dashboard: '.cloud-nav a[href="dashboard.html"]',
      whatsappCloud: '.cloud-nav a[aria-current="page"]', qr: '.cloud-nav a[href="qr.html"]', salir: '#logout',
      back: '#backToList', chatHeading: '#chatTitle', composer: '#composerForm', messageInput: '#messageInput', send: '#sendButton',
      status: '#composerNotice',
    });
    assertVisibleLayout(detailLayout, {
      touch: ['dashboard', 'whatsappCloud', 'qr', 'salir', 'back', 'messageInput', 'send'],
      nonOverlapping: [['title', 'dashboard'], ['back', 'chatHeading'], ['messageInput', 'send']],
    });
    assert.deepEqual(await page.evaluate(() => ({
      conversationDisplay: getComputedStyle(document.querySelector('.conversation-pane')).display,
      appStatusHidden: document.querySelector('#appStatus').hidden,
    })), { conversationDisplay: 'none', appStatusHidden: true });
    console.log('MOBILE_DETAIL_LAYOUT', JSON.stringify(detailLayout));
    await page.screenshot({ path: path.join(screenshotDir, 'whatsapp-cloud-mobile-detail-390x844.png') });

    await page.click('#backToList');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.conversationId), '44');
    await page.click('.conversation-card[data-conversation-id="44"]');
    await page.waitForFunction(() => document.activeElement?.id === 'backToList');
    await page.click('#messageInput');
    await page.type('#messageInput', 'mensaje que puede haber salido');
    await page.click('#sendButton');
    await page.waitForFunction(() => document.querySelector('#composerNotice').textContent.includes('Resultado incierto'), { timeout: 1_000 });
    const uncertain = await page.evaluate(() => ({
      inputDisabled: document.querySelector('#messageInput').disabled,
      sendDisabled: document.querySelector('#sendButton').disabled,
      newMessageHidden: document.querySelector('#startNewMessage').hidden,
      uuidCalls: window.__uuidCalls,
    }));
    assert.deepEqual(uncertain, { inputDisabled: true, sendDisabled: true, newMessageHidden: false, uuidCalls: 1 });
    await page.evaluate(() => document.querySelector('#composerForm').requestSubmit());
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(counts.replies, 1);
    assert.equal(await page.evaluate(() => window.__uuidCalls), 1);

    const before = { ...counts };
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(counts.conversations > before.conversations);
    assert.equal(counts.messages, before.messages, 'un resultado incierto pausa el refresh de historial');
    assert.deepEqual(await page.evaluate(() => ({
      inputDisabled: document.querySelector('#messageInput').disabled,
      sendDisabled: document.querySelector('#sendButton').disabled,
      uncertainDraft: document.querySelector('#messageInput').value,
    })), {
      inputDisabled: true,
      sendDisabled: true,
      uncertainDraft: 'mensaje que puede haber salido',
    });

    page.once('dialog', dialog => dialog.accept());
    await page.click('#startNewMessage');
    assert.deepEqual(await page.evaluate(() => ({
      value: document.querySelector('#messageInput').value,
      disabled: document.querySelector('#messageInput').disabled,
      active: document.activeElement?.id,
    })), { value: '', disabled: false, active: 'messageInput' });

  });
});

test('browser conecta doble submit sincronizado a una sola key, un POST y un settle aceptado', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage(
    { width: 1440, height: 900, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.type('#messageInput', 'respuesta única');
      await page.evaluate(() => {
        const form = document.querySelector('#composerForm');
        form.requestSubmit();
        form.requestSubmit();
      });

      await page.waitForFunction(() => (
        document.querySelector('#messageInput').value === ''
        && document.querySelector('#composerNotice').textContent.includes('Mensaje en cola')
        && document.querySelector('#sendButton').disabled === false
      ), { timeout: 2_000 });

      assert.equal(counts.replies, 1);
      assert.equal(counts.replyKeys.length, 1);
      assert.match(counts.replyKeys[0], /^[0-9a-f-]{36}$/i);
      assert.equal(await page.evaluate(() => window.__uuidCalls), 1);
      assert.deepEqual(await page.evaluate(() => ({
        draft: document.querySelector('#messageInput').value,
        notice: document.querySelector('#composerNotice').textContent,
        sendDisabled: document.querySelector('#sendButton').disabled,
      })), {
        draft: '',
        notice: 'Mensaje en cola. No se reenviará automáticamente.',
        sendDisabled: false,
      });
    },
    {
      replyDelayMs: 40,
      sendTimeoutMs: 1_000,
      replyResponse: {
        status: 202,
        body: { accepted: true, deduplicated: false, id: '501', status: 'accepted' },
      },
    },
  );
});

test('Task 6 browser pausa history durante submission y outcome_unknown sin POST automático', { skip: !existsSync(chromePath) }, async () => {
  const firstListCycle = deferred();
  const secondListCycle = deferred();
  let liveListCalls = 0;
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola'));
      await page.type('#messageInput', 'envío en curso');
      const historyBefore = counts.messages;
      await page.click('#sendButton');
      await page.waitForFunction(() => document.querySelector('#sendButton').disabled === true);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await firstListCycle.promise;
      assert.equal(counts.replies, 1);
      assert.equal(counts.messages, historyBefore, 'history GET se pausa mientras el POST está en vuelo');
      await page.waitForFunction(() => document.querySelector('#composerNotice').textContent.includes('Resultado incierto'), { timeout: 2_000 });
      await secondListCycle.promise;
      assert.equal(counts.replies, 1, 'outcome_unknown nunca dispara reenvío automático');
      assert.equal(counts.messages, historyBefore, 'outcome_unknown mantiene history GET pausado');
      const replyRequests = counts.apiRequests.filter(entry => entry.path.endsWith('/replies'));
      assert.deepEqual(replyRequests.map(entry => entry.method), ['POST']);
    },
    {
      refreshDelayMs: 40,
      sendTimeoutMs: 80,
      replyDelayMs: 300,
      replyResponse: { status: 202, body: { accepted: true, id: '501', status: 'accepted' } },
      conversationsResponse: ({ index }) => {
        if (index > 0) {
          liveListCalls += 1;
          if (liveListCalls === 1) firstListCycle.resolve();
          if (liveListCalls === 2) secondListCycle.resolve();
        }
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null };
      },
      messagesResponse: () => ({ messages: [
        { id: '1', direction: 'outbound', type: 'text', text: 'hola', deliveryStatus: 'sent', messageAt: '2026-10-06T12:00:00Z' },
      ], nextCursor: null }),
    },
  );
});

test('Task 6 browser auto-refresh visible emite sólo GET y preserva borrador y foco', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola'));
      await page.click('#messageInput');
      await page.type('#messageInput', 'borrador preservado');
      await page.evaluate(() => { document.querySelector('#messageHistory .message').dataset.identity = 'stable'; });
      await page.waitForFunction(() => document.querySelector('#messageInput').value === 'borrador preservado');
      const baseline = counts.apiRequests.length;
      const listBefore = counts.conversations;
      const historyBefore = counts.messages;
      await new Promise(resolve => setTimeout(resolve, 140));
      assert.ok(counts.conversations > listBefore);
      assert.ok(counts.messages > historyBefore);
      await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'updated');
      const automatic = counts.apiRequests.slice(baseline);
      assert.ok(automatic.length >= 2);
      assert.deepEqual([...new Set(automatic.map(entry => entry.method))], ['GET']);
      assert.equal(automatic.some(entry => /read|replies|search|state|quick-replies/.test(entry.path)), false);
      const preserved = await page.evaluate(() => ({
        draft: document.querySelector('#messageInput').value,
        focus: document.activeElement?.id,
        sync: document.querySelector('#syncStatus').dataset.state,
        historyIdentity: document.querySelector('#messageHistory .message')?.dataset.identity || '',
      }));
      assert.deepEqual({ ...preserved, sync: undefined }, {
        draft: 'borrador preservado', focus: 'messageInput', sync: undefined, historyIdentity: 'stable',
      });
      assert.ok(['updating', 'updated'].includes(preserved.sync));
    },
    { refreshDelayMs: 40, sendTimeoutMs: 1_000 },
  );
});

test('Task 6 browser 401 redirige y corta todo tráfico automático posterior', { skip: !existsSync(chromePath) }, async () => {
  let unauthorized = false;
  const unauthorizedSeen = deferred();
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola'));
      unauthorized = true;
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await unauthorizedSeen.promise;
      await new Promise(resolve => setTimeout(resolve, 80));
      const stoppedAt = counts.apiRequests.filter(entry => entry.path.startsWith('/api/admin/whatsapp-cloud')).length;
      await new Promise(resolve => setTimeout(resolve, 180));
      const cloudTraffic = counts.apiRequests.filter(entry => entry.path.startsWith('/api/admin/whatsapp-cloud'));
      assert.equal(cloudTraffic.length, stoppedAt, JSON.stringify(cloudTraffic.slice(stoppedAt)));
    },
    {
      refreshDelayMs: 40,
      conversationsResponse: () => {
        if (unauthorized) {
          unauthorizedSeen.resolve();
          return { status: 401, body: { error: 'session_expired' } };
        }
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null };
      },
      messagesResponse: () => ({ messages: [
        { id: '1', direction: 'outbound', type: 'text', text: 'hola', deliveryStatus: 'sent', messageAt: '2026-10-06T12:00:00Z' },
      ], nextCursor: null }),
    },
  );
});

test('Task 6 browser 403 detiene scheduler y error transitorio conserva DOM con stale/backoff', { skip: !existsSync(chromePath) }, async () => {
  let mode = 'initial';
  const forbiddenSeen = deferred();
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola'));
      await page.type('#messageInput', 'borrador admin');
      await page.evaluate(() => {
        const indicator = document.querySelector('#newMessagesIndicator');
        indicator.hidden = false;
        indicator.textContent = '2 mensajes nuevos';
      });
      mode = 'forbidden';
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await forbiddenSeen.promise;
      await page.waitForFunction(() => document.querySelector('#appStatus').textContent.includes('No tenés acceso'), { polling: 5, timeout: 1_000 });
      const stoppedAt = { conversations: counts.conversations, messages: counts.messages };
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.deepEqual({ conversations: counts.conversations, messages: counts.messages }, stoppedAt);
      assert.deepEqual(await page.evaluate(() => ({
        ids: [...document.querySelectorAll('.conversation-card')].map(item => item.dataset.conversationId),
        history: document.querySelector('#messageHistory').textContent,
        title: document.querySelector('#chatTitle').textContent,
        context: document.querySelector('#conversationContext').textContent,
        quickReplies: document.querySelector('#quickReplyList').textContent,
        draft: document.querySelector('#messageInput').value,
        newMessages: document.querySelector('#newMessagesIndicator').textContent,
        newMessagesHidden: document.querySelector('#newMessagesIndicator').hidden,
        composerBlocked: document.querySelector('#messageInput').disabled && document.querySelector('#sendButton').disabled,
        unauthorized: document.querySelector('#appStatus').textContent,
      })), {
        ids: [], history: '', title: 'Acceso no autorizado', context: '', quickReplies: '', draft: '',
        newMessages: '', newMessagesHidden: true,
        composerBlocked: true, unauthorized: 'No tenés acceso a esta bandeja.',
      });
    },
    {
      refreshDelayMs: 40,
      conversationsResponse: () => {
        if (mode === 'forbidden') {
          forbiddenSeen.resolve();
          return { status: 403, body: { error: 'forbidden' } };
        }
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null };
      },
      messagesResponse: () => ({ messages: [
        { id: '1', direction: 'outbound', type: 'text', text: 'hola', deliveryStatus: 'sent', messageAt: '2026-10-06T12:00:00Z' },
      ], nextCursor: null }),
    },
  );

  const failureSeen = deferred();
  const recoverySeen = deferred();
  const requestTimes = [];
  let transientCalls = 0;
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page }) => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola'));
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await failureSeen.promise;
      await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'stale', { polling: 5, timeout: 1_000 });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.conversation-card').length), 2);
      await recoverySeen.promise;
      await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'updated');
      assert.ok(requestTimes[1] - requestTimes[0] >= 60, `backoff real insuficiente: ${requestTimes[1] - requestTimes[0]}ms`);
      assert.equal(await page.evaluate(() => document.querySelector('#messageHistory').textContent.includes('hola')), true);
    },
    {
      refreshDelayMs: 40,
      conversationsResponse: ({ index }) => {
        if (index === 0) return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null };
        requestTimes.push(Date.now());
        transientCalls += 1;
        if (transientCalls === 1) {
          failureSeen.resolve();
          return { status: 503, body: { error: 'temporary' } };
        }
        recoverySeen.resolve();
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null };
      },
      messagesResponse: () => ({ messages: [
        { id: '1', direction: 'outbound', type: 'text', text: 'hola', deliveryStatus: 'sent', messageAt: '2026-10-06T12:00:00Z' },
      ], nextCursor: null }),
    },
  );
});

test('Task 6 browser super revocado borra selector, tenant y toda metadata sensible sin tráfico posterior', { skip: !existsSync(chromePath) }, async () => {
  let mode = 'initial';
  const forbiddenSeen = deferred();
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.waitForSelector('#companySelect');
      assert.match(await page.evaluate(() => document.querySelector('#companyPicker').textContent), /Empresa Alfa.*Empresa Beta/s);
      await page.select('#companySelect', '1');
      await page.waitForSelector('.conversation-card[data-conversation-id="44"]');
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola sensible'));
      await page.type('#messageInput', 'borrador sensible');
      await page.evaluate(() => {
        const indicator = document.querySelector('#newMessagesIndicator');
        indicator.hidden = false;
        indicator.textContent = '3 mensajes nuevos';
      });
      mode = 'forbidden';
      await page.click('#refreshConversations');
      await forbiddenSeen.promise;
      await page.waitForFunction(() => document.querySelector('#appStatus').textContent.includes('No tenés acceso'));
      const stoppedAt = counts.apiRequests.filter(entry => entry.path.startsWith('/api/admin/whatsapp-cloud')).length;
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(counts.apiRequests.filter(entry => entry.path.startsWith('/api/admin/whatsapp-cloud')).length, stoppedAt);
      const revoked = await page.evaluate(() => ({
        body: document.body.textContent,
        companyHtml: document.querySelector('#companyPicker').innerHTML,
        options: [...document.querySelectorAll('#companyPicker option')].map(option => option.textContent),
        history: document.querySelector('#messageHistory').textContent,
        context: document.querySelector('#conversationContext').textContent,
        quickReplies: document.querySelector('#quickReplyList').textContent,
        draft: document.querySelector('#messageInput').value,
        newMessages: document.querySelector('#newMessagesIndicator').textContent,
        newMessagesHidden: document.querySelector('#newMessagesIndicator').hidden,
        composerBlocked: document.querySelector('#messageInput').disabled && document.querySelector('#sendButton').disabled,
      }));
      assert.doesNotMatch(revoked.body, /Empresa Alfa|Empresa Beta|hola sensible|borrador sensible/);
      assert.deepEqual(revoked.options, []);
      assert.equal(revoked.companyHtml, '');
      assert.equal(revoked.history, '');
      assert.equal(revoked.context, '');
      assert.equal(revoked.quickReplies, '');
      assert.equal(revoked.draft, '');
      assert.equal(revoked.newMessages, '');
      assert.equal(revoked.newMessagesHidden, true);
      assert.equal(revoked.composerBlocked, true);
    },
    {
      userResponse: { user: { role: 'super' } },
      companiesResponse: [{ id: 1, nombre: 'Empresa Alfa' }, { id: 2, nombre: 'Empresa Beta' }],
      waitForConversation: false,
      refreshDelayMs: 10_000,
      conversationsResponse: () => {
        if (mode === 'forbidden') {
          forbiddenSeen.resolve();
          return { status: 403, body: { error: 'actor_forbidden' } };
        }
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-08T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
        ], nextCursor: null };
      },
      messagesResponse: () => ({ messages: [
        { id: '1', direction: 'inbound', type: 'text', text: 'hola sensible', deliveryStatus: 'received', messageAt: '2026-10-08T12:00:00Z' },
      ], nextCursor: null }),
    },
  );
});

test('Task 6 browser mergea lista e historial reales sin perder páginas, activo, borradores ni cursores', { skip: !existsSync(chromePath) }, async () => {
  const liveListSeen = deferred();
  const liveHistorySeen = deferred();
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page }) => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.click('#loadMoreConversations');
      await page.waitForSelector('.conversation-card[data-conversation-id="40"]');
      await page.click('.conversation-card[data-conversation-id="40"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('actual-1'));
      await page.click('#loadOlderMessages');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('antiguo-0'));
      await page.type('#messageInput', 'borrador intacto');
      await page.type('#conversationSearch', 'busqueda sin enviar');

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await Promise.all([liveListSeen.promise, liveHistorySeen.promise]);
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('nuevo-3'));

      const state = await page.evaluate(() => ({
        ids: [...document.querySelectorAll('.conversation-card')].map(item => item.dataset.conversationId),
        active: document.querySelector('.conversation-card.active')?.dataset.conversationId,
        draft: document.querySelector('#messageInput').value,
        searchDraft: document.querySelector('#conversationSearch').value,
        moreConversations: !document.querySelector('#loadMoreConversations').hidden,
        moreHistory: !document.querySelector('#loadOlderMessages').hidden,
        messageIds: [...document.querySelectorAll('#messageHistory .message')].map(item => item.dataset.messageId),
        firstStatus: [...document.querySelectorAll('#messageHistory .message')]
          .find(item => item.dataset.messageId === '1')?.querySelector('.status-badge')?.textContent,
      }));
      assert.deepEqual(state.ids.sort(), ['40', '44', '45', '46']);
      assert.equal(new Set(state.ids).size, state.ids.length);
      assert.equal(state.active, '40');
      assert.equal(state.draft, 'borrador intacto');
      assert.equal(state.searchDraft, 'busqueda sin enviar');
      assert.equal(state.moreConversations, true);
      assert.equal(state.moreHistory, true);
      assert.deepEqual(state.messageIds, ['0', '1', '2', '3']);
      assert.equal(state.firstStatus, 'Leído', 'el estado read no retrocede a failed tardío');
    },
    {
      refreshDelayMs: 10_000,
      conversationsResponse: ({ index, url }) => {
        if (url.searchParams.has('cursor')) return { conversations: [
          { conversationId: '40', participant: '*********0040', lastMessageAt: '2026-10-06T08:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: 'conv-cursor-2' };
        if (index > 1) {
          liveListSeen.resolve();
          return { conversations: [
            { conversationId: '46', participant: '*********0046', lastMessageAt: '2026-10-08T13:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
            { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-08T12:30:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
            { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-08T12:30:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          ], nextCursor: null };
        }
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: 'conv-cursor' };
      },
      messagesResponse: ({ index, url }) => {
        if (url.searchParams.has('cursor')) return { messages: [
          { id: '0', direction: 'outbound', type: 'text', text: 'antiguo-0', deliveryStatus: 'sent', messageAt: '2026-10-06T09:00:00Z' },
        ], nextCursor: 'history-cursor' };
        if (index > 1) {
          liveHistorySeen.resolve();
          return { messages: [
            { id: '1', direction: 'outbound', type: 'text', text: 'actual-1 stale', deliveryStatus: 'failed', messageAt: '2026-10-06T10:00:00Z' },
            { id: '3', direction: 'inbound', type: 'text', text: 'nuevo-3', deliveryStatus: 'received', messageAt: '2026-10-06T12:00:00Z' },
            { id: '3', direction: 'inbound', type: 'text', text: 'nuevo-3', deliveryStatus: 'received', messageAt: '2026-10-06T12:00:00Z' },
          ], nextCursor: null };
        }
        return { messages: [
          { id: '1', direction: 'outbound', type: 'text', text: 'actual-1', deliveryStatus: 'read', messageAt: '2026-10-06T10:00:00Z' },
          { id: '2', direction: 'outbound', type: 'text', text: 'actual-2', deliveryStatus: 'sent', messageAt: '2026-10-06T11:00:00Z' },
        ], nextCursor: 'history-cursor' };
      },
    },
  );
});

test('Task 6 browser reconcilia búsqueda activa sin POST automático y clear conserva canónico nuevo', { skip: !existsSync(chromePath) }, async () => {
  const a = '4ad1a4a8-8877-4dc6-a7a0-e81b87f8e2a1';
  const b = '6be6f351-3535-48d1-b1a1-cde16f27a9b3';
  const c = '97db6aed-a667-47d7-8bc7-3bca34228d49';
  const refreshed = deferred();
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.type('#conversationSearch', 'cliente');
      await page.click('#conversationSearchSubmit');
      await page.waitForFunction(() => document.querySelectorAll('.conversation-card').length === 3);
      const searchPostsBefore = counts.apiRequests.filter(entry => entry.path.endsWith('/search')).length;
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await refreshed.promise;
      await page.waitForFunction(id => !document.querySelector(`.conversation-card[data-conversation-id="${id}"]`), {}, c);
      assert.deepEqual(await page.evaluate(ids => ({
        aPriority: document.querySelector(`.conversation-card[data-conversation-id="${ids.a}"]`)?.textContent.includes('Prioridad urgent'),
        bStale: document.querySelector(`.conversation-card[data-conversation-id="${ids.b}"]`)?.dataset.searchStale,
      }), { a, b }), { aPriority: true, bStale: 'true' });
      assert.equal(counts.apiRequests.filter(entry => entry.path.endsWith('/search')).length, searchPostsBefore);
      await page.click('#conversationSearchClear');
      assert.equal(await page.evaluate(id => (
        document.querySelector(`.conversation-card[data-conversation-id="${id}"]`)?.textContent.includes('Prioridad urgent')
      ), a), true);
    },
    {
      refreshDelayMs: 10_000,
      conversationsResponse: ({ index }) => {
        if (index > 0) {
          refreshed.resolve();
          return { conversations: [
            { conversationId: a, participant: '*********0001', priority: 'urgent', workflowStatus: 'resolved', version: 4, unreadCount: 0, lastMessageAt: '2026-10-08T12:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'read', lastMessageId: '40' },
          ], nextCursor: null, authoritativeRemovedIds: [c] };
        }
        return { conversations: [
          { conversationId: a, participant: '*********0001', priority: 'normal', workflowStatus: 'pending', version: 1, unreadCount: 1, lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received', lastMessageId: '10' },
          { conversationId: b, participant: '*********0002', priority: 'high', workflowStatus: 'pending', version: 1, unreadCount: 2, lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received', lastMessageId: '9' },
        ], nextCursor: null };
      },
      searchResponse: () => ({ conversations: [
        { conversationId: a, participant: '*********0001', priority: 'normal', workflowStatus: 'pending', version: 1, unreadCount: 1, lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received', lastMessageId: '10' },
        { conversationId: b, participant: '*********0002', priority: 'high', workflowStatus: 'pending', version: 1, unreadCount: 2, lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received', lastMessageId: '9' },
        { conversationId: c, participant: '*********0003', priority: 'normal', workflowStatus: 'pending', version: 1, unreadCount: 1, lastMessageAt: '2026-10-06T10:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received', lastMessageId: '8' },
      ], nextCursor: null }),
    },
  );
});

test('Task 6 browser descarta GET demorados al cambiar tenant y conversación', { skip: !existsSync(chromePath) }, async () => {
  const releaseOldList = deferred();
  const releaseOldHistory = deferred();
  const oldListStarted = deferred();
  const oldHistoryStarted = deferred();
  let delayOld = false;
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.select('#companySelect', '1');
      await page.waitForSelector('.conversation-card[data-conversation-id="44"]');
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('tenant-A inicial'));
      delayOld = true;
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await Promise.all([oldListStarted.promise, oldHistoryStarted.promise]);

      await page.select('#companySelect', '2');
      releaseOldList.resolve();
      releaseOldHistory.resolve();
      await page.waitForSelector('.conversation-card[data-conversation-id="244"]');
      await page.click('.conversation-card[data-conversation-id="244"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('tenant-B vigente'));
      await page.waitForFunction(() => document.querySelector('#syncStatus').dataset.state === 'updated');

      const finalState = await page.evaluate(() => ({
        ids: [...document.querySelectorAll('.conversation-card')].map(item => item.dataset.conversationId),
        title: document.querySelector('#chatTitle').textContent,
        history: document.querySelector('#messageHistory').textContent,
      }));
      assert.deepEqual(finalState.ids, ['244']);
      assert.equal(finalState.title, '*********0202');
      assert.match(finalState.history, /tenant-B vigente/);
      assert.doesNotMatch(finalState.history, /tenant-A/);
      assert.equal(counts.maxActiveConversations, 1, 'lista nunca solapa GET aunque abort demore');
      assert.equal(counts.maxActiveMessages, 1, 'historial nunca solapa GET aunque abort demore');
    },
    {
      waitForConversation: false,
      refreshDelayMs: 10_000,
      userResponse: { user: { role: 'super', empresa_id: null } },
      conversationsResponse: async ({ url }) => {
        const companyId = url.searchParams.get('empresa_id');
        if (companyId === '1' && delayOld) {
          oldListStarted.resolve();
          await releaseOldList.promise;
          return { conversations: [
            { conversationId: '99', participant: '*********0099', lastMessageAt: '2026-10-08T13:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          ], nextCursor: null };
        }
        if (companyId === '2') return { conversations: [
          { conversationId: '244', participant: '*********0202', lastMessageAt: '2026-10-08T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
        ], nextCursor: null };
        return { conversations: [
          { conversationId: '44', participant: '*********0101', lastMessageAt: '2026-10-08T11:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
        ], nextCursor: null };
      },
      messagesResponse: async ({ url }) => {
        const conversationId = url.pathname.split('/').at(-2);
        const companyId = url.searchParams.get('empresa_id');
        if (companyId === '1' && conversationId === '44' && delayOld) {
          oldHistoryStarted.resolve();
          await releaseOldHistory.promise;
          return { messages: [
            { id: '99', direction: 'inbound', type: 'text', text: 'tenant-A tardío', deliveryStatus: 'received', messageAt: '2026-10-08T13:00:00Z' },
          ], nextCursor: null };
        }
        const text = companyId === '2' ? 'tenant-B vigente' : 'tenant-A inicial';
        return { messages: [
          { id: companyId === '2' ? '202' : '101', direction: 'inbound', type: 'text', text, deliveryStatus: 'received', messageAt: '2026-10-08T12:00:00Z' },
        ], nextCursor: null };
      },
    },
  );
});

test('Task 6 browser hidden sostenido no trafica y visible reanuda un solo ciclo sin duplicar timers', { skip: !existsSync(chromePath) }, async () => {
  let listBarrier = null;
  let historyBarrier = null;
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelector('#messageHistory')?.textContent.includes('hola'));
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const hiddenBaseline = { conversations: counts.conversations, messages: counts.messages };
      await new Promise(resolve => setTimeout(resolve, 260));
      assert.deepEqual({ conversations: counts.conversations, messages: counts.messages }, hiddenBaseline);

      for (let cycle = 0; cycle < 2; cycle += 1) {
        const before = { conversations: counts.conversations, messages: counts.messages };
        listBarrier = deferred();
        historyBarrier = deferred();
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await Promise.all([listBarrier.promise, historyBarrier.promise]);
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        assert.deepEqual(
          { conversations: counts.conversations - before.conversations, messages: counts.messages - before.messages },
          { conversations: 1, messages: 1 },
          'cada reanudación visible ejecuta exactamente un ciclo',
        );
      }
    },
    {
      refreshDelayMs: 60,
      conversationsResponse: ({ counts }) => {
        listBarrier?.resolve();
        return { conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null, counters: { total: counts.conversations } };
      },
      messagesResponse: () => {
        historyBarrier?.resolve();
        return { messages: [
          { id: '1', direction: 'inbound', type: 'text', text: 'hola', deliveryStatus: 'received', messageAt: '2026-10-06T12:00:00Z' },
        ], nextCursor: null };
      },
    },
  );
});

test('Task 6 browser conserva ancla geométrica al expandir contenido previo y autoscroll al fondo', { skip: !existsSync(chromePath) }, async () => {
  const baseMessages = Array.from({ length: 40 }, (_, index) => ({
    id: String(index + 1),
    direction: index % 2 ? 'outbound' : 'inbound',
    type: 'text',
    text: `msg-${index + 1} corto`,
    deliveryStatus: index % 2 ? 'sent' : 'received',
    messageAt: `2026-10-06T12:${String(index).padStart(2, '0')}:00Z`,
  }));
  let secondLiveRequestedResolve;
  const secondLiveRequested = new Promise(resolve => { secondLiveRequestedResolve = resolve; });
  await withBrowserPage(
    { width: 1280, height: 800, deviceScaleFactor: 1 },
    async ({ page, counts }) => {
      await page.addStyleTag({ content: '#messageHistory { height: 300px; flex: none; } #messageHistory .message { flex: none; min-height: 48px; }' });
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.click('.conversation-card[data-conversation-id="44"]');
      await page.waitForFunction(() => document.querySelectorAll('#messageHistory .message').length === 40);
      await page.waitForFunction(() => document.querySelector('#messageHistory').scrollHeight > document.querySelector('#messageHistory').clientHeight);
      const before = await page.evaluate(() => {
        const history = document.querySelector('#messageHistory');
        const anchor = [...history.querySelectorAll('.message')].find(item => item.textContent.includes('msg-20'));
        history.scrollTop = anchor.offsetTop - 35;
        const rect = anchor.getBoundingClientRect();
        return {
          id: anchor.dataset.messageId,
          offset: rect.top - history.getBoundingClientRect().top,
        };
      });
      assert.equal(before.id, '20', 'cada mensaje usa el ID opaco del DTO como ancla DOM');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => document.querySelector('#newMessagesIndicator').hidden === false, { timeout: 2_000 });
      const after = await page.evaluate(anchorId => {
        const history = document.querySelector('#messageHistory');
        const anchor = [...history.querySelectorAll('.message')].find(item => item.dataset.messageId === anchorId);
        return {
          offset: anchor.getBoundingClientRect().top - history.getBoundingClientRect().top,
          scrollTop: history.scrollTop,
          indicator: document.querySelector('#newMessagesIndicator').textContent,
        };
      }, before.id);
      assert.ok(Math.abs(after.offset - before.offset) <= 2, `ancla se movió ${after.offset - before.offset}px`);
      assert.ok(after.scrollTop > 0);
      assert.equal(after.indicator, '1 mensajes nuevos');

      await page.evaluate(() => {
        const history = document.querySelector('#messageHistory');
        history.scrollTop = history.scrollHeight;
      });
      await secondLiveRequested;
      await page.waitForFunction(() => document.querySelectorAll('#messageHistory .message').length === 42);
      await page.waitForFunction(() => document.querySelector('#newMessagesIndicator').hidden === true);
      assert.equal(await page.evaluate(() => {
        const history = document.querySelector('#messageHistory');
        return history.scrollHeight - history.scrollTop - history.clientHeight <= 2;
      }), true);
    },
    {
      refreshDelayMs: 120,
      sendTimeoutMs: 1_000,
      messagesResponse: ({ index }) => {
        if (index === 0) return { messages: baseMessages, nextCursor: 'older-cursor' };
        if (index === 2) secondLiveRequestedResolve();
        const expanded = baseMessages.map((message, messageIndex) => messageIndex < 12
          ? { ...message, text: `${message.text} ${'contenido expandido '.repeat(12)}` }
          : message);
        const extra = index === 1
          ? [{ id: '41', direction: 'inbound', type: 'text', text: 'nuevo-41', deliveryStatus: 'received', messageAt: '2026-10-06T13:00:00Z' }]
          : [
              { id: '41', direction: 'inbound', type: 'text', text: 'nuevo-41', deliveryStatus: 'received', messageAt: '2026-10-06T13:00:00Z' },
              { id: '42', direction: 'inbound', type: 'text', text: 'nuevo-42', deliveryStatus: 'received', messageAt: '2026-10-06T13:01:00Z' },
            ];
        return { messages: [...expanded, ...extra], nextCursor: null };
      },
    },
  );
});

test('browser desktop no desborda y no mueve foco al botón Volver', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage({ width: 1440, height: 900, deviceScaleFactor: 1 }, async ({ page }) => {
    await page.click('.conversation-card[data-conversation-id="44"]');
    const measured = await page.evaluate(() => {
      const composer = document.querySelector('#composerForm').getBoundingClientRect();
      const topbar = document.querySelector('.topbar').getBoundingClientRect();
      const nav = document.querySelector('.cloud-nav').getBoundingClientRect();
      return {
        activeId: document.activeElement?.id || '',
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        composerBottom: composer.bottom,
        topbar: { left: topbar.left, right: topbar.right, top: topbar.top, bottom: topbar.bottom },
        nav: { left: nav.left, right: nav.right, top: nav.top, bottom: nav.bottom },
      };
    });
    assert.notEqual(measured.activeId, 'backToList');
    assert.ok(measured.scrollHeight <= measured.viewportHeight);
    assert.ok(measured.composerBottom <= measured.viewportHeight);
    assert.ok(measured.topbar.left >= 0 && measured.topbar.right <= measured.viewportWidth);
    assert.ok(measured.nav.left >= 0 && measured.nav.right <= measured.viewportWidth);
    console.log('DESKTOP_LAYOUT', JSON.stringify(measured));
    await page.screenshot({ path: path.join(screenshotDir, 'whatsapp-cloud-desktop-1440x900.png') });
  });
});

test('Task 7 usa tres paneles desktop, dos paneles tablet y list-detail mobile sin overflow', { skip: !existsSync(chromePath) }, async () => {
  for (const viewport of [
    { width: 320, height: 568, deviceScaleFactor: 1 },
    { width: 360, height: 800, deviceScaleFactor: 1 },
    { width: 390, height: 844, deviceScaleFactor: 1 },
    { width: 768, height: 1024, deviceScaleFactor: 1 },
    { width: 1024, height: 768, deviceScaleFactor: 1 },
    { width: 1440, height: 900, deviceScaleFactor: 1 },
  ]) {
    await withBrowserPage(viewport, async ({ page }) => {
      const initial = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        height: innerHeight,
        queue: getComputedStyle(document.querySelector('.conversation-pane')).display,
        chat: getComputedStyle(document.querySelector('#chatPanel')).display,
        context: getComputedStyle(document.querySelector('#contextPanel')).display,
        safeArea: getComputedStyle(document.querySelector('#composerForm')).paddingBottom,
      }));
      assert.ok(initial.scrollWidth <= viewport.width, `${viewport.width}: overflow horizontal inicial`);
      assert.ok(initial.scrollHeight <= viewport.height, `${viewport.width}: overflow vertical de página inicial`);
      assert.equal(initial.queue === 'none', false);
      if (viewport.width < 768) assert.equal(initial.chat, 'none');
      else assert.equal(initial.chat === 'none', false);
      if (viewport.width >= 1200) assert.equal(initial.context === 'none', false);
      else assert.equal(initial.context, 'none');
      assert.notEqual(initial.safeArea, '0px');

      await openConversationAndWait(page);
      const detail = await page.evaluate(() => {
        const box = selector => {
          const element = document.querySelector(selector);
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, display: getComputedStyle(element).display };
        };
        return {
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          queue: box('.conversation-pane'), chat: box('#chatPanel'), context: box('#contextPanel'),
          composer: box('#composerForm'), header: box('.topbar'),
        };
      });
      assert.ok(detail.scrollWidth <= viewport.width, `${viewport.width}: overflow horizontal detalle`);
      assert.ok(detail.scrollHeight <= viewport.height, `${viewport.width}: overflow vertical detalle`);
      assert.ok(detail.composer.bottom <= viewport.height && detail.composer.height >= 44, `${viewport.width}: composer alcanzable`);
      if (viewport.width >= 1200) {
        assert.ok(detail.queue.width >= 360 && detail.queue.width <= 400);
        assert.ok(detail.context.width >= 300 && detail.context.width <= 340);
        assert.ok(detail.queue.right <= detail.chat.left && detail.chat.right <= detail.context.left);
      } else if (viewport.width >= 768) {
        assert.ok(detail.queue.width >= 300 && detail.chat.width >= 420);
        assert.equal(detail.context.display, 'none');
        if (viewport.width === 1024) {
          await openOverlayAndWait(page, '#contextToggle', '#contextPanel');
          const drawer = await page.$eval('#contextPanel', element => element.getBoundingClientRect().toJSON());
          const composer = await page.$eval('#composerForm', element => element.getBoundingClientRect().toJSON());
          assert.ok(drawer.left >= 0 && drawer.right <= viewport.width);
          assert.equal(overlapArea(drawer, composer), 0, 'drawer tablet no debe cubrir el composer');
          await page.keyboard.press('Escape');
          assert.equal(await page.$eval('#contextToggle', button => button.getAttribute('aria-expanded')), 'false');
          await page.screenshot({ path: path.join(screenshotDir, 'whatsapp-cloud-tablet-1024x768.png') });
        }
      } else {
        assert.equal(detail.queue.display, 'none');
        assert.notEqual(detail.chat.display, 'none');
        assert.ok(detail.composer.left >= 0 && detail.composer.right <= viewport.width);
        const targets = await page.evaluate(() => ['backToList', 'conversationWorkflow', 'conversationPriority', 'contextToggle', 'messageInput', 'sendButton'].map(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return { id, width: rect.width, height: rect.height };
        }));
        for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44, `${viewport.width}: ${target.id} touch target`);
      }
    });
  }
});

test('Task 7 tablet mantiene todos los controles táctiles visibles en al menos 44x44', { skip: !existsSync(chromePath) }, async () => {
  const viewports = [
    { width: 768, height: 800, deviceScaleFactor: 1 },
    { width: 768, height: 1024, deviceScaleFactor: 1 },
    { width: 1024, height: 768, deviceScaleFactor: 1 },
  ];

  for (const viewport of viewports) {
    await withBrowserPage(viewport, async ({ page }) => {
      const assertTouchTargets = async (rootSelector, phase) => {
        const measured = await page.evaluate(rootTarget => {
          const root = rootTarget === 'document' ? document : document.querySelector(rootTarget);
          const candidates = [...root.querySelectorAll('button,select,input,textarea,summary,a[href]')];
          const seen = new Set();
          return candidates.flatMap(element => {
            const style = getComputedStyle(element);
            if (element.matches(':disabled') || element.inert || element.getAttribute('aria-disabled') === 'true'
              || style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return [];
            let target = element;
            if (element.matches('input[type="checkbox"],input[type="radio"]')) {
              target = element.closest('label') || document.querySelector(`label[for="${CSS.escape(element.id)}"]`) || element;
            }
            const rect = target.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0
              || rect.left >= innerWidth || rect.top >= innerHeight) return [];
            const key = `${target.id || target.tagName}:${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
            if (seen.has(key)) return [];
            seen.add(key);
            return [{
              id: element.id || target.id || element.textContent.trim().slice(0, 32) || element.tagName,
              width: rect.width,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            }];
          });
        }, rootSelector);
        assert.ok(measured.length > 0, `${viewport.width}x${viewport.height} ${phase}: debe medir controles visibles`);
        for (const target of measured) {
          assert.ok(target.width >= 44 && target.height >= 44,
            `${viewport.width}x${viewport.height} ${phase}: ${target.id} mide ${target.width}x${target.height}`);
          assertInsideViewport(target, viewport, `${viewport.width}x${viewport.height} ${phase}: ${target.id}`);
        }
        return measured;
      };

      const initialLayout = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        const nav = document.querySelector('.cloud-nav');
        const topbarInner = document.querySelector('.topbar-inner');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          navDirection: getComputedStyle(nav).flexDirection,
          topbarDirection: getComputedStyle(topbarInner).flexDirection,
          topbar: box('.topbar'),
          brand: box('.brand'),
          brandImage: box('.brand img'),
          shell: box('.shell'),
          inbox: box('#inboxLayout'),
          queue: box('.conversation-pane'),
          chat: box('#chatPanel'),
          contextDisplay: getComputedStyle(document.querySelector('#contextPanel')).display,
        };
      });
      assert.ok(initialLayout.scrollWidth <= viewport.width, `${viewport.width}x${viewport.height}: documento sin overflow horizontal`);
      assert.ok(initialLayout.scrollHeight <= viewport.height, `${viewport.width}x${viewport.height}: documento sin overflow vertical`);
      assert.equal(initialLayout.navDirection, 'row', `${viewport.width}x${viewport.height}: navegación tablet horizontal`);
      assert.equal(initialLayout.topbarDirection, 'row', `${viewport.width}x${viewport.height}: topbar tablet horizontal`);
      assert.ok(initialLayout.topbar.height <= 72, `${viewport.width}x${viewport.height}: topbar compacta`);
      assert.ok(initialLayout.brandImage.height <= 32, `${viewport.width}x${viewport.height}: logo sin sobredimensionar`);
      assert.ok(initialLayout.shell.top >= initialLayout.topbar.bottom, `${viewport.width}x${viewport.height}: workspace despejado bajo topbar`);
      assert.ok(initialLayout.shell.left >= 0 && initialLayout.shell.right <= viewport.width, `${viewport.width}x${viewport.height}: shell dentro del viewport`);
      assert.ok(initialLayout.inbox.left >= initialLayout.shell.left && initialLayout.inbox.right <= initialLayout.shell.right,
        `${viewport.width}x${viewport.height}: inbox contenido en shell`);
      assert.ok(initialLayout.queue.width >= 300 && initialLayout.chat.width >= 420,
        `${viewport.width}x${viewport.height}: workspace conserva dos paneles tablet`);
      assert.equal(initialLayout.contextDisplay, 'none', `${viewport.width}x${viewport.height}: contexto inicia como drawer`);

      await assertTouchTargets('document', 'lista');
      await openOverlayAndWait(page, '#filtersToggle', '#queueFilters');
      await assertTouchTargets('#queueFilters', 'filtros');
      await page.keyboard.press('Escape');

      await openConversationAndWait(page);
      await page.type('#messageInput', 'respuesta tablet');
      await page.waitForFunction(() => document.querySelector('#sendButton')?.disabled === false);
      await assertTouchTargets('.shell', 'conversación');

      await openOverlayAndWait(page, '#contextToggle', '#contextPanel');
      await assertTouchTargets('#contextPanel', 'contexto');
      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        composer: document.querySelector('#composerForm').getBoundingClientRect().toJSON(),
        context: document.querySelector('#contextPanel').getBoundingClientRect().toJSON(),
      }));
      assert.ok(layout.scrollWidth <= viewport.width, `${viewport.width}x${viewport.height}: sin overflow horizontal`);
      assert.ok(layout.scrollHeight <= viewport.height, `${viewport.width}x${viewport.height}: sin overflow vertical`);
      assert.equal(overlapArea(layout.context, layout.composer), 0, `${viewport.width}x${viewport.height}: contexto despeja composer`);
    });
  }
});

test('Task 7 drawers son accesibles, cierran con Escape y restauran foco sin perder borrador', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage({ width: 390, height: 844, deviceScaleFactor: 1 }, async ({ page }) => {
    const semantics = await page.evaluate(() => ({
      main: document.querySelector('main')?.getAttribute('aria-label'),
      filtersControls: document.querySelector('#filtersToggle')?.getAttribute('aria-controls'),
      filtersExpanded: document.querySelector('#filtersToggle')?.getAttribute('aria-expanded'),
      contextControls: document.querySelector('#contextToggle')?.getAttribute('aria-controls'),
      syncLive: document.querySelector('#syncStatus')?.getAttribute('aria-live'),
      historyLive: document.querySelector('#messageHistory')?.getAttribute('aria-live'),
    }));
    assert.deepEqual(semantics, {
      main: 'Espacio de trabajo de WhatsApp Cloud', filtersControls: 'queueFilters', filtersExpanded: 'false',
      contextControls: 'contextPanel', syncLive: 'polite', historyLive: 'polite',
    });
    const client = await page.createCDPSession();
    await client.send('Accessibility.enable');
    const ax = await client.send('Accessibility.getFullAXTree');
    const namedRoles = ax.nodes.map(node => ({ role: node.role?.value, name: node.name?.value })).filter(node => node.name);
    assert.ok(namedRoles.some(node => node.role === 'main' && node.name === 'Espacio de trabajo de WhatsApp Cloud'));
    assert.ok(namedRoles.some(node => node.role === 'navigation' && node.name === 'Navegación backoffice'));
    assert.ok(namedRoles.some(node => node.role === 'searchbox' && /Buscar por cliente/.test(node.name)));

    await page.focus('#conversationSearch');
    await page.type('#conversationSearch', 'borrador búsqueda');
    await openOverlayAndWait(page, '#filtersToggle', '#queueFilters');
    assert.equal(await page.$eval('#filtersToggle', button => button.getAttribute('aria-expanded')), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'workflowFilter');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#filtersToggle', button => button.getAttribute('aria-expanded')), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'filtersToggle');
    assert.equal(await page.$eval('#conversationSearch', input => input.value), 'borrador búsqueda');

    await openConversationAndWait(page);
    await page.type('#messageInput', 'borrador de respuesta');
    await openOverlayAndWait(page, '#contextToggle', '#contextPanel');
    const open = await page.evaluate(() => ({
      expanded: document.querySelector('#contextToggle').getAttribute('aria-expanded'),
      active: document.activeElement?.id,
      drawerRole: document.querySelector('#contextPanel').getAttribute('role'),
      modal: document.querySelector('#contextPanel').getAttribute('aria-modal'),
      closeBox: document.querySelector('#contextClose').getBoundingClientRect().toJSON(),
    }));
    assert.equal(open.expanded, 'true');
    assert.equal(open.active, 'contextClose');
    assert.equal(open.drawerRole, 'dialog');
    assert.equal(open.modal, 'true');
    assert.ok(open.closeBox.width >= 44 && open.closeBox.height >= 44);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#contextToggle', button => button.getAttribute('aria-expanded')), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'contextToggle');
    assert.equal(await page.$eval('#messageInput', input => input.value), 'borrador de respuesta');
  });
});

test('Task 7 usa 767px como único límite mobile para foco, volver y restauración', { skip: !existsSync(chromePath) }, async () => {
  for (const width of [760, 761, 767, 768]) {
    await withBrowserPage({ width, height: 800, deviceScaleFactor: 1 }, async ({ page }) => {
      await openConversationAndWait(page);
      const detail = await page.evaluate(() => ({
        queue: getComputedStyle(document.querySelector('.conversation-pane')).display,
        chat: getComputedStyle(document.querySelector('#chatPanel')).display,
        back: getComputedStyle(document.querySelector('#backToList')).display,
        active: document.activeElement?.id || '',
      }));
      if (width <= 767) {
        assert.equal(detail.queue, 'none', `${width}: lista oculta en detalle mobile`);
        assert.notEqual(detail.chat, 'none', `${width}: chat visible en detalle mobile`);
        assert.notEqual(detail.back, 'none', `${width}: volver visible en mobile`);
        assert.equal(detail.active, 'backToList', `${width}: foco entra al volver mobile`);
        await page.click('#backToList');
        assert.notEqual(await page.$eval('.conversation-pane', element => getComputedStyle(element).display), 'none');
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.conversationId), '44');
      } else {
        assert.notEqual(detail.queue, 'none', '768: lista permanece visible en tablet');
        assert.notEqual(detail.chat, 'none', '768: chat permanece visible en tablet');
        assert.equal(detail.back, 'none', '768: volver mobile permanece oculto');
        assert.notEqual(detail.active, 'backToList', '768: no mueve foco a un control oculto');
      }
    });
  }
});

test('Task 7 ajusta detalle y composer al visualViewport y restaura al cerrar teclado u orientar', { skip: !existsSync(chromePath) }, async () => {
  for (const width of [320, 360, 390]) {
    const layoutHeight = width === 320 ? 568 : 844;
    await withBrowserPage({ width, height: layoutHeight, deviceScaleFactor: 1 }, async ({ page }) => {
      await openConversationAndWait(page);
      for (const [height, offsetTop] of [[500, 0], [420, 18]]) {
        await page.evaluate(({ height: nextHeight, offsetTop: nextOffset }) => window.__setVisualViewport({ height: nextHeight, offsetTop: nextOffset }), { height, offsetTop });
        await page.waitForFunction(() => document.body.classList.contains('keyboard-open'));
        const measured = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          const vv = visualViewport;
          return {
            visualTop: vv.offsetTop,
            visualBottom: vv.offsetTop + vv.height,
            shell: rect('.shell'), inbox: rect('#inboxLayout'), chat: rect('#chatPanel'), composer: rect('#composerForm'),
            input: rect('#messageInput'), send: rect('#sendButton'),
            documentScrollHeight: document.documentElement.scrollHeight,
            bodyOverflow: getComputedStyle(document.body).overflow,
            historyOverflow: getComputedStyle(document.querySelector('#messageHistory')).overflowY,
          };
        });
        for (const target of ['shell', 'inbox', 'chat', 'composer', 'input', 'send']) {
          assert.ok(measured[target].top >= measured.visualTop - 2, `${width}x${height}: ${target} comienza dentro de visualViewport`);
          assert.ok(measured[target].bottom <= measured.visualBottom + 2, `${width}x${height}: ${target} termina dentro de visualViewport`);
        }
        assert.ok(measured.input.width > 0 && measured.input.height >= 44, `${width}x${height}: input visible`);
        assert.ok(measured.send.width >= 44 && measured.send.height >= 44, `${width}x${height}: enviar visible`);
        assert.equal(measured.bodyOverflow, 'hidden');
        assert.equal(measured.historyOverflow, 'auto', 'el historial conserva su scroll interno');
        assert.ok(measured.documentScrollHeight <= layoutHeight, 'no crea scroll trap de documento');
      }

      await page.evaluate(height => window.__setVisualViewport({ height, offsetTop: 0 }), layoutHeight);
      await page.waitForFunction(() => !document.body.classList.contains('keyboard-open'));
      const restored = await page.evaluate(() => ({
        shellHeight: document.querySelector('.shell').getBoundingClientRect().height,
        visualHeight: visualViewport.height,
        customHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-visual-height').trim(),
      }));
      assert.ok(restored.shellHeight < restored.visualHeight, 'la topbar vuelve a ocupar su espacio normal');
      assert.equal(restored.customHeight, `${layoutHeight}px`);

      await page.setViewport({ width: layoutHeight, height: width, deviceScaleFactor: 1 });
      await page.evaluate(height => window.__setVisualViewport({ height, offsetTop: 0 }), width);
      await page.waitForFunction(() => !document.body.classList.contains('keyboard-open'));
      const oriented = await page.evaluate(() => ({
        composerBottom: document.querySelector('#composerForm').getBoundingClientRect().bottom,
        documentScrollHeight: document.documentElement.scrollHeight,
        innerHeight,
      }));
      assert.ok(oriented.composerBottom <= oriented.innerHeight + 2, `${width}: composer visible tras orientación`);
      assert.ok(oriented.documentScrollHeight <= oriented.innerHeight, `${width}: sin scroll trap tras orientación`);

      await page.setViewport({ width, height: layoutHeight, deviceScaleFactor: 1 });
      await page.evaluate(height => window.__setVisualViewport({ height, offsetTop: 0 }), layoutHeight);
      await page.waitForFunction(() => document.querySelector('#composerForm').getBoundingClientRect().bottom <= innerHeight + 2);
    }, { simulatedVisualViewport: { width, height: layoutHeight, offsetTop: 0 } });
  }
});

test('Task 7 filtros y contexto son diálogos modales nombrados sólo mientras son overlays', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage({ width: 768, height: 900, deviceScaleFactor: 1 }, async ({ page }) => {
    await openOverlayAndWait(page, '#filtersToggle', '#queueFilters');
    const filters = await page.evaluate(() => {
      const panel = document.querySelector('#queueFilters');
      return {
        role: panel.getAttribute('role'), modal: panel.getAttribute('aria-modal'), labelledby: panel.getAttribute('aria-labelledby'),
        otherModal: document.querySelector('#contextPanel').getAttribute('aria-modal'),
      };
    });
    assert.deepEqual(filters, { role: 'dialog', modal: 'true', labelledby: 'filtersHeading', otherModal: null });
    const client = await page.createCDPSession();
    await client.send('Accessibility.enable');
    const ax = await client.send('Accessibility.getFullAXTree');
    assert.ok(ax.nodes.some(node => node.role?.value === 'dialog' && node.name?.value === 'Filtros de conversaciones'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#queueFilters').dataset.open === 'false');
  });

  await withBrowserPage({ width: 768, height: 900, deviceScaleFactor: 1 }, async ({ page }) => {
    await openConversationAndWait(page);
    await page.waitForFunction(() => {
      const button = document.querySelector('#contextToggle');
      const rect = button.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button;
    });
    const contextHitTarget = await page.$eval('#contextToggle', button => {
      const rect = button.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id || '';
    });
    assert.equal(contextHitTarget, 'contextToggle', 'el disparador de contexto tablet no debe quedar cubierto');
    await openOverlayAndWait(page, '#contextToggle', '#contextPanel');
    const context = await page.evaluate(() => ({
      role: document.querySelector('#contextPanel').getAttribute('role'),
      modal: document.querySelector('#contextPanel').getAttribute('aria-modal'),
      labelledby: document.querySelector('#contextPanel').getAttribute('aria-labelledby'),
      filtersModal: document.querySelector('#queueFilters').getAttribute('aria-modal'),
    }));
    assert.deepEqual(context, { role: 'dialog', modal: 'true', labelledby: 'contextHeading', filtersModal: null });
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.waitForFunction(() => document.querySelector('#contextPanel').getAttribute('role') === null);
    assert.deepEqual(await page.evaluate(() => ({
      contextRole: document.querySelector('#contextPanel').getAttribute('role'),
      contextModal: document.querySelector('#contextPanel').getAttribute('aria-modal'),
      filtersRole: document.querySelector('#queueFilters').getAttribute('role'),
      filtersModal: document.querySelector('#queueFilters').getAttribute('aria-modal'),
    })), { contextRole: null, contextModal: null, filtersRole: null, filtersModal: null });
  });
});

test('Task 7 reintenta contexto visible con GET cercado y limpia el error', { skip: !existsSync(chromePath) }, async () => {
  const staleRetry = deferred();
  await withBrowserPage({ width: 390, height: 844, deviceScaleFactor: 1 }, async ({ page, counts }) => {
    await openConversationAndWait(page);
    await page.waitForFunction(() => document.querySelector('#contextRetry'));
    await openOverlayAndWait(page, '#contextToggle', '#contextPanel');
    assert.match(await page.$eval('#conversationContext', element => element.textContent), /No se pudo cargar.*Reintentar/s);
    await clickCurrent(page, '#contextRetry');
    await page.waitForFunction(() => document.querySelector('#conversationContext')?.textContent.includes('Cliente identificado'));
    assert.equal(counts.contexts, 2);
    assert.doesNotMatch(await page.$eval('#conversationContext', element => element.textContent), /No se pudo cargar/);

    await page.keyboard.press('Escape');
    await page.click('#backToList');
    await openConversationAndWait(page, '45');
    await page.waitForFunction(() => document.querySelector('#contextRetry'));
    await openOverlayAndWait(page, '#contextToggle', '#contextPanel');
    await clickCurrent(page, '#contextRetry');
    await page.keyboard.press('Escape');
    await page.click('#backToList');
    await clickCurrent(page, '.conversation-card[data-conversation-id="44"]');
    staleRetry.resolve();
    await page.waitForFunction(() => document.querySelector('#conversationContext')?.textContent.includes('Cliente identificado'));
    assert.doesNotMatch(await page.$eval('#conversationContext', element => element.textContent), /STALE 45/);
    assert.equal(counts.apiRequests.filter(entry => entry.path.endsWith('/context')).every(entry => entry.method === 'GET'), true);
  }, {
    async contextResponse({ index, url }) {
      const id = url.pathname.split('/').at(-2);
      if (index === 0 || index === 2) return { status: 500, body: { error: 'temporary' } };
      if (index === 3) {
        await staleRetry.promise;
        return { matchStatus: 'exact', customer: { name: 'STALE 45', phone: '*********0045', address: 'Vieja' }, orders: [] };
      }
      return { matchStatus: 'exact', customer: { name: `Cliente ${id}`, phone: '*********0001', address: 'Actual' }, orders: [] };
    },
  });
});
