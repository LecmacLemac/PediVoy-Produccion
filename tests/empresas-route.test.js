import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';

import {
  createEmpresasRouter,
  redactEmpresaPaymentSecrets,
} from '../src/routes/empresas.js';
import { decryptSecret } from '../src/services/facturacionService.js';
import {
  runTransactionOnLockedClient,
  withEmpresaWhatsappConfigLock,
} from '../src/wpp/companyConfigLock.js';

process.env.FACTURACION_SECRET_KEY ||= 'test-key-empresas-route';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({
  query,
  pool = null,
  withTransaction = async work => work(query),
  user = { role: 'admin', empresa_id: 3 },
  ensureEmpresaWppWorker,
  reconcileEmpresaWppWorker,
  getEmpresaWppWorkerState,
  restoreEmpresaWppWorkerState,
}) {
  const effectivePool = pool || {
    async connect() {
      let txQuery = null;
      let finishTransaction = null;
      let transactionPromise = null;
      return {
        async query(input, params = []) {
          const sql = String(typeof input === 'string' ? input : input.text);
          const values = typeof input === 'string' ? params : input.values || [];
          if (/pg_advisory_lock/i.test(sql) && !/unlock/i.test(sql)) return { rows: [] };
          if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }] };
          if (sql === 'BEGIN') {
            let ready;
            const readyPromise = new Promise(resolve => { ready = resolve; });
            const gate = new Promise((resolve, reject) => {
              finishTransaction = { resolve, reject };
            });
            transactionPromise = withTransaction(async transactionQuery => {
              txQuery = transactionQuery;
              ready();
              return gate;
            });
            await readyPromise;
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            finishTransaction.resolve();
            await transactionPromise;
            txQuery = null;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            finishTransaction.reject(new Error('test transaction rollback'));
            await transactionPromise.catch(() => {});
            txQuery = null;
            return { rows: [] };
          }
          return { rows: await (txQuery || query)(sql, values) };
        },
        release() {},
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/empresas', createEmpresasRouter({
    query,
    pool: effectivePool,
    withTransaction,
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
    ...(reconcileEmpresaWppWorker ? { reconcileEmpresaWppWorker } : {}),
    ...(getEmpresaWppWorkerState ? { getEmpresaWppWorkerState } : {}),
    ...(restoreEmpresaWppWorkerState ? { restoreEmpresaWppWorkerState } : {}),
  }));
  return app;
}

function createAmbiguousCommitPool({ initialConfig, nextCommitOutcome, failReadback = false }) {
  let durable = structuredClone(initialConfig);
  let connects = 0;
  const releases = [];
  let firstCommit = true;

  return {
    pool: {
      async connect() {
        connects += 1;
        let staged = null;
        return {
          async query(input, params = []) {
            const sql = String(typeof input === 'string' ? input : input.text);
            const values = typeof input === 'string' ? params : input.values || [];
            if (/pg_advisory_lock/i.test(sql) && !/unlock/i.test(sql)) return { rows: [] };
            if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }] };
            if (sql === 'BEGIN') { staged = structuredClone(durable); return { rows: [] }; }
            if (sql === 'ROLLBACK') { staged = null; return { rows: [] }; }
            if (sql === 'COMMIT') {
              if (firstCommit) {
                firstCommit = false;
                if (nextCommitOutcome === 'applied') durable = structuredClone(staged);
                staged = null;
                throw new Error('transport failed after COMMIT secret=token-7');
              }
              durable = structuredClone(staged);
              staged = null;
              return { rows: [] };
            }
            if (/SELECT id, config_integraciones FROM empresas/.test(sql)) {
              if (failReadback && !firstCommit) throw new Error('readback failed secret=token-7');
              return { rows: [{ id: 7, config_integraciones: structuredClone(staged ?? durable) }] };
            }
            if (/UPDATE empresas/.test(sql)) {
              const encoded = values.length > 20 ? values[21] : values[0];
              staged = JSON.parse(encoded);
              return { rows: [{ id: 7, config_integraciones: structuredClone(staged) }] };
            }
            throw new Error(`SQL inesperado: ${sql}`);
          },
          release(error) { releases.push(error); },
        };
      },
    },
    get durable() { return structuredClone(durable); },
    get connects() { return connects; },
    get releases() { return releases; },
  };
}

