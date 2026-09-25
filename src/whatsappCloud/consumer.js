import { CloudDeliveryOutcome } from './graphClient.js';
import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';
import { CloudDispatchState } from './outboxRepository.js';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });

export { CloudDeliveryOutcome };

export function createWhatsAppCloudConsumer({
  owner,
  leaseMs,
  claimNext,
  loadConfig,
  startDispatch,
  finish,
  decryptToken,
  graphClient,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = NOOP_LOGGER,
}) {
  if (!owner || typeof claimNext !== 'function' || typeof loadConfig !== 'function'
      || typeof startDispatch !== 'function' || typeof finish !== 'function'
      || typeof decryptToken !== 'function' || typeof graphClient?.sendText !== 'function') {
    throw new TypeError('dependencias Cloud inválidas');
  }

  let stopping = false;
  let active = null;

  async function runOnce() {
    const row = await claimNext({ owner, leaseMs });
    if (!row) return { outcome: 'idle' };

    const config = await loadConfig({ empresaId: row.empresa_id });
    if (!config) {
      await finish({
        id: row.id,
        owner,
        status: 'error',
        dispatchState: CloudDispatchState.DEFINITIVE_FAILED,
        errorCode: 'cloud_config_invalid',
      });
      logger.warn('WhatsApp Cloud rechazó una fila por configuración durable inválida', { outboxId: row.id, empresaId: row.empresa_id });
      return { outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_config_invalid' };
    }

    let accessToken;
    try {
      accessToken = String(decryptToken(config.accessTokenEncrypted) || '').trim();
      if (!accessToken) throw new Error('empty token');
    } catch {
      await finish({
        id: row.id,
        owner,
        status: 'error',
        dispatchState: CloudDispatchState.DEFINITIVE_FAILED,
        errorCode: 'cloud_token_invalid',
      });
      logger.error('WhatsApp Cloud no pudo abrir credenciales', { outboxId: row.id, empresaId: row.empresa_id });
      return { outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_token_invalid' };
    }

    await startDispatch({ id: row.id, owner });
    const result = await graphClient.sendText({
      phoneNumberId: config.phoneNumberId,
      accessToken,
      to: row.telefono,
      text: row.mensaje,
    });
    accessToken = null;

    if (result.outcome === CloudDeliveryOutcome.SENT) {
      await finish({
        id: row.id,
        owner,
        status: 'sent',
        dispatchState: CloudDispatchState.SENT,
        messageId: result.messageId,
      });
      logger.info('WhatsApp Cloud confirmó envío', { outboxId: row.id, empresaId: row.empresa_id });
      return result;
    }

    const errorCode = result.errorCode || 'cloud_dispatch_unknown';
    const dispatchState = result.outcome === CloudDeliveryOutcome.DEFINITIVE_FAILURE
      ? CloudDispatchState.DEFINITIVE_FAILED
      : result.outcome === CloudDeliveryOutcome.RETRYABLE_REJECTED
        ? CloudDispatchState.MANUAL_RETRYABLE
        : CloudDispatchState.OUTCOME_UNKNOWN;
    await finish({ id: row.id, owner, status: 'error', dispatchState, errorCode });
    logger.warn('WhatsApp Cloud finalizó sin confirmación de envío; no habrá retry automático ni fallback', {
      outboxId: row.id,
      empresaId: row.empresa_id,
      outcome: result.outcome,
      errorCode,
    });
    return { outcome: result.outcome, errorCode };
  }

  function processOnce() {
    if (stopping) return Promise.resolve({ outcome: 'stopping' });
    if (active) return active;
    active = runOnce().finally(() => { active = null; });
    return active;
  }

  async function shutdown({ timeoutMs = 10_000 } = {}) {
    stopping = true;
    if (!active) return true;
    const drainTimeoutMs = normalizeCloudDeadline('drain', timeoutMs);
    let timer;
    const drained = await Promise.race([
      active.then(() => true, () => true),
      new Promise(resolve => {
        timer = unrefTimer(setTimeoutImpl(() => resolve(false), drainTimeoutMs));
      }),
    ]);
    if (timer) clearTimeoutImpl(timer);
    return drained;
  }

  return { processOnce, shutdown, isStopping: () => stopping };
}
