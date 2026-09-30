import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function buildApp(identity, counters) {
  const app = express();
  app.use(express.json());
  const forbidden = async () => {
    counters.services += 1;
    throw new Error('service must not run');
  };
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async () => {
      counters.queries += 1;
      return [];
    },
    pool: { connect: async () => {
      counters.services += 1;
      throw new Error('pool must not run');
    } },
    withTransaction: forbidden,
    withAuth(req, _res, next) {
      req.user = identity;
      next();
    },
    getEmpresaIdFromToken: () => identity?.empresa_id,
    notifyEstadoPedidoPush: forbidden,
    notificarEnRuta: forbidden,
    notificarPedidoTransferencia: forbidden,
    ejecutarEstrategiaVecinos: forbidden,
    ejecutarPostEntregaUpsell: forbidden,
    ejecutarRecompensaReferido: forbidden,
    ejecutarEstrategiaReferidos: forbidden,
    awardPointsForDeliveredOrder: forbidden,
    generateComisionesForDeliveredOrder: forbidden,
    registrarMovimientosActivosDesdePedido: forbidden,
    crearPagoParaPedido: forbidden,
    listarPagosPorPedido: forbidden,
    refrescarEstadoPagoPedido: forbidden,
  }));
  return app;
}

const operationalRoutes = [
  ['GET', '/transferencias'],
  ['GET', '/pedidos'],
  ['POST', '/pedidos/42/pago-qr'],
  ['GET', '/pedidos/42/pago-qr/estado'],
  ['POST', '/pedidos/42/transferencia/notificar'],
  ['GET', '/mis-zonas'],
  ['GET', '/entregas-evidencias'],
  ['GET', '/stock-acumulado'],
  ['PUT', '/pedidos/42'],
  ['POST', '/pedidos/42/entregar'],
  ['POST', '/pedidos/42/activos-movimientos'],
  ['GET', '/pedidos/42/activos-resumen'],
  ['GET', '/activos/stock-disponible'],
  ['POST', '/tomar/42'],
  ['POST', '/optimizar-ruta'],
];

const deniedIdentities = [
  { role: 'admin', empresa_id: 3, chofer_id: 7 },
  { role: 'super', empresa_id: 3, chofer_id: 7 },
  { role: 'user', empresa_id: 3, chofer_id: 7 },
  { role: 'Repartidor', empresa_id: 3, chofer_id: 7 },
  { role: ' repartidor', empresa_id: 3, chofer_id: 7 },
  { role: 'repartidor ', empresa_id: 3, chofer_id: 7 },
  { role: null, empresa_id: 3, chofer_id: 7 },
  { role: 'repartidor', empresa_id: '3', chofer_id: 7 },
  { role: 'repartidor', empresa_id: 3, chofer_id: '7' },
  { role: 'repartidor', empresa_id: 0, chofer_id: 7 },
  { role: 'repartidor', empresa_id: 3, chofer_id: null },
];

test('router repartidor exige rol canónico e identidad positiva antes de toda query o servicio', async () => {
  for (const identity of deniedIdentities) {
    const counters = { queries: 0, services: 0 };
    const app = buildApp(identity, counters);
    await withServer(app, async baseUrl => {
      for (const [method, route] of operationalRoutes) {
        const response = await fetch(`${baseUrl}/api/repartidor${route}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: ['POST', 'PUT'].includes(method) ? JSON.stringify({}) : undefined,
        });
        assert.equal(response.status, 403, `${method} ${route} identity=${JSON.stringify(identity)}`);
      }
    });
    assert.deepEqual(counters, { queries: 0, services: 0 }, JSON.stringify(identity));
  }
});

test('repartidor exacto con claims enteros positivos conserva acceso', async () => {
  const counters = { queries: 0, services: 0 };
  const app = buildApp({ role: 'repartidor', empresa_id: 3, chofer_id: 7 }, counters);
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/transferencias`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rows: [] });
  });
  assert.equal(counters.queries, 1);
  assert.equal(counters.services, 0);
});
