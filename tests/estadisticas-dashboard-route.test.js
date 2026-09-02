import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createEstadisticasRouter } from '../src/routes/estadisticas.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildApp({ query, user = { role: 'admin', empresa_id: 1 } }) {
  const app = express();
  app.use('/api/estadisticas', createEstadisticasRouter({
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
  }));
  return app;
}

test('GET /api/estadisticas/dashboard filtra pedidos por fecha operativa', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });

      if (sql.includes('WITH daily_data')) {
        assert.match(sql, /COALESCE\(p\.fecha_entrega, p\.fecha\)::date/);
        assert.match(sql, /::date >= \$2::date/);
        assert.match(sql, /::date <= \$3::date/);
        assert.equal(params[0], 1);
        assert.equal(params[3], 5);
        if (params[1] !== '2026-09-01' || params[2] !== '2026-09-01') return [];
        return [{
          chofer_id: 5,
          fecha_dia: '2026-09-01',
          pedidos: '7',
          ventas: '84000',
          unidades: '13',
          costo_var_dia: '19500',
        }];
      }

      if (sql.includes('FROM gastos_repartidor')) return [];
      if (sql.includes('SELECT id, nombre, tipo FROM choferes')) {
        return [{ id: 5, nombre: 'Repartidor Test', tipo: 'propio' }];
      }
      if (sql.includes('FROM items_pedido')) {
        assert.match(sql, /COALESCE\(p\.fecha_entrega, p\.fecha\)::date/);
        return [{ producto: 'Bidon 20 Lts.', cantidad: '12', ventas: '84000' }];
      }

      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/estadisticas/dashboard?from=2026-09-01&to=2026-09-01&chofer_id=5`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.report[0].id, 5);
    assert.equal(body.report[0].pedidos, 7);
    assert.equal(body.report[0].ventas, 84000);
    assert.equal(body.products[0].cantidad, 12);
  });

  assert.ok(calls.some((call) => call.sql.includes('WITH daily_data')));
});
