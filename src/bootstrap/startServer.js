import { asteriskAmiListener, getAsteriskConfig } from '../integrations/asterisk/index.js';

export const DEFAULT_PROCESS_SHUTDOWN_DEADLINE_MS = 45000;

export function startServer(app, {
  PORT,
  processTarget = process,
  exit = code => process.exit(code),
  timers = { setTimeout, clearTimeout },
  deadlineMs = DEFAULT_PROCESS_SHUTDOWN_DEADLINE_MS,
  asteriskListener = asteriskAmiListener,
  getAsteriskConfigFn = getAsteriskConfig,
  logger = console,
} = {}) {
  let asteriskStarted = false;
  let shuttingDown = false;
  const server = app.listen(PORT, () => {
    logger.log(`🚀 Servidor unificado corriendo en puerto ${PORT}`);
    if (shuttingDown) return;

    const asteriskConfig = getAsteriskConfigFn();
    if (asteriskConfig.enabled) {
      const startResult = asteriskListener.start();
      asteriskStarted = startResult === true || asteriskListener.started === true;
      if (asteriskStarted) logger.log('[asterisk] integración habilitada: AMI listener iniciado');
    }
  });

  let shutdownPromise = null;
  let fatalShutdownError = null;
  const closeHttp = () => new Promise((resolve, reject) => {
    try {
      server.close(error => (error ? reject(error) : resolve(true)));
    } catch (error) {
      reject(error);
    }
  });
  const removeSignalListeners = () => {
    processTarget.removeListener('SIGTERM', onSignal);
    processTarget.removeListener('SIGINT', onSignal);
  };
  const withDeadline = operation => new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new Error('Process shutdown deadline exceeded')), deadlineMs);
    Promise.resolve(operation).then(resolve, reject).finally(() => timers.clearTimeout(timer));
  });
  const shutdown = fatalError => {
    if (fatalError && !fatalShutdownError) fatalShutdownError = fatalError;
    if (shutdownPromise) return shutdownPromise;

    shuttingDown = true;
    let resolveShutdown;
    shutdownPromise = new Promise(resolve => { resolveShutdown = resolve; });
    const httpClosed = closeHttp();
    let wppStopped;
    try {
      const wppShutdown = app.locals?.wppGeneralShutdown;
      wppStopped = typeof wppShutdown === 'function' ? wppShutdown() : true;
    } catch (error) {
      wppStopped = Promise.reject(error);
    }
    let companyWorkersStopped;
    try {
      const companyWorkersShutdown = app.locals?.wppEmpresaWorkersShutdown;
      companyWorkersStopped = typeof companyWorkersShutdown === 'function' ? companyWorkersShutdown() : true;
    } catch (error) {
      companyWorkersStopped = Promise.reject(error);
    }
    let asteriskStopped = true;
    try {
      if (asteriskStarted) {
        asteriskStopped = typeof asteriskListener.stop === 'function'
          ? asteriskListener.stop()
          : false;
      }
    } catch (error) {
      asteriskStopped = Promise.reject(error);
    }

    withDeadline(Promise.allSettled([httpClosed, wppStopped, companyWorkersStopped, asteriskStopped]))
      .then(results => {
        const rejected = results.find(result => result.status === 'rejected');
        if (fatalShutdownError) throw fatalShutdownError;
        if (rejected) throw rejected.reason;
        const [, wppResult, companyWorkersResult, asteriskResult] = results.map(result => result.value);
        if (wppResult !== true) throw new Error('WhatsApp General shutdown was not confirmed');
        if (companyWorkersResult !== true) throw new Error('WhatsApp Empresa workers shutdown was not confirmed');
        if (asteriskResult !== true) throw new Error('Asterisk shutdown was not confirmed');
        removeSignalListeners();
        exit(0);
        return true;
      })
      .catch(error => {
        removeSignalListeners();
        logger.error('[shutdown] fatal graceful shutdown failure:', error);
        exit(1);
        return false;
      })
      .then(resolveShutdown);
    return shutdownPromise;
  };
  const onSignal = () => { void shutdown(); };

  processTarget.on('SIGTERM', onSignal);
  processTarget.on('SIGINT', onSignal);
  server.shutdown = shutdown;
  app.locals ??= {};
  app.locals.requestFatalShutdown = error => shutdown(error);
  if (app.locals.wppGeneralFatalError) void shutdown(app.locals.wppGeneralFatalError);

  return server;
}
