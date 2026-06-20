import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /public/pedidos con mismo submission_id no duplica pedido', async () => {
  const seen = new Map();

  const query = async (sql, params = []) => {
    if (sql.includes('FROM puntos_entrega') && sql.includes('telefono_normalizado LIKE')) return [];
    if (sql.includes('INSERT INTO puntos_entrega')) return [{ id: 777 }];
    if (sql.includes('FROM zona_chofer')) return [];
    if (sql.includes('FROM cliente_recompensas')) return [];

    if (sql.includes('SELECT pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }];

    if (sql.includes('FROM pedidos WHERE empresa_id=$1 AND submission_id=$2')) {
      const key = `${params[0]}:${params[1]}`;
      return seen.has(key) ? [seen.get(key)] : [];
    }

    if (sql.includes('INSERT INTO pedidos')) {
      const row = { id: 4321, estado: 'pendiente', monto: 1200, tracking_token: 'tok_4321' };
      const key = `${params[0]}:${params[5]}`;
      seen.set(key, row);
      return [row];
    }

    if (sql.includes('INSERT INTO items_pedido')) return [];
    if (sql.includes('SELECT config_entrega FROM empresas')) return [{ config_entrega: {} }];

    return [];
  };

  const app = express();
  app.use(express.json());
  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    geocodeIfNeeded: async () => null,
    normalizePhone: (v) => String(v || '').replace(/\D+/g, ''),
    pointInAnyZone: async () => null,
    enqueueWppMessage: async () => null,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa: async () => null,
    ejecutarEstrategiaVecinosFn: async () => null,
  });

  const payload = {
    empresa_id: 1,
    cliente: 'Cliente Idempotente',
    telefono: '3875550000',
    direccion: 'Mitre 123',
    items: [{ producto: 'Bidón', cantidad: 1, precio_unitario: 1200 }],
    submission_id: 'idem-1',
  };

  await withServer(app, async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' };

    const r1 = await fetch(`${baseUrl}/public/pedidos`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const j1 = await r1.json();

    const r2 = await fetch(`${baseUrl}/public/pedidos`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const j2 = await r2.json();

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(j1.created, true);
    assert.equal(j2.created, false);
    assert.equal(j1.pedido.id, 4321);
    assert.equal(j2.pedido.id, 4321);
    assert.equal(j1.pedido.tracking_url, '/pedidos/seguimiento.html?t=tok_4321');
    assert.equal(j2.pedido.tracking_url, '/pedidos/seguimiento.html?t=tok_4321');
  });
});
