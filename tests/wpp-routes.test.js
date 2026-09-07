import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import qrcode from 'qrcode';

import { registerWppRoutes } from '../src/wpp/routes.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({
  enabled = true,
  qrOnly = false,
  user = { id: 1, role: 'super' },
  state = {},
  client = null,
  initWhatsApp = async () => {},
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-wpp-test-')),
} = {}) {
  const app = express();
  app.use(express.json());

  const currentState = {
    isConnected: false,
    isReadyWpp: false,
    isInitializingWpp: false,
    isShuttingDownWpp: false,
    lastQr: null,
    wppHandlersStarted: false,
    ...state,
  };

  registerWppRoutes(app, {
    ENABLE_WPP: enabled,
    WPP_QR_ONLY: qrOnly,
    qrcode,
    fs,
    path,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getState() {
      return currentState;
    },
    setState(patch = {}) {
      Object.assign(currentState, patch);
    },
    getClient() {
      return client;
    },
    initWhatsApp,
    limpiarLocksSesion() {},
  });

  return { app, tmpDir, state: currentState };
}

test('status general informa modo solo QR y QR disponible', async () => {
  const { app } = buildApp({
    qrOnly: true,
    state: { lastQr: 'qr-demo', isInitializingWpp: false },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/whatsapp/status`);
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.enabled, true);
    assert.equal(body.qr_only, true);
    assert.equal(body.has_qr, true);
    assert.match(body.message, /QR general disponible/);
  });
});

test('qr general devuelve imagen cuando hay QR', async () => {
  const { app } = buildApp({
    state: { lastQr: 'qr-demo' },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/whatsapp/qr`);
    assert.equal(resp.status, 200);

    const html = await resp.text();
    assert.match(html, /<img src="data:image\/png;base64,/);
  });
});

test('qr general informa cuando WhatsApp esta deshabilitado', async () => {
  const { app } = buildApp({ enabled: false });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/whatsapp/qr`);
    assert.equal(resp.status, 503);

    const html = await resp.text();
    assert.match(html, /WhatsApp general deshabilitado/);
  });
});

test('reset general limpia estado y reinicializa si hay cliente', async () => {
  let destroyed = false;
  let initialized = false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-wpp-reset-test-'));
  const previousSessionPath = process.env.WPP_SESSION_PATH;
  const { app } = buildApp({
    tmpDir,
    state: { lastQr: 'qr-demo', isConnected: true, isReadyWpp: true, wppHandlersStarted: true },
    client: {
      async destroy() {
        destroyed = true;
      },
    },
    initWhatsApp: async () => {
      initialized = true;
    },
  });

  try {
    process.env.WPP_SESSION_PATH = tmpDir;
    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
      assert.equal(resp.status, 200);

      const body = await resp.json();
      assert.equal(body.ok, true);
    });
  } finally {
    if (previousSessionPath === undefined) delete process.env.WPP_SESSION_PATH;
    else process.env.WPP_SESSION_PATH = previousSessionPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.equal(destroyed, true);
  assert.equal(initialized, true);
});

test('reset general sigue siendo solo superadmin', async () => {
  const { app } = buildApp({ user: { id: 2, role: 'admin' } });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
    assert.equal(resp.status, 403);

    const body = await resp.json();
    assert.match(body.error, /SUPER ADMIN/);
  });
});
