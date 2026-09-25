import { sanitizeMetaMessageId } from './outboxRepository.js';

const LIST_STATES = Object.freeze(['dispatch_started', 'outcome_unknown', 'manual_retryable']);
const ERROR_CODES = Object.freeze([
  'cloud_payload_invalid',
  'cloud_rate_limited',
  'cloud_remote_rejected',
  'cloud_dispatch_unknown',
  'cloud_token_invalid',
  'cloud_config_invalid',
  'meta_rejected',
  'recipient_invalid',
  'policy_blocked',
  'template_invalid',
  'auth_invalid',
  'meta_confirmed_not_sent',
  'meta_no_delivery_record',
]);

export const MARK_FAILED_REASONS = Object.freeze([
  'meta_rejected',
  'recipient_invalid',
  'policy_blocked',
  'template_invalid',
  'auth_invalid',
  'cloud_config_invalid',
]);

export const CONFIRM_NOT_SENT_REASONS = Object.freeze([
  'meta_confirmed_not_sent',
  'meta_no_delivery_record',
]);

export const REPLAY_REASONS = Object.freeze(['manual_replay']);

function opsError(code) {
  return Object.assign(new Error('operación Cloud rechazada'), { code });
}

function requireId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw opsError('OPS_INVALID_ARGUMENT');
  return id;
}

function requireActor(actor) {
  const value = String(actor || '').trim();
  if (!/^[A-Za-z0-9._@:-]{2,100}$/.test(value)) throw opsError('OPS_INVALID_ARGUMENT');
  return value;
}

function requireReason(reason, allowed) {
  const value = String(reason || '').trim();
  if (!allowed.includes(value)) throw opsError('OPS_INVALID_ARGUMENT');
  return value;
}

