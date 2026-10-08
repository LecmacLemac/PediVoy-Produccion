import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNotificarEnRuta,
  createNotificarPedidoTransferencia,
} from '../src/services/notificacionesPedidos.js';

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
  assert.equal(enqueued[0].message, '🚚 *¡Tu pedido está en camino!*\n\nHola Cliente Test, tu pedido ya salió hacia Calle Test 123.\n\n🗺️ *Seguí al repartidor en vivo aquí:*\nhttps://www.pedivoy.com/pedidos/seguimiento.html?t=tok_123\n\n¡Nos vemos pronto! 👋');
  assert.deepEqual(enqueued[0].utility_template, {
    key: 'order_en_route',
    parameters: {
      customer_name: 'Cliente Test',
      address: 'Calle Test 123',
      tracking_token: 'tok_123',
    },
  });
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
      if (sql.includes('SET tracking_token')) return [{ tracking_token: 'winner_token' }];
      if (sql.includes('SET en_ruta_notificado_at')) return [];
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async (msg) => enqueued.push(msg),
    randomBytes: () => ({ toString: () => 'tok_nuevo' }),
  });

  await notificarEnRuta(42, 1);

  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].message, /https:\/\/clientes\.pedivoy\.test\/pedidos\/seguimiento\.html\?t=winner_token/);
  assert.equal(enqueued[0].utility_template.parameters.tracking_token, 'winner_token');
  assert.doesNotMatch(enqueued[0].message, /tok_nuevo/);
});

test('notificarEnRuta rechaza tokens no opacos y no marca la notificación', async () => {
  for (const token of ['', 'https://evil.test/x', 'tok?x=1', 'tok con espacio', 'tok\ncontrol', 'x'.repeat(201)]) {
    const enqueued = [];
    const marks = [];
    const notificarEnRuta = createNotificarEnRuta({
      queryFn: async (sql) => {
        if (sql.includes('ALTER TABLE pedidos')) return [];
        if (sql.includes('SELECT') && sql.includes('FROM pedidos')) return [buildPedido({ tracking_token: token })];
        if (sql.includes('SET tracking_token')) return [{ tracking_token: token }];
        if (sql.includes('SET en_ruta_notificado_at')) { marks.push(sql); return []; }
        throw new Error(`SQL no esperado: ${sql}`);
      },
      enqueueWppMessageFn: async payload => { enqueued.push(payload); },
    });
    await assert.rejects(notificarEnRuta(42, 1), { code: 'cloud_template_payload_invalid' });
    assert.equal(enqueued.length, 0);
    assert.equal(marks.length, 0);
  }
});

test('notificarEnRuta propaga error sanitizado y marca sólo después de enqueue confirmado', async () => {
  const events = [];
  const notificarEnRuta = createNotificarEnRuta({
    queryFn: async (sql) => {
      if (sql.includes('ALTER TABLE pedidos')) return [];
      if (sql.includes('SELECT') && sql.includes('FROM pedidos')) return [buildPedido()];
      if (sql.includes('SET en_ruta_notificado_at')) { events.push('marked'); return []; }
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async () => {
      events.push('enqueue');
      throw Object.assign(new Error('private token tok_123 customer Cliente Test'), { code: 'enqueue_fallido' });
    },
  });

  await assert.rejects(notificarEnRuta(42, 1), error => {
    assert.equal(error.code, 'enqueue_fallido');
    assert.doesNotMatch(JSON.stringify(error), /tok_123|Cliente Test|private/);
    return true;
  });
  assert.deepEqual(events, ['enqueue']);
});

test('notificarPedidoTransferencia usa la cuenta activa de menor prioridad', async () => {
  const enqueued = [];
  const queries = [];
  const notificarPedidoTransferencia = createNotificarPedidoTransferencia({
    queryFn: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM pedidos')) {
        return [{
          id: 42,
          monto: 7500,
          cliente: 'Cliente Test',
          telefono: '3531234567',
          direccion: 'Calle Test 123',
          empresa_nombre: 'PediVoy Test',
          empresa_id: 1,
        }];
      }
      if (sql.includes('FROM empresa_cuentas_bancarias')) {
        assert.match(sql, /ORDER BY COALESCE\(prioridad, 999\), id ASC/);
        return [{
          alias: 'PRINCIPAL.TEST',
          banco: 'Banco Principal',
          cbu: '0000003100012345678901',
          titular: 'PediVoy Test',
          prioridad: 1,
        }];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async (msg) => enqueued.push(msg),
  });

  await notificarPedidoTransferencia(42, 1);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].phone, '3531234567');
  assert.equal(enqueued[0].empresa_id, 1);
  assert.equal(enqueued[0].message, '🏦 *Pago por transferencia*\n\nHola Cliente Test, tu pedido fue marcado para pagar por *transferencia* ($\u00a07.500,00).\n\n💳 *Datos para transferir:*\nAlias: PRINCIPAL.TEST\nCBU: 0000003100012345678901\nBanco: Banco Principal\nTitular: PediVoy Test\n\nPor favor, adjuntá el *comprobante de transferencia* respondiendo a este mensaje para poder acreditar el pago.\n\n¡Muchas gracias!\nPediVoy Test');
  assert.deepEqual(enqueued[0].utility_template, {
    key: 'transfer_payment',
    parameters: {
      customer_name: 'Cliente Test',
      amount: '$\u00a07.500,00',
      alias: 'PRINCIPAL.TEST',
      cbu: '0000003100012345678901',
      bank: 'Banco Principal',
      holder: 'PediVoy Test',
      company_name: 'PediVoy Test',
    },
  });
  assert.match(enqueued[0].message, /Alias: PRINCIPAL\.TEST/);
  assert.match(enqueued[0].message, /CBU: 0000003100012345678901/);
  assert.match(enqueued[0].message, /Banco: Banco Principal/);
  assert.ok(queries.some((q) => q.sql.includes('FROM empresa_cuentas_bancarias')));
});