function createSerializedLockPool(events = [], transactionQuery = null) {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  return {
    pool: {
      async connect() {
        let releaseTurn;
        const previous = tail;
        tail = new Promise(resolve => { releaseTurn = resolve; });
        return {
          async query(sql, params = []) {
            const text = String(sql);
            if (/pg_advisory_lock/i.test(text) && !/unlock/i.test(text)) {
              await previous;
              active += 1;
              maxActive = Math.max(maxActive, active);
              events.push('lock');
              return { rows: [] };
            }
            if (/pg_advisory_unlock/i.test(text)) {
              events.push('unlock');
              active -= 1;
              releaseTurn();
              return { rows: [{ unlocked: true }] };
            }
            if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
            if (typeof transactionQuery === 'function') {
              return { rows: await transactionQuery(text, params) };
            }
            throw new Error(`lock SQL inesperado: ${sql}`);
          },
          release() {},
        };
      },
    },
    get active() { return active; },
    get maxActive() { return maxActive; },
  };
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
          config_integraciones: {},
          wpp_status: 'disconnected',
          wpp_qr_code: null,
          wpp_reset_requested_at: null,
          updated_at: new Date('2026-09-21T16:44:40.000Z'),
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    pool: {},
    withTransaction: async work => work(async () => []),
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

test('empresa Cloud activa no arranca ni resetea worker Web', async () => {
  const workerCalls = [];
  const updates = [];
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    ensureEmpresaWppWorker: empresaId => {
      workerCalls.push(empresaId);
      return { started: true };
    },
    query: async (sql) => {
      if (sql.includes('ALTER TABLE empresas')) return [];
      if (sql.includes('FROM empresas') && sql.includes('WHERE id = $1')) {
        return [{
          id: 7,
          nombre: 'Cloud',
          config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } },
          wpp_status: 'connected',
          wpp_qr_code: 'qr-web-existente',
          wpp_reset_requested_at: null,
          updated_at: new Date('2026-09-24T12:00:00.000Z'),
        }];
      }
      if (sql.includes('UPDATE empresas')) {
        updates.push(sql);
        return [];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const qr = await fetch(`${baseUrl}/api/empresas/7/whatsapp-qr`);
    assert.equal(qr.status, 409);
    assert.match((await qr.json()).error, /Cloud/i);

    const reset = await fetch(`${baseUrl}/api/empresas/7/whatsapp-reset`, { method: 'POST' });
    assert.equal(reset.status, 409);
    assert.match((await reset.json()).error, /Cloud/i);
  });

  assert.deepEqual(workerCalls, []);
  assert.deepEqual(updates, []);
});
test('superadmin conserva edicion completa de empresa', async () => {
  let updateCall = null;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async (sql, params = []) => {
      if (sql.includes('config_integraciones FROM empresas')) {
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
            provider: '  ClOuD  ',
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
      access_token_configured: true,
    });
    assert.equal(body.config_integraciones.pagos.proveedor, 'mercado_pago');
    assert.equal(body.config_integraciones.pagos.public_key, 'public-safe');
    assert.equal(JSON.stringify(body).includes('legacy-'), false);
  });

  assert.equal(persistedIntegraciones.whatsapp.provider, 'cloud');
  assert.equal(persistedIntegraciones.whatsapp.enabled, true);
  assert.equal(persistedIntegraciones.whatsapp.phone_number_id, 'phone-safe');
  assert.equal(typeof persistedIntegraciones.whatsapp.access_token_encrypted, 'string');
  assert.equal(persistedIntegraciones.whatsapp.access_token, undefined);
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
      access_token_configured: true,
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
      if (sql.includes('config_integraciones FROM empresas')) {
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
      access_token_configured: true,
    });
    assert.equal(JSON.stringify(body).includes('legacy-'), false);
  });

  assert.equal(persistedIntegraciones.whatsapp.provider, 'cloud');
  assert.equal(persistedIntegraciones.whatsapp.enabled, true);
  assert.equal(persistedIntegraciones.whatsapp.phone_number_id, 'phone-safe');
  assert.equal(typeof persistedIntegraciones.whatsapp.access_token_encrypted, 'string');
  assert.equal(persistedIntegraciones.whatsapp.access_token, undefined);
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
      if (sql.includes('config_integraciones FROM empresas')) {
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
      access_token_configured: true,
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
      access_token_encrypted: persistedIntegraciones.whatsapp.access_token_encrypted,
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
      if (sql.includes('config_integraciones FROM empresas')) return [{ config_integraciones: {} }];
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
            whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'sensitive-phone', access_token: 'token-safe' },
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
      access_token_configured: true,
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
      if (sql.includes('SELECT id') && sql.includes('FROM empresas')) return [{ id: 3, config_integraciones: {} }];
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

