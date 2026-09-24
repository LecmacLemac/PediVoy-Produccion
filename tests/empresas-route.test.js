import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

function buildApp({ query, user = { role: 'admin', empresa_id: 3 }, ensureEmpresaWppWorker }) {
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
    ...(ensureEmpresaWppWorker ? { ensureEmpresaWppWorker } : {}),
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

test('consulta QR de empresa desconectada arranca worker de recuperación sin resetear sesión', async () => {
  const workerCalls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/empresas', createEmpresasRouter({
    query: async (sql) => {
      if (sql.includes('ALTER TABLE empresas')) return [];
      if (sql.includes('SELECT id, nombre, rubro, etiquetas')) {
        return [{
          id: 1,
          nombre: 'AguaHidro.com',
          rubro: null,
          etiquetas: null,
          landing_slug: null,
          landing_domain: null,
          prompt_ia_vendedor: null,
          prompt_ia_general: null,
          wpp_status: 'disconnected',
          wpp_qr_code: null,
          wpp_reset_requested_at: null,
          updated_at: new Date('2026-09-21T16:44:40.000Z'),
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    pool: {},
    withAuth(req, _res, next) { req.user = { role: 'super', empresa_id: null }; next(); },
    isSuper(req) { return String(req.user?.role || '').toLowerCase() === 'super'; },
    getEmpresaIdFromToken(req) { return req.user?.empresa_id; },
    resolveEmpresaId(req) { return req.user?.empresa_id; },
    getEmpresaById: async () => null,
    ensureEmpresaWppWorker: (empresaId) => {
      workerCalls.push(empresaId);
      return { started: true, pid: 1234 };
    },
  }));

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas/1/whatsapp-qr`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.status, 'disconnected');
    assert.equal(body.has_qr, false);
    assert.deepEqual(body.worker, { started: true, pid: 1234 });
  });

  assert.deepEqual(workerCalls, [1]);
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

test('POST de empresa persiste solo la allowlist WhatsApp sin alterar campos publicos de pagos', async () => {
  let persistedIntegraciones;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO empresas')) {
        persistedIntegraciones = JSON.parse(params[21]);
        return [{
          id: 7,
          nombre: 'Empresa Cloud',
          config_integraciones: {
            ...persistedIntegraciones,
            whatsapp: {
              ...persistedIntegraciones.whatsapp,
              access_token: 'legacy-token',
              app_secret: 'legacy-secret',
              arbitrary: 'legacy-arbitrary',
            },
          },
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Empresa Cloud',
        config_integraciones: {
          pagos: { proveedor: 'mercado_pago', public_key: 'public-safe' },
          whatsapp: {
            provider: 'cloud',
            enabled: true,
            phone_number_id: 'phone-safe',
            access_token: 'incoming-token',
            app_secret: 'incoming-secret',
            arbitrary: 'incoming-arbitrary',
          },
        },
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.config_integraciones.whatsapp, {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-safe',
    });
    assert.equal(body.config_integraciones.pagos.proveedor, 'mercado_pago');
    assert.equal(body.config_integraciones.pagos.public_key, 'public-safe');
    assert.equal(JSON.stringify(body).includes('legacy-'), false);
  });

  assert.deepEqual(persistedIntegraciones.whatsapp, {
    provider: 'cloud',
    enabled: true,
    phone_number_id: 'phone-safe',
  });
  assert.deepEqual(persistedIntegraciones.pagos, {
    proveedor: 'mercado_pago',
    public_key: 'public-safe',
    access_token_encrypted: null,
    webhook_secret_encrypted: null,
  });
  assert.equal(JSON.stringify(persistedIntegraciones).includes('incoming-'), false);
});

test('GET de empresas aplica allowlist WhatsApp y conserva la redaccion existente de pagos', async () => {
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql) => {
      if (sql.includes('SELECT * FROM empresas ORDER BY id')) {
        return [{
          id: 7,
          config_integraciones: {
            pagos: {
              proveedor: 'mercado_pago',
              public_key: 'public-safe',
              access_token_encrypted: 'encrypted-token',
              webhook_secret_encrypted: 'encrypted-secret',
            },
            whatsapp: {
              provider: 'cloud',
              enabled: true,
              phone_number_id: 'phone-public',
              access_token: 'legacy-token',
              app_secret: 'legacy-secret',
              arbitrary: 'legacy-arbitrary',
            },
          },
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas`);
    assert.equal(resp.status, 200);
    const [empresa] = await resp.json();
    assert.deepEqual(empresa.config_integraciones.whatsapp, {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-public',
    });
    assert.deepEqual(empresa.config_integraciones.pagos, {
      proveedor: 'mercado_pago',
      public_key: 'public-safe',
      access_token_configured: true,
      webhook_secret_configured: true,
    });
    assert.equal(JSON.stringify(empresa).includes('encrypted-'), false);
    assert.equal(JSON.stringify(empresa).includes('legacy-'), false);
  });
});

