import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

async function runWithinDeadline(operation, deadlinePromise) {
  let operationPromise;
  try {
    operationPromise = Promise.resolve(operation());
  } catch {
    operationPromise = Promise.reject();
  }
  const settled = operationPromise.then(
    value => ({ settled: true, value }),
    () => ({ settled: true, rejected: true }),
  );
  return Promise.race([settled, deadlinePromise]);
}

export function createWhatsAppCloudWorkerRuntime({
  consumer,
  closePool,
  intervalMs = 1000,
  shutdownTimeoutMs = 10_000,
  onSignal = (signal, handler) => process.once(signal, handler),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = Date.now,
  exit = code => process.exit(code),
  keepAlive = false,
  logger = NOOP_LOGGER,
}) {
  if (!consumer || typeof consumer.processOnce !== 'function' || typeof consumer.shutdown !== 'function') {
    throw new TypeError('consumer Cloud requerido');
  }
  const pollIntervalMs = normalizeCloudDeadline('poll', intervalMs);
  const workerShutdownTimeoutMs = normalizeCloudDeadline('shutdown', shutdownTimeoutMs);
  let interval = null;
  let tickPromise = null;
  let shutdownPromise = null;

  function tick() {
    if (tickPromise) return tickPromise;
    tickPromise = Promise.resolve()
      .then(() => consumer.processOnce())
      .catch(() => {
        logger.error('WhatsApp Cloud worker encontró un error operativo sanitizado');
        return { outcome: 'operational_error' };
      })
      .finally(() => { tickPromise = null; });
    return tickPromise;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (interval !== null) {
        clearIntervalImpl(interval);
        interval = null;
      }
      const deadlineAt = now() + workerShutdownTimeoutMs;
      let deadlineTimer;
      const deadlinePromise = new Promise(resolve => {
        const remainingMs = Math.max(0, deadlineAt - now());
        deadlineTimer = setTimeoutImpl(() => resolve({ timedOut: true }), remainingMs);
      });
      let drained = false;
      let poolClosed = false;
      try {
        const shutdownResult = await runWithinDeadline(
          () => consumer.shutdown({ timeoutMs: workerShutdownTimeoutMs }),
          deadlinePromise,
        );
        drained = shutdownResult.settled === true
          && shutdownResult.rejected !== true
          && shutdownResult.value === true;
        const closeResult = await runWithinDeadline(closePool, deadlinePromise);
        poolClosed = closeResult.settled === true && closeResult.rejected !== true;
      } finally {
        clearTimeoutImpl(deadlineTimer);
      }
      if (!drained) logger.warn('WhatsApp Cloud worker agotó el plazo de drain');
      if (!poolClosed) logger.warn('WhatsApp Cloud worker no cerró el pool dentro del plazo');
      const clean = drained && poolClosed;
      exit(clean ? 0 : 1);
      return clean;
    })();
    return shutdownPromise;
  }

  function start() {
    if (interval !== null) return;
    const intervalHandle = setIntervalImpl(() => tick(), pollIntervalMs);
    interval = keepAlive ? intervalHandle : unrefTimer(intervalHandle);
    onSignal('SIGTERM', shutdown);
    onSignal('SIGINT', shutdown);
    logger.info('WhatsApp Cloud worker iniciado');
  }

  return { start, tick, shutdown };
}