test('PUT que activa Cloud reconcilia despues del UPDATE y no inicia worker Web', async () => {
  const events = [];
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    ensureEmpresaWppWorker: () => assert.fail('no debe iniciar worker'),
    reconcileEmpresaWppWorker: async (empresaId, eligible) => {
      events.push(`reconcile:${empresaId}:${eligible}`);
      return { eligible, stopped: true };
    },
    query: async (sql, params = []) => {
      if (sql.includes('config_integraciones FROM empresas')) return [{ config_integraciones: {} }];
      if (sql.includes('UPDATE empresas')) {
        events.push('update');
        return [{ id: 7, nombre: 'Cloud final', config_integraciones: JSON.parse(params[21]) }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } },
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(events, ['update', 'reconcile:7:false']);
});

test('PUT no relacionado con WhatsApp no toca el supervisor', async () => {
  let reconciles = 0;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async () => { reconciles += 1; },
    query: async (sql, params = []) => {
      if (sql.includes('UPDATE empresas')) return [{ id: 7, nombre: params[0], config_integraciones: {} }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Sin cambio WPP' }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(reconciles, 0);
});

test('PUT que vuelve a Web marca elegible sin arrancar worker', async () => {
  const reconciles = [];
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    ensureEmpresaWppWorker: () => assert.fail('no debe iniciar worker'),
    reconcileEmpresaWppWorker: async (empresaId, eligible) => {
      reconciles.push([empresaId, eligible]);
      return { eligible, stopped: false };
    },
    query: async (sql, params = []) => {
      if (sql.includes('config_integraciones FROM empresas')) {
        return [{ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } } }];
      }
      if (sql.includes('UPDATE empresas')) {
        return [{ id: 7, nombre: 'Web final', config_integraciones: JSON.parse(params[21]) }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'web', enabled: true } } }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(reconciles, [[7, true]]);
});

test('fallo al detener worker devuelve 503 sanitizado declarando rollback', async () => {
  let updated = false;
  const originalConsoleError = console.error;
  console.error = () => {};
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async () => {
      throw new Error('SIGKILL failed for pid 9988 /secret/path');
    },
    query: async (sql, params = []) => {
      if (sql.includes('config_integraciones FROM empresas')) return [{ config_integraciones: {} }];
      if (sql.includes('SET config_integraciones = $1')) return [{ id: 7 }];
      if (sql.includes('UPDATE empresas')) {
        updated = true;
        return [{ id: 7, nombre: 'Cloud persistida', config_integraciones: JSON.parse(params[21]) }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'WPP_WORKER_RECONCILE_FAILED');
      assert.equal(body.updated, false);
      assert.equal(body.rolled_back, true);
      assert.equal(JSON.stringify(body).includes('9988'), false);
      assert.equal(JSON.stringify(body).includes('/secret/path'), false);
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(updated, true);
});

test('POST rechaza activación Cloud incompleta antes de INSERT', async () => {
  let inserts = 0;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async sql => {
      if (String(sql).includes('INSERT INTO empresas')) inserts += 1;
      return [];
    },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: 'Cloud incompleta', config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7' } } }),
    });
    assert.equal(response.status, 422);
    assert.equal(JSON.stringify(await response.json()).includes('phone-7'), false);
  });
  assert.equal(inserts, 0);
});

test('PUT rechaza placeholder de token sin cifrado previo antes de UPDATE o reconcile', async () => {
  let updates = 0;
  let reconciles = 0;
  const query = async sql => {
    if (String(sql).includes('SELECT') && String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: {} }];
    if (String(sql).includes('UPDATE empresas')) updates += 1;
    return [];
  };
  const app = buildApp({
    query,
    withTransaction: work => work(query),
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async () => { reconciles += 1; },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: '********' } } }),
    });
    assert.equal(response.status, 422);
  });
  assert.equal(updates, 0);
  assert.equal(reconciles, 0);
});

