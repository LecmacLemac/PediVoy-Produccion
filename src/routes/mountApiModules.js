import { registerRoutes } from './index.js';
import { createAuthGuestSignupRouter } from './authGuestSignup.js';
import { createSetupRouter } from './setup.js';
import { createPublicLandingRouter } from './publicLanding.js';
import { createPublicClientAppRouter } from './publicClientApp.js';
import { createEmpresasRouter } from './empresas.js';
import { createEntregaConfigRouter } from './entregaConfig.js';
import { createAiSiteBuilderRouter } from './aiSiteBuilder.js';
import { createZonasRouter } from './zonas.js';
import { createChoferesRouter } from './choferes.js';
import { createAsignacionesZonasRouter } from './asignacionesZonas.js';
import { createProductosRouter } from './productos.js';
import { createAdminUsuariosRouter } from './adminUsuarios.js';
import { createRepartidorApiRouter } from './repartidorApi.js';
import { createTransferenciasRouter } from './transferencias.js';
import { createGastosRouter } from './gastos.js';
import { createAuthRouter } from './auth.js';
import { createClientesRouter } from './clientes.js';
import { createTrackingRouter } from './tracking.js';
import { createFacturacionRouter } from './facturacion.js';
import { createPedidosRouter } from './pedidos.js';
import { createPedidosItemsRouter } from './pedidosItems.js';
import { createPedidosPagoRouter } from './pedidosPago.js';
import { createEstadisticasRouter } from './estadisticas.js';
import { createStockRouter } from './stock.js';
import { createRetornablesRouter } from './retornables.js';
import { createReportesRouter } from './reportes.js';
import { createRepartidorStatsRouter } from './repartidorStats.js';
import { createLicenciasMpRouter, createMercadoPagoWebhookRouter } from './licenciasMp.js';
import { createPromptsGlobalesRouter } from './promptsGlobales.js';
import { createPromocionesRouter } from './promociones.js';
import { createJuegosPublicosRouter, createJuegosRouter } from './juegos.js';
import { createReferentesRouter } from './referentes.js';
import { createReferentePortalRouter } from './referentePortal.js';
import { createAnalyticsRouter } from './analytics.js';
import { createCallCampaignsRouter } from './callCampaigns.js';
import { createCallsRouter } from './calls.js';
import { createWhatsAppCloudWebhookRouter } from './whatsappCloudWebhook.js';
import { trackingPublicRouter } from '../trackingPublic.js';

export function mountApiModules(app, deps) {
  const {
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
    ejecutarPostEntregaUpsell,
    registrarMovimientosActivosDesdePedido,
    TRANSF_DIR,
    GASTOS_DIR,
    getEmpresaById,
  } = deps;

  // AUTH / core multi-tenant
  app.use('/api/auth', createAuthGuestSignupRouter({ query, withAuth, pool }));
  app.use('/api/setup', createSetupRouter({ query, withAuth, getEmpresaIdFromToken }));
  app.use('/api/public', createPublicLandingRouter({ query }));
  app.use('/api/public', trackingPublicRouter);
  app.use('/api/public/app', createPublicClientAppRouter({ query }));

  // Admin vertical modules: activos/alquileres/costos + pagos QR
  registerRoutes(app);

  // API de negocio
  app.use('/api', createAuthRouter());
  app.use('/api/clientes', createClientesRouter());
  app.use('/api/track', createTrackingRouter());
  app.use('/api', createFacturacionRouter());
  app.use('/api/gastos', createGastosRouter({ GASTOS_DIR }));
  app.use('/api/pedidos', createPedidosRouter());
  app.use('/api/pedidos', createPedidosItemsRouter());
  app.use('/api/pedidos', createPedidosPagoRouter());
  app.use('/api/estadisticas', createEstadisticasRouter());
  app.use('/api/analytics', createAnalyticsRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/call-campaigns', createCallCampaignsRouter({ withAuth, resolveEmpresaId }));
  app.use('/api', createCallsRouter({ withAuth, resolveEmpresaId }));
  app.use('/api/stock', createStockRouter());
  app.use('/api/retornables', createRetornablesRouter({ query, pool, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/reportes', createReportesRouter());
  app.use('/api/repartidor', createRepartidorStatsRouter());
  app.use('/api/transferencias', createTransferenciasRouter({ TRANSF_DIR }));

  app.use('/api/admin/licencia', createLicenciasMpRouter({ crearPreferenciaLicencia }));
  app.use('/api/webhooks', createMercadoPagoWebhookRouter({ obtenerPago }));
  app.use('/api/webhooks/whatsapp', createWhatsAppCloudWebhookRouter());
  app.use('/api/admin/prompts', createPromptsGlobalesRouter());

  app.use(
    '/api/empresas',
    createEmpresasRouter({
      query,
      pool,
      withAuth,
      isSuper,
      getEmpresaIdFromToken,
      resolveEmpresaId,
      getEmpresaById,
    })
  );

  app.use('/api/entrega', createEntregaConfigRouter({ query, withAuth, resolveEmpresaId }));
  app.use('/api/ai', createAiSiteBuilderRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/zonas', createZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api', createChoferesRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api', createAsignacionesZonasRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/productos', createProductosRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/promociones', createPromocionesRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/juegos', createJuegosRouter({ query, pool, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/juegos-publicos', createJuegosPublicosRouter({ query, pool }));
  app.use('/api/referentes', createReferentesRouter({ query, withAuth, isSuper, getEmpresaIdFromToken }));
  app.use('/api/referente', createReferentePortalRouter({ query, withAuth }));
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
      ejecutarPostEntregaUpsell,
      registrarMovimientosActivosDesdePedido,
    })
  );
}
