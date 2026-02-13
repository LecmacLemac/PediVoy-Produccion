// server.js — CORREGIDO Y UNIFICADO
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';

import { registerOrderRoutes, notifyEstadoPedidoPush, getEmpresaById } from './backend.js';
import { query, pool } from './src/db.js';
import { withAuth, isSuper, getEmpresaIdFromToken, resolveEmpresaId, enqueueWppMessage, checkLicencia } from './src/services.js';
import { crearPreferenciaLicencia, obtenerPago } from './src/mercadoPagoService.js';
import handlers from './src/handlers.js';
import { notificarEnRuta, notificarPedidoTransferencia } from './src/services/notificacionesPedidos.js';

import { registerRoutes } from './src/routes/index.js';
import { registerLandingRoutes } from './src/routes/landingRoutes.js';
import { createAuthGuestSignupRouter } from './src/routes/authGuestSignup.js';
import { createSetupRouter } from './src/routes/setup.js';
import { createPublicLandingRouter } from './src/routes/publicLanding.js';
import { createEmpresasRouter } from './src/routes/empresas.js';
import { createEntregaConfigRouter } from './src/routes/entregaConfig.js';
import { createAiSiteBuilderRouter } from './src/routes/aiSiteBuilder.js';
import { createZonasRouter } from './src/routes/zonas.js';
import { createChoferesRouter } from './src/routes/choferes.js';
import { createAsignacionesZonasRouter } from './src/routes/asignacionesZonas.js';
import { createProductosRouter } from './src/routes/productos.js';
import { createAdminUsuariosRouter } from './src/routes/adminUsuarios.js';
import { createRepartidorApiRouter } from './src/routes/repartidorApi.js';
import { registerWhatsAppWeb } from './src/wpp/whatsappWeb.js';

import { createTransferenciasRouter } from './src/routes/transferencias.js';
import { createGastosRouter } from './src/routes/gastos.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createClientesRouter } from './src/routes/clientes.js';
import { createTrackingRouter } from './src/routes/tracking.js';
import { createPedidosRouter } from './src/routes/pedidos.js';
import { createPedidosItemsRouter } from './src/routes/pedidosItems.js';
import { createPedidosPagoRouter } from './src/routes/pedidosPago.js';
import { createEstadisticasRouter } from './src/routes/estadisticas.js';
import { createStockRouter } from './src/routes/stock.js';
import { createReportesRouter } from './src/routes/reportes.js';
import { createRepartidorStatsRouter } from './src/routes/repartidorStats.js';
import { createLicenciasMpRouter, createMercadoPagoWebhookRouter } from './src/routes/licenciasMp.js';
import { createPromptsGlobalesRouter } from './src/routes/promptsGlobales.js';
import { trackingPublicRouter } from './src/trackingPublic.js';

// --------------------------------------------------
// Config express
// --------------------------------------------------
const { Client, LocalAuth } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

const ENABLE_WPP = process.env.ENABLE_WPP === '1' || process.env.RENDER === 'true';

console.log('[DEBUG] process.env.ENABLE_WPP =', process.env.ENABLE_WPP);
console.log('[DEBUG] FLAG ENABLE_WPP =', ENABLE_WPP);


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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================================================
// RUTEO INTELIGENTE (LANDINGS vs INDEX GLOBAL)
// ==================================================

registerLandingRoutes(app, {
  projectDir: __dirname,
  query,
  withAuth,
  resolveEmpresaId,
  isSuper,
});

// ==================================================
// CARPETAS ESTÁTICAS DEL SISTEMA (Carrito, etc.)
// ==================================================

const PEDIDOS_DIR = path.join(__dirname, 'pedidos');
if (fs.existsSync(PEDIDOS_DIR)) app.use('/pedidos', express.static(PEDIDOS_DIR));

const TRANSF_DIR = path.join(__dirname, 'Transferencia');
if (!fs.existsSync(TRANSF_DIR)) fs.mkdirSync(TRANSF_DIR, { recursive: true });
app.use('/Transferencia', express.static(TRANSF_DIR));

const GASTOS_DIR = path.join(__dirname, 'Gastos');
if (!fs.existsSync(GASTOS_DIR)) fs.mkdirSync(GASTOS_DIR, { recursive: true });
app.use('/Gastos', express.static(GASTOS_DIR));

