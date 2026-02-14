import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';

import { notifyEstadoPedidoPush, getEmpresaById, registerOrderRoutes } from '../../backend.js';
import { query, pool } from '../db.js';
import {
  withAuth,
  isSuper,
  getEmpresaIdFromToken,
  resolveEmpresaId,
  enqueueWppMessage,
  checkLicencia,
} from '../services.js';
import { crearPreferenciaLicencia, obtenerPago } from '../mercadoPagoService.js';
import handlers from '../handlers.js';
import { notificarEnRuta, notificarPedidoTransferencia } from '../services/notificacionesPedidos.js';
import { ejecutarEstrategiaVecinos } from '../estrategias.js';
import { registrarMovimientosActivosDesdePedido } from '../adm/pedidoActivosService.js';

const { Client, LocalAuth } = pkg;

export function createServerDeps({ projectDir }) {
  const ENABLE_WPP = process.env.ENABLE_WPP === '1' || process.env.RENDER === 'true';

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

    // wpp deps
    ENABLE_WPP,
    wpp: {
      Client,
      LocalAuth,
      qrcode,
      handlers,
      enqueueWppMessage,
      checkLicencia,
    },

    // legacy backend routes
    registerOrderRoutes,
  };
}
