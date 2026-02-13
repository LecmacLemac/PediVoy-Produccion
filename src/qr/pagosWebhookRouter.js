// src/qr/pagosWebhookRouter.js
import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { actualizarEstadoPagoScoped } from './pagosService.js';

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

/**
 * Webhook genérico para pedido_pagos.
 *
 * POST /api/webhooks/pagos
 * Headers:
 *  - x-pagos-signature: hex(hmac_sha256(webhook_secret, `${proveedor}|${providerPaymentId}|${nuevoEstado}`))
 * Body:
 *  - proveedor: string
 *  - providerPaymentId: string
 *  - nuevoEstado: 'pendiente'|'pagado'|'rechazado'|'expired'|...
 *  - providerStatus?: string
 */
router.post('/pagos', async (req, res) => {
  try {
    const { proveedor, providerPaymentId, nuevoEstado, providerStatus = null } = req.body || {};

    if (!proveedor || !providerPaymentId || !nuevoEstado) {
      return res.status(400).json({ error: 'Payload inválido' });
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
    const secret = cfg?.pagos?.webhook_secret || null;

    if (!secret) {
      return res.status(403).json({ error: 'Webhook no habilitado' });
    }

    // 3) Verificar firma
    const providedSig = req.headers['x-pagos-signature'];
    const msg = `${proveedor}|${providerPaymentId}|${nuevoEstado}`;
    const expectedSig = crypto.createHmac('sha256', String(secret)).update(msg).digest('hex');

    if (!timingSafeEqualHex(providedSig, expectedSig)) {
      return res.status(403).json({ error: 'Firma inválida' });
    }

    // 4) Actualizar estado del pago
    const updated = await actualizarEstadoPagoScoped({
      proveedor: String(proveedor),
      providerPaymentId: String(providerPaymentId),
      nuevoEstado: String(nuevoEstado),
      providerStatus: providerStatus ? String(providerStatus) : null
    });

    // Idempotente: si ya estaba, updated puede ser null; igual devolvemos ok
    return res.status(200).json({ ok: true, updated: !!updated });

  } catch (e) {
    console.error('WEBHOOK pagos error:', e);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
