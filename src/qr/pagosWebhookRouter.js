// src/qr/pagosWebhookRouter.js
import { Router } from 'express';
import crypto from 'node:crypto';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { query } from '../db.js';
import {
  actualizarEstadoPagoPedido,
  actualizarEstadoPagoScoped,
  getConfigPagosEmpresa
} from './pagosService.js';
import { normalizePagoEstado } from './pagosEstado.js';

const router = Router();

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function sanitizeWebhookPayload({ body, providerStatus, canonicalEstado, ip }) {
  // Guardamos solo lo mínimo útil para auditoría (sin secretos ni datos de tarjeta)
  return {
    webhook: {
      received_at: new Date().toISOString(),
      ip: ip || null
    },
    provider: {
      status: providerStatus ? String(providerStatus) : null,
      canonical_estado: String(canonicalEstado)
    },
    // del body guardamos solo whitelist
    body: {
      proveedor: body?.proveedor ? String(body.proveedor) : null,
      providerPaymentId: body?.providerPaymentId ? String(body.providerPaymentId) : null,
      nuevoEstado: body?.nuevoEstado ? String(body.nuevoEstado) : null
    }
  };
}

function getMercadoPagoPaymentId(req) {
  const { query: q, body } = req;
  return (
    q.id ||
    q['data.id'] ||
    body?.data?.id ||
    body?.id ||
    null
  );
}

function getMercadoPagoTopic(req) {
  const { query: q, body } = req;
  return q.topic || q.type || body?.type || body?.topic || null;
}

function parsePedidoExternalReference(externalReference) {
  const parts = String(externalReference || '').split('|');
  if (parts[0] !== 'PEDIDO') return null;

  const empresaId = Number(parts.find((p) => p.startsWith('emp:'))?.split(':')[1]);
  const pedidoId = Number(parts.find((p) => p.startsWith('ped:'))?.split(':')[1]);

  if (!Number.isInteger(empresaId) || empresaId <= 0) return null;
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) return null;

  return { empresaId, pedidoId };
}

async function getMercadoPagoPayment({ accessToken, paymentId }) {
  const client = new MercadoPagoConfig({
    accessToken,
    options: { timeout: 5000 }
  });
  const payment = new Payment(client);
  return payment.get({ id: paymentId });
}

function sanitizeMercadoPagoPayment({ payment, canonicalEstado, ip }) {
  return {
    webhook: {
      received_at: new Date().toISOString(),
      ip: ip || null
    },
    provider: {
      id: payment?.id ? String(payment.id) : null,
      status: payment?.status ? String(payment.status) : null,
      status_detail: payment?.status_detail ? String(payment.status_detail) : null,
      canonical_estado: String(canonicalEstado),
      preference_id: payment?.preference_id ? String(payment.preference_id) : null,
      external_reference: payment?.external_reference ? String(payment.external_reference) : null
    }
  };
}

