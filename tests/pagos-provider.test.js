import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPedidoSeguimientoBackUrls } from '../src/qr/pagosProvider.js';
import { validarPagoMercadoPagoContraRegistro } from '../src/qr/pagosService.js';
import { decryptSecret } from '../src/services/facturacionService.js';
import {
  redactEmpresaPaymentSecrets,
  securePaymentIntegraciones,
} from '../src/routes/empresas.js';

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

function paymentFixture(overrides = {}) {
  return {
    id: 'payment_123',
    preference_id: 'preference_123',
    external_reference: 'PEDIDO|emp:3|ped:42',
    transaction_amount: 1250.5,
    currency_id: 'ARS',
    ...overrides,
  };
}

function pagoFixture(overrides = {}) {
  return {
    provider_order_id: 'preference_123',
    monto: '1250.50',
    moneda: 'ARS',
    vence_at: '2026-05-26T18:00:00.000Z',
    ...overrides,
  };
}

test('Mercado Pago acredita solamente la preferencia QR registrada con mismo importe y moneda', () => {
  const result = validarPagoMercadoPagoContraRegistro({
    payment: paymentFixture(),
    pago: pagoFixture(),
    empresaId: 3,
    pedidoId: 42,
    now: new Date('2026-05-25T18:00:00.000Z'),
  });

  assert.deepEqual(result, { ok: true, reason: null });
});

test('Mercado Pago rechaza acreditar un pago de otra preferencia aunque use la referencia del pedido', () => {
  const result = validarPagoMercadoPagoContraRegistro({
    payment: paymentFixture({ preference_id: 'preference_atacante' }),
    pago: pagoFixture(),
    empresaId: 3,
    pedidoId: 42,
    now: new Date('2026-05-25T18:00:00.000Z'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preferencia_invalida');
});

test('Mercado Pago rechaza importes, monedas o QR vencidos', () => {
  const cases = [
    [paymentFixture({ transaction_amount: 1 }), pagoFixture(), 'monto_invalido'],
    [paymentFixture({ currency_id: 'USD' }), pagoFixture(), 'moneda_invalida'],
    [paymentFixture(), pagoFixture({ vence_at: '2026-05-24T18:00:00.000Z' }), 'pago_vencido'],
  ];

  for (const [payment, pago, reason] of cases) {
    const result = validarPagoMercadoPagoContraRegistro({
      payment,
      pago,
      empresaId: 3,
      pedidoId: 42,
      now: new Date('2026-05-25T18:00:00.000Z'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
});

test('configuracion QR cifra credenciales nuevas y no las devuelve al panel', () => {
  const previousKey = process.env.FACTURACION_SECRET_KEY;
  process.env.FACTURACION_SECRET_KEY = 'test-key-pagos-qr';
  try {
    const secured = securePaymentIntegraciones({
      pagos: {
        proveedor: 'mercado_pago',
        access_token: 'APP_USR_secreto',
        webhook_secret: 'firma_secreta',
        auto_confirmar: true,
      },
    });

    assert.equal(secured.pagos.access_token, undefined);
    assert.equal(secured.pagos.webhook_secret, undefined);
    assert.equal(decryptSecret(secured.pagos.access_token_encrypted), 'APP_USR_secreto');
    assert.equal(decryptSecret(secured.pagos.webhook_secret_encrypted), 'firma_secreta');

    const response = redactEmpresaPaymentSecrets({
      id: 3,
      config_integraciones: secured,
    });
    assert.equal(response.config_integraciones.pagos.access_token_encrypted, undefined);
    assert.equal(response.config_integraciones.pagos.webhook_secret_encrypted, undefined);
    assert.equal(response.config_integraciones.pagos.access_token_configured, true);
    assert.equal(response.config_integraciones.pagos.webhook_secret_configured, true);
  } finally {
    if (previousKey === undefined) delete process.env.FACTURACION_SECRET_KEY;
    else process.env.FACTURACION_SECRET_KEY = previousKey;
  }
});

test('configuracion QR conserva el cifrado cuando el panel envia placeholder', () => {
  const secured = securePaymentIntegraciones(
    { pagos: { proveedor: 'mercado_pago', access_token: '********' } },
    { pagos: { access_token_encrypted: 'v1:ya-cifrado' } }
  );

  assert.equal(secured.pagos.access_token_encrypted, 'v1:ya-cifrado');
});
