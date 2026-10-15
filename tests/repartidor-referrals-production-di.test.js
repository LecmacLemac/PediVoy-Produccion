import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolateRepartidorProductionDI } from './support/repartidor-production-di-isolation.js';

const isolation = isolateRepartidorProductionDI();
const { createApp } = await import('../src/app.js');
const { createDomainDeps } = await import('../src/bootstrap/createDomainDeps.js');
await isolation.fixture();
test.after(() => {
  try {
    assert.deepEqual(isolation.state.defaultDbCalls, []);
    assert.deepEqual(isolation.state.workerCalls, []);
    assert.deepEqual(isolation.state.networkViolations, []);
  } finally {
    isolation.restore();
  }
});

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checklist = { cliente_confirmado: true, producto_entregado: true, cobro_confirmado: true };

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  isolation.state.ports.add(server.address().port);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    const port = server.address().port;
    try {
      // ENABLE_WPP=false prevents transport startup, not cron registration.
      // Exercise the real application lifecycle instead of unref/timeout/exit.
      assert.equal(await app.locals.wppGeneralShutdown(), true);
      await app.locals.wppEmpresaWorkersShutdown();
    } finally {
      await new Promise(resolve => server.close(resolve));
      isolation.state.ports.delete(port);
    }
  }
}

function deliveryClient({ commitError = null, workError = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql === 'COMMIT' && commitError) throw commitError;
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE')) return { rows: [{
          id: 42, empresa_id: 3, chofer_id: 7, estado: 'en_ruta', metodo_pago: 'efectivo',
          zona_id: 5, punto_entrega_id: 9, punto_entrega_tenant_id: 9, monto: 1200,
          cuenta_corriente_habilitada: false,
        }] };
        if (sql.includes('FROM choferes') && sql.includes('FOR SHARE')) return { rows: [{ id: 7 }] };
        if (sql.includes('to_jsonb(pe)') && !sql.includes('FOR UPDATE')) return { rows: [{ id: 9, empresa_id: 3 }] };
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('FROM puntos_entrega') && sql.includes('FOR')) return { rows: [{ id: 9, cuenta_corriente_habilitada: false }] };
        if (sql.includes('FROM zona_chofer')) return { rows: [{ zona_id: 5 }] };
        if (sql.includes('FROM items_pedido') && sql.includes('ORDER BY id')) return { rows: [] };
        if (sql.includes('FROM productos') && sql.includes('id = ANY') && !sql.includes('FOR SHARE')) return { rows: [] };
        if (sql.includes('FROM productos') && sql.includes('FOR SHARE')) return { rows: [] };
        if (sql.includes('COALESCE(p.retornable') && sql.includes('FROM items_pedido ip')) return { rows: [] };
        if (sql.includes('config_activo') && sql.includes('FROM items_pedido ip')) return { rows: [] };
        if (sql.includes("UPDATE pedidos") && sql.includes("estado = 'entregado'")) {
          if (workError) throw workError;
          return { rows: [{ id: 42 }] };
        }
        if (sql.includes('INSERT INTO entregas_evidencias')) return { rows: [] };
        if (sql.includes('FROM comprobantes_transferencia')) return { rows: [] };
        throw new Error(`Consulta inesperada: ${sql}`);
      },
      release() {},
    },
  };
}

