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

async function withBrowserPage(viewport, work) {
  const app = express();
  app.post('/api/admin/whatsapp-cloud/conversations/:id/replies', req => {
    req.on('close', () => {});
  });
  app.get('/pedidos/whatsapp-cloud.js', async (_req, res) => {
    const controller = await readFile(path.join(root, 'pedidos/whatsapp-cloud.js'), 'utf8');
    res.type('text/javascript').send(controller.replace('const SEND_TIMEOUT_MS = 25_000;', 'const SEND_TIMEOUT_MS = 30;'));
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
    const counts = { conversations: 0, messages: 0, replies: 0 };
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
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/messages/.test(url.pathname)) {
        counts.messages += 1;
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [
          { id: '1', direction: 'inbound', type: 'text', text: 'hola', deliveryStatus: 'received', messageAt: '2026-10-06T12:00:00Z' },
        ], nextCursor: null }) });
      } else if (/\/api\/admin\/whatsapp-cloud\/conversations\/\d+\/replies/.test(url.pathname)) {
        counts.replies += 1;
        request.continue();
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
    await page.click('.conversation-card[data-conversation-id="44"]');
    await page.waitForSelector('#inboxLayout.mobile-detail');
    await page.waitForFunction(() => document.activeElement?.id === 'backToList');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backToList');

    const mobileLayout = await page.evaluate(() => {
      const composer = document.querySelector('#composerForm').getBoundingClientRect();
      return {
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        composerTop: composer.top,
        composerBottom: composer.bottom,
      };
    });
    assert.ok(mobileLayout.scrollHeight <= mobileLayout.viewportHeight);
    assert.ok(mobileLayout.composerTop >= 0 && mobileLayout.composerBottom <= mobileLayout.viewportHeight);
    console.log('MOBILE_LAYOUT', JSON.stringify(mobileLayout));
    await page.screenshot({ path: path.join(screenshotDir, 'whatsapp-cloud-mobile-390x844.png') });

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

test('browser desktop no desborda y no mueve foco al botón Volver', { skip: !existsSync(chromePath) }, async () => {
  await withBrowserPage({ width: 1440, height: 900, deviceScaleFactor: 1 }, async ({ page }) => {
    await page.click('.conversation-card[data-conversation-id="44"]');
    const measured = await page.evaluate(() => {
      const composer = document.querySelector('#composerForm').getBoundingClientRect();
      return {
        activeId: document.activeElement?.id || '',
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        composerBottom: composer.bottom,
      };
    });
    assert.notEqual(measured.activeId, 'backToList');
    assert.ok(measured.scrollHeight <= measured.viewportHeight);
    assert.ok(measured.composerBottom <= measured.viewportHeight);
    console.log('DESKTOP_LAYOUT', JSON.stringify(measured));
    await page.screenshot({ path: path.join(screenshotDir, 'whatsapp-cloud-desktop-1440x900.png') });
  });
});
