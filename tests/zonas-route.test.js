import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createZonasRouter } from '../src/routes/zonas.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({ query, user = { role: 'user', empresa_id: 3 } } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/zonas', createZonasRouter({
    query,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return app;
}

test('POST /api/zonas guarda dias_entrega normalizados', async () => {
  let insertParams = null;
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO zonas_geograficas')) {
        insertParams = params;
        return [{ id: 22 }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/zonas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Norte',
        dias_entrega: [4, '2', 9, 2, null],
        poligono: [[-24.8, -65.4], [-24.7, -65.4], [-24.7, -65.3]],
      }),
    });

    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { id: 22 });
  });

  assert.ok(insertParams);
  assert.equal(insertParams[0], 3);
  assert.equal(insertParams[1], 'Norte');
  assert.equal(insertParams[2], '[2,4]');
});

test('PUT /api/zonas actualiza dias_entrega cuando vienen en payload', async () => {
  let updateParams = null;
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('SELECT id FROM zonas_geograficas')) return [{ id: 22 }];
      if (sql.includes('UPDATE zonas_geograficas')) {
        updateParams = params;
        return [];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/zonas/22`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'Norte 2', dias_entrega: [1, 6, 6, 'x'] }),
    });

    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  });

  assert.ok(updateParams);
  assert.equal(updateParams[0], 'Norte 2');
  assert.equal(updateParams[1], '[1,6]');
});
