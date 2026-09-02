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

function buildApp({ query, user = { uid: 10, role: 'admin', empresa_id: 1 } }) {
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

test('GET /api/setup/fase3/semaforo-operativo usa fecha local Argentina para compras vencidas', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM tesoreria_movimientos')) {
        return [{ ingresos_30d: '100000', egresos_30d: '75000', pendientes_conciliacion: '0' }];
      }
      if (sql.includes('FROM compras_ordenes')) {
        assert.match(sql, /America\/Argentina\/Buenos_Aires/);
        return [{ compras_vencidas: '0' }];
      }
      if (sql.includes('FROM crm_oportunidades')) {
        return [{ pipeline_ponderado: '90000' }];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase3/semaforo-operativo`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.nivel, 'verde');
  });

  assert.ok(calls.some((call) => call.sql.includes('America/Argentina/Buenos_Aires')));
});

test('GET /api/setup/fase3/control-cierre usa fecha local Argentina para compras vencidas', async () => {
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('FROM tesoreria_movimientos') && sql.includes('conciliado=FALSE')) {
        return [{ pendientes: '0', monto: '0' }];
      }
      if (sql.includes('FROM compras_ordenes')) {
        assert.match(sql, /America\/Argentina\/Buenos_Aires/);
        return [{ vencidas: '0' }];
      }
      if (sql.includes('WITH b AS')) {
        assert.deepEqual(params, [1, 2026, 9]);
        return [{ presupuestado: '100000', ejecutado: '90000', desvio: '-10000' }];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase3/control-cierre?anio=2026&mes=9`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.periodo.anio, 2026);
    assert.equal(body.periodo.mes, 9);
  });
});
