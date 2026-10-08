import {
  UTILITY_TEMPLATE_FIELDS,
  validateUtilityTemplateIntent,
} from '../whatsappCloud/utilityTemplates.js';
import { createHash } from 'node:crypto';
import { pool as defaultPool } from '../db.js';
import { normalizeWhatsappPhone } from '../core/format.js';
import { empresaWhatsappConfigLockNamespace } from './companyConfigLock.js';
import { isWhatsappCloudActive as matchesCanonicalCloudPolicy } from './companyWebPolicy.js';

const VALID_REPLY_JID = /^[^\s@]+@(c\.us|lid)$/i;
const REQUIRED_UTILITY_TEMPLATE_CAPABILITY = Symbol('required-utility-template-capability');
const MAX_CANDIDATE_FIELD_LENGTH = 16_384;
const MAX_CANDIDATE_TOTAL_LENGTH = 65_536;

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

function prepareUtilityTemplateCandidate(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new WppTransportConfigError('cloud_template_payload_invalid');
  }
  const intentDescriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(intentDescriptors).length !== 2
      || !Object.hasOwn(intentDescriptors, 'key') || !Object.hasOwn(intentDescriptors.key, 'value')
      || !Object.hasOwn(intentDescriptors, 'parameters') || !Object.hasOwn(intentDescriptors.parameters, 'value')) {
    throw new WppTransportConfigError('cloud_template_payload_invalid');
  }
  const key = intentDescriptors.key.value;
  const fields = UTILITY_TEMPLATE_FIELDS[key];
  const inputParameters = intentDescriptors.parameters.value;
  if (!fields || !inputParameters || typeof inputParameters !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(inputParameters))) {
    throw new WppTransportConfigError('cloud_template_payload_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(inputParameters);
  if (Reflect.ownKeys(descriptors).length !== fields.length) {
    throw new WppTransportConfigError('cloud_template_payload_invalid');
  }
  const parameters = {};
  let totalLength = 0;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
        || !descriptor.value.isWellFormed() || descriptor.value.length > MAX_CANDIDATE_FIELD_LENGTH) {
      throw new WppTransportConfigError('cloud_template_payload_invalid');
    }
    totalLength += descriptor.value.length;
    if (totalLength > MAX_CANDIDATE_TOTAL_LENGTH) {
      throw new WppTransportConfigError('cloud_template_payload_invalid');
    }
    parameters[field] = descriptor.value;
  }
  return { key, parameters };
}

function prepareEnqueue({
  empresaId = null,
  phone,
  message,
  dedupeWindowMinutes = 5,
  utility_template = null,
  queryOptions, // Legacy producers request sensitivity; all payload queries are always sensitive.
  ...extra
}, { correlatedTransportOrigin = null, correlationId = null } = {}) {
  if (Object.keys(extra).length) throw new WppTransportConfigError('cloud_template_payload_invalid');
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
  if (correlatedTransportOrigin === 'cloud' && normalizedEmpresaId === null) {
    throw new WppTransportConfigError('empresa_id_invalido');
  }
  const normalizedCorrelationId = correlationId == null ? null : String(correlationId).trim();
  if (correlatedTransportOrigin === 'cloud' && !normalizedCorrelationId) {
    throw new WppTransportConfigError('correlation_id_requerido');
  }
  if (correlationId != null && (!normalizedCorrelationId || normalizedCorrelationId.length > 512)) {
    throw new WppTransportConfigError('correlation_id_invalido');
  }

  const utilityTemplateCandidate = prepareUtilityTemplateCandidate(utility_template);
  return {
    utilityTemplateCandidate,
    payload,
    windowMinutes,
    normalizedEmpresaId,
    correlatedTransportOrigin,
    correlationId: normalizedCorrelationId,
  };
}

