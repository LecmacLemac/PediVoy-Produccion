import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });
const LEASE_LOST_CODE = 'CLOUD_INBOUND_LEASE_LOST';

function leaseLostError() {
  return Object.assign(new Error('Cloud inbound lease perdido'), { code: LEASE_LOST_CODE });
}

export function createWhatsAppCloudInboundConsumer({
  owner,
  leaseMs,
  claimNext,
  loadTenant,
  startProcessing,
  renewLease,
  finish,
  processBotMessage,
  logger = NOOP_LOGGER,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!owner || typeof claimNext !== 'function' || typeof loadTenant !== 'function'
      || typeof startProcessing !== 'function' || typeof renewLease !== 'function'
      || typeof finish !== 'function' || typeof processBotMessage !== 'function') {
    throw new TypeError('dependencias inbound Cloud inválidas');
  }

  const lease = normalizeCloudDeadline('lease', leaseMs);
  const heartbeatMs = Math.max(100, Math.floor(lease / 3));
  let stopping = false;
  let active = null;

  async function runOnce() {
    const row = await claimNext({ owner, leaseMs: lease });
    if (!row) return { outcome: 'idle' };

    const tenant = await loadTenant({ empresaId: row.empresa_id });
    if (!tenant) {
      await finish({ id: row.id, owner, state: 'skipped', errorCode: 'cloud_config_invalid' });
      return { outcome: 'skipped', eventId: row.id, errorCode: 'cloud_config_invalid' };
    }
    if (row.message_type !== 'text') {
      await finish({ id: row.id, owner, state: 'skipped', errorCode: 'unsupported_message_type' });
      return { outcome: 'skipped', eventId: row.id, errorCode: 'unsupported_message_type' };
    }
    const text = row.event_data?.text?.body;
    if (typeof text !== 'string' || !text.trim()) {
      await finish({ id: row.id, owner, state: 'skipped', errorCode: 'invalid_text_message' });
      return { outcome: 'skipped', eventId: row.id, errorCode: 'invalid_text_message' };
    }

    await startProcessing({ id: row.id, owner, leaseMs: lease });
    let heartbeat = null;
    let leaseLost = false;
    let renewal = Promise.resolve();

    const assertLease = () => {
      renewal = renewal.then(async () => {
        if (leaseLost) throw leaseLostError();
        let renewed = false;
        try {
          renewed = await renewLease({ id: row.id, owner, leaseMs: lease });
        } catch {
          leaseLost = true;
          throw leaseLostError();
        }
        if (!renewed) {
          leaseLost = true;
          throw leaseLostError();
        }
        return true;
      });
      return renewal;
    };

    heartbeat = unrefTimer(setIntervalImpl(() => {
      assertLease().catch(() => {});
    }, heartbeatMs));

    try {
      await processBotMessage({
        empresaId: row.empresa_id,
        messageId: row.message_id,
        senderId: row.sender_id,
        text,
        assertLease,
      });
      await assertLease();
      await finish({ id: row.id, owner, state: 'processed', errorCode: null });
      return { outcome: 'processed', eventId: row.id };
    } catch (error) {
      if (leaseLost || error?.code === LEASE_LOST_CODE || error?.code === 'CLOUD_INBOUND_CLAIM_LOST') {
        logger.warn('WhatsApp Cloud inbound perdió ownership', { eventId: row.id, empresaId: row.empresa_id });
        return { outcome: 'lease_lost', eventId: row.id, errorCode: 'cloud_inbound_lease_lost' };
      }
      try {
        await finish({ id: row.id, owner, state: 'outcome_unknown', errorCode: 'bot_processing_unknown' });
      } catch (finishError) {
        if (finishError?.code === 'CLOUD_INBOUND_CLAIM_LOST') {
          return { outcome: 'lease_lost', eventId: row.id, errorCode: 'cloud_inbound_lease_lost' };
        }
        throw finishError;
      }
      logger.error('WhatsApp Cloud inbound terminó con outcome incierto', { eventId: row.id, empresaId: row.empresa_id });
      return { outcome: 'outcome_unknown', eventId: row.id, errorCode: 'bot_processing_unknown' };
    } finally {
      if (heartbeat !== null) clearIntervalImpl(heartbeat);
    }
  }

  function processOnce() {
    if (stopping) return Promise.resolve({ outcome: 'stopping' });
    if (active) return active;
    active = runOnce().finally(() => { active = null; });
    return active;
  }

  async function shutdown() {
    stopping = true;
    if (!active) return true;
    await active.catch(() => {});
    return true;
  }

  return { processOnce, shutdown, isStopping: () => stopping };
}
