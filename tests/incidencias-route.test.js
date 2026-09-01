import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createSetupRouter } from '../src/routes/setup.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({ query, user = { id: 10, role: 'admin', empresa_id: 1 } }) {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', createSetupRouter({
    query,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return app;
}

test('GET /api/setup/fase3/incidencias/mis-pendientes acepta token con uid', async () => {
  const calls = [];
  const app = buildApp({
    user: { uid: 10, username: 'admin', role: 'admin', empresa_id: 1 },
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM incidencias_operativas i')) return [];
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase3/incidencias/mis-pendientes`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.kpis.total, 0);
  });

  assert.equal(calls[0].params[0], 1);
  assert.equal(calls[0].params[1], 10);
});

test('PUT /api/setup/fase3/incidencias/:id permite limpiar campos anulables', async () => {
  let updateCall;
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('SELECT * FROM incidencias_operativas')) {
        return [{
          id: 7,
          empresa_id: 1,
          estado: 'abierta',
          severidad: 'alta',
          responsable_usuario_id: 33,
          vence_at: '2026-09-01T12:00:00.000Z',
        }];
      }

      if (sql.includes('UPDATE incidencias_operativas')) {
        updateCall = { sql, params };
        return [{
          id: 7,
          estado: 'en_progreso',
          severidad: 'alta',
          responsable_usuario_id: null,
          vence_at: null,
        }];
      }

      if (sql.includes('INSERT INTO incidencias_operativas_historial')) {
        return [];
      }

      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase3/incidencias/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        estado: 'en_progreso',
        responsable_usuario_id: null,
        vence_at: null,
        accion_recomendada: null,
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
  });

  assert.ok(updateCall);
  assert.match(updateCall.sql, /CASE WHEN \$13 THEN \$14 ELSE responsable_usuario_id END/);
  assert.equal(updateCall.params[4], true);
  assert.equal(updateCall.params[5], 'en_progreso');
  assert.equal(updateCall.params[10], true);
  assert.equal(updateCall.params[11], null);
  assert.equal(updateCall.params[12], true);
  assert.equal(updateCall.params[13], null);
  assert.equal(updateCall.params[14], true);
  assert.equal(updateCall.params[15], null);
});
