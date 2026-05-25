// src/qr/pagosProvider.js
import { MercadoPagoConfig, Preference } from 'mercadopago';

/**
 * Este módulo NO conoce Express ni la base, solo el contrato con el proveedor.
 */

function normalizeProveedor(proveedor) {
  return String(proveedor || '').trim().toLowerCase();
}

function getBaseUrl() {
  return String(
    process.env.PEDIDO_PAGOS_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    ''
  ).replace(/\/+$/, '');
}

function getPedidoWebhookUrl({ proveedor, empresaId }) {
  const explicit = process.env.PEDIDO_PAGOS_WEBHOOK_URL;
  if (explicit) return explicit;

  const baseUrl = getBaseUrl();
  if (!baseUrl) return null;

  const params = new URLSearchParams({ empresa_id: String(empresaId) });
  return `${baseUrl}/api/webhooks/pagos/${proveedor}?${params.toString()}`;
}

export function buildPedidoSeguimientoBackUrls({ baseUrl, pedido }) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const token = String(pedido?.trackingToken || pedido?.tracking_token || '').trim();
  if (!cleanBase || !token) return null;

  const trackingUrl = `${cleanBase}/pedidos/seguimiento.html?t=${encodeURIComponent(token)}`;
  return {
    success: `${trackingUrl}&pago=approved`,
    failure: `${trackingUrl}&pago=failure`,
    pending: `${trackingUrl}&pago=pending`
  };
}

function getFakePago({ pedido }) {
  const descripcion = `Pedido #${pedido.id} - ${pedido.clienteNombre || ''}`.trim();
  const fakePaymentId = `fake_${pedido.id}_${Date.now()}`;
  const checkoutUrl = `https://pagos.ejemplo.com/pagar/${fakePaymentId}`;

  return {
    providerPaymentId: fakePaymentId,
    providerOrderId: fakePaymentId,
    checkoutUrl,
    qrPayload: checkoutUrl,
    moneda: 'ARS',
    descripcion
  };
}

async function crearPagoMercadoPago({ credenciales, pedido, empresa }) {
  if (!credenciales?.accessToken) {
    const err = new Error('Mercado Pago no está configurado: falta access_token');
    err.statusCode = 400;
    throw err;
  }

  const monto = Number(pedido.total || 0);
  if (!monto || Number.isNaN(monto) || monto <= 0) {
    const err = new Error('El pedido no tiene un monto válido para Mercado Pago');
    err.statusCode = 400;
    throw err;
  }

  const client = new MercadoPagoConfig({
    accessToken: credenciales.accessToken,
    options: { timeout: 5000 }
  });

  const preference = new Preference(client);
  const descripcion = `Pedido #${pedido.id} - ${pedido.clienteNombre || ''}`.trim();
  const externalReference = `PEDIDO|emp:${empresa.id}|ped:${pedido.id}`;
  const notificationUrl = getPedidoWebhookUrl({
    proveedor: 'mercado_pago',
    empresaId: empresa.id
  });

  const body = {
    items: [
      {
        id: `PEDIDO-${pedido.id}`,
        title: descripcion || `Pedido #${pedido.id}`,
        quantity: 1,
        unit_price: monto,
        currency_id: 'ARS'
      }
    ],
    external_reference: externalReference,
    metadata: {
      empresa_id: Number(empresa.id),
      pedido_id: Number(pedido.id)
    }
  };

  if (pedido.venceAt instanceof Date && !Number.isNaN(pedido.venceAt.getTime())) {
    body.expires = true;
    body.expiration_date_from = new Date().toISOString();
    body.expiration_date_to = pedido.venceAt.toISOString();
  }

  if (notificationUrl) {
    body.notification_url = notificationUrl;
  }

  const baseUrl = getBaseUrl();
  if (baseUrl) {
    const backUrls = buildPedidoSeguimientoBackUrls({ baseUrl, pedido });
    if (backUrls) body.back_urls = backUrls;
  }

  const result = await preference.create({ body });
  const checkoutUrl = result.init_point || result.sandbox_init_point || null;

  return {
    providerPaymentId: String(result.id),
    providerOrderId: String(result.id),
    checkoutUrl,
    qrPayload: checkoutUrl,
    moneda: 'ARS',
    descripcion
  };
}

export async function crearPagoProveedor({ proveedor, credenciales, pedido, empresa }) {
  const prov = normalizeProveedor(proveedor || 'fake');

  if (prov === 'fake') {
    return getFakePago({ pedido });
  }

  if (prov === 'mercado_pago' || prov === 'mercadopago' || prov === 'mp') {
    return crearPagoMercadoPago({ credenciales, pedido, empresa });
  }

  const err = new Error(`Proveedor de pagos no soportado: ${proveedor}`);
  err.statusCode = 400;
  throw err;
}