function productionApp(client, effects, {
  recompensa = args => effects.push(['recompensa', args]),
  estrategia = args => effects.push(['estrategia', args]),
} = {}) {
  const deps = createDomainDeps({ projectDir });
  assert.equal(typeof deps.ejecutarRecompensaReferido, 'function');
  assert.equal(typeof deps.ejecutarEstrategiaReferidos, 'function');
  const businessQueries = [];
  const app = createApp({
    ...deps,
    query: async (sql, params) => { businessQueries.push({ sql, params }); return []; },
    pool: { connect: async () => client },
    withTransaction: async work => work(async () => []),
    withAuth(req, _res, next) {
      req.user = { role: 'repartidor', empresa_id: 3, chofer_id: 7, username: 'chofer' };
      next();
    },
    getEmpresaIdFromToken: () => 3,
    resolveEmpresaId: () => 3,
    isSuper: () => false,
    notifyEstadoPedidoPush: async () => {},
    notificarEnRuta: async () => {},
    notificarPedidoTransferencia: async () => {},
    ejecutarEstrategiaVecinos: async () => {},
    ejecutarPostEntregaUpsell: async () => {},
    ejecutarRecompensaReferido: recompensa,
    ejecutarEstrategiaReferidos: estrategia,
    awardPointsForDeliveredOrder: async () => {},
    generateComisionesForDeliveredOrder: async () => {},
    registrarMovimientosActivosDesdePedido: async () => {},
    wpp: { checkLicencia: (_req, _res, next) => next() },
    ENABLE_WPP: false,
    WPP_QR_ONLY: false,
  });
  app.locals.diBusinessQueries = businessQueries;
  return app;
}

test('DI montaje no ejecuta IO de negocio y teardown libera los timers WPP aunque ENABLE_WPP sea false', async () => {
  const timersBefore = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
  const { client, calls } = deliveryClient();
  const effects = [];
  const app = productionApp(client, effects);
  await withServer(app, async baseUrl => {
    assert.deepEqual(calls, [], 'montar no debe iniciar la transacción de entrega');
    assert.deepEqual(app.locals.diBusinessQueries, [], 'montar no debe ejecutar consultas de negocio inyectadas');
    assert.deepEqual(effects, []);
    assert.deepEqual(isolation.state.defaultDbCalls, [], 'ninguna consulta DB por defecto');
    assert.deepEqual(isolation.state.workerCalls, [], 'ningún worker');
    assert.equal(typeof app.locals.wppGeneralShutdown, 'function');
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    await response.json();
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(process.getActiveResourcesInfo().filter(type => type === 'Timeout').length, timersBefore,
    'el fixture debe cerrar los cron/timers, no sólo el socket HTTP');
});

test('DI productiva createDomainDeps -> createApp -> mount -> repartidor entrega ambas tareas una vez después de COMMIT', async () => {
  const { client, calls } = deliveryClient();
  const effects = [];
  const app = productionApp(client, effects);
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checklist, movimientos: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.deepEqual(effects, [
    ['recompensa', { pedidoId: 42, empresaId: 3 }],
    ['estrategia', { pedidoId: 42, empresaId: 3 }],
  ]);
});

test('DI productiva no ejecuta referidos ante COMMIT ambiguo', async () => {
  const { client } = deliveryClient({ commitError: new Error('commit ambiguo') });
  const effects = [];
  const app = productionApp(client, effects);
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checklist, movimientos: [] }),
    });
    assert.equal(response.status, 503);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(effects, []);
});

test('DI productiva no ejecuta referidos si la transacción revierte antes de COMMIT', async () => {
  const { client, calls } = deliveryClient({ workError: new Error('fallo transaccional') });
  const effects = [];
  const app = productionApp(client, effects);
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checklist, movimientos: [] }),
    });
    assert.equal(response.status, 500);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 0);
  assert.deepEqual(effects, []);
});

test('DI productiva aísla throw síncrono y rechazo async de referidos después de COMMIT', async () => {
  const { client, calls } = deliveryClient();
  const effects = [];
  const app = productionApp(client, effects, {
    recompensa(args) {
      effects.push(['recompensa', args]);
      throw new Error('recompensa sync privada');
    },
    async estrategia(args) {
      effects.push(['estrategia', args]);
      throw new Error('estrategia async privada');
    },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checklist, movimientos: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 0);
  assert.deepEqual(effects, [
    ['recompensa', { pedidoId: 42, empresaId: 3 }],
    ['estrategia', { pedidoId: 42, empresaId: 3 }],
  ]);
});
