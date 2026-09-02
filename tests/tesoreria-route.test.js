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

function buildApp({ query, user = { uid: 88, role: 'admin', empresa_id: 1 } }) {
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

test('POST /api/setup/fase2/tesoreria registra created_by desde uid', async () => {
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO tesoreria_movimientos')) {
        assert.equal(params[12], 88);
        assert.equal(params[5], '2026-09-02');
        return [{ id: 701, empresa_id: 1, tipo: params[1], monto: params[6], created_by: params[12] }];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase2/tesoreria`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'egreso',
        categoria: 'pago_proveedor',
        monto: 12500,
        fecha: '2026-09-02',
        referencia: 'REC-1',
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
  });
});

test('POST /api/setup/fase2/presupuesto registra created_by desde uid', async () => {
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('SELECT id FROM presupuesto_mensual')) {
        return [];
      }
      if (sql.includes('INSERT INTO presupuesto_mensual')) {
        assert.equal(params[6], 88);
        return [{ id: 801, empresa_id: 1, categoria: params[3], monto_presupuestado: params[5], created_by: params[6] }];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase2/presupuesto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anio: 2026,
        mes: 9,
        categoria: 'insumos',
        monto_presupuestado: 90000,
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
  });
});

test('GET /api/setup/fase2/presupuesto-vs-ejecutado usa periodo solicitado', async () => {
  const app = buildApp({
    query: async (sql, params = []) => {
      assert.match(sql, /FROM presupuesto_mensual/);
      assert.deepEqual(params, [1, 2026, 9]);
      return [{
        categoria: 'insumos',
        proveedor_id: null,
        proveedor_nombre: null,
        presupuestado: '90000',
        ejecutado: '100000',
        desvio: '10000',
      }];
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase2/presupuesto-vs-ejecutado?anio=2026&mes=9`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.summary.desvio, 10000);
    assert.equal(body.periodo.anio, 2026);
    assert.equal(body.periodo.mes, 9);
  });
});
