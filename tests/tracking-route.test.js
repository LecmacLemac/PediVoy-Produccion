import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createTrackingRouter } from '../src/routes/tracking.js';

function buildApp(queryFn) {
  const app = express();
  app.use(express.json());
  app.use('/api/track', createTrackingRouter({
    queryFn,
    withAuthFn: (req, res, next) => {
      req.user = {
        id: 11,
        chofer_id: 7,
        empresa_id: 3,
        username: 'chofer-test',
        role: 'repartidor',
      };
      next();
    },
  }));
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

test('POST /api/track/location guarda coordenadas reales del repartidor', async () => {
  const calls = [];
  const app = buildApp(async (sql, params) => {
    calls.push({ sql, params });

    if (sql.includes('FROM pedidos')) {
      return [{ id: 42, empresa_id: 3, chofer_id: 7, estado: 'en_camino' }];
    }

    if (sql.includes('INSERT INTO pedido_track_points')) {
      return [];
    }

    throw new Error(`Consulta inesperada: ${sql}`);
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/track/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pedido_id: 42,
        lat: -32.410123,
        lng: -63.210456,
        accuracy: 18,
      }),
    });

    const body = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
  });

  const insert = calls.find((call) => call.sql.includes('INSERT INTO pedido_track_points'));
  assert.ok(insert);
  assert.deepEqual(insert.params, [42, -32.410123, -63.210456, 'gps', 18, null, null]);
});

test('POST /api/track/location rechaza coordenadas 0,0', async () => {
  let dbTouched = false;
  const app = buildApp(async () => {
    dbTouched = true;
    return [];
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/track/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pedido_id: 42,
        lat: 0,
        lng: 0,
      }),
    });

    const body = await resp.json();
    assert.equal(resp.status, 400);
    assert.equal(body.error, 'Coordenadas inválidas');
  });

  assert.equal(dbTouched, false);
});
