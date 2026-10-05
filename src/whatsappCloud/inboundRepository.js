import { normalizeCloudDeadline } from './deadlines.js';

const TERMINAL_STATES = new Set(['processed', 'skipped', 'outcome_unknown']);

function requireQuery(query) {
  if (typeof query !== 'function') throw new TypeError('query es requerida');
}

function requireId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${field} inválido`);
  return id;
}

export async function claimNextCloudInboundEvent({ query, owner, leaseMs } = {}) {
  requireQuery(query);
  if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('owner inválido');
  const lease = normalizeCloudDeadline('lease', leaseMs);
  const rows = await query(`
    WITH reconciled AS (
      UPDATE whatsapp_cloud_events
         SET processing_state = 'outcome_unknown',
             processing_error_code = 'processing_lease_expired',
             processed_at = NOW(),
             claim_owner = NULL,
             claim_until = NULL
       WHERE event_kind = 'message'
         AND processing_state = 'processing_started'
         AND claim_until IS NOT NULL
         AND claim_until < NOW()
       RETURNING id
    ), candidate AS (
      SELECT event.id
        FROM whatsapp_cloud_events AS event
       WHERE event.event_kind = 'message'
         AND (
           event.processing_state = 'pending'
           OR (
             event.processing_state = 'pre_process'
             AND event.claim_until IS NOT NULL
             AND event.claim_until < NOW()
           )
         )
       ORDER BY event.received_at, event.id
       LIMIT 1
       FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE whatsapp_cloud_events AS event
       SET processing_state = 'pre_process',
           claim_owner = $1,
           claim_until = NOW() + ($2 * INTERVAL '1 millisecond'),
           processing_error_code = NULL
      FROM candidate
     WHERE event.id = candidate.id
     RETURNING event.id, event.empresa_id, event.message_id, event.sender_id,
               event.message_type, event.event_data, event.received_at
  `, [owner.trim(), lease]);
  return rows[0] || null;
}

export async function loadActiveCloudInboundTenant({ query, empresaId } = {}) {
  requireQuery(query);
  const id = requireId(empresaId, 'empresaId');
  const rows = await query(`
    SELECT id AS empresa_id
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
  `, [id]);
  return rows.length === 1 ? { empresaId: Number(rows[0].empresa_id) } : null;
}

export async function startCloudInboundProcessing({ query, id, owner, leaseMs } = {}) {
  requireQuery(query);
  const eventId = requireId(id, 'id');
  const lease = normalizeCloudDeadline('lease', leaseMs);
  const rows = await query(`
    UPDATE whatsapp_cloud_events
       SET processing_state = 'processing_started',
           processing_started_at = NOW(),
           claim_until = NOW() + ($3 * INTERVAL '1 millisecond')
     WHERE id = $1
       AND claim_owner = $2
       AND processing_state = 'pre_process'
       AND claim_until >= NOW()
     RETURNING id
  `, [eventId, owner, lease]);
  if (rows.length !== 1) throw Object.assign(new Error('Cloud inbound claim perdido'), { code: 'CLOUD_INBOUND_CLAIM_LOST' });
}

export async function renewCloudInboundProcessingLease({ query, id, owner, leaseMs } = {}) {
  requireQuery(query);
  const eventId = requireId(id, 'id');
  if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('owner inválido');
  const lease = normalizeCloudDeadline('lease', leaseMs);
  const rows = await query(`
    UPDATE whatsapp_cloud_events
       SET claim_until = NOW() + ($3 * INTERVAL '1 millisecond')
     WHERE id = $1
       AND claim_owner = $2
       AND processing_state = 'processing_started'
       AND claim_until >= NOW()
     RETURNING id
  `, [eventId, owner.trim(), lease]);
  return rows.length === 1;
}

export async function finishCloudInboundEvent({ query, id, owner, state, errorCode = null } = {}) {
  requireQuery(query);
  const eventId = requireId(id, 'id');
  if (!TERMINAL_STATES.has(state)) throw new TypeError('estado inbound terminal inválido');
  const sourceState = state === 'skipped' ? 'pre_process' : 'processing_started';
  const rows = await query(`
    UPDATE whatsapp_cloud_events
       SET processing_state = $3,
           processing_error_code = $4,
           processed_at = NOW(),
           claim_owner = NULL,
           claim_until = NULL
     WHERE id = $1
       AND claim_owner = $2
       AND processing_state = '${sourceState}'
       AND claim_until >= NOW()
     RETURNING id
  `, [eventId, owner, state, errorCode]);
  if (rows.length !== 1) throw Object.assign(new Error('Cloud inbound claim perdido'), { code: 'CLOUD_INBOUND_CLAIM_LOST' });
}

export async function resetCloudInboundEventForManualRetry({ query, id } = {}) {
  requireQuery(query);
  const eventId = requireId(id, 'id');
  const rows = await query(`
    UPDATE whatsapp_cloud_events
       SET processing_state = 'pending',
           processing_error_code = NULL,
           processing_started_at = NULL,
           processed_at = NULL,
           claim_owner = NULL,
           claim_until = NULL
     WHERE id = $1
       AND processing_state = 'skipped'
       AND processing_error_code IN ('cloud_config_invalid', 'unsupported_message_type', 'invalid_text_message')
     RETURNING id
  `, [eventId]);
  if (rows.length !== 1) throw Object.assign(new Error('Cloud inbound no admite retry manual seguro'), { code: 'CLOUD_INBOUND_RETRY_NOT_ALLOWED' });
  return { reset: true, id: eventId };
}
