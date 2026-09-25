import { createHash } from 'node:crypto';
import { pool as defaultPool } from '../db.js';
import { normalizeWhatsappPhone } from '../core/format.js';
import { empresaWhatsappConfigLockNamespace } from './companyConfigLock.js';
import { isWhatsappCloudActive as matchesCanonicalCloudPolicy } from './companyWebPolicy.js';

const VALID_REPLY_JID = /^[^\s@]+@(c\.us|lid)$/i;

export function normalizeWppOutboxPayload({ phone, message }) {
  if (!phone || !message) return null;
  const rawPhone = String(phone).trim();
  const cleanPhone = VALID_REPLY_JID.test(rawPhone)
    ? rawPhone
    : normalizeWhatsappPhone(rawPhone);
  const cleanMessage = String(message).trim();
  if (!cleanPhone || !cleanMessage) return null;
  return { phone: cleanPhone, message: cleanMessage };
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export class WppTransportConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WppTransportConfigError';
    this.code = code;
  }
}

export function isWhatsappCloudActive(configIntegraciones) {
  const integrations = objectOrNull(configIntegraciones);
  if (!integrations) throw new WppTransportConfigError('config_integraciones_invalida');
  if (!Object.hasOwn(integrations, 'whatsapp')) return false;

  const whatsapp = objectOrNull(integrations.whatsapp);
  if (!whatsapp) throw new WppTransportConfigError('config_whatsapp_invalida');
  return matchesCanonicalCloudPolicy(integrations);
}

export async function resolveWppTransportOrigin({ empresaId, query }) {
  if (empresaId == null) return 'general';
  const normalizedEmpresaId = Number(empresaId);
  if (!Number.isInteger(normalizedEmpresaId) || normalizedEmpresaId <= 0) {
    throw new WppTransportConfigError('empresa_id_invalido');
  }
  if (typeof query !== 'function') throw new WppTransportConfigError('query_requerida');
  const rows = await query(
    'SELECT config_integraciones FROM empresas WHERE id = $1 LIMIT 1',
    [normalizedEmpresaId],
  );
  if (rows.length !== 1) throw new WppTransportConfigError('empresa_no_encontrada');
  return isWhatsappCloudActive(rows[0].config_integraciones) ? 'cloud' : 'company';
}

function stableDedupeKey({ empresaId, phone, message, transportOrigin }) {
  return createHash('sha256')
    .update(JSON.stringify([empresaId, phone, message, transportOrigin]))
    .digest('hex');
}

async function clientRows(client, text, values = [], { sensitive = false } = {}) {
  const result = await client.query({ text, values, sensitive });
  return result?.rows || [];
}

function resolveTransactionPool(transactionPool) {
  if (transactionPool && typeof transactionPool.connect === 'function') return transactionPool;
  throw new WppTransportConfigError('transaction_pool_requerido');
}

function prepareEnqueue({
  empresaId = null,
  phone,
  message,
  dedupeWindowMinutes = 5,
}, { correlatedGeneralReply = false } = {}) {
  const payload = normalizeWppOutboxPayload({ phone, message });
  if (!payload) return { skippedResult: { queued: false, skipped: true, reason: 'invalid_payload' } };

  const windowMinutes = Number(dedupeWindowMinutes);
  if (!Number.isInteger(windowMinutes) || windowMinutes <= 0) {
    throw new WppTransportConfigError('dedupe_window_invalida');
  }
  const normalizedEmpresaId = empresaId == null ? null : Number(empresaId);
  if (normalizedEmpresaId !== null
    && (!Number.isSafeInteger(normalizedEmpresaId) || normalizedEmpresaId <= 0 || normalizedEmpresaId > 0x7fffffff)) {
    throw new WppTransportConfigError('empresa_id_invalido');
  }

  return { payload, windowMinutes, normalizedEmpresaId, correlatedGeneralReply };
}

