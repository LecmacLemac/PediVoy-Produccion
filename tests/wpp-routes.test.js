import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

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

test('reset de WhatsApp preserva mensajes pendientes en la cola', async () => {
  const app = express();
  let queryCalled = false;
  let statePatch = null;

  registerWppRoutes(app, {
    ENABLE_WPP: true,
    qrcode: { toDataURL: async () => '' },
    fs: { rmSync: () => {} },
    path: { join: (...segments) => segments.join('/') },
    query: async () => {
      queryCalled = true;
      throw new Error('El reset no debe modificar wpp_outbox');
    },
    withAuth: (req, _res, next) => {
      req.user = { id: 1, role: 'super' };
      next();
    },
    isSuper: () => true,
    getState: () => ({ isConnected: false, lastQr: null }),
    setState: (patch) => {
      statePatch = patch;
    },
    getClient: () => null,
    initWhatsApp: async () => {},
    limpiarLocksSesion: () => {},
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  });

  assert.equal(queryCalled, false);
  assert.deepEqual(statePatch, {
    lastQr: null,
    isConnected: false,
    isReadyWpp: false,
    wppHandlersStarted: false,
  });
});
