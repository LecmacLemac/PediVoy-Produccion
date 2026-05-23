import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';

function buildTestApp({ query }) {
  return buildTestAppWithDeps({ query });
}

function buildTestAppWithDeps({ query, pool = {}, ...overrides }) {
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
    ...overrides,
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

test('repartidor de empresa 1 genera QR desde ruta propia sin usar endpoint admin', async () => {
  const calls = [];
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
      calls.push({ sql, params });

      if (sql.includes('FROM pedidos p') && sql.includes('p.empresa_id = $2')) {
        return [{
          id: 42,
          empresa_id: 1,
          chofer_id: 7,
          estado: 'pendiente',
          metodo_pago: 'transferencia',
        }];
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    crearPagoParaPedido: async (params, options) => {
      assert.deepEqual(params, { pedidoId: 42, empresaId: 1 });
      assert.equal(options.canal, 'repartidor');
      assert.equal(options.metodoPago, 'qr_dinamico');

      return {
        id: 99,
        estado: 'pendiente',
        monto: 1200,
        moneda: 'ARS',
        checkout_url: 'https://mp.test/checkout',
        qr_payload: 'https://mp.test/checkout',
        vence_at: '2026-05-22T23:00:00.000Z',
        proveedor: 'mercado_pago',
      };
    },
    withAuth: (req, res, next) => {
      req.user = {
        chofer_id: 7,
        empresa_id: 1,
        username: 'chofer-test',
        role: 'repartidor',
      };
      next();
    },
    getEmpresaIdFromToken: () => 1,
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/pago-qr`, { method: 'POST' });
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.qr_payload, 'https://mp.test/checkout');
    assert.equal(body.proveedor, 'mercado_pago');
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [42, 1, 7]);
});

test('repartidor consulta estado QR aprobado antes de continuar entrega', async () => {
  const calls = [];
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
      calls.push({ sql, params });

      if (sql.includes('FROM pedidos p') && sql.includes('p.empresa_id = $2')) {
        return [{
          id: 42,
          empresa_id: 1,
          chofer_id: 7,
          estado: 'en_ruta',
          metodo_pago: 'transferencia',
        }];
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    listarPagosPorPedido: async (params) => {
      assert.deepEqual(params, { pedidoId: 42, empresaId: 1 });
      return [{
        id: 88,
        metodo_pago: 'qr_dinamico',
        estado: 'pagado',
        updated_at: '2026-05-23T03:00:00.000Z',
      }];
    },
    withAuth: (req, res, next) => {
      req.user = {
        chofer_id: 7,
        empresa_id: 1,
        username: 'chofer-test',
        role: 'repartidor',
      };
      next();
    },
    getEmpresaIdFromToken: () => 1,
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/pago-qr/estado`);
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.pagado, true);
    assert.equal(body.estado, 'pagado');
    assert.equal(body.pago_id, 88);
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [42, 1, 7]);
});

test('repartidor puede disparar WhatsApp de transferencia desde modal QR', async () => {
  const calls = [];
  const notificaciones = [];
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
      calls.push({ sql, params });

      if (sql.includes('FROM pedidos p') && sql.includes('p.empresa_id = $2')) {
        return [{
          id: 42,
          empresa_id: 1,
          chofer_id: 7,
          estado: 'en_ruta',
          metodo_pago: 'transferencia',
        }];
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    notificarPedidoTransferencia: async (pedidoId, empresaId) => {
      notificaciones.push({ pedidoId, empresaId });
    },
    withAuth: (req, res, next) => {
      req.user = {
        chofer_id: 7,
        empresa_id: 1,
        username: 'chofer-test',
        role: 'repartidor',
      };
      next();
    },
    getEmpresaIdFromToken: () => 1,
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/transferencia/notificar`, { method: 'POST' });
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.ok, true);
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [42, 1, 7]);
  assert.deepEqual(notificaciones, [{ pedidoId: 42, empresaId: 1 }]);
});

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
