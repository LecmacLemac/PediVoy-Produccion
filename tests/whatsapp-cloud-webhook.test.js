import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';

import * as whatsappCloudWebhook from '../src/routes/whatsappCloudWebhook.js';

const { createWhatsAppCloudWebhookRouter } = whatsappCloudWebhook;

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildWebhookApp({ handler, logger = silentLogger() } = {}) {
  assert.equal(typeof whatsappCloudWebhook.createWhatsAppCloudJsonMiddleware, 'function');

  const app = express();
  app.use(
    '/api/webhooks/whatsapp',
    whatsappCloudWebhook.createWhatsAppCloudJsonMiddleware(),
    createWhatsAppCloudWebhookRouter({ logger, handler })
  );
  return app;
}

function signBody(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

test('normaliza un mensaje de WhatsApp Cloud preservando su tipo', () => {
  assert.equal(typeof whatsappCloudWebhook.normalizeWhatsAppCloudEvents, 'function');

  const events = whatsappCloudWebhook.normalizeWhatsAppCloudEvents({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba-1',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'phone-id-1' },
          messages: [{ id: 'message-1', from: '5491112345678', type: 'future_type', future_type: { opaque: true } }],
        },
      }],
    }],
  });

  assert.deepEqual(events, [{
    kind: 'message',
    entryId: 'waba-1',
    phoneNumberId: 'phone-id-1',
    message: { id: 'message-1', from: '5491112345678', type: 'future_type', future_type: { opaque: true } },
  }]);
});

test('normaliza statuses y batches mixtos en orden', () => {
  const events = whatsappCloudWebhook.normalizeWhatsAppCloudEvents({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'phone-id-1' },
            messages: [{ id: 'message-1', type: 'text', text: { body: 'privado' } }],
            statuses: [{ id: 'message-out-1', status: 'delivered', recipient_id: '5491199999999' }],
          },
        }],
      },
      {
        id: 'waba-2',
        changes: [
          { field: 'account_alerts', value: { ignored: true } },
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-id-2' },
              statuses: [{ id: 'message-out-2', status: 'future_status', opaque: { retained: true } }],
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(events, [
    {
      kind: 'message',
      entryId: 'waba-1',
      phoneNumberId: 'phone-id-1',
      message: { id: 'message-1', type: 'text', text: { body: 'privado' } },
    },
    {
      kind: 'status',
      entryId: 'waba-1',
      phoneNumberId: 'phone-id-1',
      status: { id: 'message-out-1', status: 'delivered', recipient_id: '5491199999999' },
    },
    {
      kind: 'status',
      entryId: 'waba-2',
      phoneNumberId: 'phone-id-2',
      status: { id: 'message-out-2', status: 'future_status', opaque: { retained: true } },
    },
  ]);
});

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

test('WhatsApp Cloud webhook falla cerrado si el token de verificacion no esta configurado', async () => {
  const previousToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  delete process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;

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
      assert.equal(resp.status, 500);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_VERIFY_TOKEN', previousToken);
  }
});

test('WhatsApp Cloud webhook rechaza un mode distinto de subscribe', async () => {
  const previousToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = 'test-token';

  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter({ logger: silentLogger() }));

  try {
    await withServer(app, async (baseUrl) => {
      const params = new URLSearchParams({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'test-token',
        'hub.challenge': 'pedivoy-ok',
      });

      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp?${params}`);
      assert.equal(resp.status, 403);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_VERIFY_TOKEN', previousToken);
  }
});

test('WhatsApp Cloud webhook rechaza challenge ausente', async () => {
  const previousToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = 'test-token';

  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter({ logger: silentLogger() }));

  try {
    await withServer(app, async (baseUrl) => {
      const params = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-token',
      });

      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp?${params}`);
      assert.equal(resp.status, 403);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_VERIFY_TOKEN', previousToken);
  }
});

