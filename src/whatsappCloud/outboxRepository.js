import { normalizeCloudDeadline } from './deadlines.js';

const MESSAGE_ID_MAX_LENGTH = 255;

export const CloudDispatchState = Object.freeze({
  PRE_DISPATCH: 'pre_dispatch',
  DISPATCH_STARTED: 'dispatch_started',
  SENT: 'sent',
  DEFINITIVE_FAILED: 'definitive_failed',
  MANUAL_RETRYABLE: 'manual_retryable',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});

export function sanitizeMetaMessageId(value) {
  const compact = String(value || '').replace(/[^A-Za-z0-9._:-]/g, '');
  return compact ? compact.slice(0, MESSAGE_ID_MAX_LENGTH) : null;
}

export async function claimNextCloudOutboxRow({ query, owner, leaseMs } = {}) {
  if (typeof query !== 'function') throw new TypeError('query requerido');
  if (!String(owner || '').trim()) throw new TypeError('owner requerido');
  const normalizedLeaseMs = normalizeCloudDeadline('lease', leaseMs);
  const rows = await query(`
    WITH candidate AS (
      SELECT o.id
        FROM wpp_outbox o
       WHERE o.transport_origin = 'cloud'
         AND o.empresa_id IS NOT NULL
         AND (
           (o.status = 'pending' AND o.cloud_dispatch_state IS NULL)
           OR (
             o.status = 'sending'
             AND o.cloud_dispatch_state = 'pre_dispatch'
             AND (o.claim_until IS NULL OR o.claim_until < NOW())
           )
         )
       ORDER BY o.created_at, o.id
       FOR UPDATE OF o SKIP LOCKED
       LIMIT 1
    )
    UPDATE wpp_outbox o
       SET status = 'sending',
           cloud_dispatch_state = 'pre_dispatch',
           dispatch_started_at = NULL,
           claim_owner = $1,
           claim_epoch = NULL,
           claim_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           error = NULL
      FROM candidate c
     WHERE o.id = c.id
    RETURNING o.id, o.empresa_id, o.telefono, o.mensaje, o.created_at
  `, [owner, normalizedLeaseMs], { sensitive: true });
  return rows[0] ?? null;
}

export async function markCloudDispatchStarted({ query, id, owner }) {
  if (typeof query !== 'function') throw new TypeError('query requerido');
  const rows = await query(`
    UPDATE wpp_outbox
       SET cloud_dispatch_state = 'dispatch_started',
           dispatch_started_at = COALESCE(dispatch_started_at, NOW())
     WHERE id = $1
       AND status = 'sending'
       AND transport_origin = 'cloud'
       AND cloud_dispatch_state = 'pre_dispatch'
       AND claim_owner = $2
    RETURNING id
  `, [id, owner], { sensitive: true });
  if (rows.length !== 1) {
    throw Object.assign(new Error('cloud outbox claim perdido'), { code: 'CLOUD_OUTBOX_CLAIM_LOST' });
  }
  return rows[0];
}

export async function loadDurableCloudConfig({ query, empresaId }) {
  const rows = await query(`
    SELECT BTRIM(config_integraciones::jsonb #>> '{whatsapp,phone_number_id}') AS phone_number_id,
           BTRIM(config_integraciones::jsonb #>> '{whatsapp,access_token_encrypted}') AS access_token_encrypted
      FROM empresas
     WHERE id = $1
       AND jsonb_typeof(config_integraciones::jsonb) = 'object'
       AND config_integraciones::jsonb ? 'whatsapp'
       AND jsonb_typeof((config_integraciones::jsonb)->'whatsapp') = 'object'
       AND LOWER(BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'provider', ''))) = 'cloud'
       AND jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
       AND CASE
             WHEN jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
               THEN ((config_integraciones::jsonb)->'whatsapp'->>'enabled')::boolean
             ELSE FALSE
           END IS TRUE
       AND BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', '')) <> ''
       AND BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'access_token_encrypted', '')) <> ''
     LIMIT 1
  `, [empresaId], { sensitive: true });
  if (!rows.length) return null;
  return {
    phoneNumberId: rows[0].phone_number_id,
    accessTokenEncrypted: rows[0].access_token_encrypted,
  };
}

export async function finishCloudOutboxRow({
  query,
  id,
  owner,
  status,
  dispatchState,
  errorCode = null,
  messageId = null,
}) {
  const validFinalStates = new Set([
    CloudDispatchState.SENT,
    CloudDispatchState.DEFINITIVE_FAILED,
    CloudDispatchState.MANUAL_RETRYABLE,
    CloudDispatchState.OUTCOME_UNKNOWN,
  ]);
  if (!['sent', 'error'].includes(status) || !validFinalStates.has(dispatchState)) {
    throw new TypeError('estado final inválido');
  }
  if ((status === 'sent') !== (dispatchState === CloudDispatchState.SENT)) {
    throw new TypeError('estado final inconsistente');
  }
  const allowedSourceStates = dispatchState === CloudDispatchState.DEFINITIVE_FAILED
    ? [CloudDispatchState.PRE_DISPATCH, CloudDispatchState.DISPATCH_STARTED]
    : [CloudDispatchState.DISPATCH_STARTED];
  const rows = await query(`
    UPDATE wpp_outbox
       SET status = $1,
           error = $2,
           sent_at = CASE WHEN $1 = 'sent' THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
           meta_message_id = $4,
           cloud_dispatch_state = $6,
           claim_owner = NULL,
           claim_epoch = NULL,
           claim_until = NULL
     WHERE id = $3
       AND status = 'sending'
       AND transport_origin = 'cloud'
       AND claim_owner = $5
       AND cloud_dispatch_state = ANY($7::text[])
    RETURNING id
  `, [status, errorCode, id, sanitizeMetaMessageId(messageId), owner, dispatchState, allowedSourceStates], { sensitive: true });
  if (rows.length !== 1) {
    throw Object.assign(new Error('cloud outbox claim perdido'), { code: 'CLOUD_OUTBOX_CLAIM_LOST' });
  }
  return rows[0];
}
