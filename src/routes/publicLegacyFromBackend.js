import express from 'express';
import { createLegacyBackendDeps } from '../legacy/backendAdapter.js';

export function mountPublicLegacyFromBackend(app) {
  const { registerOrderRoutes } = createLegacyBackendDeps();
  if (typeof registerOrderRoutes !== 'function') return;

  const router = express.Router();
  registerOrderRoutes(router);
  app.use('/', router);
}
