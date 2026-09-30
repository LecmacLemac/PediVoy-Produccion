import { Router } from 'express';
import { withAuth as defaultWithAuth } from '../services.js';
import { requireCanonicalBackofficeRole } from '../routes/canonicalBackofficeRole.js';
import * as defaultHandlers from './alquileresController.js';

export function createAlquileresRouter({ withAuth = defaultWithAuth, handlers = defaultHandlers } = {}) {
  const router = Router();
  const secured = [withAuth, requireCanonicalBackofficeRole];
  router.get('/', ...secured, handlers.listarAlquileres);
  router.get('/resumen', ...secured, handlers.resumenAlquileres);
  router.post('/mp-link', ...secured, handlers.generarLinkMercadoPago);
  router.post('/marcar-cobrado', ...secured, handlers.marcarAlquilerCobrado);
  router.post('/desmarcar-cobrado', ...secured, handlers.desmarcarAlquilerCobrado);
  router.post('/comunicacion', ...secured, handlers.enviarComunicacionAlquiler);
  router.post('/generar', ...secured, handlers.generarCargosPeriodo);
  return router;
}

export default createAlquileresRouter();
