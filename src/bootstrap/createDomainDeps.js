import { query, pool } from '../db.js';
import { createLegacyBackendDeps } from '../legacy/backendAdapter.js';
import {
  withAuth,
  isSuper,
  getEmpresaIdFromToken,
  resolveEmpresaId,
} from '../services.js';
import { crearPreferenciaLicencia, obtenerPago } from '../mercadoPagoService.js';
import { notificarEnRuta, notificarPedidoTransferencia } from '../services/notificacionesPedidos.js';
import { ejecutarEstrategiaVecinos } from '../estrategias.js';
import { registrarMovimientosActivosDesdePedido } from '../adm/pedidoActivosService.js';

export function createDomainDeps({ projectDir }) {
  const legacy = createLegacyBackendDeps();

  const { notifyEstadoPedidoPush, getEmpresaById, registerOrderRoutes } = legacy;

  return {
    projectDir,

    // core
    query,
    pool,

    // auth/tenant
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,

    // empresas helper
    getEmpresaById,

    // MP/licencias
    crearPreferenciaLicencia,
    obtenerPago,

    // repartidor helpers
    notifyEstadoPedidoPush,
    notificarEnRuta,
    notificarPedidoTransferencia,
    ejecutarEstrategiaVecinos,
    registrarMovimientosActivosDesdePedido,

    // legacy backend routes
    registerOrderRoutes,
  };
}
