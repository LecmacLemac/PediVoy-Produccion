import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createEmpresasRouter } from '../src/routes/empresas.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({ query, user = { role: 'admin', empresa_id: 3 } }) {
  const app = express();
  app.use(express.json());
  app.use('/api/empresas', createEmpresasRouter({
    query,
    pool: {},
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
    resolveEmpresaId(req) {
      return req.user?.empresa_id;
    },
    getEmpresaById: async () => null,
  }));
  return app;
}

test('admin puede editar perfil de su propia empresa sin cambiar campos superadmin', async () => {
  let updateCall = null;
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('UPDATE empresas')) {
        updateCall = { sql, params };
        return [{
          id: 3,
          nombre: params[0],
          telefono: params[1],
          email: params[2],
          landing_slug: 'slug-original',
          plan_estado: 'active',
          plan_tipo: 'pro',
          config_integraciones: { pagos: { proveedor: 'mercado_pago' } },
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas/3`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Mi Empresa Editada',
        telefono: '3515550000',
        email: 'admin@empresa.test',
        landing_slug: 'slug-atacante',
        plan_estado: 'expired',
        plan_tipo: 'enterprise',
        config_integraciones: { pagos: { access_token: 'secreto' } },
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.nombre, 'Mi Empresa Editada');
    assert.equal(body.landing_slug, 'slug-original');
    assert.equal(body.plan_estado, 'active');
  });

  assert.ok(updateCall);
  assert.equal(updateCall.params[13], null);
  assert.equal(updateCall.params[21], null);
  assert.equal(updateCall.params[22], null);
  assert.equal(updateCall.params[23], null);
  assert.equal(updateCall.params[24], null);
  assert.equal(updateCall.params[25], null);
  assert.equal(updateCall.params[27], '3');
});

test('admin no puede editar una empresa ajena', async () => {
  const app = buildApp({
    query: async () => {
      throw new Error('No debe consultar DB si intenta editar empresa ajena');
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas/4`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Empresa Ajena' }),
    });

    assert.equal(resp.status, 403);
    assert.match((await resp.json()).error, /tu empresa/);
  });
});

test('superadmin conserva edicion completa de empresa', async () => {
  let updateCall = null;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql, params = []) => {
      if (sql.includes('SELECT config_integraciones FROM empresas')) {
        return [{ config_integraciones: {} }];
      }
      if (sql.includes('UPDATE empresas')) {
        updateCall = { sql, params };
        return [{
          id: 7,
          nombre: params[0],
          landing_slug: params[13],
          plan_estado: params[22],
          plan_tipo: params[23],
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Empresa Super',
        landing_slug: 'empresa-super',
        plan_estado: 'active',
        plan_tipo: 'enterprise',
        config_integraciones: { pagos: { proveedor: 'mercado_pago' } },
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.landing_slug, 'empresa-super');
    assert.equal(body.plan_tipo, 'enterprise');
  });

  assert.ok(updateCall);
  assert.equal(updateCall.params[13], 'empresa-super');
  assert.equal(updateCall.params[22], 'active');
  assert.equal(updateCall.params[23], 'enterprise');
  assert.equal(typeof updateCall.params[21], 'string');
});
