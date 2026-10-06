function requirePositiveInteger(value, field) {
  const normalized = Number(value);
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
        ORDER BY id DESC
        LIMIT 1`,
      [tenantId, messageId],
    );
  } catch {
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
    await runQuery(
      'SELECT public.whatsapp_cloud_messages_reconcile_status($1, $2)',
      [tenantId, messageId],
    );
    return { reconciled: true };
  } catch {
    throw sanitizedError(
      'CLOUD_INBOX_RECONCILE_FAILED',
      'WhatsApp Cloud projection reconciliation failed',
    );
  }
}
