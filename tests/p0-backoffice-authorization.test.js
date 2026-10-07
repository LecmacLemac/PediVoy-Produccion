import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPedidosItemsRouter } from '../src/routes/pedidosItems.js';
import { createProductosRouter } from '../src/routes/productos.js';
import { createStockRouter } from '../src/routes/stock.js';
import { createClientesRouter } from '../src/routes/clientes.js';
import { createReportesRouter } from '../src/routes/reportes.js';
import { createReferentesRouter } from '../src/routes/referentes.js';

const deniedRoles = ['repartidor', 'referente', 'user', 'facturacion', 'contable', 'desconocido', 'Admin', ' admin', 'super '];

const referentesReads = [
  '/api/referentes/resumen',
  '/api/referentes/liquidaciones/1',
  '/api/referentes',
  '/api/referentes/1/acceso',
  '/api/referentes/clientes-propuestos',
  '/api/referentes/clientes',
  '/api/referentes/1/productos',
  '/api/referentes/comisiones',
];

const mutations = [
  ['pedidosItems', 'PUT', '/api/pedidos/999/items', { items: [{ producto_id: 1, cantidad: 1, precio_unitario: 1 }] }],
  ['productos', 'POST', '/api/productos', { nombre: 'P', precio: 1 }],
  ['productos', 'PUT', '/api/productos/1', { precio: 2 }],
  ['productos', 'DELETE', '/api/productos/1', undefined],
  ['stock', 'POST', '/api/stock/depositos', { nombre: 'D' }],
  ['stock', 'PUT', '/api/stock/depositos/1', { nombre: 'D2' }],
  ['stock', 'DELETE', '/api/stock/depositos/1', undefined],
  ['stock', 'POST', '/api/stock/depositos/transferir', { origen_deposito_id: 1, destino_deposito_id: 2, producto_id: 1, chofer_id: 123, cantidad: 1 }],
  ['stock', 'POST', '/api/stock/depositos/transferencias/revertir', { referencia: 'TRANSFER:1', chofer_id: 123 }],
  ['stock', 'POST', '/api/stock/depositos/choferes', { chofer_id: 123, deposito_ids: [1] }],
  ['stock', 'PUT', '/api/stock/depositos/permisos-config', { deposito_permisos_estricto: true }],
  ['stock', 'POST', '/api/stock/ajuste', { producto_id: 1, qty: 1, tipo: 'ADJUST+', chofer_id: 123 }],
  ['clientes', 'POST', '/api/clientes/geocode', { direccion: 'Calle 1' }],
  ['clientes', 'POST', '/api/clientes', { cliente: 'C', telefono: '3510000000', direccion: 'Calle 1' }],
  ['clientes', 'PUT', '/api/clientes/1', { cliente: 'C2' }],
  ['clientes', 'DELETE', '/api/clientes/1', undefined],
  ['reportes', 'POST', '/api/reportes/saldos-clientes/solicitar', { telefono: '3510000000', mensaje: 'arbitrario', saldo: 1, empresa_id: 999 }],
  ['referentes', 'POST', '/api/referentes', { nombre: 'R', codigo: 'REF-1', porcentaje_comision: 10 }],
  ['referentes', 'PUT', '/api/referentes/1', { nombre: 'R2' }],
  ['referentes', 'POST', '/api/referentes/1/acceso', { username: 'ref1', password: 'password-seguro' }],
  ['referentes', 'POST', '/api/referentes/1/productos', { productos: [{ producto_id: 1 }] }],
  ['referentes', 'POST', '/api/referentes/clientes-propuestos/1/aprobar', {}],
  ['referentes', 'POST', '/api/referentes/clientes-propuestos/1/rechazar', { motivo: 'No corresponde' }],
  ['referentes', 'DELETE', '/api/referentes/1', undefined],
  ['referentes', 'POST', '/api/referentes/comisiones/liquidar', { comision_ids: [1] }],
  ['referentes', 'POST', '/api/referentes/clientes/1/desvincular', { motivo: 'Fin de vínculo' }],
];

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function createHarness(role) {
  const downstream = { auth: 0, license: 0, query: 0, tx: 0, geocode: 0, enqueue: 0, pool: 0 };
  const withAuth = (req, _res, next) => {
    downstream.auth += 1;
    req.user = { uid: 80, role, empresa_id: role === 'super' ? null : 3, chofer_id: 123 };
    next();
  };
  const query = async () => { downstream.query += 1; throw new Error('downstream query'); };
  const withTransaction = async work => {
    downstream.tx += 1;
    return work(async statement => {
      if (/FROM usuarios/.test(statement)) {
        return [{ id: 80, role, empresa_id: role === 'super' ? null : 3, activo: true }];
      }
      throw new Error('downstream tx');
    });
  };
  const checkLicencia = (_req, _res, next) => { downstream.license += 1; next(); };
  const deps = {
    query,
    withTransaction,
    withAuth,
    checkLicencia,
    isSuper: req => req.user?.role === 'super',
    getEmpresaIdFromToken: req => req.user?.empresa_id,
  };
  const pool = {
    async connect() {
      downstream.pool += 1;
      throw new Error('downstream pool');
    },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/pedidos', createPedidosItemsRouter(deps));
  app.use('/api/productos', createProductosRouter(deps));
  app.use('/api/stock', createStockRouter({ ...deps, pool }));
  app.use('/api/clientes', createClientesRouter({
    ...deps,
    pool,
    normalizePhone: String,
    geocodeIfNeeded: async () => { downstream.geocode += 1; throw new Error('downstream geocode'); },
    pointInAnyZone: async () => null,
  }));
  app.use('/api/reportes', createReportesRouter({
    ...deps,
    enqueueWppMessage: async () => { downstream.enqueue += 1; },
  }));
  app.use('/api/referentes', createReferentesRouter(deps));
  return { app, downstream };
}

for (const role of deniedRoles) {
  test(`rol no canónico ${JSON.stringify(role)} queda bloqueado antes de todo downstream en cada mutación`, async () => {
    const { app, downstream } = createHarness(role);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(downstream, { auth: 0, license: 0, query: 0, tx: 0, geocode: 0, enqueue: 0, pool: 0 }, 'crear routers no debe ejecutar schema/query');

    await withServer(app, async baseUrl => {
      for (const [routerName, method, path, body] of mutations) {
        const before = { ...downstream };
        const response = await fetch(baseUrl + path, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert.equal(response.status, 403, `${routerName} ${method} ${path} con ${JSON.stringify(role)}`);
        assert.equal(downstream.auth, before.auth + 1);
        assert.deepEqual(
          { ...downstream, auth: before.auth },
          before,
          `${routerName} ${method} ${path} no debe tocar licencia/schema/query/upload/tx/enqueue`,
        );
      }
    });
  });

  test(`rol no canónico ${JSON.stringify(role)} queda bloqueado antes de downstream en lecturas administrativas de referentes`, async () => {
    const { app, downstream } = createHarness(role);
    await withServer(app, async baseUrl => {
      for (const path of referentesReads) {
        const before = { ...downstream };
        const response = await fetch(baseUrl + path);
        assert.equal(response.status, 403, `GET ${path} con ${JSON.stringify(role)}`);
        assert.equal(downstream.auth, before.auth + 1);
        assert.deepEqual({ ...downstream, auth: before.auth }, before, `GET ${path} no debe tocar downstream`);
      }
    });
  });
}

test('repartidor chofer 123 no modifica ítems de pedido 999 ni propio por endpoint backoffice', async () => {
  const { app, downstream } = createHarness('repartidor');
  await withServer(app, async baseUrl => {
    for (const pedidoId of [999, 123]) {
      const response = await fetch(`${baseUrl}/api/pedidos/${pedidoId}/items`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ producto_id: 1, cantidad: 1, precio_unitario: 1 }] }),
      });
      assert.equal(response.status, 403);
    }
  });
  assert.equal(downstream.query, 0);
  assert.equal(downstream.tx, 0);
});

