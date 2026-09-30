import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { createRepartidorStatsRouter } from '../src/routes/repartidorStats.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function enumerateRoutes(router) {
  return router.stack.filter(layer => layer.route).flatMap(layer =>
    Object.keys(layer.route.methods).map(method => ({ method: method.toUpperCase(), path: layer.route.path })));
}

function buildRouters(identity, counters) {
  const withAuth = (req, _res, next) => { req.user = identity; next(); };
  const query = async sql => {
    counters.queries += 1;
    if (/WITH entregas/.test(sql)) return [{ cantidad: 2, pago: 30 }];
    if (/CURRENT_DATE/.test(sql)) return [{ entregados: 1, pendientes: 2, dinero: 300 }];
    return [];
  };
  const forbidden = async () => { counters.services += 1; throw new Error('service must not run'); };
  return {
    stats: createRepartidorStatsRouter({ query, withAuth }),
    api: createRepartidorApiRouter({
      query, pool: { connect: forbidden }, withTransaction: forbidden, withAuth,
      getEmpresaIdFromToken: () => identity?.empresa_id,
      notifyEstadoPedidoPush: forbidden, notificarEnRuta: forbidden, notificarPedidoTransferencia: forbidden,
      ejecutarEstrategiaVecinos: forbidden, ejecutarPostEntregaUpsell: forbidden,
      ejecutarRecompensaReferido: forbidden, ejecutarEstrategiaReferidos: forbidden,
      awardPointsForDeliveredOrder: forbidden, generateComisionesForDeliveredOrder: forbidden,
      registrarMovimientosActivosDesdePedido: forbidden, crearPagoParaPedido: forbidden,
      listarPagosPorPedido: forbidden, refrescarEstadoPagoPedido: forbidden,
    }),
  };
}

const expectedRoutes = [
  'GET /resumen-dia', 'GET /pago-dia', 'GET /transferencias', 'GET /pedidos',
  'POST /pedidos/:id/pago-qr', 'GET /pedidos/:id/pago-qr/estado',
  'POST /pedidos/:id/transferencia/notificar', 'GET /mis-zonas', 'GET /entregas-evidencias',
  'GET /stock-acumulado', 'PUT /pedidos/:id', 'POST /pedidos/:id/entregar',
  'POST /pedidos/:id/activos-movimientos', 'GET /pedidos/:id/activos-resumen',
  'GET /activos/stock-disponible', 'POST /tomar/:id', 'POST /optimizar-ruta',
];

test('montaje productivo conjunto protege todas las rutas actuales bajo /api/repartidor', async () => {
  const counters = { queries: 0, services: 0 };
  const { stats, api } = buildRouters({ role: 'admin', empresa_id: 3, chofer_id: 7 }, counters);
  const routes = [...enumerateRoutes(stats), ...enumerateRoutes(api)];
  assert.deepEqual(routes.map(route => `${route.method} ${route.path}`), expectedRoutes);
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', stats);
  app.use('/api/repartidor', api);
  await withServer(app, async baseUrl => {
    for (const route of routes) {
      const response = await fetch(`${baseUrl}/api/repartidor${route.path.replace(/:[^/]+/g, '42')}`, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        body: ['POST', 'PUT', 'PATCH'].includes(route.method) ? JSON.stringify({}) : undefined,
      });
      assert.equal(response.status, 403, `${route.method} ${route.path}`);
    }
  });
  assert.deepEqual(counters, { queries: 0, services: 0 });
});

test('montaje conjunto conserva smoke de una ruta de cada router para repartidor válido', async () => {
  const counters = { queries: 0, services: 0 };
  const { stats, api } = buildRouters({ role: 'repartidor', empresa_id: 3, chofer_id: 7 }, counters);
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', stats);
  app.use('/api/repartidor', api);
  await withServer(app, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/api/repartidor/resumen-dia`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/repartidor/transferencias`)).status, 200);
  });
  assert.deepEqual(counters, { queries: 2, services: 0 });
});
