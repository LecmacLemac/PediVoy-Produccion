import { asteriskAmiListener, getAsteriskConfig } from '../integrations/asterisk/index.js';

export function startServer(app, {
  PORT,
  processTarget = process,
  exit = code => process.exit(code),
  timers = { setTimeout, clearTimeout },
  deadlineMs = 30000,
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
  const shutdown = () => {
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

    withDeadline(Promise.all([httpClosed, wppStopped, asteriskStopped]))
      .then(([, wppResult, asteriskResult]) => {
        if (wppResult !== true) throw new Error('WhatsApp General shutdown was not confirmed');
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

  return server;
}