test('superadmin no persiste ni recibe secretos de configuracion WhatsApp Cloud', async () => {
  let persistedIntegraciones;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql, params = []) => {
      if (sql.includes('SELECT config_integraciones FROM empresas')) {
        return [{ config_integraciones: {} }];
      }
      if (sql.includes('UPDATE empresas')) {
        persistedIntegraciones = JSON.parse(params[21]);
        return [{
          id: 7,
          nombre: 'Empresa Cloud',
          config_integraciones: {
            ...persistedIntegraciones,
            whatsapp: {
              ...persistedIntegraciones.whatsapp,
              access_token: 'legacy-token',
              app_secret: 'legacy-secret',
              unexpected: 'legacy-value',
            },
          },
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
        config_integraciones: {
          whatsapp: {
            provider: 'cloud',
            enabled: true,
            phone_number_id: 'phone-safe',
            access_token: 'incoming-token',
            app_secret: 'incoming-secret',
            unexpected: 'incoming-value',
          },
        },
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.config_integraciones.whatsapp, {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-safe',
    });
    assert.equal(JSON.stringify(body).includes('legacy-'), false);
  });

  assert.deepEqual(persistedIntegraciones.whatsapp, {
    provider: 'cloud',
    enabled: true,
    phone_number_id: 'phone-safe',
  });
  assert.equal(JSON.stringify(persistedIntegraciones).includes('incoming-'), false);
});

test('PUT parcial conserva pagos cifrados, WhatsApp allowlisted y una integracion hermana', async () => {
  let persistedIntegraciones;
  const existingIntegraciones = {
    pagos: {
      proveedor: 'mercado_pago',
      public_key: 'public-existing',
      access_token_encrypted: 'v1:token-cifrado',
      webhook_secret_encrypted: 'v1:webhook-cifrado',
    },
    whatsapp: {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-existing',
      access_token: 'legacy-token',
      app_secret: 'legacy-secret',
      unexpected: 'legacy-value',
    },
    envios: { proveedor: 'correo', sucursal: 'centro' },
  };
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql, params = []) => {
      if (sql.includes('SELECT config_integraciones FROM empresas')) {
        return [{ config_integraciones: existingIntegraciones }];
      }
      if (sql.includes('UPDATE empresas')) {
        persistedIntegraciones = JSON.parse(params[21]);
        return [{ id: 7, nombre: 'Empresa Cloud', config_integraciones: persistedIntegraciones }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config_integraciones: {
          pagos: { auto_confirmar: true, access_token: '********' },
        },
      }),
    });

    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.config_integraciones.whatsapp, {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-existing',
    });
    assert.deepEqual(body.config_integraciones.envios, { proveedor: 'correo', sucursal: 'centro' });
    assert.equal(body.config_integraciones.pagos.public_key, 'public-existing');
    assert.equal(body.config_integraciones.pagos.auto_confirmar, true);
    assert.equal(body.config_integraciones.pagos.access_token_configured, true);
    assert.equal(body.config_integraciones.pagos.webhook_secret_configured, true);
    assert.equal(JSON.stringify(body).includes('legacy-'), false);
    assert.equal(JSON.stringify(body).includes('v1:'), false);
  });

  assert.deepEqual(persistedIntegraciones, {
    pagos: {
      proveedor: 'mercado_pago',
      public_key: 'public-existing',
      auto_confirmar: true,
      access_token_encrypted: 'v1:token-cifrado',
      webhook_secret_encrypted: 'v1:webhook-cifrado',
    },
    whatsapp: {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-existing',
    },
    envios: { proveedor: 'correo', sucursal: 'centro' },
  });
  assert.equal(JSON.stringify(persistedIntegraciones).includes('legacy-'), false);
});