test('fallo reconcile compensa config comprometida y restaura estado operativo previo', async () => {
  let persisted = { whatsapp: { provider: 'web', enabled: true } };
  const reconciles = [];
  const withTransaction = async work => {
    const before = structuredClone(persisted);
    try {
      return await work(async (sql, params = []) => {
        if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
        if (String(sql).includes('SET config_integraciones = $1')) {
          persisted = JSON.parse(params[0]);
          return [{ id: 7 }];
        }
        if (String(sql).includes('UPDATE empresas')) {
          persisted = JSON.parse(params[21]);
          return [{ id: 7, nombre: 'Cloud', config_integraciones: structuredClone(persisted) }];
        }
        throw new Error(`SQL inesperado: ${sql}`);
      });
    } catch (error) {
      persisted = before;
      throw error;
    }
  };
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'), withTransaction,
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: true, pid: 101 }),
    reconcileEmpresaWppWorker: async (_id, eligible) => {
      reconciles.push(eligible);
      throw new Error('stop failed');
    },
    restoreEmpresaWppWorkerState: async () => ({ restored: true, successorPid: 202 }),
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.updated, false);
    assert.equal(body.rolled_back, true);
  });
  assert.equal(persisted.whatsapp.provider, 'web');
  assert.deepEqual(reconciles, [false]);
});

test('fallo reconcile compensa WhatsApp legacy con snapshot cifrado y no filtra secretos', async () => {
  const legacyToken = 'legacy-whatsapp-token-very-secret';
  const forbiddenAppSecret = 'legacy-meta-app-secret';
  let persisted = {
    whatsapp: {
      provider: 'web', enabled: true, access_token: legacyToken,
      app_secret: forbiddenAppSecret, private_key: 'legacy-private-key',
    },
  };
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);
  const withTransaction = async work => work(async (sql, params = []) => {
    if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    if (String(sql).includes('SET config_integraciones = $1')) {
      persisted = JSON.parse(params[0]);
      return [{ id: 7 }];
    }
    if (String(sql).includes('UPDATE empresas')) {
      persisted = JSON.parse(params[21]);
      return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  });
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'), withTransaction,
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: false }),
    reconcileEmpresaWppWorker: async () => { throw new Error(`stop failed ${legacyToken}`); },
    restoreEmpresaWppWorkerState: async () => ({ restored: true }),
  });
  try {
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'new-token' } } }),
      });
      assert.equal(response.status, 503);
      const body = JSON.stringify(await response.json());
      assert.equal(body.includes(legacyToken), false);
      assert.equal(body.includes(forbiddenAppSecret), false);
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(Object.hasOwn(persisted.whatsapp, 'access_token'), false);
  assert.equal(Object.hasOwn(persisted.whatsapp, 'app_secret'), false);
  assert.equal(Object.hasOwn(persisted.whatsapp, 'private_key'), false);
  assert.equal(decryptSecret(persisted.whatsapp.access_token_encrypted), legacyToken);
  assert.equal(JSON.stringify(logged).includes(legacyToken), false);
  assert.equal(JSON.stringify(logged).includes(forbiddenAppSecret), false);
});

test('fallo reconcile compensa pagos legacy sólo con secretos cifrados', async () => {
  const legacyAccessToken = 'legacy-payment-access-token';
  const legacyWebhookSecret = 'legacy-payment-webhook-secret';
  let persisted = {
    whatsapp: { provider: 'web', enabled: true },
    pagos: { proveedor: 'mercado_pago', access_token: legacyAccessToken, webhook_secret: legacyWebhookSecret },
  };
  const withTransaction = async work => work(async (sql, params = []) => {
    if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    if (String(sql).includes('SET config_integraciones = $1')) {
      persisted = JSON.parse(params[0]);
      return [{ id: 7 }];
    }
    if (String(sql).includes('UPDATE empresas')) {
      persisted = JSON.parse(params[21]);
      return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  });
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'), withTransaction,
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: false }),
    reconcileEmpresaWppWorker: async () => { throw new Error('stop failed'); },
    restoreEmpresaWppWorkerState: async () => ({ restored: true }),
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'new-token' } } }),
    });
    assert.equal(response.status, 503);
    const body = JSON.stringify(await response.json());
    assert.equal(body.includes(legacyAccessToken), false);
    assert.equal(body.includes(legacyWebhookSecret), false);
  });
  assert.equal(Object.hasOwn(persisted.pagos, 'access_token'), false);
  assert.equal(Object.hasOwn(persisted.pagos, 'webhook_secret'), false);
  assert.equal(decryptSecret(persisted.pagos.access_token_encrypted), legacyAccessToken);
  assert.equal(decryptSecret(persisted.pagos.webhook_secret_encrypted), legacyWebhookSecret);
});

