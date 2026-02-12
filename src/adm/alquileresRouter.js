// src/adm/alquileresRouter.js
import { Router } from 'express';
import { withAuth, isRepartidor } from '../services.js';
import {
  listarAlquileres,
  resumenAlquileres,
  generarLinkMercadoPago,
  marcarAlquilerCobrado,
  generarCargosPeriodo
} from './alquileresController.js';

const router = Router();

router.use(withAuth);
router.use((req, res, next) => {
  if (isRepartidor(req)) {
    return res.status(403).json({ error: 'No autorizado.' });
  }
  next();
});

// Todas las rutas de este módulo requieren autenticación
router.use(withAuth);

// Listado de alquileres por período
router.get('/', listarAlquileres);

// KPIs / resumen para período
router.get('/resumen', resumenAlquileres);

// Integración Mercado Pago: generar link de pago para cliente + período
router.post('/mp-link', generarLinkMercadoPago);

// Marcar alquiler como cobrado (cruce manual con pagos)
router.post('/marcar-cobrado', marcarAlquilerCobrado);

// Generar cargos masivos para el mes (Botón "Generar Período")
router.post('/generar', generarCargosPeriodo);

export default router;
