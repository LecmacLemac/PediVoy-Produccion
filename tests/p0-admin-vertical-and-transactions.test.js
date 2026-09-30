import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';

import { createActivosRouter } from '../src/adm/activosRouter.js';
import { createCostosRouter } from '../src/adm/costosRouter.js';
import { createAlquileresRouter } from '../src/adm/alquileresRouter.js';
import { createJuegosRouter } from '../src/routes/juegos.js';
import { asignarActivo } from '../src/adm/activosController.js';
import { actualizarCosto } from '../src/adm/costosController.js';
import { generarCargosPeriodo } from '../src/adm/alquileresController.js';

const deniedRoles = ['repartidor', 'referente', 'user', 'facturacion', 'contable', 'Admin', ' admin', 'super '];

function routeInventory(router) {
  return router.stack.filter(layer => layer.route).map(layer => ({
    method: Object.keys(layer.route.methods).find(Boolean).toUpperCase(),
    path: layer.route.path,
    handlers: layer.route.stack.map(entry => entry.handle),
  }));
}

function assertCanonicalAdminRouter(name, router, expected) {
  const actual = routeInventory(router);
  assert.deepEqual(actual.map(({ method, path }) => [method, path]).sort(), expected.sort());
  for (const route of actual) {
    assert.equal(route.handlers[0].name, 'withAuth');
    assert.equal(route.handlers[1].canonicalBackofficeGuard, true, `${name} ${route.method} ${route.path}`);
  }
}

const noopHandlers = new Proxy({}, { get: () => (_req, res) => res.json({ ok: true }) });
function withAuth(req, _res, next) { next(); }

const activosExpected = [
  ['GET', '/resumen/general'], ['GET', '/mantenimiento/pendiente'], ['GET', '/reportes/ociosos'],
  ['GET', '/stock-disponible'], ['GET', '/:id/historial'], ['GET', '/:id'], ['GET', '/'],
  ['POST', '/'], ['PUT', '/:id'], ['POST', '/:id/baja'], ['POST', '/asignar'], ['POST', '/devolver'],
  ['POST', '/sanitizar'], ['POST', '/en-reparacion'], ['POST', '/fin-reparacion'],
];
const costosExpected = [
  ['GET', '/simular/:productoId'], ['POST', '/actualizar'], ['GET', '/evolucion/:productoId'], ['GET', '/fijos'],
  ['POST', '/fijos'], ['PUT', '/fijos/:id'], ['DELETE', '/fijos/:id'], ['GET', '/variables/definiciones'],
  ['POST', '/variables/definiciones'], ['PUT', '/variables/definiciones/:id'], ['DELETE', '/variables/definiciones/:id'],
  ['GET', '/variables/aplicacion'], ['POST', '/variables/aplicacion'],
];
const alquileresExpected = [
  ['GET', '/'], ['GET', '/resumen'], ['POST', '/mp-link'], ['POST', '/marcar-cobrado'],
  ['POST', '/desmarcar-cobrado'], ['POST', '/comunicacion'], ['POST', '/generar'],
];

test('RED: los tres routers /api/admin aplican auth y rol canónico a todas sus rutas', () => {
  assertCanonicalAdminRouter('activos', createActivosRouter({ withAuth, handlers: noopHandlers }), activosExpected);
  assertCanonicalAdminRouter('costos', createCostosRouter({ withAuth, handlers: noopHandlers }), costosExpected);
  assertCanonicalAdminRouter('alquileres', createAlquileresRouter({ withAuth, handlers: noopHandlers }), alquileresExpected);
});

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const adminMutations = [
  ['POST', '/api/admin/activos/', {}], ['PUT', '/api/admin/activos/1', {}], ['POST', '/api/admin/activos/1/baja', {}],
  ['POST', '/api/admin/activos/asignar', {}], ['POST', '/api/admin/activos/devolver', {}], ['POST', '/api/admin/activos/sanitizar', {}],
  ['POST', '/api/admin/activos/en-reparacion', {}], ['POST', '/api/admin/activos/fin-reparacion', {}],
  ['POST', '/api/admin/costos/actualizar', {}], ['POST', '/api/admin/costos/fijos', {}], ['PUT', '/api/admin/costos/fijos/1', {}],
  ['DELETE', '/api/admin/costos/fijos/1'], ['POST', '/api/admin/costos/variables/definiciones', {}],
  ['PUT', '/api/admin/costos/variables/definiciones/1', {}], ['DELETE', '/api/admin/costos/variables/definiciones/1'],
  ['POST', '/api/admin/costos/variables/aplicacion', {}], ['POST', '/api/admin/alquileres/mp-link', {}],
  ['POST', '/api/admin/alquileres/marcar-cobrado', {}], ['POST', '/api/admin/alquileres/desmarcar-cobrado', {}],
  ['POST', '/api/admin/alquileres/comunicacion', {}], ['POST', '/api/admin/alquileres/generar', {}],
];

