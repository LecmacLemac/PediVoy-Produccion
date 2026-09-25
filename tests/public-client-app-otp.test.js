import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPublicClientAppRouter } from '../src/routes/publicClientApp.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

function buildApp({ query, pool }) {
  const app = express();
  app.use(express.json());
  app.use('/api/public/app', createPublicClientAppRouter({ query, pool }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/public/app/auth/request-otp normaliza teléfono local para WhatsApp', async () => {
  let inserted = null;
  const query = async (sql) => { throw new Error(`SQL inesperado en test: ${String(sql).slice(0, 90)}`); };
  const pool = createWppEnqueueTestPool({
    configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
    onQuery(request) {
      if (/INSERT INTO wpp_outbox/.test(request.text)) inserted = request;
      return undefined;
    },
  });

  const app = buildApp({ query, pool });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/public/app/auth/request-otp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.91',
      },
      body: JSON.stringify({
        empresa_id: 1,
        telefono: '353 427-7739',
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
  });

  assert.ok(inserted);
  assert.equal(inserted.values[0], 1);
  assert.equal(inserted.values[1], '5493534277739');
  assert.match(inserted.values[2], /PediVoy: tu código de ingreso es \d{6}/);
  assert.equal(inserted.values[3], 'cloud');
});
