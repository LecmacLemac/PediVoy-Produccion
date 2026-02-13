// src/app.js
// Crea y configura la app Express (extraído desde server.js)

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import { registerRoutes } from './routes/index.js';
import { registerLandingRoutes } from './routes/landingRoutes.js';
import { createAuthGuestSignupRouter } from './routes/authGuestSignup.js';
import { createSetupRouter } from './routes/setup.js';
import { createPublicLandingRouter } from './routes/publicLanding.js';
import { createEmpresasRouter } from './routes/empresas.js';
import { createEntregaConfigRouter } from './routes/entregaConfig.js';
import { createAiSiteBuilderRouter } from './routes/aiSiteBuilder.js';
import { createZonasRouter } from './routes/zonas.js';
import { createChoferesRouter } from './routes/choferes.js';
import { createAsignacionesZonasRouter } from './routes/asignacionesZonas.js';
import { createProductosRouter } from './routes/productos.js';
import { createAdminUsuariosRouter } from './routes/adminUsuarios.js';
import { createRepartidorApiRouter } from './routes/repartidorApi.js';

import { createTransferenciasRouter } from './routes/transferencias.js';
import { createGastosRouter } from './routes/gastos.js';
import { createAuthRouter } from './routes/auth.js';
import { createClientesRouter } from './routes/clientes.js';
import { createTrackingRouter } from './routes/tracking.js';
import { createPedidosRouter } from './routes/pedidos.js';
import { createPedidosItemsRouter } from './routes/pedidosItems.js';
import { createPedidosPagoRouter } from './routes/pedidosPago.js';
import { createEstadisticasRouter } from './routes/estadisticas.js';
import { createStockRouter } from './routes/stock.js';
import { createReportesRouter } from './routes/reportes.js';
import { createRepartidorStatsRouter } from './routes/repartidorStats.js';
import { createLicenciasMpRouter, createMercadoPagoWebhookRouter } from './routes/licenciasMp.js';
import { createPromptsGlobalesRouter } from './routes/promptsGlobales.js';

import { trackingPublicRouter } from './trackingPublic.js';
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

  // --------------------------------------------------
  // AUTH /api/auth (guest/register/signup-full)
  // --------------------------------------------------
  app.use('/api/auth', createAuthGuestSignupRouter({ query, withAuth }));

  // --------------------------------------------------
  // SETUP
  // --------------------------------------------------
  app.use('/api/setup', createSetupRouter({ query, withAuth, getEmpresaIdFromToken }));

  // ==================================================
  // RUTAS PÚBLICAS PARA LANDINGS (SIN AUTH)
  // ==================================================
  app.use('/api/public', createPublicLandingRouter({ query }));
  app.use('/api/public', trackingPublicRouter);

  // Routers modulares
  registerRoutes(app);
  app.use('/api', createAuthRouter());
  app.use('/api/clientes', createClientesRouter());
  app.use('/api/track', createTrackingRouter());
  app.use('/api/gastos', createGastosRouter({ GASTOS_DIR }));
  app.use('/api/pedidos', createPedidosRouter());
  app.use('/api/pedidos', createPedidosItemsRouter());
  app.use('/api/pedidos', createPedidosPagoRouter());
  app.use('/api/estadisticas', createEstadisticasRouter());
  app.use('/api/stock', createStockRouter());
  app.use('/api/reportes', createReportesRouter());
  app.use('/api/repartidor', createRepartidorStatsRouter());
  app.use('/api/transferencias', createTransferenciasRouter({ TRANSF_DIR }));

  // Licencias Mercado Pago
  app.use('/api/admin/licencia', createLicenciasMpRouter({ crearPreferenciaLicencia }));
  app.use('/api/webhooks', createMercadoPagoWebhookRouter({ obtenerPago }));

  // Prompts globales (super admin)
  app.use('/api/admin/prompts', createPromptsGlobalesRouter());

  // --------------------------------------------------
  // Módulos extraídos (dominio)
  // --------------------------------------------------
  app.use(
    '/api/empresas',
    createEmpresasRouter({
      query,
      withAuth,
      isSuper,
      getEmpresaIdFromToken,
      resolveEmpresaId,
      getEmpresaById: deps?.getEmpresaById, // opcional
    })
  );

  app.use('/api/entrega', createEntregaConfigRouter({ query, withAuth, resolveEmpresaId }));
  app.use('/api/ai', createAiSiteBuilderRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/zonas', createZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api', createChoferesRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api', createAsignacionesZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/productos', createProductosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/admin', createAdminUsuariosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

  app.use(
    '/api/repartidor',
    createRepartidorApiRouter({
      query,
      pool,
      withAuth,
      getEmpresaIdFromToken,
      notifyEstadoPedidoPush,
      notificarEnRuta,
      notificarPedidoTransferencia,
      ejecutarEstrategiaVecinos,
      registrarMovimientosActivosDesdePedido,
    })
  );

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
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}
