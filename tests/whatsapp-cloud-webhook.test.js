import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createWhatsAppCloudWebhookRouter } from '../src/routes/whatsappCloudWebhook.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('WhatsApp Cloud webhook verifica el challenge con token valido', async () => {
  const previousToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = 'test-token';

  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter({ logger: silentLogger() }));

  try {
    await withServer(app, async (baseUrl) => {
      const params = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-token',
        'hub.challenge': 'pedivoy-ok',
      });

      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp?${params}`);
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), 'pedivoy-ok');
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_VERIFY_TOKEN', previousToken);
  }
});

test('WhatsApp Cloud webhook rechaza verificacion con token invalido', async () => {
  const previousToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = 'test-token';

  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter({ logger: silentLogger() }));

  try {
    await withServer(app, async (baseUrl) => {
      const params = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'pedivoy-ok',
      });

      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp?${params}`);
      assert.equal(resp.status, 403);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_VERIFY_TOKEN', previousToken);
  }
});

test('WhatsApp Cloud webhook recibe eventos entrantes', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter({ logger: silentLogger() }));

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [],
      }),
    });

    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  });
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
