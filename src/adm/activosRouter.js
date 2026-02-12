// src/adm/activosRouter.js
import { Router } from 'express';
import { withAuth, isRepartidor } from '../services.js';
import {
  listarActivos,
  crearActivo,
  asignarActivo,
  devolverActivo,
  registrarSanitizacion,
  actualizarActivo,
  marcarBajaActivo,
  enviarAReparacion,
  finReparacion,
  getHistorialActivo,
  resumenActivos,
  activosMantenimientoPendiente,
  getActivoPorId,
  reporteActivosOciosos,
  getMisActivosDisponibles
} from './activosController.js';


const router = Router();

// Middleware de seguridad: todo requiere estar logueado
router.use(withAuth);

// Middleware extra: bloqueamos a repartidores para gestión de activos.
// (Si en el futuro querés darles acceso de solo lectura, podés aflojar esto.)
router.use((req, res, next) => {
  if (isRepartidor(req)) {
    return res.status(403).json({ error: 'No autorizado para gestionar activos.' });
  }
  next();
});

// ------------------------------------------------------------------
// Rutas de reportes / dashboard
// ------------------------------------------------------------------
router.get('/resumen/general', resumenActivos);
router.get('/mantenimiento/pendiente', activosMantenimientoPendiente);
router.get('/reportes/ociosos', reporteActivosOciosos);
router.get('/stock-disponible', getMisActivosDisponibles);

// ------------------------------------------------------------------
// Rutas de ficha / historial
// ------------------------------------------------------------------

router.get('/:id/historial', getHistorialActivo);
router.get('/:id', getActivoPorId);   // 👈 nueva ruta para ficha detalle

// ------------------------------------------------------------------
// Rutas CRUD / FSM
// ------------------------------------------------------------------

// Listado (inventario de activos)
router.get('/', listarActivos);

// Alta de activo
router.post('/', crearActivo);

// Actualizar datos de ficha (no estado/cliente)
router.put('/:id', actualizarActivo);

// Marcar baja definitiva
router.post('/:id/baja', marcarBajaActivo);

// FSM de comodatos
router.post('/asignar', asignarActivo);
router.post('/devolver', devolverActivo);

// Mantenimiento / sanitización
router.post('/sanitizar', registrarSanitizacion);

// Estados de reparación
router.post('/en-reparacion', enviarAReparacion);
router.post('/fin-reparacion', finReparacion);

export default router;
