import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import { createSetupRouter } from '../src/routes/setup.js';

async function requestWithSetup({ role = 'super', path, method = 'GET', body, query }) {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', createSetupRouter({
    withAuth(req, _res, next) {
      req.user = { uid: 12, role, empresa_id: 2 };
      next();
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
    query,
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${port}/api/setup${path}`, options);
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('marketing rechaza usuarios que no son super admin', async () => {
  let queryCalls = 0;
  const result = await requestWithSetup({
    role: 'admin',
    path: '/marketing/config',
    query: async () => {
      queryCalls += 1;
      return [];
    },
  });

  assert.equal(result.status, 403);
  assert.equal(result.json.error, 'Acceso exclusivo para super admin');
  assert.equal(queryCalls, 0);
});

test('preview de campaña no promueve contactos ni ejecuta envíos', async () => {
  const sqlCalls = [];
  const result = await requestWithSetup({
    path: '/marketing/base/launch',
    method: 'POST',
    body: {
      empresa_id: 2,
      max_envios: 10,
      frecuencia_horas: 24,
      dry_run: true,
    },
    query: async (sql) => {
      sqlCalls.push(sql);
      if (sql.includes('SELECT mc.id, mc.telefono')) {
        return [{ id: 22, telefono: '3515551111', rubro: 'hogar', zona: 'centro', lista_nombre: 'Base' }];
      }
      return [];
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, dry_run: true, candidatos: 1 });
  assert.equal(sqlCalls.some((sql) => sql.includes('UPDATE marketing_contactos')), false);
  assert.equal(sqlCalls.some((sql) => sql.includes('INSERT INTO marketing_envios_telemetria')), false);
});

test('lanzamiento real sigue exigiendo un mensaje', async () => {
  const result = await requestWithSetup({
    path: '/marketing/base/launch',
    method: 'POST',
    body: {
      empresa_id: 2,
      max_envios: 10,
      frecuencia_horas: 24,
      dry_run: false,
    },
    query: async () => [],
  });

  assert.equal(result.status, 400);
  assert.equal(result.json.error, 'mensaje requerido');
});

test('lanzamiento SMS respeta interruptor IFTTT_SMS_ENABLED', async () => {
  const oldEnabled = process.env.IFTTT_SMS_ENABLED;
  process.env.IFTTT_SMS_ENABLED = '0';

  const telemetryParams = [];
  try {
    const result = await requestWithSetup({
      path: '/marketing/base/launch',
      method: 'POST',
      body: {
        empresa_id: 2,
        canal: 'sms',
        mensaje: 'Hola {rubro}',
        max_envios: 1,
        frecuencia_horas: 24,
        dry_run: false,
      },
      query: async (sql, params) => {
        if (sql.includes('SELECT mc.id, mc.telefono')) {
          return [{ id: 22, telefono: '3515551111', rubro: 'hogar', zona: 'centro', lista_nombre: 'Base' }];
        }
        if (sql.includes('INSERT INTO marketing_envios_telemetria')) {
          telemetryParams.push(params);
        }
        return [];
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.enviados, 0);
    assert.equal(result.json.errores, 1);
    assert.equal(telemetryParams.length, 1);
    assert.equal(telemetryParams[0][7], 'IFTTT_SMS_ENABLED=0');
  } finally {
    if (oldEnabled === undefined) delete process.env.IFTTT_SMS_ENABLED;
    else process.env.IFTTT_SMS_ENABLED = oldEnabled;
  }
});

test('telemetría contabiliza errores generados por lanzamientos manuales', async () => {
  const sqlCalls = [];
  const result = await requestWithSetup({
    path: '/marketing/telemetria?empresa_id=2&dias=7',
    query: async (sql) => {
      sqlCalls.push(sql);
      return [];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0], /estado IN \('failed','error'\)/);
  assert.match(sqlCalls[1], /estado IN \('failed','error'\)/);
});
