// server.js
// Entry-point: crea la app y levanta el server HTTP.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';

import { createApp } from './src/app.js';

import { registerOrderRoutes, notifyEstadoPedidoPush, getEmpresaById } from './backend.js';
import { query, pool } from './src/db.js';
import {
  withAuth,
  isSuper,
  getEmpresaIdFromToken,
  resolveEmpresaId,
  enqueueWppMessage,
  checkLicencia,
} from './src/services.js';

import { crearPreferenciaLicencia, obtenerPago } from './src/mercadoPagoService.js';
import handlers from './src/handlers.js';
import { notificarEnRuta, notificarPedidoTransferencia } from './src/services/notificacionesPedidos.js';
import { ejecutarEstrategiaVecinos } from './src/estrategias.js';
import { registrarMovimientosActivosDesdePedido } from './src/adm/pedidoActivosService.js';

const { Client, LocalAuth } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ENABLE_WPP = process.env.ENABLE_WPP === '1' || process.env.RENDER === 'true';

const app = createApp({
  projectDir: __dirname,

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
});

// Rutas legacy que siguen viviendo en backend.js (mantener igual)
registerOrderRoutes(app);

app.listen(PORT, () => console.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`));
