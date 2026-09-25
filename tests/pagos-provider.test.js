import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPedidoSeguimientoBackUrls } from '../src/qr/pagosProvider.js';
import { validarPagoMercadoPagoContraRegistro } from '../src/qr/pagosService.js';
import { decryptSecret } from '../src/services/facturacionService.js';
import {
  redactEmpresaPaymentSecrets,
  securePaymentIntegraciones,
} from '../src/routes/empresas.js';

process.env.FACTURACION_SECRET_KEY ||= 'test-key-pagos-provider';

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

test('update solo WhatsApp conserva pagos cifrados y otras integraciones', () => {
  const secured = securePaymentIntegraciones(
    {
      whatsapp: {
        provider: 'cloud',
        enabled: true,
        phone_number_id: 'phone-new',
      },
    },
    {
      pagos: {
        proveedor: 'mercado_pago',
        public_key: 'public-existing',
        access_token_encrypted: 'v1:token-cifrado',
        webhook_secret_encrypted: 'v1:webhook-cifrado',
      },
      whatsapp: { provider: 'web', enabled: false },
      envios: { proveedor: 'correo', sucursal: 'centro' },
    }
  );

  assert.deepEqual(secured.pagos, {
    proveedor: 'mercado_pago',
    public_key: 'public-existing',
    access_token_encrypted: 'v1:token-cifrado',
    webhook_secret_encrypted: 'v1:webhook-cifrado',
  });
  assert.deepEqual(secured.whatsapp, {
    provider: 'cloud',
    enabled: true,
    phone_number_id: 'phone-new',
  });
  assert.deepEqual(secured.envios, { proveedor: 'correo', sucursal: 'centro' });
});

test('provider WhatsApp se persiste canónico con trim y lowercase', () => {
  const cloud = securePaymentIntegraciones({ whatsapp: { provider: '  ClOuD  ' } });
  const web = securePaymentIntegraciones({ whatsapp: { provider: '\tWeB\n' } });
  assert.equal(cloud.whatsapp.provider, 'cloud');
  assert.equal(web.whatsapp.provider, 'web');
});

test('update solo pagos conserva WhatsApp allowlisted y fusiona otras integraciones', () => {
  const secured = securePaymentIntegraciones(
    {
      pagos: {
        proveedor: 'mercado_pago',
        access_token: '********',
        auto_confirmar: true,
      },
      envios: { sucursal: 'norte' },
    },
    {
      pagos: {
        proveedor: 'mercado_pago',
        public_key: 'public-existing',
        access_token_encrypted: 'v1:token-cifrado',
        webhook_secret_encrypted: 'v1:webhook-cifrado',
      },
      whatsapp: {
        provider: 'cloud',
        enabled: true,
        phone_number_id: 'phone-existing',
        access_token: 'legacy-token',
        app_secret: 'legacy-secret',
        arbitrary: 'legacy-arbitrary',
      },
      envios: { proveedor: 'correo', sucursal: 'centro' },
    }
  );

  assert.deepEqual(secured.pagos, {
    proveedor: 'mercado_pago',
    public_key: 'public-existing',
    auto_confirmar: true,
    access_token_encrypted: 'v1:token-cifrado',
    webhook_secret_encrypted: 'v1:webhook-cifrado',
  });
  assert.equal(secured.whatsapp.provider, 'cloud');
  assert.equal(secured.whatsapp.enabled, true);
  assert.equal(secured.whatsapp.phone_number_id, 'phone-existing');
  assert.equal(decryptSecret(secured.whatsapp.access_token_encrypted), 'legacy-token');
  assert.deepEqual(secured.envios, { proveedor: 'correo', sucursal: 'norte' });
  assert.equal(JSON.stringify(secured).includes('legacy-'), false);
});

test('configuracion WhatsApp Cloud cifra token, conserva placeholder y migra plaintext legacy', () => {
  const previousKey = process.env.FACTURACION_SECRET_KEY;
  process.env.FACTURACION_SECRET_KEY = 'test-key-whatsapp-cloud';
  try {
    const secured = securePaymentIntegraciones({
      pagos: { proveedor: 'mercado_pago' },
      whatsapp: {
        provider: 'cloud',
        enabled: true,
        phone_number_id: 'phone-safe',
        access_token: 'token-secreto',
        app_secret: 'app-secreto',
        clave_arbitraria: 'no-permitida',
      },
    });

    assert.equal(secured.whatsapp.access_token, undefined);
    assert.equal(secured.whatsapp.app_secret, undefined);
    assert.equal(decryptSecret(secured.whatsapp.access_token_encrypted), 'token-secreto');

    const preserved = securePaymentIntegraciones(
      { whatsapp: { access_token: '********' } },
      { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-safe', access_token_encrypted: secured.whatsapp.access_token_encrypted } },
    );
    assert.equal(preserved.whatsapp.access_token_encrypted, secured.whatsapp.access_token_encrypted);

    const migrated = securePaymentIntegraciones(
      { pagos: { auto_confirmar: true } },
      { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-safe', access_token: 'legacy-token' } },
    );
    assert.equal(migrated.whatsapp.access_token, undefined);
    assert.equal(decryptSecret(migrated.whatsapp.access_token_encrypted), 'legacy-token');

    const response = redactEmpresaPaymentSecrets({ id: 3, config_integraciones: migrated });
    assert.deepEqual(response.config_integraciones.whatsapp, {
      provider: 'cloud',
      enabled: true,
      phone_number_id: 'phone-safe',
      access_token_configured: true,
    });
    assert.equal(response.config_integraciones.whatsapp.access_token, undefined);
    assert.equal(response.config_integraciones.whatsapp.access_token_encrypted, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.FACTURACION_SECRET_KEY;
    else process.env.FACTURACION_SECRET_KEY = previousKey;
  }
});
