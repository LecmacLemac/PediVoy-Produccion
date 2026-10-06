import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {} });
const LEASE_LOST_CODE = 'CLOUD_INBOUND_LEASE_LOST';
const SAFE_PRE_EFFECT_ERROR_CODES = new Set([
  'cloud_config_invalid',
  'cloud_media_auth_failed',
  'cloud_media_payload_invalid',
  'cloud_media_remote_rejected',
  'cloud_media_metadata_invalid',
  'cloud_media_url_invalid',
  'cloud_media_too_large',
  'cloud_media_redirect_rejected',
  'cloud_media_not_found',
  'cloud_media_mime_mismatch',
  'cloud_media_hash_mismatch',
  'unsupported_type',
  'invalid_file_signature',
]);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function calculateCloudInboundRetryDelay({ eventId, retryCount, baseMs = 1000, maxMs = 60000 } = {}) {
  const base = boundedInteger(baseMs, 1000, 1, 60000);
  const cap = boundedInteger(maxMs, 60000, base, 86400000);
  const count = boundedInteger(retryCount, 0, 0, 30);
  const exponential = Math.min(cap, base * (2 ** Math.min(count, 20)));
  const seed = ((Number(eventId) || 0) * 31 + (count + 1) * 17) % 201;
  return Math.min(cap, exponential + Math.floor(exponential * seed / 1000));
}

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
  prepareReceipt = null,
  processReceipt = null,
  scheduleRetry = null,
  maxPreEffectRetries = 3,
  retryBaseMs = 1000,
  retryMaxMs = 60000,
  logger = NOOP_LOGGER,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!owner || typeof claimNext !== 'function' || typeof loadTenant !== 'function'
      || typeof startProcessing !== 'function' || typeof renewLease !== 'function'
      || typeof finish !== 'function' || typeof processBotMessage !== 'function'
      || (prepareReceipt !== null && typeof prepareReceipt !== 'function')
      || (processReceipt !== null && typeof processReceipt !== 'function')
      || (prepareReceipt !== null && typeof scheduleRetry !== 'function')) {
    throw new TypeError('dependencias inbound Cloud inválidas');
  }

  const lease = normalizeCloudDeadline('lease', leaseMs);
  const retryLimit = boundedInteger(maxPreEffectRetries, 3, 0, 20);
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
    const isReceipt = row.message_type === 'image' || row.message_type === 'document';
    if (row.message_type !== 'text' && !isReceipt) {
      await finish({ id: row.id, owner, state: 'skipped', errorCode: 'unsupported_message_type' });
      return { outcome: 'skipped', eventId: row.id, errorCode: 'unsupported_message_type' };
    }
    const text = row.event_data?.text?.body;
    const media = isReceipt ? row.event_data?.[row.message_type] : null;
    if (!isReceipt && (typeof text !== 'string' || !text.trim())) {
      await finish({ id: row.id, owner, state: 'skipped', errorCode: 'invalid_text_message' });
      return { outcome: 'skipped', eventId: row.id, errorCode: 'invalid_text_message' };
    }
    if (isReceipt && (!processReceipt || typeof media?.id !== 'string' || !media.id.trim())) {
      await finish({ id: row.id, owner, state: 'skipped', errorCode: 'invalid_media_message' });
      return { outcome: 'skipped', eventId: row.id, errorCode: 'invalid_media_message' };
    }

    let heartbeat = null;
    let leaseLost = false;
    let processingStarted = false;
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
      const common = {
        empresaId: row.empresa_id,
        messageId: row.message_id,
        senderId: row.sender_id,
        originalPhoneNumberId: row.phone_number_id,
        assertLease,
      };
      let prepared = null;
      if (isReceipt && prepareReceipt) {
        try {
          prepared = await prepareReceipt({ ...common, media, messageType: row.message_type, tenant });
        } catch (error) {
          if (leaseLost || error?.code === LEASE_LOST_CODE || error?.code === 'CLOUD_INBOUND_CLAIM_LOST') throw error;
          const priorRetries = boundedInteger(row.retry_count, 0, 0, 1000000);
          if (error?.retryable === true && priorRetries < retryLimit) {
            await assertLease();
            const delayMs = calculateCloudInboundRetryDelay({
              eventId: row.id, retryCount: priorRetries, baseMs: retryBaseMs, maxMs: retryMaxMs,
            });
            await scheduleRetry({ id: row.id, owner, delayMs, errorCode: 'cloud_media_retryable' });
            return { outcome: 'retry_scheduled', eventId: row.id, errorCode: 'cloud_media_retryable', retryCount: priorRetries + 1 };
          }
          const errorCode = error?.retryable === true
            ? 'cloud_media_retry_exhausted'
            : (SAFE_PRE_EFFECT_ERROR_CODES.has(error?.code) ? error.code : 'cloud_media_preprocess_failed');
          await finish({ id: row.id, owner, state: 'skipped', errorCode });
          return { outcome: 'skipped', eventId: row.id, errorCode };
        }
      }

      await assertLease();
      await startProcessing({ id: row.id, owner, leaseMs: lease });
      processingStarted = true;
      if (isReceipt) {
        const receiptResult = await processReceipt({ ...common, media, messageType: row.message_type, tenant, prepared });
        if (receiptResult?.handled !== true) {
          throw Object.assign(new Error('cloud_receipt_outcome_unknown'), { code: 'cloud_receipt_outcome_unknown' });
        }
      } else await processBotMessage({ ...common, text });
      await assertLease();
      await finish({ id: row.id, owner, state: 'processed', errorCode: null });
      return { outcome: 'processed', eventId: row.id };
    } catch (error) {
      if (leaseLost || error?.code === LEASE_LOST_CODE || error?.code === 'CLOUD_INBOUND_CLAIM_LOST') {
        logger.warn('WhatsApp Cloud inbound perdió ownership', { eventId: row.id, empresaId: row.empresa_id });
        return { outcome: 'lease_lost', eventId: row.id, errorCode: 'cloud_inbound_lease_lost' };
      }
      if (!processingStarted) {
        logger.warn('WhatsApp Cloud inbound falló antes de iniciar efectos', { eventId: row.id, empresaId: row.empresa_id });
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
