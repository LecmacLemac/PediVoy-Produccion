import test from 'node:test';
import assert from 'node:assert/strict';

import {
  associateClienteWithReferente,
  generateComisionesForDeliveredOrder,
  normalizeReferenteCode,
} from '../src/services/referentesService.js';

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

