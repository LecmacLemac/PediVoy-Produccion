import { handleIncomingComprobanteFromBotPg } from '../transferenciasPipeline.js';
import { createIncomingMediaHandler } from './incomingMedia.js';
import { createOutboxProcessor } from './outboxProcessor.js';
import { createGeneralControlRepository } from './generalControlRepository.js';
import { createGeneralRuntime } from './generalRuntime.js';
import { registerWppRoutes } from './routes.js';
import { registerWppCronAndRoutes } from './cronRoutes.js';
import { safeErrorString } from './sessionUtils.js';

export function resolveGeneralRouteDeps({
  query,
  generalControlRepository,
  generalSupervisor,
} = {}) {
  return {
    repository: generalControlRepository ?? createGeneralControlRepository(query),
    supervisor: generalSupervisor ?? null,
  };
}

export function registerWhatsAppWeb(app, deps = {}) {
  const {
    ENABLE_WPP,
    WPP_QR_ONLY = false,
    Client,
    LocalAuth,
    qrcode,
    fs,
    path,
    query,
    pool,
    handlers,
    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,
    ejecutarCampaniaBaseImportadaAuto,
    ejecutarReactivacionInteligente,
    ejecutarPostEntregaUpsell,
    ejecutarProgramaVip,
    withAuth,
    isSuper,
    generalRuntime: injectedRuntime,
    generalControlRepository,
    generalSupervisor,
    generalOwnership,
    runtimeDependencies = {},
    createOutboxProcessorFn = createOutboxProcessor,
    registerCronAndRoutesFn = registerWppCronAndRoutes,
  } = deps;

  if (!app) throw new Error('registerWhatsAppWeb: falta app');
  if (typeof query !== 'function') throw new Error('registerWhatsAppWeb: falta query(fn)');

  const repository = generalControlRepository ?? injectedRuntime?.repository
    ?? createGeneralControlRepository(query);
  const lidByPhone = new Map();
  const handleIncomingMediaMessage = createIncomingMediaHandler({
    query,
    lidByPhone,
    handleIncomingComprobanteFromBotPg,
  });

  const runtime = injectedRuntime ?? createGeneralRuntime({
    enabled: Boolean(ENABLE_WPP),
    qrOnly: Boolean(WPP_QR_ONLY),
    Client,
    LocalAuth,
    fs,
    path,
    query,
    pool,
    repository,
    supervisor: generalSupervisor,
    ownership: generalOwnership,
    handlers,
    handleIncomingMediaMessage,
    ...runtimeDependencies,
  });

  const getState = () => runtime.getState();
  if (ENABLE_WPP && !WPP_QR_ONLY && typeof runtime.setOutboxProcessor === 'function') {
    const outboxProcessor = createOutboxProcessorFn({
      ENABLE_WPP: true,
      query,
      lidByPhone,
      safeErrorString,
      getClient: () => getState().wppClient,
      getIsReady: () => getState().isReadyWpp,
      getIsShuttingDown: () => getState().isShuttingDownWpp,
      requestRestart: () => runtime.supervisor.restart('outbox_transport_error'),
    });
    runtime.setOutboxProcessor(outboxProcessor);
  }

  registerWppRoutes(app, {
    ENABLE_WPP,
    WPP_QR_ONLY,
    qrcode,
    withAuth,
    isSuper,
    getState,
    repository: runtime.repository,
    supervisor: runtime.supervisor,
  });

  registerCronAndRoutesFn(app, {
    query,
    ejecutarReposicionPredictiva,
    ejecutarCampaniaClima,
    ejecutarCampaniaBaseImportadaAuto,
    ejecutarReactivacionInteligente,
    ejecutarPostEntregaUpsell,
    ejecutarProgramaVip,
  });

  if (ENABLE_WPP) runtime.start().catch(error => {
    console.error('[WPP GENERAL] initial runtime start failed:', error);
  });

  return runtime;
}