async function enqueuePreparedWithClient({
  utilityTemplateCandidate,
  payload,
  windowMinutes,
  normalizedEmpresaId,
  correlatedTransportOrigin = null,
  correlationId = null,
  requiredUtilityTemplateKey = null,
  requiredUtilityTemplateCapability = null,
}, client) {
  let transportOrigin = correlatedTransportOrigin || 'general';
  if (normalizedEmpresaId !== null && correlatedTransportOrigin !== 'general') {
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
    const cloudActive = isWhatsappCloudActive(companies[0].config_integraciones);
    if (correlatedTransportOrigin === 'cloud' && !cloudActive) {
      throw new WppTransportConfigError('cloud_config_invalida');
    }
    transportOrigin = correlatedTransportOrigin === 'cloud'
      ? 'cloud'
      : cloudActive ? 'cloud' : 'company';
  }
  let utilityTemplate = null;
  if (transportOrigin === 'cloud') {
    try {
      utilityTemplate = utilityTemplateCandidate == null
        ? null
        : validateUtilityTemplateIntent(utilityTemplateCandidate);
    } catch {
      throw new WppTransportConfigError('cloud_template_payload_invalid');
    }
    const requiresUtilityTemplate = requiredUtilityTemplateCapability === REQUIRED_UTILITY_TEMPLATE_CAPABILITY;
    if (requiresUtilityTemplate
        && (!utilityTemplate || utilityTemplate.key !== requiredUtilityTemplateKey)) {
      throw new WppTransportConfigError('cloud_template_payload_invalid');
    }
  }

  const dedupeKey = correlationId
    ? `reply:${normalizedEmpresaId ?? 0}:${transportOrigin}:${correlationId}`
    : stableDedupeKey({
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

  const recent = await clientRows(client, correlationId
    ? `SELECT id, status, transport_origin
       FROM wpp_outbox
      WHERE empresa_id IS NOT DISTINCT FROM $1::integer
        AND transport_origin = $2
        AND reply_correlation_id = $3
      LIMIT 1`
    : `SELECT id, status, transport_origin
       FROM wpp_outbox
      WHERE telefono = $1
        AND mensaje = $2
        AND empresa_id IS NOT DISTINCT FROM $3::integer
        AND transport_origin = $4
        AND created_at > (NOW() - ($5 * INTERVAL '1 minute'))
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    correlationId
      ? [normalizedEmpresaId, transportOrigin, correlationId]
      : [payload.phone, payload.message, normalizedEmpresaId, transportOrigin, windowMinutes],
    { sensitive: true },
  );

  if (recent.length) {
    const row = recent[0];
    return {
      queued: false,
      skipped: true,
      reason: correlationId ? 'duplicate_correlation' : `duplicate_${windowMinutes}m`,
      id: row.id || null,
      status: row.status || null,
      transportOrigin,
    };
  }

  const inserted = await clientRows(
    client,
    `INSERT INTO wpp_outbox
       (empresa_id, telefono, mensaje, transport_origin, reply_correlation_id, cloud_template_key, cloud_template_parameters, status, created_at)
     VALUES ($1::integer, $2, $3, $4, $5, $6, $7::jsonb, 'pending', NOW())
     RETURNING id, status, transport_origin`,
    [normalizedEmpresaId, payload.phone, payload.message, transportOrigin, correlationId,
      transportOrigin === 'cloud' ? utilityTemplate?.key ?? null : null,
      transportOrigin === 'cloud' && utilityTemplate ? JSON.stringify(utilityTemplate.parameters) : null],
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

function enqueueRequiredUtilityNotification(input, transactionPool, requiredUtilityTemplateKey) {
  return enqueueWppOutboxWithPolicy(input, transactionPool, {
    requiredUtilityTemplateCapability: REQUIRED_UTILITY_TEMPLATE_CAPABILITY,
    requiredUtilityTemplateKey,
  });
}

export function enqueueWppOrderConfirmationNotification(input, transactionPool = defaultPool) {
  return enqueueRequiredUtilityNotification(input, transactionPool, 'order_confirmation');
}

export function enqueueWppOrderEnRouteNotification(input, transactionPool = defaultPool) {
  return enqueueRequiredUtilityNotification(input, transactionPool, 'order_en_route');
}

export function enqueueWppTransferPaymentNotification(input, transactionPool = defaultPool) {
  return enqueueRequiredUtilityNotification(input, transactionPool, 'transfer_payment');
}

export async function enqueueWppOutboxCorrelatedReply({
  empresaId = null,
  phone,
  message,
  dedupeWindowMinutes = 5,
  transportOrigin,
  correlationId = null,
}, transactionPool = defaultPool, { beforeEnqueue = null } = {}) {
  if (transportOrigin !== 'general' && transportOrigin !== 'cloud') {
    throw new WppTransportConfigError('transport_origin_correlacionado_no_permitido');
  }
  return enqueueWppOutboxWithPolicy({
    empresaId,
    phone,
    message,
    dedupeWindowMinutes,
  }, transactionPool, { correlatedTransportOrigin: transportOrigin, correlationId, beforeEnqueue });
}

async function enqueueWppOutboxWithPolicy(input, transactionPool, policy = {}) {
  const beforeEnqueue = policy.beforeEnqueue;
  if (beforeEnqueue != null && typeof beforeEnqueue !== 'function') {
    throw new WppTransportConfigError('before_enqueue_invalido');
  }
  let prepared = beforeEnqueue ? null : prepareEnqueue(input, policy);
  if (prepared?.skippedResult) return prepared.skippedResult;

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

      if (beforeEnqueue) {
        const transactionInput = await beforeEnqueue({ client });
        if (!transactionInput || typeof transactionInput !== 'object' || Array.isArray(transactionInput)
          || Object.keys(transactionInput).length !== 1 || !Object.hasOwn(transactionInput, 'phone')) {
          throw new WppTransportConfigError('before_enqueue_invalido');
        }
        prepared = prepareEnqueue({ ...input, phone: transactionInput.phone }, policy);
        if (prepared.skippedResult) throw new WppTransportConfigError('before_enqueue_invalido');
      }

      if (policy.requiredUtilityTemplateCapability === REQUIRED_UTILITY_TEMPLATE_CAPABILITY) {
        prepared.requiredUtilityTemplateCapability = policy.requiredUtilityTemplateCapability;
        prepared.requiredUtilityTemplateKey = policy.requiredUtilityTemplateKey;
      }

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
