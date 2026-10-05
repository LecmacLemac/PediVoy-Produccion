const NOOP_LOGGER = Object.freeze({ error() {} });

export function createWhatsAppCloudCombinedConsumer({ inbound, outbound, logger = NOOP_LOGGER } = {}) {
  for (const consumer of [inbound, outbound]) {
    if (!consumer || typeof consumer.processOnce !== 'function' || typeof consumer.shutdown !== 'function') {
      throw new TypeError('consumidores Cloud inválidos');
    }
  }
  let stopping = false;
  let active = null;
  let shutdownPromise = null;

  function processOnce() {
    if (stopping) return Promise.resolve({ outcome: 'stopping' });
    if (active) return active;
    active = Promise.resolve().then(async () => {
      const run = async (channel, consumer) => {
        try {
          return await consumer.processOnce();
        } catch {
          logger.error('WhatsApp Cloud worker encontró un error operativo sanitizado', { channel });
          return { outcome: 'operational_error' };
        }
      };
      const [inboundResult, outboundResult] = await Promise.all([
        run('inbound', inbound),
        run('outbound', outbound),
      ]);
      return { outcome: 'tick', inbound: inboundResult, outbound: outboundResult };
    }).finally(() => { active = null; });
    return active;
  }

  function shutdown(options = {}) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      const shutdowns = [
        Promise.resolve().then(() => inbound.shutdown(options)),
        Promise.resolve().then(() => outbound.shutdown(options)),
      ];
      if (active) await active.catch(() => {});
      const results = await Promise.allSettled(shutdowns);
      return results.every(result => result.status === 'fulfilled' && result.value === true);
    })();
    return shutdownPromise;
  }

  return { processOnce, shutdown, isStopping: () => stopping };
}
