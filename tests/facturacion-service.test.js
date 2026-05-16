import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateInvoiceTotals,
  isPedidoEstadoFacturable,
  isValidCuit,
  normalizeAfipMode,
  resolveTipoComprobante,
} from '../src/services/facturacionService.js';

test('isValidCuit valida digito verificador', () => {
  assert.equal(isValidCuit('20-12345678-6'), true);
  assert.equal(isValidCuit('20-12345678-7'), false);
  assert.equal(isValidCuit('123'), false);
});

test('normalizeAfipMode usa homologacion como fallback seguro', () => {
  assert.equal(normalizeAfipMode('produccion'), 'produccion');
  assert.equal(normalizeAfipMode('otro'), 'homologacion');
  assert.equal(normalizeAfipMode(null), 'homologacion');
});

test('resolveTipoComprobante cubre reglas fiscales iniciales', () => {
  assert.deepEqual(
    resolveTipoComprobante({ emisorCondicionIva: 'monotributo', receptorCondicionIva: 'responsable_inscripto' }),
    { tipo: 'C', codigo: 11 }
  );
  assert.deepEqual(
    resolveTipoComprobante({ emisorCondicionIva: 'responsable_inscripto', receptorCondicionIva: 'responsable_inscripto' }),
    { tipo: 'A', codigo: 1 }
  );
  assert.deepEqual(
    resolveTipoComprobante({ emisorCondicionIva: 'responsable_inscripto', receptorCondicionIva: 'consumidor_final' }),
    { tipo: 'B', codigo: 6 }
  );
});

test('calculateInvoiceTotals calcula importes de items sin IVA por defecto', () => {
  const totals = calculateInvoiceTotals([
    { descripcion: 'Bidon 20L', cantidad: 2, precio_unitario: 3500 },
    { descripcion: 'Soda', cantidad: 1, precio_unitario: 1200 },
  ]);

  assert.equal(totals.importe_neto, 8200);
  assert.equal(totals.importe_iva, 0);
  assert.equal(totals.importe_total, 8200);
  assert.equal(totals.items.length, 2);
});

test('isPedidoEstadoFacturable excluye pedidos cancelados', () => {
  assert.equal(isPedidoEstadoFacturable('entregado'), true);
  assert.equal(isPedidoEstadoFacturable('pendiente'), true);
  assert.equal(isPedidoEstadoFacturable('Cancelado'), false);
  assert.equal(isPedidoEstadoFacturable('cancelada'), false);
});
