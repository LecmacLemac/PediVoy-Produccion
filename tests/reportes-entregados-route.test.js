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
  app.use('/api/reportes', createReportesRouter({
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

test('GET /api/reportes/entregados expone estado IA del ultimo comprobante asociado', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      assert.match(sql, /LEFT JOIN LATERAL/);
      assert.match(sql, /transferencia_ai_verificada/);
      assert.deepEqual(params, [3, '2026-06-28', '2026-06-28', 'transferencia']);
      return [{
        id: 42,
        cliente: 'Cliente Test',
        telefono: '3510000000',
        monto: '1500',
        metodo_pago: 'transferencia',
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
  });

  assert.equal(calls.length, 1);
});
