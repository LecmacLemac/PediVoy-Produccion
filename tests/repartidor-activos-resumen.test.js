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
          estado: 'en_ruta',
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

test('repartidor no genera QR si el pedido todavia no esta en ruta', async () => {
  let crearPagoLlamado = false;
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
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
    crearPagoParaPedido: async () => {
      crearPagoLlamado = true;
      throw new Error('No debe generar pago');
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
    assert.equal(resp.status, 409);
  });

  assert.equal(crearPagoLlamado, false);
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

test('repartidor refresca estado QR contra proveedor si sigue pendiente localmente', async () => {
  const refreshCalls = [];
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
      if (sql.includes('FROM pedidos p') && sql.includes('p.empresa_id = $2')) {
        return [{
          id: 42,
          empresa_id: 1,
          chofer_id: 7,
          estado: 'en_ruta',
          metodo_pago: 'qr_dinamico',
        }];
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    listarPagosPorPedido: async (params) => {
      assert.deepEqual(params, { pedidoId: 42, empresaId: 1 });
      return [{
        id: 88,
        metodo_pago: 'qr_dinamico',
        proveedor: 'mercado_pago',
        estado: 'pendiente',
        updated_at: '2026-05-23T03:00:00.000Z',
      }];
    },
    refrescarEstadoPagoPedido: async (args) => {
      refreshCalls.push(args);
      assert.equal(args.pedidoId, 42);
      assert.equal(args.empresaId, 1);
      assert.equal(args.pago.id, 88);
      return {
        ...args.pago,
        estado: 'pagado',
        updated_at: '2026-05-24T16:20:00.000Z',
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
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/pago-qr/estado`);
    assert.equal(resp.status, 200);

    const body = await resp.json();
    assert.equal(body.pagado, true);
    assert.equal(body.estado, 'pagado');
    assert.equal(body.pago_id, 88);
  });

  assert.equal(refreshCalls.length, 1);
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

test('cambiar pedido a transferencia no envia WhatsApp antes del modal QR', async () => {
  const notificaciones = [];
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
      if (sql.startsWith('ALTER TABLE puntos_entrega')) return [];

      if (sql.includes('FROM pedidos p') && sql.includes('p.id = $1 AND p.empresa_id = $2')) {
        return [{
          chofer_id: 7,
          metodo_pago: 'efectivo',
          estado: 'pendiente',
          zona_id: 5,
          punto_entrega_id: 9,
          cuenta_corriente_habilitada: false,
        }];
      }

      if (sql.includes('UPDATE pedidos SET metodo_pago')) {
        assert.deepEqual(params, ['transferencia', '42', 3]);
        return [];
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    notificarPedidoTransferencia: async (pedidoId, empresaId) => {
      notificaciones.push({ pedidoId, empresaId });
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metodo_pago: 'transferencia' }),
    });
    assert.equal(resp.status, 200);
  });

  assert.deepEqual(notificaciones, []);
});

test('repartidor notifica al cliente cuando inicia ruta', async () => {
  const notificaciones = [];
  const app = buildTestAppWithDeps({
    query: async (sql, params) => {
      if (sql.startsWith('ALTER TABLE puntos_entrega')) return [];

      if (sql.includes('FROM pedidos p') && sql.includes('p.id = $1 AND p.empresa_id = $2')) {
        assert.deepEqual(params, ['42', 3]);
        return [{
          chofer_id: 7,
          metodo_pago: 'efectivo',
          estado: 'pendiente',
          zona_id: 5,
          punto_entrega_id: 9,
          cuenta_corriente_habilitada: false,
        }];
      }

      if (sql.includes('UPDATE pedidos SET estado')) {
        assert.deepEqual(params, ['en_ruta', '42', 3]);
        return [];
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    notificarEnRuta: async (pedidoId, empresaId) => {
      notificaciones.push({ pedidoId, empresaId });
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado: 'en_ruta' }),
    });
    assert.equal(resp.status, 200);
  });

  assert.deepEqual(notificaciones, [{ pedidoId: '42', empresaId: 3 }]);
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

function buildEntregaClient({
  metodoPago = 'transferencia',
  estado = 'en_ruta',
  comprobantes = [],
} = {}) {
  const sqlCalls = [];
  const client = {
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            id: 42,
            empresa_id: 3,
            chofer_id: 7,
            estado,
            metodo_pago: metodoPago,
            zona_id: 5,
            punto_entrega_id: 9,
            monto: 1200,
            cuenta_corriente_habilitada: false,
          }],
        };
      }

      if (sql.includes('UPDATE pedidos') && sql.includes("estado = 'entregado'")) {
        return { rows: [] };
      }

      if (sql.includes('FROM items_pedido ip') && sql.includes('JOIN productos p')) {
        return { rows: [] };
      }

      if (sql.includes('FROM comprobantes_transferencia')) {
        assert.deepEqual(params, [42, 3]);
        return { rows: comprobantes };
      }

      throw new Error(`Consulta inesperada: ${sql}`);
    },
    release: () => {},
  };

  return { client, sqlCalls };
}

test('entregar solicita comprobante cuando transferencia ya estaba guardada y no hay adjunto', async () => {
  const notificaciones = [];
  const { client, sqlCalls } = buildEntregaClient();
  const app = buildTestAppWithDeps({
    query: async () => [],
    pool: { connect: async () => client },
    notificarPedidoTransferencia: async (pedidoId, empresaId) => {
      notificaciones.push({ pedidoId, empresaId });
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [] }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  });

  assert.deepEqual(notificaciones, [{ pedidoId: 42, empresaId: 3 }]);
  const comprobantesCall = sqlCalls.find(({ sql }) => sql.includes('FROM comprobantes_transferencia'));
  assert.ok(comprobantesCall);
  assert.ok(sqlCalls.findIndex(({ sql }) => sql === 'COMMIT') >= 0);
});

test('reintentar una entrega ya confirmada no duplica la solicitud de comprobante', async () => {
  const notificaciones = [];
  const { client, sqlCalls } = buildEntregaClient({
    metodoPago: 'transferencia',
    estado: 'entregado',
  });
  const app = buildTestAppWithDeps({
    query: async () => [],
    pool: { connect: async () => client },
    notificarPedidoTransferencia: async () => {
      notificaciones.push(true);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [] }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true, already: true });
  });

  assert.deepEqual(notificaciones, []);
  assert.equal(sqlCalls.some(({ sql }) => sql.includes('FROM comprobantes_transferencia')), false);
});

test('entregar no solicita comprobante si hay adjunto pendiente o aprobado', async (t) => {
  const casos = [
    {
      nombre: 'pendiente',
      comprobantes: [{
        archivo_path: 'pendiente.jpg',
        comprobante_path: '/Transferencia/pendiente.jpg',
        validado: 0,
        procesado: false,
        estado_revision: 'pendiente',
      }],
    },
    {
      nombre: 'aprobado',
      comprobantes: [{
        archivo_path: 'aprobado.jpg',
        comprobante_path: '/Transferencia/aprobado.jpg',
        validado: 1,
        procesado: true,
        estado_revision: 'aprobado',
      }],
    },
    {
      nombre: 'validado sin path',
      comprobantes: [{
        archivo_path: '',
        comprobante_path: '',
        validado: 1,
        procesado: false,
        estado_revision: 'pendiente',
      }],
    },
    {
      nombre: 'verificado sin path',
      comprobantes: [{
        archivo_path: '',
        comprobante_path: '',
        validado: 0,
        procesado: false,
        estado_revision: 'verificado',
      }],
    },
  ];

  for (const caso of casos) {
    await t.test(caso.nombre, async () => {
      const notificaciones = [];
      const { client } = buildEntregaClient({ comprobantes: caso.comprobantes });
      const app = buildTestAppWithDeps({
        query: async () => [],
        pool: { connect: async () => client },
        notificarPedidoTransferencia: async () => {
          notificaciones.push(true);
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

      assert.deepEqual(notificaciones, []);
    });
  }
});

test('entregar vuelve a solicitar si solo hay comprobantes rechazados o duplicados', async () => {
  const notificaciones = [];
  const { client } = buildEntregaClient({
    comprobantes: [
      {
        archivo_path: 'rechazado.jpg',
        comprobante_path: '/Transferencia/rechazado.jpg',
        validado: 0,
        procesado: true,
        estado_revision: 'rechazado',
      },
      {
        archivo_path: 'duplicado.jpg',
        comprobante_path: '/Transferencia/duplicado.jpg',
        validado: 0,
        procesado: false,
        estado_revision: 'duplicado',
      },
    ],
  });
  const app = buildTestAppWithDeps({
    query: async () => [],
    pool: { connect: async () => client },
    notificarPedidoTransferencia: async () => {
      notificaciones.push(true);
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

  assert.deepEqual(notificaciones, [true]);
});

test('entregar no notifica otros metodos y un fallo de WhatsApp no revierte la entrega', async (t) => {
  await t.test('efectivo', async () => {
    const notificaciones = [];
    const { client, sqlCalls } = buildEntregaClient({ metodoPago: 'efectivo' });
    const app = buildTestAppWithDeps({
      query: async () => [],
      pool: { connect: async () => client },
      notificarPedidoTransferencia: async () => {
        notificaciones.push(true);
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

    assert.deepEqual(notificaciones, []);
    assert.equal(sqlCalls.some(({ sql }) => sql.includes('FROM comprobantes_transferencia')), false);
  });

  await t.test('fallo WhatsApp posterior al commit', async () => {
    const { client, sqlCalls } = buildEntregaClient();
    const app = buildTestAppWithDeps({
      query: async () => [],
      pool: { connect: async () => client },
      notificarPedidoTransferencia: async () => {
        throw new Error('WhatsApp no disponible');
      },
    });

    await withServer(app, async (baseUrl) => {
      const resp = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ movimientos: [] }),
      });
      assert.equal(resp.status, 200);
      assert.deepEqual(await resp.json(), { ok: true });
    });

    assert.equal(sqlCalls.filter(({ sql }) => sql === 'COMMIT').length, 1);
    assert.equal(sqlCalls.filter(({ sql }) => sql === 'ROLLBACK').length, 0);
  });
});
