import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';

function buildTestApp({ query }) {
  return buildTestAppWithDeps({ query });
}

function buildTestAppWithDeps({ query, pool = {} }) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    pool,
    withAuth: (req, res, next) => {
      req.user = {
        chofer_id: 7,
        empresa_id: 3,
        username: 'chofer-test',
        role: 'repartidor',
      };
      next();
    },
    getEmpresaIdFromToken: () => 3,
    notifyEstadoPedidoPush: async () => {},
    notificarEnRuta: async () => {},
    notificarPedidoTransferencia: async () => {},
    ejecutarEstrategiaVecinos: async () => {},
    registrarMovimientosActivosDesdePedido: async () => {},
  }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('activos-resumen no consulta inventario cuando el pedido no tiene productos activos', async () => {
  const sqlCalls = [];
  const app = buildTestApp({
    query: async (sql) => {
      sqlCalls.push(sql);

      if (sql.includes('FROM pedidos p') && sql.includes('p.punto_entrega_id')) {
        return [{
          id: 42,
          monto: 1200,
          chofer_id: 7,
          punto_entrega_id: 9,
          cliente: 'Cliente común',
          direccion: 'Calle 123',
        }];
      }

      if (sql.includes('FROM items_pedido ip')) {
        return [{
          item_pedido_id: 101,
          producto: 'Bidón 20L',
          cantidad: 2,
          precio_unitario: 600,
          producto_id: 55,
          config_activo: null,
        }];
      }

      throw new Error('No debería consultar tablas de activos para pedidos sin activos');
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/activos-resumen`);
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.deepEqual(body.items_activos, []);
    assert.deepEqual(body.activos_cliente, []);
    assert.deepEqual(body.activos_disponibles, []);
    assert.deepEqual(body.movimientos_existentes, []);
  });

  assert.equal(sqlCalls.length, 2);
  assert.ok(sqlCalls.every((sql) => !sql.includes('empresa_activos')));
  assert.ok(sqlCalls.every((sql) => !sql.includes('pedido_activos')));
});

test('entregar bloquea solo la fila de pedidos cuando usa LEFT JOIN', async () => {
  const sqlCalls = [];
  const client = {
    query: async (sql) => {
      sqlCalls.push(sql);

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 42,
            empresa_id: 3,
            chofer_id: 7,
            estado: 'entregado',
            metodo_pago: 'efectivo',
            zona_id: null,
            punto_entrega_id: 9,
            monto: 1200,
            cuenta_corriente_habilitada: false,
          }],
        };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    release: () => {},
  };

  const app = buildTestAppWithDeps({
    query: async () => [],
    pool: {
      connect: async () => client,
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [] }),
    });
    assert.equal(resp.status, 200);
  });

  const lockSql = sqlCalls.find((sql) => sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE'));
  assert.match(lockSql, /FOR UPDATE OF p/);
});
