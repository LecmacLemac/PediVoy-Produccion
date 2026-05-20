import test from 'node:test';
import assert from 'node:assert/strict';

import {
  associateClienteWithReferente,
  generateComisionesForDeliveredOrder,
  normalizeReferenteCode,
} from '../src/services/referentesService.js';
import { createPedidoEstadoNotifications } from '../src/services/referenteNotifications.js';

test('normalizeReferenteCode normaliza codigo de referente', () => {
  assert.equal(normalizeReferenteCode(' ref-123 '), 'REF-123');
});

test('associateClienteWithReferente crea asociacion si el codigo esta activo', async () => {
  const calls = [];
  const queryFn = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM referentes')) {
      return [{ id: 9, empresa_id: 1, nombre: 'Vendedor', codigo: 'REF9', porcentaje_comision: 10 }];
    }
    if (sql.includes('FROM cliente_referentes') && sql.includes('JOIN referentes')) return [];
    if (sql.includes('INSERT INTO cliente_referentes')) {
      return [{ id: 44, referente_id: 9, codigo_referente: 'REF9' }];
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  };

  const result = await associateClienteWithReferente({
    queryFn,
    empresaId: 1,
    puntoEntregaId: 101,
    codigo: ' ref9 ',
  });

  assert.deepEqual(result, { id: 44, referente_id: 9, codigo: 'REF9', created: true });
  assert.equal(calls.length, 3);
});

test('generateComisionesForDeliveredOrder genera comision idempotente por item', async () => {
  const inserts = [];
  const queryFn = async (sql, params = []) => {
    if (sql.includes('FROM pedidos')) {
      return [{ id: 9001, empresa_id: 1, punto_entrega_id: 101, estado: 'entregado', fecha_entrega: '2026-05-19T20:00:00Z' }];
    }
    if (sql.includes('FROM cliente_referentes')) {
      assert.match(sql, /cr\.asociado_at/);
      return [{ referente_id: 9, porcentaje_comision: 8 }];
    }
    if (sql.includes('FROM items_pedido')) {
      return [
        { item_pedido_id: 1, producto_id: 20, cantidad: 2, precio_unitario: 1000, porcentaje_producto: 10 },
        { item_pedido_id: 2, producto_id: 21, cantidad: 1, precio_unitario: 500, porcentaje_producto: null },
      ];
    }
    if (sql.includes('INSERT INTO referente_comisiones')) {
      inserts.push(params);
      return [{ id: inserts.length }];
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  };

  const result = await generateComisionesForDeliveredOrder({ queryFn, empresaId: 1, pedidoId: 9001 });

  assert.equal(result.inserted, 2);
  assert.equal(inserts[0][6], 2000);
  assert.equal(inserts[0][7], 10);
  assert.equal(inserts[1][6], 500);
  assert.equal(inserts[1][7], 8);
});

test('generateComisionesForDeliveredOrder no comisiona pedidos anteriores al codigo', async () => {
  let itemsConsultados = false;
  const queryFn = async (sql) => {
    if (sql.includes('FROM pedidos')) {
      return [{
        id: 9002,
        empresa_id: 1,
        punto_entrega_id: 101,
        estado: 'entregado',
        fecha: '2026-05-01T10:00:00Z',
        fecha_entrega: '2026-05-01T12:00:00Z',
      }];
    }
    if (sql.includes('FROM cliente_referentes')) {
      assert.match(sql, /COALESCE\(\$3::timestamptz, NOW\(\)\) >= COALESCE\(cr\.asociado_at/);
      return [];
    }
    if (sql.includes('FROM items_pedido')) {
      itemsConsultados = true;
      return [];
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  };

  const result = await generateComisionesForDeliveredOrder({ queryFn, empresaId: 1, pedidoId: 9002 });

  assert.deepEqual(result, { inserted: 0 });
  assert.equal(itemsConsultados, false);
});

test('createPedidoEstadoNotifications avisa a referentes vinculados al pedido', async () => {
  const calls = [];
  const queryFn = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('CREATE TABLE IF NOT EXISTS referente_notificaciones')) return [];
    if (sql.includes('CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx')) return [];
    if (sql.includes('INSERT INTO referente_notificaciones')) {
      assert.equal(params[0], 1);
      assert.equal(params[1], 9001);
      assert.equal(params[2], 'entregado');
      assert.match(sql, /JOIN cliente_referentes cr/);
      assert.match(sql, /cr\.estado IN \('activo','desvinculado'\)/);
      assert.match(sql, /cr\.desvinculado_at IS NULL/);
      return [{ id: 70, referente_id: 9 }];
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  };

  const result = await createPedidoEstadoNotifications({
    queryFn,
    empresaId: 1,
    pedidoId: 9001,
    estado: 'entregado',
  });

  assert.deepEqual(result, [{ id: 70, referente_id: 9 }]);
  assert.equal(calls.length, 3);
});
