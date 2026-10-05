import handlers from '../handlers.js';
import { runWithSensitiveDbQueries } from '../db.js';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

export function createCloudInboundBotAdapter({
  enqueueReply,
  contextResolver,
  logger = NOOP_LOGGER,
  runSensitive = runWithSensitiveDbQueries,
} = {}) {
  if (typeof enqueueReply !== 'function') throw new TypeError('enqueueReply es requerido');
  if (contextResolver !== undefined && typeof contextResolver !== 'function') {
    throw new TypeError('contextResolver inválido');
  }

  return {
    async process({ empresaId, messageId, senderId, text, assertLease = async () => {} }) {
      if (typeof assertLease !== 'function') throw new TypeError('assertLease inválido');
      let receive;
      const client = {
        on(event, listener) {
          if (event !== 'message') throw new TypeError('evento Cloud inválido');
          receive = listener;
        },
        async sendMessage(phone, message) {
          await assertLease();
          return enqueueReply({
            empresaId,
            phone,
            message,
            transportOrigin: 'cloud',
            correlationId: messageId,
          });
        },
      };
      handlers.start(client, {
        empresaId,
        contextResolver,
        propagateErrors: true,
        logProcessingErrors: false,
      });
      if (typeof receive !== 'function') throw new Error('cloud_bot_adapter_not_started');
      await runSensitive(() => receive({
        from: `${senderId}@c.us`,
        body: text,
        timestamp: Date.now(),
        id: { _serialized: messageId, fromMe: false },
        fromMe: false,
        hasMedia: false,
      }));
      logger.info('WhatsApp Cloud inbound entregado al bot', { empresaId });
    },
  };
}