async function handleMercadoPagoWebhook(req, res) {
  const topic = getMercadoPagoTopic(req);
  const paymentId = getMercadoPagoPaymentId(req);

  if (topic && topic !== 'payment') {
    return res.status(200).json({ ok: true, ignored: true });
  }

  if (!paymentId) {
    return res.status(400).json({ error: 'Falta id de pago de Mercado Pago' });
  }

  const empresaIdFromUrl = Number(req.query.empresa_id || req.body?.empresa_id || 0);
  if (!Number.isInteger(empresaIdFromUrl) || empresaIdFromUrl <= 0) {
    return res.status(400).json({ error: 'Falta empresa_id en webhook de Mercado Pago' });
  }

  const configPagos = await getConfigPagosEmpresa(empresaIdFromUrl);
  if (!configPagos?.accessToken) {
    return res.status(403).json({ error: 'Mercado Pago no configurado para la empresa' });
  }

  const payment = await getMercadoPagoPayment({
    accessToken: configPagos.accessToken,
    paymentId
  });

  const ref = parsePedidoExternalReference(payment?.external_reference);
  if (!ref || ref.empresaId !== empresaIdFromUrl) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const canonicalEstado = normalizePagoEstado({
    proveedor: 'mercado_pago',
    providerStatus: payment?.status,
    nuevoEstado: payment?.status
  });

  if (!canonicalEstado) {
    return res.status(400).json({ error: 'Estado de Mercado Pago no soportado' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const aplicarEstado = canonicalEstado !== 'pagado' || configPagos.autoConfirmar === true;
  const updated = await actualizarEstadoPagoPedido({
    empresaId: ref.empresaId,
    pedidoId: ref.pedidoId,
    proveedor: 'mercado_pago',
    providerPaymentId: String(payment.id),
    providerOrderId: payment?.preference_id ? String(payment.preference_id) : null,
    nuevoEstado: canonicalEstado,
    providerStatus: payment?.status ? String(payment.status) : null,
    providerPayload: sanitizeMercadoPagoPayment({ payment, canonicalEstado, ip }),
    aplicarEstado
  });

  return res.status(200).json({ ok: true, updated: !!updated, auto_confirmado: aplicarEstado });
}

/**
 * Webhook genérico para pedido_pagos.
 *
 * POST /api/webhooks/pagos
 * POST /api/webhooks/pagos/:proveedor
 * Headers:
 *  - x-pagos-signature: hex(hmac_sha256(webhook_secret, `${proveedor}|${providerPaymentId}|${nuevoEstado}`))
 * Body:
 *  - proveedor: string
 *  - providerPaymentId: string
 *  - nuevoEstado: 'pendiente'|'pagado'|'rechazado'|'expired'|...
 *  - providerStatus?: string
 */
router.post(['/pagos', '/pagos/:proveedor'], async (req, res) => {
  try {
    const proveedorRuta = req.params?.proveedor ? String(req.params.proveedor) : null;
    if (proveedorRuta === 'mercado_pago' || proveedorRuta === 'mercadopago' || proveedorRuta === 'mp') {
      return handleMercadoPagoWebhook(req, res);
    }

    const {
      proveedor = proveedorRuta,
      providerPaymentId,
      nuevoEstado,
      providerStatus = null
    } = req.body || {};

    if (!proveedor || !providerPaymentId || !nuevoEstado) {
      return res.status(400).json({ error: 'Payload inválido' });
    }

    const canonicalEstado = normalizePagoEstado({
      proveedor,
      providerStatus,
      nuevoEstado
    });

    if (!canonicalEstado) {
      return res.status(400).json({ error: 'Estado no soportado' });
    }

    // 1) Resolver empresa a partir del pago (guard-rail multi-tenant)
    const pagoRows = await query(
      `SELECT id, empresa_id
         FROM pedido_pagos
        WHERE proveedor = $1
          AND provider_payment_id = $2
        LIMIT 1`,
      [String(proveedor), String(providerPaymentId)]
    );

    if (!pagoRows.length) {
      // Respondemos 200 para evitar reintentos con basura (y no filtramos existencia)
      return res.status(200).json({ ok: true });
    }

    const empresaId = Number(pagoRows[0].empresa_id);

    // 2) Leer webhook_secret por empresa
    const cfgRows = await query(
      `SELECT config_integraciones
         FROM empresas
        WHERE id = $1
        LIMIT 1`,
      [empresaId]
    );

    const cfg = cfgRows[0]?.config_integraciones || {};
    const pagosCfg = cfg?.pagos || {};
    const secret = pagosCfg.webhook_secret || null;
    const autoConfirmar = pagosCfg.auto_confirmar === true;

    if (!secret) {
      return res.status(403).json({ error: 'Webhook no habilitado' });
    }

    // 3) Verificar firma
    const providedSig = req.headers['x-pagos-signature'];
    const msg = `${proveedor}|${providerPaymentId}|${canonicalEstado}`;
    const expectedSig = crypto.createHmac('sha256', String(secret)).update(msg).digest('hex');

    if (!timingSafeEqualHex(providedSig, expectedSig)) {
      return res.status(403).json({ error: 'Firma inválida' });
    }

    // 4) Actualizar estado del pago
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const providerPayload = sanitizeWebhookPayload({
      body: req.body,
      providerStatus,
      canonicalEstado,
      ip
    });
    const aplicarEstado = canonicalEstado !== 'pagado' || autoConfirmar;

    const updated = await actualizarEstadoPagoScoped({
      proveedor: String(proveedor),
      providerPaymentId: String(providerPaymentId),
      nuevoEstado: aplicarEstado ? String(canonicalEstado) : 'pendiente',
      providerStatus: providerStatus ? String(providerStatus) : null,
      providerPayload
    });

    // Idempotente: si ya estaba, updated puede ser null; igual devolvemos ok
    return res.status(200).json({ ok: true, updated: !!updated, auto_confirmado: aplicarEstado });

  } catch (e) {
    console.error('WEBHOOK pagos error:', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
