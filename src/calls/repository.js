import { query } from '../db.js';
import { normalizePhone } from '../core/format.js';

export async function listCampaigns({ empresaId }) {
  return query(
    `SELECT *
       FROM call_campaigns
      WHERE empresa_id = $1
      ORDER BY created_at DESC, id DESC`,
    [empresaId]
  );
}

export async function getCampaignById({ id, empresaId }) {
  const rows = await query(
    `SELECT *
       FROM call_campaigns
      WHERE id = $1 AND empresa_id = $2
      LIMIT 1`,
    [id, empresaId]
  );
  return rows[0] || null;
}

export async function createCampaign({
  empresaId,
  createdBy,
  name,
  purpose,
  promptVersion,
  maxAttempts,
  allowedStartTime,
  allowedEndTime,
  metadata,
}) {
  const rows = await query(
    `INSERT INTO call_campaigns (
        empresa_id, created_by, name, purpose, prompt_version,
        max_attempts, allowed_start_time, allowed_end_time, metadata
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING *`,
    [
      empresaId,
      createdBy || null,
      name,
      purpose || null,
      promptVersion || null,
      maxAttempts || 2,
      allowedStartTime || null,
      allowedEndTime || null,
      JSON.stringify(metadata || {}),
    ]
  );
  return rows[0];
}

export async function updateCampaignStatus({ id, empresaId, status }) {
  const rows = await query(
    `UPDATE call_campaigns
        SET status = $3,
            updated_at = NOW()
      WHERE id = $1 AND empresa_id = $2
      RETURNING *`,
    [id, empresaId, status]
  );
  return rows[0] || null;
}

export async function importCampaignContacts({ campaignId, empresaId, contacts = [] }) {
  const inserted = [];

  for (const item of contacts) {
    const phone = String(item.phone || item.telefono || '').trim();
    const phoneNormalized = normalizePhone(phone);
    if (!phoneNormalized) continue;

    const rows = await query(
      `INSERT INTO call_campaign_contacts (
          campaign_id, empresa_id, customer_id, name, phone, phone_normalized, metadata
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (campaign_id, phone_normalized)
       DO UPDATE SET
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         metadata = call_campaign_contacts.metadata || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        campaignId,
        empresaId,
        item.customer_id ? Number(item.customer_id) : null,
        item.name || item.nombre || null,
        phone,
        phoneNormalized,
        JSON.stringify(item.metadata || item),
      ]
    );
    if (rows[0]) inserted.push(rows[0]);
  }

  return inserted;
}

export async function listCampaignContacts({ campaignId, empresaId }) {
  return query(
    `SELECT *
       FROM call_campaign_contacts
      WHERE campaign_id = $1 AND empresa_id = $2
      ORDER BY id DESC`,
    [campaignId, empresaId]
  );
}

export async function createCallSession({ campaignContactId, empresaId, campaignId, metadata }) {
  const rows = await query(
    `INSERT INTO call_sessions (campaign_contact_id, empresa_id, campaign_id, metadata)
     VALUES ($1,$2,$3,$4::jsonb)
     RETURNING *`,
    [campaignContactId, empresaId, campaignId, JSON.stringify(metadata || {})]
  );
  return rows[0];
}

export async function getCallSession({ sessionId, empresaId }) {
  const rows = await query(
    `SELECT *
       FROM call_sessions
      WHERE id = $1 AND empresa_id = $2
      LIMIT 1`,
    [sessionId, empresaId]
  );
  return rows[0] || null;
}

export async function getCallSessionById(sessionId) {
  const rows = await query(
    `SELECT *
       FROM call_sessions
      WHERE id = $1
      LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}

export async function findCallSessionByChannel({ channelId }) {
  const rows = await query(
    `SELECT *
       FROM call_sessions
      WHERE asterisk_channel_id = $1 OR asterisk_linkedid = $1
      ORDER BY id DESC
      LIMIT 1`,
    [channelId]
  );
  return rows[0] || null;
}

export async function updateCallSession({ sessionId, empresaId, fields = {} }) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return getCallSession({ sessionId, empresaId });

  const values = [];
  const sets = entries.map(([key, value], index) => {
    values.push(value);
    return `${key} = $${index + 1}`;
  });

  values.push(sessionId, empresaId);

  const rows = await query(
    `UPDATE call_sessions
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND empresa_id = $${values.length}
      RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function createCallEvent({ callSessionId, eventType, payload }) {
  const rows = await query(
    `INSERT INTO call_events (call_session_id, event_type, payload)
     VALUES ($1,$2,$3::jsonb)
     RETURNING *`,
    [callSessionId, eventType, JSON.stringify(payload || {})]
  );
  return rows[0];
}

export async function createCallTask({ callSessionId, taskType, dueAt, notes }) {
  const rows = await query(
    `INSERT INTO call_tasks (call_session_id, task_type, due_at, notes)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [callSessionId, taskType, dueAt || null, notes || null]
  );
  return rows[0];
}

export async function findDispatchableContacts({ empresaId, limit = 10 }) {
  return query(
    `SELECT c.*, camp.name AS campaign_name, camp.prompt_version, camp.max_attempts
       FROM call_campaign_contacts c
       JOIN call_campaigns camp ON camp.id = c.campaign_id
      WHERE c.empresa_id = $1
        AND camp.status = 'active'
        AND c.status IN ('pending', 'retry')
        AND c.attempts < camp.max_attempts
        AND (c.next_retry_at IS NULL OR c.next_retry_at <= NOW())
      ORDER BY c.id ASC
      LIMIT $2`,
    [empresaId, limit]
  );
}

export async function markContactCalling({ contactId, empresaId }) {
  const rows = await query(
    `UPDATE call_campaign_contacts
        SET status = 'calling',
            attempts = attempts + 1,
            last_call_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND empresa_id = $2
      RETURNING *`,
    [contactId, empresaId]
  );
  return rows[0] || null;
}

export async function updateContactResult({ contactId, empresaId, status, finalDisposition, nextRetryAt }) {
  const rows = await query(
    `UPDATE call_campaign_contacts
        SET status = COALESCE($3, status),
            final_disposition = COALESCE($4, final_disposition),
            next_retry_at = $5,
            updated_at = NOW()
      WHERE id = $1 AND empresa_id = $2
      RETURNING *`,
    [contactId, empresaId, status || null, finalDisposition || null, nextRetryAt || null]
  );
  return rows[0] || null;
}