async function enqueuePreparedWithClient({
  payload,
  windowMinutes,
  normalizedEmpresaId,
  correlatedGeneralReply = false,
}, client) {
  let transportOrigin = 'general';
  if (normalizedEmpresaId !== null && !correlatedGeneralReply) {
    await clientRows(
      client,
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer) AS locked',
      [empresaWhatsappConfigLockNamespace, normalizedEmpresaId],
    );
    const companies = await clientRows(
      client,
      'SELECT config_integraciones FROM empresas WHERE id = $1::integer LIMIT 1',
      [normalizedEmpresaId],
    );
    if (companies.length !== 1) throw new WppTransportConfigError('empresa_no_encontrada');
    transportOrigin = isWhatsappCloudActive(companies[0].config_integraciones) ? 'cloud' : 'company';
  }

  const dedupeKey = stableDedupeKey({
    empresaId: normalizedEmpresaId,
    phone: payload.phone,
    message: payload.message,
    transportOrigin,
  });
  await clientRows(
    client,
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked',
    [dedupeKey],
  );

  const recent = await clientRows(
    client,
    `SELECT id, status, transport_origin
       FROM wpp_outbox
      WHERE telefono = $1
        AND mensaje = $2
        AND empresa_id IS NOT DISTINCT FROM $3::integer
        AND transport_origin = $4
        AND created_at > (NOW() - ($5 * INTERVAL '1 minute'))
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [payload.phone, payload.message, normalizedEmpresaId, transportOrigin, windowMinutes],
    { sensitive: true },
  );

  if (recent.length) {
    const row = recent[0];
    return {
      queued: false,
      skipped: true,
      reason: `duplicate_${windowMinutes}m`,
      id: row.id || null,
      status: row.status || null,
      transportOrigin,
    };
  }

  const inserted = await clientRows(
    client,
    `INSERT INTO wpp_outbox
       (empresa_id, telefono, mensaje, transport_origin, status, created_at)
     VALUES ($1::integer, $2, $3, $4, 'pending', NOW())
     RETURNING id, status, transport_origin`,
    [normalizedEmpresaId, payload.phone, payload.message, transportOrigin],
    { sensitive: true },
  );
  if (inserted.length !== 1) throw new WppTransportConfigError('enqueue_sin_resultado');
  return {
    queued: true,
    id: inserted[0].id,
    status: inserted[0].status,
    transportOrigin,
  };
}

function sanitizedEnqueueError(error) {
  return error instanceof WppTransportConfigError
    ? error
    : new WppTransportConfigError('enqueue_fallido');
}

function unknownEnqueueTransactionOutcomeError() {
  return new WppTransportConfigError('WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN');
}

export async function enqueueWppOutboxInTransaction(input, { client, transactionOwner } = {}) {
  if (transactionOwner !== 'caller' || !client || typeof client.query !== 'function'
    || typeof client.release !== 'function') {
    throw new WppTransportConfigError('transaction_client_requerido');
  }
  const prepared = prepareEnqueue(input);
  if (prepared.skippedResult) return prepared.skippedResult;
  try {
    return await enqueuePreparedWithClient(prepared, client);
  } catch (error) {
    throw sanitizedEnqueueError(error);
  }
}

export async function enqueueWppOutbox(input, transactionPool = defaultPool) {
  return enqueueWppOutboxWithPolicy(input, transactionPool);
}

export async function enqueueWppOutboxCorrelatedReply({
  empresaId = null,
  phone,
  message,
  dedupeWindowMinutes = 5,
  transportOrigin,
}, transactionPool = defaultPool) {
  if (transportOrigin !== 'general') {
    throw new WppTransportConfigError('transport_origin_correlacionado_no_permitido');
  }
  return enqueueWppOutboxWithPolicy({
    empresaId,
    phone,
    message,
    dedupeWindowMinutes,
  }, transactionPool, { correlatedGeneralReply: true });
}

async function enqueueWppOutboxWithPolicy(input, transactionPool, policy = {}) {
  const prepared = prepareEnqueue(input, policy);
  if (prepared.skippedResult) return prepared.skippedResult;

  const pool = resolveTransactionPool(transactionPool);
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw new WppTransportConfigError('enqueue_fallido');
  }
  let transactionOpen = false;
  let commitAttempted = false;
  let operationError = null;
  let releaseError;
  let result;

  try {
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      result = await enqueuePreparedWithClient(prepared, client);

      commitAttempted = true;
      await client.query('COMMIT');
      transactionOpen = false;
    } catch (error) {
      operationError = commitAttempted
        ? unknownEnqueueTransactionOutcomeError()
        : sanitizedEnqueueError(error);
      releaseError = commitAttempted || !transactionOpen ? error : undefined;

      if (transactionOpen && !commitAttempted) {
        try {
          await client.query('ROLLBACK');
          transactionOpen = false;
        } catch (rollbackError) {
          releaseError = rollbackError;
        }
      }
    }
  } finally {
    try {
      client.release(releaseError);
    } catch {
      if (!operationError) operationError = new WppTransportConfigError('enqueue_fallido');
    }
  }

  if (operationError) throw operationError;
  return result;
}
