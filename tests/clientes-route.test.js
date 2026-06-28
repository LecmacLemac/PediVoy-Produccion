import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createClientesRouter } from '../src/routes/clientes.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function isSchemaQuery(sql) {
  return /ALTER TABLE/i.test(sql);
}

function buildApp({
  query,
  user = { role: 'user', empresa_id: 3 },
  geocodeIfNeeded = async () => ({ lat: -32.4113, lng: -63.2374 }),
  pointInAnyZone = async () => 7,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/clientes', createClientesRouter({
    query,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    checkLicencia(_req, _res, next) {
      next();
    },
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
    normalizePhone(value) {
      return String(value || '').replace(/\D/g, '');
    },
    geocodeIfNeeded,
    pointInAnyZone,
  }));
  return app;
}

test('PUT /api/clientes/:id actualiza pin y devuelve latitud, longitud y zona', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM puntos_entrega WHERE id=$1 AND empresa_id=$2')) return [{ id: 45 }];
      if (sql.includes('FROM zonas_geograficas')) return [{ id: 7 }];
      if (sql.includes('UPDATE puntos_entrega')) {
        return [{ id: 45, latitud: -32.4113, longitud: -63.2374, zona_id: 7 }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/clientes/45`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitud: '-32.4113', longitud: '-63.2374', zona_id: 7 }),
    });
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.cliente.latitud, -32.4113);
    assert.equal(body.cliente.longitud, -63.2374);
    assert.equal(body.cliente.zona_id, 7);
  });

  const updateCall = calls.find(c => c.sql.includes('UPDATE puntos_entrega'));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.params.slice(0, 3), [-32.4113, -63.2374, 7]);
});

test('POST /api/clientes/geocode usa país de la empresa', async () => {
  let geocodeArgs = null;
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('FROM empresas')) {
        assert.deepEqual(params, [3]);
        return [{ ciudad: 'Montevideo', provincia: 'Montevideo', pais: 'Uruguay', config_operativa: {} }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    geocodeIfNeeded: async (args) => {
      geocodeArgs = args;
      return { lat: -34.905, lng: -56.191 };
    },
    pointInAnyZone: async () => null,
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/clientes/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direccion: '18 de Julio 1234' }),
    });
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.equal(body.latitud, -34.905);
    assert.equal(body.longitud, -56.191);
  });

  assert.deepEqual(geocodeArgs, {
    direccion: '18 de Julio 1234',
    ciudad: 'Montevideo',
    provincia: 'Montevideo',
    pais: 'Uruguay',
  });
});

test('POST /api/clientes/geocode rechaza coordenadas 0,0', async () => {
  const app = buildApp({
    query: async (sql) => {
      if (sql.includes('FROM empresas')) {
        return [{ ciudad: 'Córdoba', provincia: 'Córdoba', pais: 'Argentina', config_operativa: {} }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    geocodeIfNeeded: async () => ({ lat: 0, lng: 0 }),
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/clientes/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direccion: 'Dirección sin precisión' }),
    });
    const body = await resp.json();

    assert.equal(resp.status, 404);
    assert.match(body.error, /No se pudo ubicar/);
  });
});

test('PUT /api/clientes/:id rechaza zona de otra empresa', async () => {
  const app = buildApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM puntos_entrega WHERE id=$1 AND empresa_id=$2')) return [{ id: 45 }];
      if (sql.includes('FROM zonas_geograficas')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/clientes/45`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitud: '-32.4113', longitud: '-63.2374', zona_id: 99 }),
    });
    const body = await resp.json();

    assert.equal(resp.status, 400);
    assert.match(body.error, /Zona no pertenece/);
  });
});

test('PUT /api/clientes/:id rechaza coordenadas inválidas', async () => {
  const app = buildApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM puntos_entrega WHERE id=$1 AND empresa_id=$2')) return [{ id: 45 }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/clientes/45`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitud: 'abc', longitud: '-63.2374' }),
    });
    const body = await resp.json();

    assert.equal(resp.status, 400);
    assert.match(body.error, /Latitud inválida/);
  });
});
