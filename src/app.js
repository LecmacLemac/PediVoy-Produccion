// src/app.js
// Crea y configura la app Express (extraído desde server.js)

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { registerLandingRoutes } from './routes/landingRoutes.js';
import { mountApiModules } from './routes/mountApiModules.js';
import { createPublicLegacyPedidosRouter } from './routes/publicLegacyPedidos.js';
import { createPublicLegacyCatalogRouter } from './routes/publicLegacyCatalog.js';
import { createPublicLegacyMarketplaceRouter } from './routes/publicLegacyMarketplace.js';
import { registerPublicLegacyCreatePedidoRoute } from './routes/publicLegacyCreatePedido.js';
import { toNum, inRange, round, buildOrderSummary, getAliasEmpresa } from './public/pedidosLegacyHelpers.js';
import { registerWhatsAppWeb } from './wpp/whatsappWeb.js';
import { assertProductionEnv } from './bootstrap/env.js';

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

  } = deps || {};

  if (!projectDir) throw new Error('createApp: falta projectDir');
  if (typeof query !== 'function') throw new Error('createApp: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createApp: falta withAuth(fn)');

  const app = express();

  // Seguridad producción
  assertProductionEnv();

  app.set('trust proxy', 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    req.requestId = String(requestId);
    res.set('x-request-id', req.requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      console.info(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) reqId=${req.requestId}`);
    });

    next();
  });

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

  // Endpoints públicos migrados a módulos dedicados
  app.use('/public', createPublicLegacyCatalogRouter({ query }));
  app.use('/public', createPublicLegacyMarketplaceRouter({ query }));
  app.use('/public', createPublicLegacyPedidosRouter({ query }));
  registerPublicLegacyCreatePedidoRoute(app, {
    query,
    geocodeIfNeeded: deps?.geocodeIfNeeded,
    normalizePhone: deps?.normalizePhone,
    pointInAnyZone: deps?.pointInAnyZone,
    enqueueWppMessage: deps?.enqueueWppMessage,
    toNum,
    inRange,
    round,
    buildOrderSummary,
    getAliasEmpresa,
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

  // Sin fallback legacy: toda ruta pública vive en src/routes/*

  const healthPayload = () => ({
    ok: true,
    service: 'hidro-api',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });

  app.get('/health', (_req, res) => res.json(healthPayload()));
  app.get('/api/health', (_req, res) => res.json(healthPayload()));

  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      path: req.originalUrl,
    });
  });

  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return;
    res.status(err?.statusCode || 500).json({
      error: err?.message || 'Internal Server Error',
    });
  });

  return app;
}