test('WhatsApp Cloud webhook acepta challenge "0" explicitamente', async () => {
  const previousToken = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = 'test-token';

  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter({ logger: silentLogger() }));

  try {
    await withServer(app, async (baseUrl) => {
      const params = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-token',
        'hub.challenge': '0',
      });

      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp?${params}`);
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), '0');
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_VERIFY_TOKEN', previousToken);
  }
});

test('WhatsApp Cloud webhook falla cerrado sin app secret y no invoca el handler', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  delete process.env.WHATSAPP_CLOUD_APP_SECRET;
  let calls = 0;

  const app = buildWebhookApp({ handler() { calls += 1; } });

  try {
    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': 'sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        body: '{"object":"whatsapp_business_account","entry":[]}',
      });

      assert.equal(resp.status, 503);
      assert.equal(calls, 0);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook rechaza firma ausente sin invocar el handler', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  let calls = 0;

  const app = buildWebhookApp({ handler() { calls += 1; } });

  try {
    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"object":"whatsapp_business_account","entry":[]}',
      });

      assert.equal(resp.status, 401);
      assert.equal(calls, 0);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook rechaza firma malformada estrictamente', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  let calls = 0;
  const app = buildWebhookApp({ handler() { calls += 1; } });

  try {
    await withServer(app, async (baseUrl) => {
      for (const signature of [
        'sha256=abc',
        `SHA256=${'a'.repeat(64)}`,
        `sha256=${'A'.repeat(64)}`,
        `sha256=${'g'.repeat(64)}`,
        `sha256=${'a'.repeat(65)}`,
      ]) {
        const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
          },
          body: '{"object":"whatsapp_business_account","entry":[]}',
        });
        assert.equal(resp.status, 401, signature);
      }
      assert.equal(calls, 0);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook rechaza firma HMAC incorrecta sin invocar el handler', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  let calls = 0;
  const app = buildWebhookApp({ handler() { calls += 1; } });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = '{ "entry": [], "object": "whatsapp_business_account" }';
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody('otro-secret', rawBody),
        },
        body: rawBody,
      });

      assert.equal(resp.status, 401);
      assert.equal(calls, 0);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook valida la firma antes de parsear JSON', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  let calls = 0;
  const app = buildWebhookApp({ handler() { calls += 1; } });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = '{json-invalido';
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody('otro-secret', rawBody),
        },
        body: rawBody,
      });

      assert.equal(resp.status, 401);
      assert.equal(calls, 0);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook valida los bytes JSON exactos y entrega eventos al handler', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  const received = [];
  const app = buildWebhookApp({ handler(events) { received.push(events); } });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = `{
  "entry": [{"changes":[{"value":{"messages":[{"type":"text","id":"m-1","text":{"body":"dato privado"}}],"metadata":{"phone_number_id":"phone-1"}},"field":"messages"}],"id":"waba-1"}],
  "object": "whatsapp_business_account"
}`;
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody('app-secret-test', rawBody),
        },
        body: rawBody,
      });

      assert.equal(resp.status, 200);
      assert.deepEqual(await resp.json(), { ok: true });
      assert.deepEqual(received, [[{
        kind: 'message',
        entryId: 'waba-1',
        phoneNumberId: 'phone-1',
        message: { type: 'text', id: 'm-1', text: { body: 'dato privado' } },
      }]]);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook responde 503 si falla el procesamiento async', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  const logger = silentLogger();
  const app = buildWebhookApp({
    logger,
    async handler() {
      throw new Error('processing failed');
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody('app-secret-test', rawBody),
        },
        body: rawBody,
        signal: AbortSignal.timeout(500),
      });

      assert.equal(resp.status, 503);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook responde 400 a estructura firmada invalida sin handler', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  let calls = 0;
  const app = buildWebhookApp({ handler() { calls += 1; } });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = '{"object":"whatsapp_business_account","entry":{}}';
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody('app-secret-test', rawBody),
        },
        body: rawBody,
      });

      assert.equal(resp.status, 400);
      assert.equal(calls, 0);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('WhatsApp Cloud webhook acepta payload valido sin eventos reconocidos', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret-test';
  const received = [];
  const app = buildWebhookApp({ handler(events) { received.push(events); } });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[{"id":"waba-1","changes":[{"field":"account_alerts","value":{"opaque":true}}]}]}';
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signBody('app-secret-test', rawBody),
        },
        body: rawBody,
      });

      assert.equal(resp.status, 200);
      assert.deepEqual(received, [[]]);
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
  }
});

test('raw body queda acotado al montaje del webhook', async () => {
  const app = express();
  app.use('/api/webhooks/whatsapp', whatsappCloudWebhook.createWhatsAppCloudJsonMiddleware());
  app.use(express.json());
  app.post('/otra-ruta', (req, res) => {
    res.json({ hasRawBody: Object.hasOwn(req, 'rawBody') });
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/otra-ruta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"sensitive":"value"}',
    });

    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { hasRawBody: false });
  });
});

test('logging no filtra telefono texto firma ni secret aunque LOG_PAYLOAD=1', async () => {
  const previousSecret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  const previousLogPayload = process.env.WHATSAPP_CLOUD_LOG_PAYLOAD;
  const secret = 'secret-super-sensible';
  process.env.WHATSAPP_CLOUD_APP_SECRET = secret;
  process.env.WHATSAPP_CLOUD_LOG_PAYLOAD = '1';
  const records = [];
  const logger = captureLogger(records);
  const app = buildWebhookApp({ logger });

  try {
    await withServer(app, async (baseUrl) => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[{"id":"waba-1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"phone-sensitive"},"messages":[{"id":"m-1","from":"5491112345678","type":"text","text":{"body":"texto ultra privado"}}]}}]}]}';
      const signature = signBody(secret, rawBody);
      const resp = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      assert.equal(resp.status, 200);
      const serializedLogs = JSON.stringify(records);
      for (const sensitive of ['5491112345678', 'texto ultra privado', signature, secret, 'phone-sensitive']) {
        assert.equal(serializedLogs.includes(sensitive), false, sensitive);
      }
    });
  } finally {
    restoreEnv('WHATSAPP_CLOUD_APP_SECRET', previousSecret);
    restoreEnv('WHATSAPP_CLOUD_LOG_PAYLOAD', previousLogPayload);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function captureLogger(records) {
  return {
    info(...args) { records.push(['info', ...args]); },
    warn(...args) { records.push(['warn', ...args]); },
    error(...args) { records.push(['error', ...args]); },
  };
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