// --------------------------------------------------
// AUTH /api/auth (guest/register/signup-full)
// --------------------------------------------------
app.use('/api/auth', createAuthGuestSignupRouter({ query, withAuth }));

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
// Transferencias (comprobantes de transferencia)
// --------------------------------------------------

// Gastos movidos a src/routes/gastos.js

// --------------------------------------------------
// AUTH (login + /me)
// --------------------------------------------------
// Movido a src/routes/auth.js

// --------------------------------------------------
// ONBOARDING / CONFIGURACIÓN INICIAL
// --------------------------------------------------

app.use('/api/setup', createSetupRouter({ query, withAuth, getEmpresaIdFromToken }));

// --------------------------------------------------
// EMPRESAS (CRUD + cuentas)
// --------------------------------------------------

app.use(
  '/api/empresas',
  createEmpresasRouter({
    query,
    withAuth,
    isSuper,
    getEmpresaIdFromToken,
    resolveEmpresaId,
    getEmpresaById,
  })
);

// Nota: /api/empresas/:id/landing-page se maneja en src/routes/landingRoutes.js

// --------------------------------------------------
// CONFIGURACIÓN DE ENTREGA POR EMPRESA
// --------------------------------------------------

app.use('/api/entrega', createEntregaConfigRouter({ query, withAuth, resolveEmpresaId }));

// ==================================================
// GENERADOR WEB CON IA (Database Driven + Slug Aware)
// ==================================================

app.use('/api/ai', createAiSiteBuilderRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// ZONAS (CRUD - Tabla: zonas_geograficas con PostGIS)
// --------------------------------------------------

app.use('/api/zonas', createZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// CHOFERES + COSTOS + ESCALAS + TRAMOS
// --------------------------------------------------

app.use('/api', createChoferesRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// (ASIGNACIONES) /api/asignarChofer y /api/desasignarChofer movidos a src/routes/asignacionesZonas.js
app.use('/api', createAsignacionesZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// PRODUCTOS (CRUD)
// --------------------------------------------------

app.use('/api/productos', createProductosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// (CHOFERES/COSTOS/ESCALAS/TRAMOS) movidos a src/routes/choferes.js

// --------------------------------------------------
// USUARIOS (ADMIN - Creación/Gestión)
// --------------------------------------------------

app.use('/api/admin', createAdminUsuariosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));

// --------------------------------------------------
// API REPARTIDOR (Dashboard Chofer)
// --------------------------------------------------
app.use('/api/repartidor', createRepartidorApiRouter({
  query,
  pool,
  withAuth,
  getEmpresaIdFromToken,
  notifyEstadoPedidoPush,
  notificarEnRuta,
  notificarPedidoTransferencia,
  ejecutarEstrategiaVecinos,
  registrarMovimientosActivosDesdePedido,
}));



  
// --------------------------------------------------
// PEDIDOS (ADMIN / DASHBOARD)
// --------------------------------------------------
// Rutas base movidas a src/routes/pedidos.js (GET /api/pedidos, PUT/DELETE /api/pedidos/:id)

// Items de pedidos movidos a src/routes/pedidosItems.js

// Stock movido a src/routes/stock.js

// Reportes movidos a src/routes/reportes.js

// Endpoint para el Checkbox (Toggle Pago)
// toggle-pago movido a src/routes/pedidosPago.js

// Estadísticas movidas a src/routes/estadisticas.js

// --------------------------------------------------
// CLIENTES
// --------------------------------------------------

// --------------------------------------------------
// ENDPOINT DE TRACKING (Necesario para el Repartidor)
// --------------------------------------------------

// POST /api/track/update movido a src/routes/tracking.js

/**
 * Genera token (si no existe) y envía WPP de 'En Ruta' **solo la primera vez**
 */

// Helpers de notificaciones movidos a src/services/notificacionesPedidos.js

// ==================================================
// 💰 SISTEMA DE COBRO DE LICENCIAS (Mercado Pago)
// ==================================================
// Movido a src/routes/licenciasMp.js

// Prompts globales movidos a src/routes/promptsGlobales.js

registerOrderRoutes(app);

// --------------------------------------------------
// WHATSAPP WEB (Integrado)
// --------------------------------------------------
registerWhatsAppWeb(app, {
  ENABLE_WPP,
  Client,
  LocalAuth,
  qrcode,
  fs,
  path,
  __dirname,
  query,
  pool,
  handlers,
  enqueueWppMessage,
  checkLicencia,
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`));