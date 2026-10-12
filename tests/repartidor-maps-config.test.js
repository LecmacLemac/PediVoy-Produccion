import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createWithAuth } from '../src/core/auth.js';
import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';

// Synthetic identities only; no application database or server startup.
export async function mapsHarness(env = {}) {
  const secret = 'synthetic-maps-test-only';
  const users = [
    { id: 1, role: 'repartidor', empresa_id: 7, chofer_id: 4, referente_id: null, activo: true, chofer_valid: true },
    { id: 2, role: 'admin', empresa_id: 7, chofer_id: null, referente_id: null, activo: true },
  ];
  const app = express();
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async () => { throw new Error('Maps configuration must not query domain data'); },
    getEmpresaIdFromToken: req => req.user.empresa_id,
    withAuth: createWithAuth({ jwtSecret: secret, queryFn: async (_sql, args) => users.filter(u => u.id === args[0]) }),
    mapsBrowserEnv: env,
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { app, server, origin: `http://127.0.0.1:${server.address().port}`, token: uid => jwt.sign({ uid, role: uid === 1 ? 'repartidor' : 'admin' }, secret), close: () => new Promise(resolve => server.close(resolve)) };
}

test('server geocoding key is never exposed when browser key is absent', async () => {
  const h = await mapsHarness({ GOOGLE_MAPS_API_KEY: 'synthetic-server-secret' });
  try {
    const response = await fetch(`${h.origin}/api/repartidor/maps-config`, { headers: { authorization: `Bearer ${h.token(1)}` } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /synthetic-server-secret/);
  } finally { await h.close(); }
});

test('pilot uses DEMO_MAP_ID only when map id is not configured', async () => {
  const h = await mapsHarness({ GOOGLE_MAPS_BROWSER_API_KEY: 'synthetic-browser-key' });
  try {
    const response = await fetch(`${h.origin}/api/repartidor/maps-config`, { headers: { authorization: `Bearer ${h.token(1)}` } });
    assert.deepEqual(await response.json(), { apiKey: 'synthetic-browser-key', mapId: 'DEMO_MAP_ID' });
  } finally { await h.close(); }
});

test('browser map configuration requires real authentication and exact linked driver role', async () => {
  const h = await mapsHarness({ GOOGLE_MAPS_BROWSER_API_KEY: 'synthetic-browser-key', GOOGLE_MAPS_MAP_ID: 'synthetic-map-id' });
  try {
    const url = `${h.origin}/api/repartidor/maps-config`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${h.token(2)}` } })).status, 403);
    const response = await fetch(url, { headers: { authorization: `Bearer ${h.token(1)}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { apiKey: 'synthetic-browser-key', mapId: 'synthetic-map-id' });
  } finally { await h.close(); }
});
