// src/adm/costosRouter.js
import { Router } from 'express';
import { withAuth } from '../services.js';
import {
  simularPrecio,
  actualizarCosto,
  obtenerEvolucion,
  listarCostosFijos,
  crearCostoFijo,
  editarCostoFijo,
  borrarCostoFijo,
  listarVariablesCostoDef,
  crearVariableCostoDef,
  editarVariableCostoDef,
  borrarVariableCostoDef,
  listarVariablesCostoAplicacion,
  upsertVariableCostoAplicacion
} from './costosController.js';

const router = Router();

router.use(withAuth);
router.use((req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (!['admin', 'user', 'super'].includes(role)) {
    return res.status(403).json({ error: 'No autorizado.' });
  }
  next();
});

// Rentabilidad / costos por producto
router.get('/simular/:productoId', simularPrecio);
router.post('/actualizar', actualizarCosto);
router.get('/evolucion/:productoId', obtenerEvolucion);

// Costos fijos operativos (CRUD)
router.get('/fijos', listarCostosFijos);
router.post('/fijos', crearCostoFijo);
router.put('/fijos/:id', editarCostoFijo);
router.delete('/fijos/:id', borrarCostoFijo);

// Variables de costo (definiciones por empresa)
router.get('/variables/definiciones', listarVariablesCostoDef);
router.post('/variables/definiciones', crearVariableCostoDef);
router.put('/variables/definiciones/:id', editarVariableCostoDef);
router.delete('/variables/definiciones/:id', borrarVariableCostoDef);

// Aplicación de variables (empresa / grupo / producto)
router.get('/variables/aplicacion', listarVariablesCostoAplicacion);
router.post('/variables/aplicacion', upsertVariableCostoAplicacion);

export default router;
