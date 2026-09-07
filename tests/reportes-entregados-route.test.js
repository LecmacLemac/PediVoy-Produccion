import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createReportesRouter } from '../src/routes/reportes.js';

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
  app.use('/api/reportes', createReportesRouter({
    query,
    enqueueWppMessage: async (...args) => {
      app.locals.enqueueCalls = app.locals.enqueueCalls || [];
      app.locals.enqueueCalls.push(args[0]);
    },
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

test('GET /api/reportes/entregados expone estado IA del ultimo comprobante asociado', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      assert.match(sql, /LEFT JOIN LATERAL/);
      assert.match(sql, /transferencia_ai_verificada/);
      assert.match(sql, /transferencia_alias/);
      assert.match(sql, /transferencia_titular/);
      assert.match(sql, /empresa_nombre/);
      assert.deepEqual(params, [3, '2026-06-28', '2026-06-28', 'transferencia']);
      return [{
        id: 42,
        cliente: 'Cliente Test',
        telefono: '3510000000',
        monto: '1500',
        metodo_pago: 'transferencia',
        empresa_nombre: 'AguaHidro.com',
        transferencia_alias: 'Agua.Hidro',
        transferencia_titular: 'MD',
        pagado: true,
        comprobante_transferencia_id: 77,
        transferencia_procesado: true,
        transferencia_estado_revision: 'aprobado',
        transferencia_verified_reason: 'Validacion automatica por IA desde WhatsApp',
        transferencia_ai_verificada: true,
      }];
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/reportes/entregados?from=2026-06-28&to=2026-06-28&metodo_pago=transferencia`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].comprobante_transferencia_id, 77);
    assert.equal(body[0].transferencia_ai_verificada, true);
    assert.equal(body[0].transferencia_estado_revision, 'aprobado');
    assert.equal(body[0].empresa_nombre, 'AguaHidro.com');
    assert.equal(body[0].transferencia_alias, 'Agua.Hidro');
    assert.equal(body[0].transferencia_titular, 'MD');
  });

  assert.equal(calls.length, 1);
});

test('POST /api/reportes/saldos-clientes/solicitar encola solicitud de saldo por WhatsApp', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT nombre FROM empresas')) return [{ nombre: 'AguaHidro' }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/reportes/saldos-clientes/solicitar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente: 'Cliente Test',
        telefono: '351 555 0000',
        saldo: 12500,
        from: '2026-08-01',
        to: '2026-08-31',
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.queued, true);
    assert.match(body.mensaje, /Cliente Test/);
    assert.match(body.mensaje, /\$/);
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [3]);
  assert.equal(app.locals.enqueueCalls.length, 1);
  assert.equal(app.locals.enqueueCalls[0].phone, '3515550000');
  assert.equal(app.locals.enqueueCalls[0].empresa_id, 3);
  assert.match(app.locals.enqueueCalls[0].message, /saldo pendiente/);
});

test('POST /api/reportes/saldos-clientes/solicitar rechaza saldo no pendiente', async () => {
  const app = buildApp({
    query: async () => {
      throw new Error('No debe consultar DB con saldo invalido');
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/reportes/saldos-clientes/solicitar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente: 'Cliente Test', telefono: '3515550000', saldo: 0 }),
    });
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /saldo/);
  });

  assert.equal(app.locals.enqueueCalls, undefined);
});
