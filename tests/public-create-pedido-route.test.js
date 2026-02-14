import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';

function buildTestApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const noop = async () => null;
  const query = overrides.query || (async () => []);

  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    geocodeIfNeeded: overrides.geocodeIfNeeded || noop,
    normalizePhone: overrides.normalizePhone || ((v) => String(v || '').replace(/\D+/g, '')),
    pointInAnyZone: overrides.pointInAnyZone || (async () => null),
    enqueueWppMessage: overrides.enqueueWppMessage || noop,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: overrides.getAliasEmpresa || (async () => null),
    ejecutarEstrategiaVecinosFn: overrides.ejecutarEstrategiaVecinosFn || (async () => null),
  });

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

test('POST /public/pedidos rechaza payload inválido sin tocar DB', async () => {
  let queryCalls = 0;
  const app = buildTestApp({
    query: async () => {
      queryCalls += 1;
      return [];
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/public/pedidos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ empresa_id: 1 }),
    });

    assert.equal(resp.status, 400);
    assert.ok(resp.headers.get('x-request-id'));

    const body = await resp.json();
    assert.equal(body.error, 'payload inválido');
    assert.ok(Array.isArray(body.details));
    assert.equal(queryCalls, 0);
  });
});
