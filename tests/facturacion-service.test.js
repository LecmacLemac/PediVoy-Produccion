import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateInvoiceTotals,
  cancelFactura,
  deleteFactura,
  hasProductionEmissionConfirmation,
  isPedidoEstadoFacturable,
  isProductionEmissionEnabled,
  isValidCuit,
  normalizeAfipMode,
  resolveTipoComprobante,
} from '../src/services/facturacionService.js';
import { buildAfipQrPayload } from '../src/services/facturaPdfService.js';

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

test('produccion exige habilitacion y confirmacion explicita', () => {
  assert.equal(isProductionEmissionEnabled({ modo_afip: 'homologacion' }), true);
  assert.equal(isProductionEmissionEnabled({ modo_afip: 'produccion', produccion_habilitada: false }), false);
  assert.equal(isProductionEmissionEnabled({ modo_afip: 'produccion', produccion_habilitada: true }), true);
  assert.equal(hasProductionEmissionConfirmation('EMITIR_FACTURA_REAL'), true);
  assert.equal(hasProductionEmissionConfirmation('emitir'), false);
});

test('cancelFactura marca como anulada sin tocar facturas emitidas', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return [{ id: params[0], empresa_id: params[1], estado: 'anulada' }];
  };

  const factura = await cancelFactura(query, { facturaId: 12, empresaId: 3 });

  assert.equal(factura.estado, 'anulada');
  assert.match(calls[0].sql, /estado NOT IN \('emitida', 'anulada'\)/);
  assert.deepEqual(calls[0].params, [12, 3]);
});

test('deleteFactura elimina solo facturas no emitidas ni anuladas', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return [{ id: params[0], empresa_id: params[1], estado: 'pendiente_confirmacion' }];
  };

  const factura = await deleteFactura(query, { facturaId: 15, empresaId: 4 });

  assert.equal(factura.id, 15);
  assert.match(calls[0].sql, /DELETE FROM facturas/);
  assert.match(calls[0].sql, /estado NOT IN \('emitida', 'anulada'\)/);
  assert.deepEqual(calls[0].params, [15, 4]);
});

test('buildAfipQrPayload arma URL oficial con CAE', () => {
  const qr = buildAfipQrPayload({
    config: { cuit: '20-24617736-9' },
    factura: {
      fecha_comprobante: '2026-05-16',
      punto_venta: 1,
      codigo_comprobante_afip: 11,
      numero_comprobante: 1,
      importe_total: 100,
      receptor_documento: '12345678',
      cae: '86200173459046',
    },
  });

  assert.match(qr.url, /^https:\/\/www\.afip\.gob\.ar\/fe\/qr\/\?p=/);
  assert.equal(qr.payload.cuit, 20246177369);
  assert.equal(qr.payload.tipoCmp, 11);
  assert.equal(qr.payload.codAut, 86200173459046);
});
