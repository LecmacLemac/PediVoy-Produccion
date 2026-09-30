import { Router } from 'express';
import { withAuth as defaultWithAuth } from '../services.js';
import { requireCanonicalBackofficeRole } from '../routes/canonicalBackofficeRole.js';
import * as defaultHandlers from './costosController.js';

export function createCostosRouter({ withAuth = defaultWithAuth, handlers = defaultHandlers } = {}) {
  const router = Router();
  const secured = [withAuth, requireCanonicalBackofficeRole];
  router.get('/simular/:productoId', ...secured, handlers.simularPrecio);
  router.post('/actualizar', ...secured, handlers.actualizarCosto);
  router.get('/evolucion/:productoId', ...secured, handlers.obtenerEvolucion);
  router.get('/fijos', ...secured, handlers.listarCostosFijos);
  router.post('/fijos', ...secured, handlers.crearCostoFijo);
  router.put('/fijos/:id', ...secured, handlers.editarCostoFijo);
  router.delete('/fijos/:id', ...secured, handlers.borrarCostoFijo);
  router.get('/variables/definiciones', ...secured, handlers.listarVariablesCostoDef);
  router.post('/variables/definiciones', ...secured, handlers.crearVariableCostoDef);
  router.put('/variables/definiciones/:id', ...secured, handlers.editarVariableCostoDef);
  router.delete('/variables/definiciones/:id', ...secured, handlers.borrarVariableCostoDef);
  router.get('/variables/aplicacion', ...secured, handlers.listarVariablesCostoAplicacion);
  router.post('/variables/aplicacion', ...secured, handlers.upsertVariableCostoAplicacion);
  return router;
}

export default createCostosRouter();
