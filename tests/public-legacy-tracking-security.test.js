import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPublicLegacyPedidosRouter } from '../src/routes/publicLegacyPedidos.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp(query) {
  const app = express();
  app.use('/public', createPublicLegacyPedidosRouter({ query }));
  return app;
}

test('GET /public/pedido-estado sin token queda cerrado para evitar enumeración', async () => {
  const app = buildApp(async () => {
    throw new Error('no debería consultar DB sin token');
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/public/pedido-estado?id=123`);
    const body = await resp.json();

    assert.equal(resp.status, 410);
    assert.equal(body.tracking_required, true);
  });
});

test('GET /public/pedido-chofer-wpp sin token queda cerrado para evitar exposición', async () => {
  const app = buildApp(async () => {
    throw new Error('no debería consultar DB sin token');
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/public/pedido-chofer-wpp?pedido_id=123`);
    const body = await resp.json();

    assert.equal(resp.status, 410);
    assert.equal(body.tracking_required, true);
  });
});

test('GET /public/pedido-estado con token conserva compatibilidad mínima', async () => {
  const app = buildApp(async (sql) => {
    if (sql.includes('FROM items_pedido')) return [];
    return [{
      id: 123,
      estado: 'en_ruta',
      fecha: '2026-06-25T10:00:00.000Z',
      empresa_id: 1,
      tracking_token: 'tok_123',
      cliente: 'Cliente',
      direccion: 'Calle 1',
      latitud: '-32.4',
      longitud: '-63.2',
      monto: 1000,
    }];
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/public/pedido-estado?id=123&token=tok_123`);
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.tracking_url, '/pedidos/seguimiento.html?t=tok_123');
  });
});