test('notificarPedidoTransferencia conserva texto Web sin cuenta y delega fail-closed Cloud', async () => {
  const enqueued = [];
  const notificarPedidoTransferencia = createNotificarPedidoTransferencia({
    queryFn: async (sql, params = []) => {
      if (sql.includes('FROM pedidos')) return [{
        id: 42, monto: 7500, cliente: 'Cliente Test', telefono: '3531234567',
        direccion: 'Calle Test 123', empresa_nombre: 'PediVoy Test', empresa_id: 1,
      }];
      if (sql.includes('FROM empresa_cuentas_bancarias')) {
        assert.deepEqual(params, [1]);
        return [];
      }
      throw new Error(`SQL no esperado: ${sql}`);
    },
    enqueueWppMessageFn: async payload => { enqueued.push(payload); return { queued: true, transportOrigin: 'company' }; },
  });

  await notificarPedidoTransferencia(42, 1);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].utility_template, null);
  assert.equal(enqueued[0].require_utility_template, true);
  assert.equal(enqueued[0].message, '🏦 *Pago por transferencia*\n\nHola Cliente Test, tu pedido fue marcado para pagar por *transferencia* ($\u00a07.500,00).\n\nPor favor, adjuntá el *comprobante de transferencia* respondiendo a este mensaje para poder acreditar el pago.\n\n¡Muchas gracias!\nPediVoy Test');
});

test('notificarPedidoTransferencia no filtra datos si Cloud rechaza una cuenta incompleta', async () => {
  const privateValues = ['ALIAS.SECRETO', '0000003100012345678901', 'Titular Secreto', 'Cliente Secreto', '3539999999', 'private-token'];
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    const notificarPedidoTransferencia = createNotificarPedidoTransferencia({
      queryFn: async (sql) => {
        if (sql.includes('FROM pedidos')) return [{
          id: 42, monto: 7500, cliente: privateValues[3], telefono: privateValues[4],
          direccion: 'Dirección secreta', empresa_nombre: 'PediVoy Test', empresa_id: 1,
        }];
        if (sql.includes('FROM empresa_cuentas_bancarias')) return [{
          alias: privateValues[0], banco: '', cbu: privateValues[1], titular: privateValues[2], prioridad: 1,
        }];
        throw new Error(`SQL no esperado: ${sql}`);
      },
      enqueueWppMessageFn: async payload => {
        assert.equal(payload.utility_template, null);
        assert.equal(payload.require_utility_template, true);
        throw Object.assign(new Error(privateValues.join('|')), { code: 'cloud_template_payload_invalid', token: privateValues[5] });
      },
    });

    await assert.rejects(notificarPedidoTransferencia(42, 1), error => {
      assert.equal(error.code, 'cloud_template_payload_invalid');
      const serialized = JSON.stringify(error);
      for (const value of privateValues) assert.doesNotMatch(serialized, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
    const serializedLogs = JSON.stringify(logs);
    for (const value of privateValues) assert.doesNotMatch(serializedLogs, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    console.error = originalError;
  }
});
