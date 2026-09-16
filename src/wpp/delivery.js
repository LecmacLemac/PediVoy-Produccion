const VALID_JID = /^[^\s@]+@(c\.us|lid|g\.us|broadcast)$/i;

export const WPP_OUTBOX_LEASE_MS = 120000;

export async function ensureWppDeliverySchema(query) {
  await query(`
    ALTER TABLE wpp_outbox
      ADD COLUMN IF NOT EXISTS claim_owner TEXT,
      ADD COLUMN IF NOT EXISTS claim_epoch BIGINT,
      ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ
  `);
  await query(`
    ALTER TABLE empresas
      ADD COLUMN IF NOT EXISTS wpp_heartbeat_at TIMESTAMPTZ
  `);
}

function serializedNumberId(numberId) {
  if (typeof numberId === 'string' && VALID_JID.test(numberId)) return numberId;
  if (numberId && typeof numberId._serialized === 'string' && VALID_JID.test(numberId._serialized)) {
    return numberId._serialized;
  }
  if (numberId?.user && numberId?.server) {
    const jid = `${numberId.user}@${numberId.server}`;
    if (VALID_JID.test(jid)) return jid;
  }
  return null;
}

export async function resolveWhatsappTarget(client, destination, { timeoutMs = 8000 } = {}) {
  const raw = String(destination || '').trim();
  if (!raw) throw new Error('telefono_invalido');

  if (raw.includes('@') && !VALID_JID.test(raw)) {
    throw new Error('jid_invalido');
  }

  if (VALID_JID.test(raw) && !raw.toLowerCase().endsWith('@c.us')) {
    return raw;
  }

  const source = raw.toLowerCase().endsWith('@c.us') ? raw.slice(0, -5) : raw;
  const digits = source.replace(/\D+/g, '');
  if (!digits) throw new Error('telefono_invalido');

  const phone = digits.length === 10 ? `549${digits}` : digits;
  const fallback = `${phone}@c.us`;
  if (typeof client?.getNumberId !== 'function') return fallback;

  let timeoutId;
  try {
    const numberId = await Promise.race([
      client.getNumberId(phone),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('getNumberId_timeout')), timeoutMs);
      }),
    ]);
    return serializedNumberId(numberId) || fallback;
  } catch {
    return fallback;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function claimWppOutboxRows({
  query,
  owner,
  epoch = null,
  limit,
  leaseMs = WPP_OUTBOX_LEASE_MS,
  whereSql = '',
  whereParams = [],
}) {
  if (!owner) throw new Error('claim owner requerido');
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('claim limit inválido');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('claim lease inválido');

  const fenced = epoch !== null && epoch !== undefined;
  const leaseIndex = fenced ? 3 : 2;
  const limitIndex = fenced ? 4 : 3;
  return query(`
    WITH candidates AS (
      SELECT o.id
      FROM wpp_outbox o
      LEFT JOIN empresas e ON e.id = o.empresa_id
      WHERE o.status = 'pending'
        AND (o.claim_until IS NULL OR o.claim_until < NOW())
        ${whereSql}
      ORDER BY o.created_at ASC, o.id ASC
      FOR UPDATE OF o SKIP LOCKED
      LIMIT $${limitIndex}::integer
    )
    UPDATE wpp_outbox o
       SET claim_owner = $1,
           claim_epoch = ${fenced ? '$2::bigint' : 'NULL'},
           claim_until = NOW() + ($${leaseIndex}::bigint * INTERVAL '1 millisecond')
      FROM candidates c
     WHERE o.id = c.id
    RETURNING o.id, o.empresa_id, o.telefono, o.mensaje, o.created_at
  `, fenced
    ? [owner, String(epoch), leaseMs, limit, ...whereParams]
    : [owner, leaseMs, limit, ...whereParams]);
}

export async function releaseWppOutboxClaim({ query, id, owner, epoch = null, error }) {
  const fenced = epoch !== null && epoch !== undefined;
  return query(`
    UPDATE wpp_outbox
       SET status = 'pending',
           error = $1,
           claim_owner = NULL,
           claim_epoch = NULL,
           claim_until = NULL
     WHERE id = $2 AND claim_owner = $3
       ${fenced ? 'AND claim_epoch = $4::bigint' : ''}
    RETURNING id
  `, fenced ? [error, id, owner, String(epoch)] : [error, id, owner]);
}

function claimLostError(id) {
  return Object.assign(new Error(`outbox claim ${id} is no longer owned`), {
    code: 'WPP_OUTBOX_CLAIM_LOST',
  });
}

export async function startWppOutboxDelivery({ query, id, owner, epoch }) {
  if (epoch === null || epoch === undefined) throw new Error('claim epoch requerido');
  const rows = await query(`
    UPDATE wpp_outbox
       SET status = 'sending'
     WHERE id = $1
       AND status = 'pending'
       AND claim_owner = $2
       AND claim_epoch = $3::bigint
    RETURNING id
  `, [id, owner, String(epoch)]);
  if (rows.length !== 1) throw claimLostError(id);
  return rows[0];
}

export async function finishWppOutboxClaim({ query, id, owner, epoch = null, status, error = null, sent = false }) {
  if (!['sent', 'error', 'skipped'].includes(status)) throw new Error('estado final inválido');
  const fenced = epoch !== null && epoch !== undefined;
  const rows = await query(`
    UPDATE wpp_outbox
       SET status = $1,
           sent_at = CASE WHEN $2 THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
           error = $3,
           claim_owner = NULL,
           claim_epoch = NULL,
           claim_until = NULL
     WHERE id = $4 AND claim_owner = $5
       ${fenced ? 'AND claim_epoch = $6::bigint' : ''}
    RETURNING id
  `, fenced
    ? [status, sent, error, id, owner, String(epoch)]
    : [status, sent, error, id, owner]);
  if (rows.length !== 1) throw claimLostError(id);
  return rows[0];
}
