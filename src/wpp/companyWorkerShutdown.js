export function createCompanyWorkerShutdown({
  stopSchedulers,
  shutdownLifecycle,
  closePool,
  exit,
  logger = console,
} = {}) {
  if (typeof stopSchedulers !== 'function') throw new TypeError('stopSchedulers is required');
  if (typeof shutdownLifecycle !== 'function') throw new TypeError('shutdownLifecycle is required');
  if (typeof closePool !== 'function') throw new TypeError('closePool is required');
  if (typeof exit !== 'function') throw new TypeError('exit is required');
  let shutdownPromise = null;

  return function shutdownWorker() {
    if (shutdownPromise) return shutdownPromise;
    stopSchedulers();
    shutdownPromise = (async () => {
      let success = true;
      try {
        const stopped = await shutdownLifecycle();
        if (stopped !== true) throw new Error('WhatsApp Empresa lifecycle shutdown was not confirmed');
      } catch (error) {
        success = false;
        logger.error('[WPP EMPRESA] Shutdown no confirmado:', error?.message || error);
      }
      try {
        await closePool();
      } catch (error) {
        success = false;
        logger.error('[WPP EMPRESA] Pool DB no pudo cerrarse:', error?.message || error);
      }
      exit(success ? 0 : 1);
      return success;
    })();
    return shutdownPromise;
  };
}
