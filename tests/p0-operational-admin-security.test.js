import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createChoferesRouter } from '../src/routes/choferes.js';
import { createAsignacionesZonasRouter } from '../src/routes/asignacionesZonas.js';

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function buildApp({ user, query }) {
  const app = express();
  app.use(express.json());
  const deps = {
    query,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    isSuper: req => req.user?.role === 'super',
    getEmpresaIdFromToken: req => req.user?.empresa_id,
  };
  app.use('/api', createChoferesRouter(deps));
  app.use('/api', createAsignacionesZonasRouter(deps));
  return app;
}

const mutations = [
  { family: 'choferes', method: 'POST', path: '/api/choferes', body: { nombre: 'X' } },
  { family: 'choferes', method: 'PUT', path: '/api/choferes/1', body: { nombre: 'X' } },
  { family: 'choferes', method: 'DELETE', path: '/api/choferes/1' },
  { family: 'upload', method: 'POST', path: '/api/choferes/upload-foto', malformedMultipart: true },
  { family: 'costos', method: 'POST', path: '/api/choferes/1/costos', body: { producto_id: 2, costo_unitario: 3 } },
  { family: 'costos', method: 'PUT', path: '/api/choferes/1/costos/2', body: { costo_unitario: 3 } },
  { family: 'costos', method: 'DELETE', path: '/api/choferes/1/costos/2' },
  { family: 'escalas', method: 'POST', path: '/api/choferes/1/escalas', body: { nombre: 'Base' } },
  { family: 'escalas', method: 'PUT', path: '/api/escalas/1', body: { nombre: 'Base' } },
  { family: 'escalas', method: 'DELETE', path: '/api/escalas/1' },
  { family: 'tramos', method: 'POST', path: '/api/escalas/1/tramos', body: { rango_min: 1, monto: 2 } },
  { family: 'tramos', method: 'PUT', path: '/api/tramos/1', body: { rango_min: 1, monto: 2 } },
  { family: 'tramos', method: 'DELETE', path: '/api/tramos/1' },
  { family: 'zonas', method: 'POST', path: '/api/asignarChofer', body: { chofer_id: 1, zona_id: 2 } },
  { family: 'zonas', method: 'DELETE', path: '/api/desasignarChofer', body: { chofer_id: 1, zona_id: 2 } },
];

async function request(baseUrl, mutation) {
  const headers = {};
  let body;
  if (mutation.malformedMultipart) {
    headers['content-type'] = 'multipart/form-data; boundary=broken';
    body = 'not-a-valid-multipart-body';
  } else if (mutation.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(mutation.body);
  }
  return fetch(`${baseUrl}${mutation.path}`, { method: mutation.method, headers, body });
}

const deniedIdentities = [
  { role: 'repartidor', empresa_id: 3 },
  { role: 'referente', empresa_id: 3 },
  { role: 'user', empresa_id: 3 },
  { role: 'desconocido', empresa_id: 3 },
  { role: 'Admin', empresa_id: 3 },
  { role: ' admin ', empresa_id: 3 },
  { role: 'SUPER', empresa_id: 3 },
  { role: 'admin', type: 'client', empresa_id: 3 },
  { role: 'super', type: 'referente', empresa_id: 3 },
  { role: 'admin', type: null, empresa_id: 3 },
];

test('todas las mutaciones de choferes y zonas rechazan roles no canónicos antes de query o upload', async () => {
  for (const user of deniedIdentities) {
    const calls = [];
    const app = buildApp({
      user,
      query: async (...args) => {
        calls.push(args);
        return [];
      },
    });

    await withServer(app, async baseUrl => {
      for (const mutation of mutations) {
        const response = await request(baseUrl, mutation);
        assert.equal(response.status, 403, `${JSON.stringify(user)} ${mutation.method} ${mutation.path}`);
        assert.deepEqual(await response.json(), { error: 'Acceso denegado' });
      }
    });

    assert.equal(calls.length, 0, `${JSON.stringify(user)} no debe consultar la base`);
  }
});

test('admin y super canónicos atraviesan el guard de cada familia mutante', async () => {
  const representativeMutations = [
    mutations.find(item => item.family === 'choferes'),
    mutations.find(item => item.family === 'costos'),
    mutations.find(item => item.family === 'escalas'),
    mutations.find(item => item.family === 'tramos'),
    mutations.find(item => item.family === 'zonas'),
  ];

  for (const role of ['admin', 'super']) {
    for (const mutation of representativeMutations) {
      let queryCalls = 0;
      const app = buildApp({
        user: { role, type: 'user', empresa_id: 3 },
        query: async () => {
          queryCalls += 1;
          return [{ id: 1, empresa_id: 3 }];
        },
      });
      await withServer(app, async baseUrl => {
        const response = await request(baseUrl, mutation);
        assert.notEqual(response.status, 403, `${role} ${mutation.family}`);
      });
      assert.ok(queryCalls > 0, `${role} ${mutation.family} debe llegar al handler`);
    }
  }
});
