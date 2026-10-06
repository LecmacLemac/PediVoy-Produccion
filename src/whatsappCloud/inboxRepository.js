function requirePositiveInteger(value, field) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    const error = new Error(`Invalid ${field}`);
    error.code = 'CLOUD_INBOX_INVALID_ARGUMENT';
    throw error;
  }
  if (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)) {
    const error = new Error(`Invalid ${field}`);
    error.code = 'CLOUD_INBOX_INVALID_ARGUMENT';
    throw error;
  }
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    const error = new Error(`Invalid ${field}`);
    error.code = 'CLOUD_INBOX_INVALID_ARGUMENT';
    throw error;
  }
  return normalized;
}

function requireQuery(query) {
  if (typeof query !== 'function') throw new TypeError('query es requerido');
  return query;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`Invalid ${field}`);
    error.code = 'CLOUD_INBOX_INVALID_ARGUMENT';
    throw error;
  }
  return value.trim();
}

function sanitizedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toProjectionDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    providerMessageId: row.provider_message_id,
    messageType: row.message_type,
    textBody: row.text_body,
    mediaMimeType: row.media_mime_type,
    mediaCaption: row.media_caption,
    documentFilename: row.document_filename,
    deliveryStatus: row.delivery_status,
    messageAt: row.message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findCloudMessageProjectionBySourceEvent({
  query,
  empresaId,
  sourceEventId,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requirePositiveInteger(empresaId, 'empresaId');
  const eventId = requirePositiveInteger(sourceEventId, 'sourceEventId');
  let rows;
  try {
    rows = await runQuery(
      `SELECT id, direction, provider_message_id, message_type, text_body,
              media_mime_type, media_caption, document_filename, delivery_status,
              message_at, created_at, updated_at
         FROM public.whatsapp_cloud_messages
        WHERE empresa_id = $1
          AND source_event_id = $2
        LIMIT 1`,
      [tenantId, eventId],
    );
  } catch {
    throw sanitizedError('CLOUD_INBOX_LOOKUP_FAILED', 'WhatsApp Cloud projection lookup failed');
  }
  return toProjectionDto(rows[0]);
}

export async function findCloudMessageProjectionByProviderMessageId({
  query,
  empresaId,
  providerMessageId,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requirePositiveInteger(empresaId, 'empresaId');
  const messageId = requireNonEmptyString(providerMessageId, 'providerMessageId');
  let rows;
  try {
    rows = await runQuery(
      `SELECT id, direction, provider_message_id, message_type, text_body,
              media_mime_type, media_caption, document_filename, delivery_status,
              message_at, created_at, updated_at
         FROM public.whatsapp_cloud_messages
        WHERE empresa_id = $1
          AND provider_message_id = $2
          AND direction = 'outbound'
        LIMIT 2`,
      [tenantId, messageId],
    );
  } catch {
    throw sanitizedError('CLOUD_INBOX_LOOKUP_FAILED', 'WhatsApp Cloud projection lookup failed');
  }
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw sanitizedError('CLOUD_INBOX_LOOKUP_FAILED', 'WhatsApp Cloud projection lookup failed');
  }
  return toProjectionDto(rows[0]);
}

export async function reconcileCloudMessageProjectionStatus({
  query,
  empresaId,
  providerMessageId,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requirePositiveInteger(empresaId, 'empresaId');
  const messageId = requireNonEmptyString(providerMessageId, 'providerMessageId');
  try {
    const rows = await runQuery(
      'SELECT public.whatsapp_cloud_messages_reconcile_status($1, $2) AS result',
      [tenantId, messageId],
    );
    const result = rows[0]?.result;
    if (!['not_found', 'unchanged', 'reconciled'].includes(result)) {
      throw new Error('invalid reconciliation result');
    }
    return { result };
  } catch {
    throw sanitizedError(
      'CLOUD_INBOX_RECONCILE_FAILED',
      'WhatsApp Cloud projection reconciliation failed',
    );
  }
}
