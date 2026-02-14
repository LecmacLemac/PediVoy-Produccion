// src/app.js
// Crea y configura la app Express (extraído desde server.js)

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import { registerLandingRoutes } from './routes/landingRoutes.js';
import { mountApiModules } from './routes/mountApiModules.js';
import { registerWhatsAppWeb } from './wpp/whatsappWeb.js';

/**
 * createApp(deps)
 * deps: inyecta implementaciones (db/query, auth, etc.) para testear fácil.
 */
export function createApp(deps) {
  const {
    projectDir,

    // core
    query,
    pool,

    // auth/tenant
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,

    // MP/licencias
    crearPreferenciaLicencia,
    obtenerPago,

    // repartidor helpers
    notifyEstadoPedidoPush,
    notificarEnRuta,
    notificarPedidoTransferencia,
    ejecutarEstrategiaVecinos,
    registrarMovimientosActivosDesdePedido,

    // wpp
    ENABLE_WPP,
    wpp: {
      Client,
      LocalAuth,
      qrcode,
      handlers,
      enqueueWppMessage,
      checkLicencia,
    } = {},

    // legacy backend routes
    registerOrderRoutes,
  } = deps || {};

  if (!projectDir) throw new Error('createApp: falta projectDir');
  if (typeof query !== 'function') throw new Error('createApp: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createApp: falta withAuth(fn)');

  const app = express();

  // Seguridad producción (mantener igual que server.js)
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'dev' || secret.length < 32) {
      console.error('🔴 ERROR FATAL: JWT_SECRET inseguro en producción.');
      process.exit(1);
    }
  }

  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // ==================================================
  // RUTEO INTELIGENTE (LANDINGS vs INDEX GLOBAL)
  // ==================================================
  registerLandingRoutes(app, {
    projectDir,
    query,
    withAuth,
    resolveEmpresaId,
    isSuper,
  });

  // ==================================================
  // CARPETAS ESTÁTICAS DEL SISTEMA (Carrito, etc.)
  // ==================================================
  const PEDIDOS_DIR = path.join(projectDir, 'pedidos');
  if (fs.existsSync(PEDIDOS_DIR)) app.use('/pedidos', express.static(PEDIDOS_DIR));

  const TRANSF_DIR = path.join(projectDir, 'Transferencia');
  if (!fs.existsSync(TRANSF_DIR)) fs.mkdirSync(TRANSF_DIR, { recursive: true });
  app.use('/Transferencia', express.static(TRANSF_DIR));

  const GASTOS_DIR = path.join(projectDir, 'Gastos');
  if (!fs.existsSync(GASTOS_DIR)) fs.mkdirSync(GASTOS_DIR, { recursive: true });
  app.use('/Gastos', express.static(GASTOS_DIR));

  mountApiModules(app, {
    query,
    pool,
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,
    crearPreferenciaLicencia,
    obtenerPago,
    notifyEstadoPedidoPush,
    notificarEnRuta,
    notificarPedidoTransferencia,
    ejecutarEstrategiaVecinos,
    registrarMovimientosActivosDesdePedido,
    TRANSF_DIR,
    GASTOS_DIR,
    getEmpresaById: deps?.getEmpresaById,
  });

  // --------------------------------------------------
  // WhatsApp Web integrado
  // --------------------------------------------------
  registerWhatsAppWeb(app, {
    ENABLE_WPP,
    Client,
    LocalAuth,
    qrcode,
    fs,
    path,
    __dirname: projectDir,
    query,
    pool,
    handlers,
    enqueueWppMessage,
    checkLicencia,

    withAuth,
    isSuper,
  });

  // --------------------------------------------------
  // Rutas legacy que siguen viviendo en backend.js
  // --------------------------------------------------
  if (typeof registerOrderRoutes === 'function') {
    registerOrderRoutes(app);
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}
