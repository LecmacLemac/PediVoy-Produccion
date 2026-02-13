// src/routes/index.js
import express from 'express';

import { trackingPublicRouter } from '../trackingPublic.js';

// Admin routers
import costosRouter from '../adm/costosRouter.js';
import activosRouter from '../adm/activosRouter.js';
import alquileresRouter from '../adm/alquileresRouter.js';

// Pagos/QR
import pagosQrRouter from '../qr/pagosRouter.js';
import pagosWebhookRouter from '../qr/pagosWebhookRouter.js';

/**
 * Registra routers modulares.
 *
 * Nota: esto no mueve aún las rutas enormes de server.js,
 * solo centraliza los routers ya existentes.
 */
export function registerRoutes(app) {
  // Public
  app.use('/api/public', trackingPublicRouter);

  // Admin modules
  app.use('/api/admin/costos', costosRouter);
  app.use('/api/admin/activos', activosRouter);
  app.use('/api/admin/alquileres', alquileresRouter);

  // QR payments + webhooks
  app.use('/api/admin/qr', pagosQrRouter);
  app.use('/api/webhooks', pagosWebhookRouter);

  // Health
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // 404 api fallback (optional)
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
}
