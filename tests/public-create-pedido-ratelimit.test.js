import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /public/pedidos aplica rate limit por IP', async () => {
  const app = express();
  app.use(express.json());

  registerPublicLegacyCreatePedidoRoute(app, {
    query: async () => [],
    geocodeIfNeeded: async () => null,
    normalizePhone: (v) => String(v || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => null,
    enqueueWppMessage: async () => null,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => null,
    ejecutarEstrategiaVecinosFn: async () => null,
  });

  const payload = {
    empresa_id: 1,
    cliente: 'A',
    telefono: '1',
    direccion: 'X',
    items: [{ producto: 'Bidón', cantidad: 1, precio_unitario: 1000 }],
  };

  await withServer(app, async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '2.2.2.2' };

    let lastStatus = null;
    for (let i = 0; i < 21; i += 1) {
      const r = await fetch(`${baseUrl}/public/pedidos`, { method: 'POST', headers, body: JSON.stringify(payload) });
      lastStatus = r.status;
    }

    assert.equal(lastStatus, 429);
  });
});
