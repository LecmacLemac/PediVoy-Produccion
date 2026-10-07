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
} = {}) {
  const app = express();
  app.post('/api/admin/whatsapp-cloud/conversations/:id/replies', req => {
    req.on('close', () => {});
  });
  app.get('/pedidos/whatsapp-cloud.js', async (_req, res) => {
    const controller = await readFile(path.join(root, 'pedidos/whatsapp-cloud.js'), 'utf8');
    res.type('text/javascript').send(controller.replace(
      'const SEND_TIMEOUT_MS = 25_000;',
      `const SEND_TIMEOUT_MS = ${sendTimeoutMs};`,
    ));
  });
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.evaluateOnNewDocument(() => {
      const nativeRandomUUID = crypto.randomUUID.bind(crypto);
      window.__uuidCalls = 0;
      crypto.randomUUID = () => {
        window.__uuidCalls += 1;
        return nativeRandomUUID();
      };
    });
    await page.setRequestInterception(true);
    const counts = { conversations: 0, messages: 0, replies: 0, replyKeys: [] };
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/me') {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { role: 'admin', empresa_id: 7 } }) });
      } else if (url.pathname === '/api/admin/whatsapp-cloud/conversations') {
        counts.conversations += 1;
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversations: [
          { conversationId: '44', participant: '*********0001', lastMessageAt: '2026-10-06T12:00:00Z', lastMessageType: 'text', lastDirection: 'inbound', lastDeliveryStatus: 'received' },
          { conversationId: '45', participant: '*********0002', lastMessageAt: '2026-10-06T11:00:00Z', lastMessageType: 'text', lastDirection: 'outbound', lastDeliveryStatus: 'sent' },
        ], nextCursor: null }) });
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/read/.test(url.pathname)) {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversationId: url.pathname.split('/').at(-2), lastReadMessageId: '1' }) });
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/messages/.test(url.pathname)) {
        counts.messages += 1;
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [
          { id: '1', direction: 'inbound', type: 'text', text: 'hola', deliveryStatus: 'received', messageAt: '2026-10-06T12:00:00Z' },
        ], nextCursor: null }) });
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
    await page.goto(`http://127.0.0.1:${server.address().port}/pedidos/whatsapp-cloud.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.conversation-card');
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
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(counts.conversations > before.conversations);
    assert.ok(counts.messages > before.messages);
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
