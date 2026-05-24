import test from 'node:test';
import assert from 'node:assert/strict';

import { createNotificarEnRuta } from '../src/services/notificacionesPedidos.js';

function buildPedido(overrides = {}) {
  return {
    id: 42,
    monto: 1000,
    tracking_token: 'tok_123',
    en_ruta_notificado_at: null,
    cliente: 'Cliente Test',
    telefono: '3531234567',
    direccion: 'Calle Test 123',
    landing_domain: null,
    landing_slug: null,
    ...overrides,
  };
}

test('notificarEnRuta envia WhatsApp aunque el pedido ya tenga tracking_token', async () => {
  const enqueued = [];
  const queries = [];
  const notificarEnRuta = createNotificarEnRuta({
    queryFn: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('ALTER TABLE pedidos')) return [];
      if (sql.includes('SELECT') && sql.includes('FROM pedidos')) return [buildPedido()];
      if (sql.includes('SET en_ruta_notificado_at')) return [];
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async (msg) => enqueued.push(msg),
  });

  await notificarEnRuta(42, 1);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].phone, '3531234567');
  assert.equal(enqueued[0].empresa_id, 1);
  assert.match(enqueued[0].message, /https:\/\/www\.pedivoy\.com\/pedidos\/seguimiento\.html\?t=tok_123/);
  assert.ok(queries.some((q) => q.sql.includes('SET en_ruta_notificado_at')));
});

test('notificarEnRuta no duplica si ya fue notificado', async () => {
  const enqueued = [];
  const notificarEnRuta = createNotificarEnRuta({
    queryFn: async (sql) => {
      if (sql.includes('ALTER TABLE pedidos')) return [];
      if (sql.includes('SELECT') && sql.includes('FROM pedidos')) {
        return [buildPedido({ en_ruta_notificado_at: '2026-05-24T10:00:00.000Z' })];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async (msg) => enqueued.push(msg),
  });

  await notificarEnRuta(42, 1);

  assert.equal(enqueued.length, 0);
});

test('notificarEnRuta genera token si falta y envia link con token nuevo', async () => {
  const enqueued = [];
  const notificarEnRuta = createNotificarEnRuta({
    queryFn: async (sql) => {
      if (sql.includes('ALTER TABLE pedidos')) return [];
      if (sql.includes('SELECT') && sql.includes('FROM pedidos')) {
        return [buildPedido({ tracking_token: null, landing_domain: 'clientes.pedivoy.test' })];
      }
      if (sql.includes('SET tracking_token')) return [{ tracking_token: 'tok_nuevo' }];
      if (sql.includes('SET en_ruta_notificado_at')) return [];
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async (msg) => enqueued.push(msg),
    randomBytes: () => ({ toString: () => 'tok_nuevo' }),
  });

  await notificarEnRuta(42, 1);

  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].message, /https:\/\/clientes\.pedivoy\.test\/pedidos\/seguimiento\.html\?t=tok_nuevo/);
});
