import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';

function buildApp({ query, enqueueWppMessage } = {}) {
  const app = express();
  app.use(express.json());

  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    geocodeIfNeeded: async () => ({ lat: -24.8, lng: -65.4 }),
    normalizePhone: (v) => String(v || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => 7,
    enqueueWppMessage: enqueueWppMessage || (async () => null),
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => 'ALIAS.TEST',
    ejecutarEstrategiaVecinosFn: async () => null,
  });

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

test('POST /public/pedidos crea pedido válido', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push(String(sql));

    if (sql.includes('FROM puntos_entrega') && sql.includes('telefono_normalizado LIKE')) return [];
    if (sql.includes('INSERT INTO puntos_entrega')) return [{ id: 101 }];
    if (sql.includes('FROM zona_chofer')) return [{ id: 55 }];
    if (sql.includes('FROM productos') && sql.includes('promo_config')) return [];
    if (sql.includes('FROM cliente_recompensas')) return [];
    if (sql.includes('SELECT pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }];
    if (sql.includes('FROM pedidos WHERE empresa_id=$1 AND submission_id=$2')) return [];
    if (sql.includes('INSERT INTO pedidos')) return [{ id: 9001, estado: 'pendiente', monto: 7000, tracking_token: 'tok_9001' }];
    if (sql.includes('INSERT INTO items_pedido')) return [];
    if (sql.includes('SELECT config_entrega FROM empresas')) return [{ config_entrega: {} }];
    if (sql.includes('FROM zonas_geograficas')) return [{ id: 7, nombre: 'Norte', dias_entrega: [3] }];
    if (sql.includes('SELECT nombre, telefono FROM choferes')) return [{ nombre: 'Juan', telefono: '3871234567' }];
    if (sql.includes('FROM cliente_retornables_saldos')) return [];

    throw new Error(`SQL inesperado en test: ${sql.slice(0, 90)}`);
  };

  let wppCalls = 0;
  const app = buildApp({
    query,
    enqueueWppMessage: async () => { wppCalls += 1; },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/public/pedidos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1' },
      body: JSON.stringify({
        empresa_id: 1,
        cliente: 'Hidro Cliente',
        telefono: '387-555-1122',
        direccion: 'Calle Falsa 123',
        ciudad: 'Salta',
        provincia: 'Salta',
        pais: 'Argentina',
        metodo_pago: 'efectivo',
        submission_id: 'sub-9001',
        items: [{ producto: 'Bidón 20L', cantidad: 2, precio_unitario: 3500 }],
      }),
    });

    assert.equal(resp.status, 200);
    assert.ok(resp.headers.get('x-request-id'));

    const body = await resp.json();
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
    assert.equal(body.pedido.id, 9001);
    assert.equal(body.pedido.estado, 'pendiente');
    assert.equal(body.pedido.monto, 7000);
    assert.equal(body.pedido.tracking_token, 'tok_9001');
    assert.equal(body.pedido.tracking_url, '/pedidos/seguimiento.html?t=tok_9001');
    assert.equal(wppCalls, 1);
    assert.ok(calls.some((s) => s.includes('INSERT INTO pedidos')));
  });
});

test('POST /public/pedidos agrega retornables pendientes al WhatsApp del cliente', async () => {
  let wppMessage = '';
  const query = async (sql) => {
    if (sql.includes('FROM puntos_entrega') && sql.includes('telefono_normalizado LIKE')) return [{ id: 101, zona_id: 7 }];
    if (sql.includes('FROM zona_chofer')) return [];
    if (sql.includes('FROM productos') && sql.includes('promo_config')) return [];
    if (sql.includes('FROM cliente_recompensas')) return [];
    if (sql.includes('SELECT pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }];
    if (sql.includes('FROM pedidos WHERE empresa_id=$1 AND submission_id=$2')) return [];
    if (sql.includes('INSERT INTO pedidos')) return [{ id: 9002, estado: 'pendiente', monto: 7000, tracking_token: 'tok_9002' }];
    if (sql.includes('INSERT INTO items_pedido')) return [];
    if (sql.includes('SELECT config_entrega FROM empresas')) return [{ config_entrega: {} }];
    if (sql.includes('FROM zonas_geograficas')) return [{ id: 7, nombre: 'Norte', dias_entrega: [3] }];
    if (sql.includes('FROM cliente_retornables_saldos')) return [{ producto_id: 55, producto: 'Bidón retornable', saldo: '3' }];

    throw new Error(`SQL inesperado en test: ${sql.slice(0, 90)}`);
  };

  const app = buildApp({
    query,
    enqueueWppMessage: async ({ message }) => { wppMessage = message; },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/public/pedidos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '2.2.2.2' },
      body: JSON.stringify({
        empresa_id: 1,
        cliente: 'Hidro Cliente',
        telefono: '387-555-1122',
        direccion: 'Calle Falsa 123',
        ciudad: 'Salta',
        provincia: 'Salta',
        pais: 'Argentina',
        metodo_pago: 'efectivo',
        submission_id: 'sub-9002',
        items: [{ producto: 'Bidón 20L', cantidad: 2, precio_unitario: 3500 }],
      }),
    });

    assert.equal(resp.status, 200);
  });

  assert.match(wppMessage, /Retornables pendientes/);
  assert.match(wppMessage, /Recordá entregar 3 Bidón retornable al repartidor/);
});
