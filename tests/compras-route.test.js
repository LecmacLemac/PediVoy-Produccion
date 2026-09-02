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

function buildApp({ query, user = { uid: 77, role: 'admin', empresa_id: 1 } }) {
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

test('POST /api/setup/fase2/compras registra created_by desde uid', async () => {
  const inserts = [];
  let itemInserted = false;
  const app = buildApp({
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO compras_ordenes')) {
        inserts.push({ sql, params });
        assert.equal(params[10], 77);
        assert.equal(params[11], 77);
        return [{ id: 501, empresa_id: 1, proveedor_id: 8, total: params[6], estado: 'emitida' }];
      }
      if (sql.includes('INSERT INTO compras_orden_items')) {
        itemInserted = true;
        return [];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/setup/fase2/compras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proveedor_id: 8,
        fecha_entrega_estimada: '2026-09-05',
        observaciones: 'Comprar para stock',
        items: [{ descripcion: 'Bidon 20 Lts.', cantidad: 10, costo_unitario: 1000 }],
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
  });

  assert.equal(inserts.length, 1);
  assert.equal(itemInserted, true);
});

test('GET endpoints de compras usan fecha local Argentina para vencimientos', async () => {
  const checked = [];
  const app = buildApp({
    query: async (sql) => {
      if (sql.includes('FROM compras_ordenes')) {
        checked.push(sql);
        assert.match(sql, /America\/Argentina\/Buenos_Aires/);
        if (sql.includes('COUNT(*) FILTER')) {
          return [{ compras_vencidas: '1', compras_por_vencer: '2' }];
        }
        if (sql.includes('dias_restantes')) {
          return [];
        }
        return [];
      }
      if (sql.includes('FROM tesoreria_movimientos')) {
        return [{ pendientes_conciliacion: '0', monto_pendiente: '0', egresos_7d: '0', egresos_30d_previos: '0' }];
      }
      if (sql.includes('GROUP BY categoria')) {
        return [{ categoria: 'insumos', total: '1000' }];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    for (const path of [
      '/api/setup/fase2/alertas',
      '/api/setup/fase2/vencimientos-proveedores',
      '/api/setup/fase2/acciones-sugeridas',
    ]) {
      const resp = await fetch(`${baseUrl}${path}`);
      assert.equal(resp.status, 200);
      const body = await resp.json();
      assert.equal(body.ok, true);
    }
  });

  assert.equal(checked.length >= 3, true);
});
