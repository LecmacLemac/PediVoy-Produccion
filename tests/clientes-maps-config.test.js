import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createWithAuth } from '../src/core/auth.js';
import { createClientesRouter } from '../src/routes/clientes.js';

test('client map config requires real admin/super auth, no business SQL or backend key fallback', async () => {
  const secret = 'synthetic-client-map-auth';
  const users = [
    { id: 1, role: 'admin', empresa_id: 7, activo: true, chofer_id: null, referente_id: null },
    { id: 2, role: 'super', empresa_id: null, activo: true, chofer_id: null, referente_id: null },
    { id: 3, role: 'user', empresa_id: 7, activo: true, chofer_id: null, referente_id: null },
  ];
  const env = { GOOGLE_MAPS_API_KEY: 'synthetic-server-secret' };
  const app = express();
  app.use('/api/clientes', createClientesRouter({
    query: async () => { throw new Error('No business SQL allowed'); },
    withAuth: createWithAuth({ jwtSecret: secret, queryFn: async (_sql, params) => users.filter(u => u.id === params[0]) }),
    mapsBrowserEnv: env,
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/clientes/maps-config`;
    const get = uid => fetch(url, uid ? { headers: { authorization: 'Bearer ' + jwt.sign({ uid, role: users[uid-1].role }, secret) } } : {});
    assert.equal((await get()).status, 401); assert.equal((await get(3)).status, 403);
    const missing = await get(1); assert.equal(missing.status, 503); assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await missing.text(), /synthetic-server-secret/);
    env.GOOGLE_MAPS_BROWSER_API_KEY = 'synthetic-browser-key';
    for (const uid of [1, 2]) { const r = await get(uid); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { apiKey: 'synthetic-browser-key', mapId: 'DEMO_MAP_ID' }); }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
