import { Router } from 'express';
import { withAuth as defaultWithAuth } from '../services.js';
import { requireCanonicalBackofficeRole } from '../routes/canonicalBackofficeRole.js';
import * as defaultHandlers from './activosController.js';

export function createActivosRouter({ withAuth = defaultWithAuth, handlers = defaultHandlers } = {}) {
  const router = Router();
  const secured = [withAuth, requireCanonicalBackofficeRole];

  router.get('/resumen/general', ...secured, handlers.resumenActivos);
  router.get('/mantenimiento/pendiente', ...secured, handlers.activosMantenimientoPendiente);
  router.get('/reportes/ociosos', ...secured, handlers.reporteActivosOciosos);
  router.get('/stock-disponible', ...secured, handlers.getMisActivosDisponibles);
  router.get('/:id/historial', ...secured, handlers.getHistorialActivo);
  router.get('/:id', ...secured, handlers.getActivoPorId);
  router.get('/', ...secured, handlers.listarActivos);
  router.post('/', ...secured, handlers.crearActivo);
  router.put('/:id', ...secured, handlers.actualizarActivo);
  router.post('/:id/baja', ...secured, handlers.marcarBajaActivo);
  router.post('/asignar', ...secured, handlers.asignarActivo);
  router.post('/devolver', ...secured, handlers.devolverActivo);
  router.post('/sanitizar', ...secured, handlers.registrarSanitizacion);
  router.post('/en-reparacion', ...secured, handlers.enviarAReparacion);
  router.post('/fin-reparacion', ...secured, handlers.finReparacion);
  return router;
}

export default createActivosRouter();
