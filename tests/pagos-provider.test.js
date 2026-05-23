import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPedidoSeguimientoBackUrls } from '../src/qr/pagosProvider.js';

test('Mercado Pago vuelve al seguimiento con token publico del pedido', () => {
  const urls = buildPedidoSeguimientoBackUrls({
    baseUrl: 'https://pedivoy.test/',
    pedido: { trackingToken: 'tok_123' },
  });

  assert.deepEqual(urls, {
    success: 'https://pedivoy.test/pedidos/seguimiento.html?t=tok_123&pago=approved',
    failure: 'https://pedivoy.test/pedidos/seguimiento.html?t=tok_123&pago=failure',
    pending: 'https://pedivoy.test/pedidos/seguimiento.html?t=tok_123&pago=pending',
  });
});

test('Mercado Pago no arma back_urls de seguimiento sin token', () => {
  const urls = buildPedidoSeguimientoBackUrls({
    baseUrl: 'https://pedivoy.test',
    pedido: {},
  });

  assert.equal(urls, null);
});