test('reportes no permite a repartidor elegir empresa, teléfono o mensaje ni encolar WhatsApp', async () => {
  const { app, downstream } = createHarness('repartidor');
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/reportes/saldos-clientes/solicitar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id: 999, telefono: '5499999999999', mensaje: 'mensaje arbitrario', saldo: 1 }),
    });
    assert.equal(response.status, 403);
  });
  assert.equal(downstream.query, 0);
  assert.equal(downstream.enqueue, 0);
});

test('repartidor no aprueba propuesta ni alcanza transacción, INSERT o UPDATE', async () => {
  const sql = [];
  let txCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/referentes', createReferentesRouter({
    withAuth(req, _res, next) {
      req.user = { uid: 77, role: 'repartidor', empresa_id: 3 };
      next();
    },
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user?.empresa_id,
    async query(statement) {
      sql.push(statement);
      return [];
    },
    async withTransaction(work) {
      txCalls += 1;
      return work(async statement => {
        sql.push(statement);
        return [];
      });
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/referentes/clientes-propuestos/1/aprobar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
  });

  assert.equal(txCalls, 0);
  assert.equal(sql.length, 0);
  assert.equal(sql.some(statement => /INSERT|UPDATE/i.test(statement)), false);
});

for (const role of ['admin', 'super']) {
  test(`${role} canónico atraviesa auth y guard en cada mutación de routers reales`, async () => {
    const { app, downstream } = createHarness(role);
    await withServer(app, async baseUrl => {
      for (const [routerName, method, path, body] of mutations) {
        const before = { ...downstream };
        const response = await fetch(baseUrl + path, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert.notEqual(response.status, 403, `${routerName} ${method} ${path} con ${role}`);
        assert.equal(downstream.auth, before.auth + 1);
      }
    });
  });

  test(`${role} canónico atraviesa auth y guard en lecturas administrativas de referentes`, async () => {
    const { app, downstream } = createHarness(role);
    await withServer(app, async baseUrl => {
      for (const path of referentesReads) {
        const before = { ...downstream };
        const response = await fetch(baseUrl + path);
        assert.notEqual(response.status, 403, `GET ${path} con ${role}`);
        assert.equal(downstream.auth, before.auth + 1);
      }
    });
  });
}

function mutationLayers(router) {
  return router.stack
    .filter(layer => layer.route && Object.keys(layer.route.methods).some(method => ['post', 'put', 'patch', 'delete'].includes(method)))
    .map(layer => ({
      method: Object.keys(layer.route.methods).find(Boolean).toUpperCase(),
      path: layer.route.path,
      handlers: layer.route.stack.map(item => item.handle),
    }));
}

test('inventario completo monta auth y guard exacto antes del handler en todas las mutaciones', () => {
  const withAuth = (_req, _res, next) => next();
  const deps = {
    query: async () => [],
    withTransaction: async work => work(async () => []),
    withAuth,
    checkLicencia: (_req, _res, next) => next(),
    isSuper: () => false,
    getEmpresaIdFromToken: () => 3,
  };
  const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const routers = {
    pedidosItems: createPedidosItemsRouter(deps),
    productos: createProductosRouter(deps),
    stock: createStockRouter({ ...deps, pool }),
    clientes: createClientesRouter({ ...deps, pool }),
    reportes: createReportesRouter(deps),
    referentes: createReferentesRouter(deps),
  };
  const expected = [
    ['pedidosItems', 'PUT', '/:id/items'],
    ['productos', 'POST', '/'],
    ['productos', 'PUT', '/:id'],
    ['productos', 'DELETE', '/:id'],
    ['stock', 'POST', '/depositos'],
    ['stock', 'PUT', '/depositos/:id'],
    ['stock', 'DELETE', '/depositos/:id'],
    ['stock', 'POST', '/depositos/transferir'],
    ['stock', 'POST', '/depositos/transferencias/revertir'],
    ['stock', 'POST', '/depositos/choferes'],
    ['stock', 'PUT', '/depositos/permisos-config'],
    ['stock', 'POST', '/ajuste'],
    ['clientes', 'POST', '/geocode'],
    ['clientes', 'POST', '/'],
    ['clientes', 'PUT', '/:id'],
    ['clientes', 'DELETE', '/:id'],
    ['reportes', 'POST', '/saldos-clientes/solicitar'],
    ['referentes', 'POST', '/'],
    ['referentes', 'PUT', '/:id'],
    ['referentes', 'POST', '/:id/acceso'],
    ['referentes', 'POST', '/:id/productos'],
    ['referentes', 'POST', '/clientes-propuestos/:id/aprobar'],
    ['referentes', 'POST', '/clientes-propuestos/:id/rechazar'],
    ['referentes', 'DELETE', '/:id'],
    ['referentes', 'POST', '/comisiones/liquidar'],
    ['referentes', 'POST', '/clientes/:clienteId/desvincular'],
  ];
  const actual = [];
  for (const [routerName, router] of Object.entries(routers)) {
    for (const route of mutationLayers(router)) {
      actual.push([routerName, route.method, route.path]);
      assert.equal(route.handlers[0], withAuth, `${routerName} ${route.method} ${route.path}: auth primero`);
      assert.equal(route.handlers[1].canonicalBackofficeGuard, true, `${routerName} ${route.method} ${route.path}: guard segundo`);
      for (const role of ['admin', 'super']) {
        let nextCalls = 0;
        let status = null;
        route.handlers[1]({ user: { role } }, { status(code) { status = code; return this; }, json() {} }, () => { nextCalls += 1; });
        assert.equal(nextCalls, 1, `${role} atraviesa ${routerName} ${route.method} ${route.path}`);
        assert.equal(status, null);
      }
    }
  }
  assert.deepEqual(actual.sort(), expected.sort());
});

test('inventario exacto de referentes clasifica todas las rutas como administración protegida', () => {
  const withAuth = (_req, _res, next) => next();
  const router = createReferentesRouter({
    query: async () => [],
    withTransaction: async work => work(async () => []),
    withAuth,
    isSuper: () => false,
    getEmpresaIdFromToken: () => 3,
  });
  const expected = [
    ['GET', '/resumen', 'admin read'],
    ['GET', '/liquidaciones/:id', 'admin read'],
    ['GET', '/', 'admin read'],
    ['POST', '/', 'admin mutation'],
    ['PUT', '/:id', 'admin mutation'],
    ['GET', '/:id/acceso', 'admin read'],
    ['POST', '/:id/acceso', 'admin mutation'],
    ['POST', '/:id/productos', 'admin mutation'],
    ['GET', '/clientes-propuestos', 'admin read'],
    ['GET', '/clientes', 'admin read'],
    ['POST', '/clientes-propuestos/:id/aprobar', 'admin mutation'],
    ['POST', '/clientes-propuestos/:id/rechazar', 'admin mutation'],
    ['GET', '/:id/productos', 'admin read'],
    ['DELETE', '/:id', 'admin mutation'],
    ['POST', '/comisiones/liquidar', 'admin mutation'],
    ['GET', '/comisiones', 'admin read'],
    ['POST', '/clientes/:clienteId/desvincular', 'admin mutation'],
  ];
  const actual = router.stack
    .filter(layer => layer.route)
    .map(layer => {
      const method = Object.keys(layer.route.methods).find(Boolean).toUpperCase();
      const classification = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'admin mutation' : 'admin read';
      assert.equal(layer.route.stack[0].handle, withAuth, `${method} ${layer.route.path}: auth primero`);
      assert.equal(layer.route.stack[1].handle.canonicalBackofficeGuard, true, `${method} ${layer.route.path}: guard segundo`);
      return [method, layer.route.path, classification];
    });
  assert.deepEqual(actual.sort(), expected.sort());
});