for (const role of deniedRoles) {
  test(`RED: ${JSON.stringify(role)} queda 403 antes de los 21 handlers admin`, async () => {
    let downstream = 0;
    const auth = (req, _res, next) => { req.user = { role, empresa_id: 7 }; next(); };
    const handlers = new Proxy({}, { get: () => (_req, res) => { downstream += 1; res.json({ ok: true }); } });
    const app = express(); app.use(express.json());
    app.use('/api/admin/activos', createActivosRouter({ withAuth: auth, handlers }));
    app.use('/api/admin/costos', createCostosRouter({ withAuth: auth, handlers }));
    app.use('/api/admin/alquileres', createAlquileresRouter({ withAuth: auth, handlers }));
    await withServer(app, async base => {
      for (const [method, path, body] of adminMutations) {
        const response = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    });
    assert.equal(downstream, 0);
  });
}

for (const role of ['admin', 'super']) {
  test(`${role} canónico atraviesa los guards de las 21 mutaciones admin`, async () => {
    let downstream = 0;
    const auth = (req, _res, next) => { req.user = { role, empresa_id: 7 }; next(); };
    const handlers = new Proxy({}, { get: () => (_req, res) => { downstream += 1; res.json({ ok: true }); } });
    const app = express(); app.use(express.json());
    app.use('/api/admin/activos', createActivosRouter({ withAuth: auth, handlers }));
    app.use('/api/admin/costos', createCostosRouter({ withAuth: auth, handlers }));
    app.use('/api/admin/alquileres', createAlquileresRouter({ withAuth: auth, handlers }));
    await withServer(app, async base => {
      for (const [method, path, body] of adminMutations) {
        const response = await fetch(base + path, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(response.status, 200, `${method} ${path}`);
      }
    });
    assert.equal(downstream, adminMutations.length);
  });
}

test('RED: juegos administrativos usa guard exacto y transacción inyectada con outcome unknown sanitizado', async () => {
  let txCalls = 0;
  const router = createJuegosRouter({
    query: async () => [],
    pool: {},
    withTransaction: async () => { txCalls += 1; const error = new Error('socket SQL secreto'); error.code = 'TRANSACTION_OUTCOME_UNKNOWN'; throw error; },
    withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: 7 }; next(); },
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
  });
  const routes = routeInventory(router);
  for (const route of routes) {
    assert.equal(route.handlers[0].name, 'withAuth');
    assert.equal(route.handlers[1].canonicalBackofficeGuard, true, `${route.method} ${route.path}`);
  }
  const app = express(); app.use(express.json()); app.use('/api/juegos', router);
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/juegos/campanias`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'Campaña', premios: [{ tipo: 'sin_premio', nombre_publico: 'Nada', probabilidad: 1 }] }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'No se pudo confirmar el resultado de la transacción.', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
  });
  assert.equal(txCalls, 1);
});

test('COMMIT ambiguo se traduce a 503 sanitizado en activos, costos y alquileres', async () => {
  const app = express();
  app.use(express.json());
  app.locals.withTransaction = async () => {
    const error = new Error('socket SQL con PII');
    error.code = 'TRANSACTION_OUTCOME_UNKNOWN';
    throw error;
  };
  const auth = (req, _res, next) => {
    req.user = { role: 'admin', empresa_id: 7, username: 'admin' };
    next();
  };
  app.use('/api/admin/activos', createActivosRouter({ withAuth: auth }));
  app.use('/api/admin/costos', createCostosRouter({ withAuth: auth }));
  app.use('/api/admin/alquileres', createAlquileresRouter({ withAuth: auth }));
  const cases = [
    ['/api/admin/activos/asignar', { activo_id: 1, cliente_id: 2 }],
    ['/api/admin/costos/actualizar', { producto_id: 1, costo_base: 2, costo_packaging: 1 }],
    ['/api/admin/alquileres/generar', { periodo: '2026-09' }],
  ];
  await withServer(app, async base => {
    for (const [path, body] of cases) {
      const response = await fetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 503, path);
      assert.deepEqual(await response.json(), {
        error: 'No se pudo confirmar el resultado de la transacción.',
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
    }
  });
});

test('RED: no quedan wrappers manuales BEGIN/COMMIT/ROLLBACK en familias migradas', () => {
  for (const relative of ['src/routes/juegos.js', 'src/adm/activosController.js', 'src/adm/costosController.js', 'src/adm/alquileresController.js']) {
    const source = fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.query\(\s*['"](?:BEGIN|COMMIT|ROLLBACK)['"]\s*\)/, relative);
  }
});

function responseRecorder() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function withoutRawErrorLogs(work) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try { await work(calls); }
  finally { console.error = original; }
}

test('exact-row aborta activos antes del historial y responde sin detalle interno', async () => {
  const sql = [];
  const req = {
    body: { activo_id: 10, cliente_id: 20 },
    user: { role: 'admin', empresa_id: 7, username: 'admin' },
    app: { locals: { withTransaction: async work => work(async statement => {
      sql.push(statement);
      if (/SELECT estado FROM empresa_activos/.test(statement)) return [{ estado: 'disponible' }];
      if (/SELECT id FROM puntos_entrega/.test(statement)) return [{ id: 20 }];
      if (/UPDATE empresa_activos/.test(statement)) return [];
      assert.fail(`SQL posterior inesperado: ${statement}`);
    }) } },
  };
  const res = responseRecorder();
  await withoutRawErrorLogs(async calls => {
    await asignarActivo(req, res);
    assert.equal(JSON.stringify(calls).includes('ASSET_EXACT_ROW_FAILED'), false);
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Error asignando activo' });
  assert.equal(sql.some(statement => /INSERT INTO historial_activos/.test(statement)), false);
});

test('exact-row aborta costos antes del historial y responde sin detalle interno', async () => {
  const sql = [];
  const req = {
    body: { producto_id: 10, costo_base: 2, costo_packaging: 1, precio_venta: 9 },
    user: { role: 'admin', empresa_id: 7, username: 'admin' },
    app: { locals: { withTransaction: async work => work(async statement => {
      sql.push(statement);
      if (/SELECT precio FROM productos/.test(statement)) return [{ precio: 8 }];
      if (/INSERT INTO empresa_productos_costos/.test(statement)) return [];
      if (/UPDATE productos SET precio/.test(statement)) return [];
      assert.fail(`SQL posterior inesperado: ${statement}`);
    }) } },
  };
  const res = responseRecorder();
  await withoutRawErrorLogs(async calls => {
    await actualizarCosto(req, res);
    assert.equal(JSON.stringify(calls).includes('PRODUCT_EXACT_ROW_FAILED'), false);
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Error actualizando costos. Se revirtieron los cambios.' });
  assert.equal(sql.some(statement => /INSERT INTO historial_costos_precios/.test(statement)), false);
});

test('exact-row exige un cargo persistido por alquiler y no confirma éxito vacío', async () => {
  const req = {
    body: { periodo: '2026-09' },
    user: { role: 'admin', empresa_id: 7 },
    app: { locals: { withTransaction: async work => work(async statement => {
      if (/WITH periodo_params/.test(statement)) return [{
        cliente_id: 20, monto_total: 100, cantidad_activos: 1, detalle_activos: [],
      }];
      if (/INSERT INTO empresa_activos_alquileres/.test(statement)) return [];
      assert.fail(`SQL inesperado: ${statement}`);
    }) } },
  };
  const res = responseRecorder();
  await withoutRawErrorLogs(async calls => {
    await generarCargosPeriodo(req, res);
    assert.equal(JSON.stringify(calls).includes('RENT_EXACT_ROW_FAILED'), false);
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Error generando cargos' });
});