function requireMetaMessageId(messageId) {
  const value = String(messageId || '');
  if (!/^wamid\.[A-Za-z0-9._:-]{1,248}$/.test(value) || sanitizeMetaMessageId(value) !== value) {
    throw opsError('OPS_INVALID_ARGUMENT');
  }
  return value;
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  let releaseError;
  let commitStarted = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    commitStarted = true;
    try {
      await client.query('COMMIT');
    } catch (error) {
      releaseError = error;
      throw opsError('OPS_COMMIT_OUTCOME_UNKNOWN');
    }
    return result;
  } catch (error) {
    if (!commitStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function lockCloudRow(client, id) {
  const { rows } = await client.query(`
    SELECT id, empresa_id, status, cloud_dispatch_state
      FROM wpp_outbox
     WHERE id = $1
       AND transport_origin = 'cloud'
     FOR UPDATE
  `, [requireId(id)]);
  if (!rows.length) throw opsError('OPS_NOT_FOUND');
  return rows[0];
}

function isAmbiguous(row) {
  return (row.status === 'sending' && row.cloud_dispatch_state === 'dispatch_started')
    || (row.status === 'error' && row.cloud_dispatch_state === 'outcome_unknown');
}

async function recordAudit(client, {
  row, actor, reason, action, toStatus, toState,
}) {
  await client.query(`
    INSERT INTO whatsapp_cloud_ops_audit (
      outbox_id, empresa_id, actor, reason_code, action,
      from_status, from_cloud_dispatch_state, to_status, to_cloud_dispatch_state
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    row.id, row.empresa_id, actor, reason, action,
    row.status, row.cloud_dispatch_state, toStatus, toState,
  ]);
}

async function updateExactlyOne(client, sql, params) {
  const { rows, rowCount } = await client.query(sql, params);
  if (rowCount !== 1 || rows.length !== 1) throw opsError('OPS_STALE_STATE');
  return rows[0];
}

export function createCloudOps({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('pool PostgreSQL requerido');
  }

  return Object.freeze({
    async list({ empresaId, state, includeDefinitiveFailed = false, limit = 100 } = {}) {
      if (empresaId !== undefined) requireId(empresaId);
      const states = includeDefinitiveFailed ? [...LIST_STATES, 'definitive_failed'] : [...LIST_STATES];
      if (state !== undefined && !states.includes(state)) throw opsError('OPS_INVALID_ARGUMENT');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw opsError('OPS_INVALID_ARGUMENT');
      const selectedStates = state ? [state] : states;
      const { rows } = await pool.query(`
        SELECT id,
               empresa_id,
               status,
               cloud_dispatch_state,
               created_at,
               dispatch_started_at,
               sent_at,
               CASE WHEN error = ANY($3::text[]) THEN error ELSE NULL END AS error_code,
               meta_message_id
          FROM wpp_outbox
         WHERE transport_origin = 'cloud'
           AND cloud_dispatch_state = ANY($1::text[])
           AND ($2::integer IS NULL OR empresa_id = $2)
         ORDER BY created_at, id
         LIMIT $4
      `, [selectedStates, empresaId ?? null, ERROR_CODES, limit]);
      return rows.map(row => ({
        ...row,
        meta_message_id: sanitizeMetaMessageId(row.meta_message_id),
      }));
    },

    async markSent({ id, actor, metaMessageId } = {}) {
      const safeActor = requireActor(actor);
      const safeMessageId = requireMetaMessageId(metaMessageId);
      return inTransaction(pool, async client => {
        const row = await lockCloudRow(client, id);
        if (!isAmbiguous(row)) throw opsError('OPS_STALE_STATE');
        const updated = await updateExactlyOne(client, `
          UPDATE wpp_outbox
             SET status = 'sent', cloud_dispatch_state = 'sent',
                 sent_at = COALESCE(sent_at, NOW()), error = NULL,
                 meta_message_id = $2,
                 claim_owner = NULL, claim_epoch = NULL, claim_until = NULL
           WHERE id = $1
             AND status = $3
             AND cloud_dispatch_state = $4
          RETURNING id, status, cloud_dispatch_state
        `, [row.id, safeMessageId, row.status, row.cloud_dispatch_state]);
        await recordAudit(client, {
          row, actor: safeActor, reason: 'meta_delivery_confirmed', action: 'mark_sent',
          toStatus: 'sent', toState: 'sent',
        });
        return updated;
      });
    },

    async markFailed({ id, actor, reason } = {}) {
      const safeActor = requireActor(actor);
      const safeReason = requireReason(reason, MARK_FAILED_REASONS);
      return inTransaction(pool, async client => {
        const row = await lockCloudRow(client, id);
        if (!isAmbiguous(row)) throw opsError('OPS_STALE_STATE');
        const updated = await updateExactlyOne(client, `
          UPDATE wpp_outbox
             SET status = 'error', cloud_dispatch_state = 'definitive_failed',
                 sent_at = NULL, error = $2, meta_message_id = NULL,
                 claim_owner = NULL, claim_epoch = NULL, claim_until = NULL
           WHERE id = $1 AND status = $3 AND cloud_dispatch_state = $4
          RETURNING id, status, cloud_dispatch_state
        `, [row.id, safeReason, row.status, row.cloud_dispatch_state]);
        await recordAudit(client, {
          row, actor: safeActor, reason: safeReason, action: 'mark_failed',
          toStatus: 'error', toState: 'definitive_failed',
        });
        return updated;
      });
    },

    async confirmNotSent({ id, actor, reason } = {}) {
      const safeActor = requireActor(actor);
      const safeReason = requireReason(reason, CONFIRM_NOT_SENT_REASONS);
      return inTransaction(pool, async client => {
        const row = await lockCloudRow(client, id);
        if (!isAmbiguous(row)) throw opsError('OPS_STALE_STATE');
        const updated = await updateExactlyOne(client, `
          UPDATE wpp_outbox
             SET status = 'error', cloud_dispatch_state = 'manual_retryable',
                 sent_at = NULL, error = $2, meta_message_id = NULL,
                 claim_owner = NULL, claim_epoch = NULL, claim_until = NULL
           WHERE id = $1 AND status = $3 AND cloud_dispatch_state = $4
          RETURNING id, status, cloud_dispatch_state
        `, [row.id, safeReason, row.status, row.cloud_dispatch_state]);
        await recordAudit(client, {
          row, actor: safeActor, reason: safeReason, action: 'confirm_not_sent',
          toStatus: 'error', toState: 'manual_retryable',
        });
        return updated;
      });
    },

    async replay({ id, actor, reason } = {}) {
      const safeActor = requireActor(actor);
      const safeReason = requireReason(reason, REPLAY_REASONS);
      return inTransaction(pool, async client => {
        const row = await lockCloudRow(client, id);
        if (row.status !== 'error' || row.cloud_dispatch_state !== 'manual_retryable') {
          throw opsError('OPS_STALE_STATE');
        }
        const updated = await updateExactlyOne(client, `
          UPDATE wpp_outbox
             SET status = 'pending', cloud_dispatch_state = NULL,
                 dispatch_started_at = NULL, sent_at = NULL, error = NULL,
                 meta_message_id = NULL,
                 claim_owner = NULL, claim_epoch = NULL, claim_until = NULL
           WHERE id = $1 AND status = 'error' AND cloud_dispatch_state = 'manual_retryable'
          RETURNING id, status, cloud_dispatch_state
        `, [row.id]);
        await recordAudit(client, {
          row, actor: safeActor, reason: safeReason, action: 'replay',
          toStatus: 'pending', toState: null,
        });
        return updated;
      });
    },
  });
}
