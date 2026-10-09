const NOOP_LOGGER = Object.freeze({ error() {} });

export function createSchemaReadyConsumer({ consumer, checkReady, logger = NOOP_LOGGER } = {}) {
  if (!consumer || typeof consumer.processOnce !== 'function' || typeof consumer.shutdown !== 'function') {
    throw new TypeError('consumer inválido');
  }
  if (typeof checkReady !== 'function') throw new TypeError('checkReady requerido');

  let ready = false;
  let checking = null;

  async function schemaReady() {
    if (ready) return true;
    if (!checking) {
      checking = Promise.resolve()
        .then(() => checkReady())
        .then(result => {
          if (result === true) ready = true;
          return ready;
        })
        .catch(() => {
          logger.error('WhatsApp Cloud inbound schema readiness falló de forma sanitizada');
          return false;
        })
        .finally(() => { checking = null; });
    }
    return checking;
  }

  async function processOnce() {
    if (!await schemaReady()) return { outcome: 'schema_not_ready' };
    return consumer.processOnce();
  }

  return {
    processOnce,
    shutdown: options => consumer.shutdown(options),
    isStopping: () => consumer.isStopping?.() === true,
  };
}
