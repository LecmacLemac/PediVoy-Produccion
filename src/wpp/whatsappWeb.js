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
    createGeneralRuntimeFn = createGeneralRuntime,
    createOutboxProcessorFn = createOutboxProcessor,
    registerCronAndRoutesFn = registerWppCronAndRoutes,
  } = deps;

  if (!app) throw new Error('registerWhatsAppWeb: falta app');
  if (typeof query !== 'function') throw new Error('registerWhatsAppWeb: falta query(fn)');
  app.locals ??= {};

  const { fatalExit: _ignoredFatalExit, ...otherRuntimeDependencies } = runtimeDependencies;
  const reportFatal = error => {
    app.locals.wppGeneralFatalError ??= error;
    console.error('[WPP GENERAL] fatal runtime error captured; HTTP service remains online:', error);
  };

  const repository = generalControlRepository ?? injectedRuntime?.repository
    ?? createGeneralControlRepository(query);
  const lidByPhone = new Map();
  let runtime = injectedRuntime ?? null;
  const withActiveClient = fn => runtime?.supervisor?.withActiveClient(fn)
    ?? Promise.reject(Object.assign(new Error('General supervisor is not active'), { code: 'WPP_NOT_OWNER' }));
  const handleIncomingMediaMessage = createIncomingMediaHandler({
    query,
    lidByPhone,
    handleIncomingComprobanteFromBotPg,
    withActiveClient,
  });

  runtime = injectedRuntime ?? createGeneralRuntimeFn({
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
    ...otherRuntimeDependencies,
    fatalExit: reportFatal,
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
      withActiveClient,
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

  const cronRegistration = registerCronAndRoutesFn(app, {
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

  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    let resolveShutdown;
    let rejectShutdown;
    shutdownPromise = new Promise((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    shutdownPromise.catch(() => {});

    let timerStop = true;
    try {
      runtime.stopTimers();
    } catch (error) {
      timerStop = Promise.reject(error);
    }
    let supervisorStop;
    try {
      if (runtime.supervisor === null || runtime.supervisor === undefined) {
        supervisorStop = true;
      } else if (typeof runtime.supervisor.shutdown === 'function') {
        supervisorStop = runtime.supervisor.shutdown();
      } else {
        supervisorStop = false;
      }
    } catch (error) {
      supervisorStop = Promise.reject(error);
    }
    let cronStop;
    try {
      if (cronRegistration === null || cronRegistration === undefined) {
        cronStop = true;
      } else if (typeof cronRegistration.shutdown === 'function') {
        cronStop = cronRegistration.shutdown();
      } else if (typeof cronRegistration.stop === 'function') {
        cronStop = cronRegistration.stop();
      } else {
        cronStop = false;
      }
    } catch (error) {
      cronStop = Promise.reject(error);
    }
    Promise.allSettled([timerStop, supervisorStop, cronStop]).then(results => {
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) {
        rejectShutdown(rejected.reason);
        return;
      }
      const [, supervisorResult, cronResult] = results.map(result => result.value);
      resolveShutdown(supervisorResult === true && cronResult === true);
    });
    return shutdownPromise;
  };
  runtime.shutdown = shutdown;
  app.locals.wppGeneralShutdown = shutdown;

  return runtime;
}