test('conflicto de phone_number_id Cloud devuelve un error sanitizado y util', async () => {
  const originalConsoleError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args);
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql) => {
      if (sql.includes('SELECT config_integraciones FROM empresas')) return [{ config_integraciones: {} }];
      if (sql.includes('UPDATE empresas')) {
        const error = new Error('duplicate key value contains sensitive details');
        error.code = '23505';
        error.constraint = 'idx_empresas_whatsapp_cloud_phone_number_id_unique';
        throw error;
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config_integraciones: {
            whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'sensitive-phone' },
          },
        }),
      });

      assert.equal(resp.status, 400);
      const body = await resp.json();
      assert.match(body.error, /phone_number_id|WhatsApp Cloud/i);
      assert.doesNotMatch(body.error, /dominio o slug/i);
      assert.equal(JSON.stringify(body).includes('sensitive-phone'), false);
      assert.equal(JSON.stringify(body).includes('duplicate key'), false);
    });
  } finally {
    console.error = originalConsoleError;
  }
  const renderedLogs = errorLogs.flat().map(value => String(value?.stack || value)).join('\n');
  assert.equal(renderedLogs.includes('sensitive details'), false);
  assert.equal(renderedLogs.includes('duplicate key'), false);
});

test('backup de empresa tampoco expone secretos ni claves arbitrarias de WhatsApp', async () => {
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql) => {
      if (sql.includes('SELECT * FROM empresas WHERE id')) {
        return [{
          id: 7,
          nombre: 'Empresa Backup',
          config_integraciones: {
            whatsapp: {
              provider: 'cloud',
              enabled: true,
              phone_number_id: 'phone-public',
              access_token: 'backup-token',
              app_secret: 'backup-secret',
              arbitrary: 'backup-arbitrary',
            },
          },
        }];
      }
      if (sql.includes('FROM information_schema.columns')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/empresas/7/backup`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.deepEqual(body.empresa.config_integraciones.whatsapp, {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-public',
    });
    assert.equal(JSON.stringify(body).includes('backup-token'), false);
    assert.equal(JSON.stringify(body).includes('backup-secret'), false);
    assert.equal(JSON.stringify(body).includes('backup-arbitrary'), false);
  });
});

test('reset de WhatsApp empresa sólo persiste el marcador, asegura worker y responde 202', async () => {
  const calls = [];
  const workers = [];
  const app = buildApp({
    ensureEmpresaWppWorker: empresaId => {
      workers.push(empresaId);
      return { started: true, pid: 555 };
    },
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (sql.includes('ALTER TABLE empresas')) return [];
      if (sql.includes('SELECT id') && sql.includes('FROM empresas')) return [{ id: 3 }];
      if (sql.includes('UPDATE empresas')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/3/whatsapp-reset`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      empresa_id: 3,
      status: 'resetting',
      worker: { started: true, pid: 555 },
    });
  });

  assert.deepEqual(workers, [3]);
  const update = calls.find(call => call.sql.includes('UPDATE empresas'));
  assert.match(update.sql, /wpp_reset_requested_at\s*=\s*NOW\(\)/i);
  assert.match(update.sql, /wpp_status\s*=\s*'resetting'/i);
  assert.doesNotMatch(update.sql, /wpp_qr_code\s*=\s*NULL/i);
  assert.doesNotMatch(update.sql, /DELETE|TRUNCATE/i);

  const source = await readFile(new URL('../src/routes/empresas.js', import.meta.url), 'utf8');
  const start = source.indexOf("router.post('/:id/whatsapp-reset'");
  const end = source.indexOf("router.get('/:id'", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /rmSync|unlink|removeChromiumSingletonLocks/);
});
