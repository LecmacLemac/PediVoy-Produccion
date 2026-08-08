import express from 'express';

function getVerifyToken() {
  return String(process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || '').trim();
}

export function createWhatsAppCloudWebhookRouter({ logger = console } = {}) {
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

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      logger.info('[whatsapp-cloud] webhook verificado');
      return res.status(200).send(String(challenge));
    }

    logger.warn('[whatsapp-cloud] verificacion rechazada');
    return res.sendStatus(403);
  });

  router.post('/', (req, res) => {
    logger.info('[whatsapp-cloud] evento recibido', {
      receivedAt: new Date().toISOString(),
      object: req.body?.object || null,
      entries: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
    });

    return res.status(200).json({ ok: true });
  });

  return router;
}