test('legacy plaintext sin clave de cifrado falla antes de UPDATE y reconcile', async () => {
  const previousArcaKey = process.env.ARCA_TOKEN_ENCRYPTION_KEY;
  const previousFacturacionKey = process.env.FACTURACION_SECRET_KEY;
  delete process.env.ARCA_TOKEN_ENCRYPTION_KEY;
  delete process.env.FACTURACION_SECRET_KEY;
  let updates = 0;
  let reconciles = 0;
  const query = async sql => {
    if (String(sql).includes('FOR UPDATE')) {
      return [{ id: 7, config_integraciones: { whatsapp: { provider: 'web', enabled: true, access_token: 'legacy-secret' } } }];
    }
    if (String(sql).includes('UPDATE empresas')) updates += 1;
    return [];
  };
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'),
    withTransaction: work => work(query),
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async () => { reconciles += 1; },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { pagos: { proveedor: 'manual' } } }),
      });
      assert.equal(response.status, 500);
      assert.equal(JSON.stringify(await response.json()).includes('legacy-secret'), false);
    });
  } finally {
    console.error = originalConsoleError;
    if (previousArcaKey === undefined) delete process.env.ARCA_TOKEN_ENCRYPTION_KEY;
    else process.env.ARCA_TOKEN_ENCRYPTION_KEY = previousArcaKey;
    if (previousFacturacionKey === undefined) delete process.env.FACTURACION_SECRET_KEY;
    else process.env.FACTURACION_SECRET_KEY = previousFacturacionKey;
  }
  assert.equal(updates, 0);
  assert.equal(reconciles, 0);
});

test('PUT WhatsApp concurrentes quedan serializados y último reconcile coincide con DB', async () => {
  let persisted = { whatsapp: { provider: 'web', enabled: true } };
  let tail = Promise.resolve();
  const reconciles = [];
  const withTransaction = work => {
    const run = tail.then(() => work(async (sql, params = []) => {
      if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
      if (String(sql).includes('UPDATE empresas')) {
        persisted = JSON.parse(params[21]);
        return [{ id: 7, config_integraciones: structuredClone(persisted) }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }));
    tail = run.catch(() => {});
    return run;
  };
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'), withTransaction,
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async (_id, eligible) => { reconciles.push(eligible); },
  });
  await withServer(app, async baseUrl => {
    const cloud = fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
    });
    const web = fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'web', enabled: true } } }),
    });
    assert.deepEqual((await Promise.all([cloud, web])).map(response => response.status), [200, 200]);
  });
  assert.equal(persisted.whatsapp.provider, 'web');
  assert.deepEqual(reconciles, [false, true]);
});

