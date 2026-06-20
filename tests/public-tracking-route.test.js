import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createTrackingPublicRouter } from '../src/trackingPublic.js';

function buildApp(queryFn) {
  const app = express();
  app.use('/api/public', createTrackingPublicRouter({ queryFn }));
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

function pedido(overrides = {}) {
  return {
    id: 123,
    estado: 'en_ruta',
    fecha: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    fecha_entrega: null,
    cliente: 'Cliente Test',
    direccion: 'Calle Test 123',
    ciudad: 'Villa Maria',
    provincia: 'Cordoba',
    dest_lat: '-32.4',
    dest_lng: '-63.2',
    chofer_nombre: 'Chofer Test',
    chofer_tel: '+5493530000000',
    monto: 7000,
    metodo_pago: 'efectivo',
    empresa_nombre: 'Empresa Test',
    empresa_logo_url: null,
    ...overrides,
  };
}

test('GET /api/public/tracking/:token muestra pedidos pendientes con token', async () => {
  let calls = 0;
  const app = buildApp(async (sql) => {
    calls += 1;
    if (sql.includes('FROM items_pedido')) {
      return [{ producto: 'Bidón 20L', cantidad: 2, precio_unitario: 3500 }];
    }
    return [pedido({ estado: 'pendiente' })];
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/public/tracking/token-pendiente`);
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.pedido.estado, 'pendiente');
    assert.equal(body.pedido.items[0].producto, 'Bidón 20L');
    assert.equal(calls, 2);
  });
});

test('GET /api/public/tracking/:token permite pedidos en camino y devuelve ubicación', async () => {
  const app = buildApp(async (sql) => {
    if (sql.includes('FROM pedido_track_points')) {
      return [{ latitud: '-32.41', longitud: '-63.21', timestamp: '2026-05-12T19:00:00.000Z' }];
    }
    if (sql.includes('FROM items_pedido')) return [];
    return [pedido({ estado: 'en_camino' })];
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/public/tracking/token-en-camino`);
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.pedido.estado, 'en_camino');
    assert.equal(body.driverLocation.latitud, '-32.41');
  });
});

test('GET /api/public/tracking/:token no vence pedidos activos por antiguedad', async () => {
  const prevTtl = process.env.TRACK_TTL_HOURS;
  process.env.TRACK_TTL_HOURS = '0.001';

  const app = buildApp(async (sql) => {
    if (sql.includes('FROM pedido_track_points')) return [];
    if (sql.includes('FROM items_pedido')) return [];
    return [pedido({ estado: 'en_ruta' })];
  });

  try {
    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/public/tracking/token-viejo-activo`);
      const body = await resp.json();

      assert.equal(resp.status, 200);
      assert.equal(body.pedido.estado, 'en_ruta');
    });
  } finally {
    if (prevTtl == null) delete process.env.TRACK_TTL_HOURS;
    else process.env.TRACK_TTL_HOURS = prevTtl;
  }
});
