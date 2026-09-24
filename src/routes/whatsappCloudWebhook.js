import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

function getVerifyToken() {
  return String(process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || '').trim();
}

export function createWhatsAppCloudJsonMiddleware() {
  return express.raw({
    type: 'application/json',
    limit: '1mb',
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    },
  });
}

export function normalizeWhatsAppCloudEvents(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.entry)) {
    throw new TypeError('Invalid WhatsApp Cloud webhook structure');
  }

  const events = [];

  for (const entry of payload.entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.changes)) {
      throw new TypeError('Invalid WhatsApp Cloud webhook structure');
    }
    for (const change of entry.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw new TypeError('Invalid WhatsApp Cloud webhook structure');
      }
      if (change.field !== 'messages') continue;

      const value = change.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Invalid WhatsApp Cloud webhook structure');
      }
      if (value.messages !== undefined && !Array.isArray(value.messages)) {
        throw new TypeError('Invalid WhatsApp Cloud webhook structure');
      }
      if (value.statuses !== undefined && !Array.isArray(value.statuses)) {
        throw new TypeError('Invalid WhatsApp Cloud webhook structure');
      }

      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      for (const message of value.messages || []) {
        events.push({
          kind: 'message',
          entryId: entry.id ?? null,
          phoneNumberId,
          message,
        });
      }
      for (const status of value.statuses || []) {
        events.push({
          kind: 'status',
          entryId: entry.id ?? null,
          phoneNumberId,
          status,
        });
      }
    }
  }

  return events;
}

export function createWhatsAppCloudWebhookRouter({ logger = console, handler } = {}) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const verifyToken = getVerifyToken();

    if (!verifyToken) {
      logger.error('[whatsapp-cloud] WHATSAPP_CLOUD_VERIFY_TOKEN no configurado');
      return res.sendStatus(500);
    }

    if (mode === 'subscribe' && token === verifyToken && typeof challenge === 'string') {
      logger.info('[whatsapp-cloud] webhook verificado');
      return res.status(200).send(String(challenge));
    }

    logger.warn('[whatsapp-cloud] verificacion rechazada');
    return res.sendStatus(403);
  });

  router.post('/', async (req, res) => {
    const appSecret = String(process.env.WHATSAPP_CLOUD_APP_SECRET || '').trim();
    if (!appSecret) {
      logger.error('[whatsapp-cloud] WHATSAPP_CLOUD_APP_SECRET no configurado');
      return res.sendStatus(503);
    }

    const signature = req.get('x-hub-signature-256');
    if (!/^sha256=[0-9a-f]{64}$/.test(signature || '')) {
      logger.warn('[whatsapp-cloud] firma rechazada');
      return res.sendStatus(401);
    }

    if (!Buffer.isBuffer(req.rawBody)) {
      logger.warn('[whatsapp-cloud] firma rechazada');
      return res.sendStatus(401);
    }

    const expectedDigest = createHmac('sha256', appSecret).update(req.rawBody).digest();
    const receivedDigest = Buffer.from(signature.slice('sha256='.length), 'hex');
    if (!timingSafeEqual(expectedDigest, receivedDigest)) {
      logger.warn('[whatsapp-cloud] firma rechazada');
      return res.sendStatus(401);
    }

    let payload;
    let events;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
      events = normalizeWhatsAppCloudEvents(payload);
    } catch {
      logger.warn('[whatsapp-cloud] estructura invalida');
      return res.sendStatus(400);
    }
    if (typeof handler === 'function') {
      try {
        await handler(events);
      } catch {
        logger.error('[whatsapp-cloud] procesamiento fallido');
        return res.sendStatus(503);
      }
    }

    logger.info('[whatsapp-cloud] evento recibido', {
      receivedAt: new Date().toISOString(),
      objectType: payload?.object === 'whatsapp_business_account' ? 'whatsapp_business_account' : 'other',
      entries: Array.isArray(payload?.entry) ? payload.entry.length : 0,
      events: events.length,
      messages: events.filter((event) => event.kind === 'message').length,
      statuses: events.filter((event) => event.kind === 'status').length,
    });

    return res.status(200).json({ ok: true });
  });

  return router;
}