for (const scenario of [
  { outcome: 'applied', expectedProvider: 'cloud', expectedEvents: ['reconcile:false'] },
  { outcome: 'aborted', expectedProvider: 'web', expectedEvents: ['restore:true:false'] },
]) {
  test(`COMMIT ambiguo ${scenario.outcome} relee DB durable y alinea supervisor`, async () => {
    const state = createAmbiguousCommitPool({
      initialConfig: { whatsapp: { provider: 'web', enabled: true } },
      nextCommitOutcome: scenario.outcome,
    });
    const events = [];
    const app = buildApp({
      query: async () => assert.fail('debe usar el client bajo advisory lock'),
      pool: state.pool,
      withTransaction: async () => assert.fail('no debe pedir una segunda conexión transaccional'),
      user: { role: 'super', empresa_id: null },
      getEmpresaWppWorkerState: () => ({ eligible: true, active: false }),
      reconcileEmpresaWppWorker: async (_id, eligible) => { events.push(`reconcile:${eligible}`); },
      restoreEmpresaWppWorkerState: async (_id, workerState) => {
        events.push(`restore:${workerState.eligible}:${workerState.active}`);
        return { restored: true, eligible: workerState.eligible, active: workerState.active };
      },
    });
    const logged = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logged.push(args);
    try {
      await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/empresas/7`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
        });
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.code, 'WPP_CONFIG_TRANSACTION_OUTCOME_UNKNOWN');
        assert.equal(body.rolled_back, false);
        assert.equal(JSON.stringify(body).includes('token-7'), false);
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(state.durable.whatsapp.provider, scenario.expectedProvider);
    assert.deepEqual(events, scenario.expectedEvents);
    assert.equal(state.connects, 2, 'client ambiguo se descarta y recovery toma un lock nuevo');
    assert.equal(Boolean(state.releases[0]), true, 'client ambiguo debe descartarse con release(error)');
    assert.equal(JSON.stringify(logged).includes('token-7'), false);
  });
}

test('COMMIT ambiguo con readback fallido exige recovery sin filtrar secretos', async () => {
  const state = createAmbiguousCommitPool({
    initialConfig: { whatsapp: { provider: 'web', enabled: true } },
    nextCommitOutcome: 'applied',
    failReadback: true,
  });
  const app = buildApp({
    query: async () => assert.fail('debe usar el client bajo advisory lock'),
    pool: state.pool,
    withTransaction: async () => assert.fail('no debe abrir otra transacción'),
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: false }),
  });
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'WPP_WORKER_RECOVERY_REQUIRED');
      assert.equal(body.rolled_back, false);
      assert.equal(JSON.stringify(body).includes('token-7'), false);
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(JSON.stringify(logged).includes('token-7'), false);
});

test('COMMIT ambiguo Cloud a Web no autoarranca un worker previamente inactivo', async () => {
  const state = createAmbiguousCommitPool({
    initialConfig: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-old', access_token_encrypted: 'v1:old' } },
    nextCommitOutcome: 'applied',
  });
  const restoredStates = [];
  const app = buildApp({
    query: async () => assert.fail('debe usar el client bajo advisory lock'),
    pool: state.pool,
    withTransaction: async () => assert.fail('no debe abrir otra transacción'),
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: false, active: false }),
    restoreEmpresaWppWorkerState: async (_id, workerState) => {
      restoredStates.push(workerState);
      return { restored: true, eligible: true, active: false };
    },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'web', enabled: true } } }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'WPP_CONFIG_TRANSACTION_OUTCOME_UNKNOWN');
  });
  assert.equal(state.durable.whatsapp.provider, 'web');
  assert.equal(restoredStates.length, 1);
  assert.equal(restoredStates[0].eligible, true);
  assert.equal(restoredStates[0].active, false);
});

test('transacción bajo advisory lock usa el mismo client y no pide otra conexión', async () => {
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push([String(sql), params]);
      if (String(sql) === 'SELECT durable') return { rows: [{ value: 42 }] };
      return { rows: [] };
    },
  };

  const result = await runTransactionOnLockedClient(client, async txQuery => {
    assert.deepEqual(await txQuery('SELECT durable'), [{ value: 42 }]);
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.deepEqual(statements.map(([sql]) => sql), ['BEGIN', 'SELECT durable', 'COMMIT']);
});

test('advisory lock de empresa usa conexión dedicada, namespace estable y libera en finally', async () => {
  const events = [];
  const client = {
    async query(sql, params) {
      events.push([String(sql), params]);
      return { rows: [{ unlocked: true }] };
    },
    release() { events.push(['release']); },
  };
  const result = await withEmpresaWhatsappConfigLock({ connect: async () => client }, 7, async lockedClient => {
    assert.equal(lockedClient, client);
    events.push(['callback']);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.match(events[0][0], /pg_advisory_lock\(\$1, \$2\)/i);
  assert.equal(events[0][1][1], 7);
  assert.match(events.at(-2)[0], /pg_advisory_unlock\(\$1, \$2\)/i);
  assert.deepEqual(events.at(-1), ['release']);
});

test('PUT WhatsApp confirma COMMIT antes de reconcile y no mantiene row lock durante el stop', async () => {
  const events = [];
  let persisted = { whatsapp: { provider: 'web', enabled: true } };
  let rowLocked = false;
  const lockClient = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/pg_advisory_lock/i.test(text) && !/unlock/i.test(text)) { events.push('advisory-lock'); return { rows: [] }; }
      if (/pg_advisory_unlock/i.test(text)) { events.push('advisory-unlock'); return { rows: [{ unlocked: true }] }; }
      if (text === 'BEGIN') { events.push('begin'); rowLocked = true; return { rows: [] }; }
      if (text === 'COMMIT') { events.push('commit'); rowLocked = false; return { rows: [] }; }
      if (text === 'ROLLBACK') { rowLocked = false; return { rows: [] }; }
      if (text.includes('FOR UPDATE')) return { rows: [{ id: 7, config_integraciones: structuredClone(persisted) }] };
      if (text.includes('UPDATE empresas')) {
        persisted = JSON.parse(params[21]);
        events.push('update');
        return { rows: [{ id: 7, config_integraciones: structuredClone(persisted) }] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    release() { events.push('release'); },
  };
  const app = buildApp({
    query: async () => assert.fail('debe usar el mismo client'),
    pool: { connect: async () => lockClient },
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: true }),
    reconcileEmpresaWppWorker: async () => {
      events.push('reconcile');
      assert.equal(rowLocked, false, 'worker UPDATE must not wait behind empresa row lock');
    },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(events, ['advisory-lock', 'begin', 'update', 'commit', 'reconcile', 'advisory-unlock', 'release']);
});

test('fallo reconcile restaura config y recrea sucesor sólo si el worker Web previo estaba activo', async () => {
  let persisted = { whatsapp: { provider: 'web', enabled: true } };
  const events = [];
  const withTransaction = async work => work(async (sql, params = []) => {
    if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    if (String(sql).includes('SET config_integraciones = $1')) {
      persisted = JSON.parse(params[0]);
      events.push(`db:${persisted.whatsapp.provider}`);
      return [{ id: 7 }];
    }
    if (String(sql).includes('UPDATE empresas')) {
      persisted = JSON.parse(params[21]);
      events.push(`db:${persisted.whatsapp.provider}`);
      return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  });
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'), withTransaction,
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: true, pid: 101 }),
    reconcileEmpresaWppWorker: async () => { events.push('reconcile-cloud'); throw new Error('stop failed'); },
    restoreEmpresaWppWorkerState: async (_id, state) => { events.push(`restore:${state.active}`); return { restored: true, successorPid: 202 }; },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).rolled_back, true);
  });
  assert.equal(persisted.whatsapp.provider, 'web');
  assert.deepEqual(events, ['db:cloud', 'reconcile-cloud', 'db:web', 'restore:true']);
});

test('compensación incompleta responde recovery_required sin fingir rollback completo', async () => {
  let persisted = { whatsapp: { provider: 'web', enabled: true } };
  const originalConsoleError = console.error;
  console.error = () => {};
  const app = buildApp({
    query: async () => assert.fail('debe usar txQuery'),
    withTransaction: async work => work(async (sql, params = []) => {
      if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
      if (String(sql).includes('SET config_integraciones = $1')) {
        const next = JSON.parse(params[0]);
        if (next.whatsapp.provider === 'web' && persisted.whatsapp.provider === 'cloud') throw new Error('recovery db failed secret');
        persisted = next;
        return [{ id: 7 }];
      }
      if (String(sql).includes('UPDATE empresas')) {
        const next = JSON.parse(params[21]);
        persisted = next;
        return [{ id: 7, config_integraciones: structuredClone(persisted) }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }),
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: true }),
    reconcileEmpresaWppWorker: async () => { throw new Error('stop failed'); },
  });
  try {
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'WPP_WORKER_RECOVERY_REQUIRED');
      assert.equal(body.status, 'recovery_required');
      assert.equal(body.rolled_back, false);
      assert.equal(JSON.stringify(body).includes('secret'), false);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('PUT Cloud y PUT pagos usan el mismo lock y preservan ambos estados', async () => {
  let persisted = { whatsapp: { provider: 'web', enabled: true }, pagos: { proveedor: 'manual' } };
  const transactionQuery = async (sql, params = []) => {
    if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    if (String(sql).includes('UPDATE empresas')) {
      persisted = JSON.parse(params[21]);
      return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  const lock = createSerializedLockPool([], transactionQuery);
  let releaseReconcile;
  let reconcileStarted = false;
  const reconciles = [];
  const app = buildApp({
    query: async () => assert.fail('debe usar transacción bajo lock'),
    pool: lock.pool,
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async (_id, eligible) => {
      reconciles.push(eligible);
      reconcileStarted = true;
      await new Promise(resolve => { releaseReconcile = resolve; });
    },
  });

  await withServer(app, async baseUrl => {
    const cloud = fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
    });
    while (!reconcileStarted) await new Promise(resolve => setImmediate(resolve));
    const pagos = fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config_integraciones: { pagos: { proveedor: 'mercado_pago', public_key: 'pk-7' } } }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lock.active, 1);
    releaseReconcile();
    assert.deepEqual((await Promise.all([cloud, pagos])).map(response => response.status), [200, 200]);
  });

  assert.equal(lock.maxActive, 1);
  assert.equal(persisted.whatsapp.provider, 'cloud');
  assert.equal(persisted.pagos.proveedor, 'mercado_pago');
  assert.equal(persisted.pagos.public_key, 'pk-7');
  assert.deepEqual(reconciles, [false]);
});

test('pagos espera la compensación WhatsApp y se aplica sobre la configuración restaurada', async () => {
  let persisted = { whatsapp: { provider: 'web', enabled: true }, pagos: { proveedor: 'manual' } };
  const events = [];
  const transactionQuery = async (sql, params = []) => {
    if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    if (String(sql).includes('SET config_integraciones = $1')) {
      persisted = JSON.parse(params[0]);
      events.push(`restore:${persisted.whatsapp.provider}`);
      return [{ id: 7 }];
    }
    if (String(sql).includes('UPDATE empresas')) {
      persisted = JSON.parse(params[21]);
      events.push(`update:${persisted.whatsapp.provider}:${persisted.pagos.proveedor}`);
      return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  const lock = createSerializedLockPool([], transactionQuery);
  const app = buildApp({
    query: async () => assert.fail('debe usar transacción bajo lock'),
    pool: lock.pool,
    user: { role: 'super', empresa_id: null },
    getEmpresaWppWorkerState: () => ({ eligible: true, active: false }),
    reconcileEmpresaWppWorker: async () => { events.push('reconcile-fail'); throw new Error('stop failed'); },
    restoreEmpresaWppWorkerState: async () => ({ restored: true }),
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withServer(app, async baseUrl => {
      const cloud = fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-7' } } }),
      });
      await new Promise(resolve => setImmediate(resolve));
      const pagos = fetch(`${baseUrl}/api/empresas/7`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_integraciones: { pagos: { proveedor: 'mercado_pago' } } }),
      });
      assert.deepEqual((await Promise.all([cloud, pagos])).map(response => response.status).sort(), [200, 503]);
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(persisted.whatsapp.provider, 'web');
  assert.equal(persisted.pagos.proveedor, 'mercado_pago');
  assert.deepEqual(events, ['update:cloud:manual', 'reconcile-fail', 'restore:web', 'update:web:mercado_pago']);
});

test('redacción WhatsApp expone sólo access_token_configured boolean', () => {
  const configured = redactEmpresaPaymentSecrets({
    id: 7,
    config_integraciones: {
      whatsapp: {
        provider: 'cloud',
        enabled: true,
        phone_number_id: 'phone-7',
        access_token_encrypted: 'v1:encrypted-secret',
        access_token: 'legacy-secret',
        access_token_configured: false,
      },
    },
  });
  assert.deepEqual(configured.config_integraciones.whatsapp, {
    provider: 'cloud',
    enabled: true,
    phone_number_id: 'phone-7',
    access_token_configured: true,
  });
  assert.equal(JSON.stringify(configured).includes('encrypted-secret'), false);
  assert.equal(JSON.stringify(configured).includes('legacy-secret'), false);

  const missing = redactEmpresaPaymentSecrets({
    id: 8,
    config_integraciones: { whatsapp: { provider: 'web', enabled: false } },
  });
  assert.equal(missing.config_integraciones.whatsapp.access_token_configured, false);
});

test('access_token_configured entrante no sustituye un token Cloud', async () => {
  let inserts = 0;
  const app = buildApp({
    user: { role: 'super', empresa_id: null },
    query: async sql => {
      if (String(sql).includes('INSERT INTO empresas')) inserts += 1;
      return [];
    },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/empresas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: 'Cloud sin token',
        config_integraciones: {
          whatsapp: {
            provider: 'cloud',
            enabled: true,
            phone_number_id: 'phone-7',
            access_token_configured: true,
          },
        },
      }),
    });
    assert.equal(response.status, 422);
  });
  assert.equal(inserts, 0);
});

test('dos updates no-WhatsApp se serializan, preservan WhatsApp y no reconcilian', async () => {
  let persisted = { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } };
  const transactionQuery = async (sql, params = []) => {
    if (String(sql).includes('FOR UPDATE')) return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    if (String(sql).includes('UPDATE empresas')) {
      persisted = JSON.parse(params[21]);
      return [{ id: 7, config_integraciones: structuredClone(persisted) }];
    }
    throw new Error(`SQL inesperado: ${sql}`);
  };
  const lock = createSerializedLockPool([], transactionQuery);
  let reconciles = 0;
  const app = buildApp({
    query: async () => assert.fail('debe usar transacción bajo lock'),
    pool: lock.pool,
    user: { role: 'super', empresa_id: null },
    reconcileEmpresaWppWorker: async () => { reconciles += 1; },
  });
  await withServer(app, async baseUrl => {
    const responses = await Promise.all([
      { pagos: { proveedor: 'mercado_pago' } },
      { envios: { proveedor: 'correo' } },
    ].map(config_integraciones => fetch(`${baseUrl}/api/empresas/7`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config_integraciones }),
    })));
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
  });
  assert.equal(lock.maxActive, 1);
  assert.equal(persisted.whatsapp.provider, 'cloud');
  assert.equal(persisted.pagos.proveedor, 'mercado_pago');
  assert.equal(persisted.envios.proveedor, 'correo');
  assert.equal(reconciles, 0);
});
