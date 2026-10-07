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

function requireTenantId(value) {
  const normalized = typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (typeof normalized !== 'number'
    || !Number.isInteger(normalized)
    || normalized <= 0
    || normalized > 2147483647) {
    const error = new Error('Invalid empresaId');
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

function maskParticipant(value) {
  const digits = String(value || '');
  if (!/^\d{6,15}$/.test(digits)) return '***';
  return `${'*'.repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}`;
}

function encodeCursor(row) {
  const timestamp = row.cursor_message_at || new Date(row.message_at).toISOString();
  return Buffer.from(JSON.stringify([timestamp, String(row.id)]))
    .toString('base64url');
}

function decodeCursor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid cursor');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('invalid cursor');
    const [timestamp, id] = parsed;
    if (typeof timestamp !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(timestamp)) {
      throw new Error('invalid cursor');
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) throw new Error('invalid cursor');
    return { timestamp, id: requirePositiveInteger(id, 'cursorId') };
  } catch {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid cursor');
  }
}

export async function listCloudConversations({
  query,
  empresaId,
  limit = 25,
  cursor = null,
  from = null,
  to = null,
  payment = null,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const pageSize = requirePositiveInteger(limit, 'limit');
  if (pageSize > 100) throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid limit');
  const pageCursor = decodeCursor(cursor);
  const fromFilter = from == null ? null : requireNonEmptyString(from, 'from');
  const toFilter = to == null ? null : requireNonEmptyString(to, 'to');
  const paymentFilter = payment == null ? null : requireNonEmptyString(payment, 'payment').toLowerCase();
  if (paymentFilter != null && paymentFilter !== 'transferencia') {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid payment');
  }
  const transferCondition = paymentFilter === 'transferencia'
    ? `AND EXISTS (
          SELECT 1
            FROM public.pedidos p
            JOIN public.puntos_entrega pe
              ON pe.id = p.punto_entrega_id
             AND pe.empresa_id = p.empresa_id
           WHERE p.empresa_id = latest.empresa_id
             AND LOWER(p.metodo_pago) = 'transferencia'
             AND RIGHT(regexp_replace(COALESCE(pe.telefono_normalizado, pe.telefono, ''), '\\D', '', 'g'), 10)
                 = RIGHT(regexp_replace(latest.participant_wa_id, '\\D', '', 'g'), 10)
        )`
    : '';
  let rows;
  try {
    rows = await runQuery(
      `WITH latest AS (
         SELECT DISTINCT ON (participant_wa_id)
                id, empresa_id, participant_wa_id, direction, message_type, delivery_status, message_at,
                to_char(message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_message_at
           FROM public.whatsapp_cloud_messages
          WHERE empresa_id = $1
            AND ($5::timestamptz IS NULL OR message_at >= $5::timestamptz)
            AND ($6::timestamptz IS NULL OR message_at < $6::timestamptz)
          ORDER BY participant_wa_id, message_at DESC, id DESC
       )
       SELECT id, participant_wa_id, direction, message_type, delivery_status, message_at,
              cursor_message_at
         FROM latest
        WHERE ($3::timestamptz IS NULL OR (message_at, id) < ($3::timestamptz, $4::bigint))
          ${transferCondition}
        ORDER BY message_at DESC, id DESC
        LIMIT $2`,
      [tenantId, pageSize + 1, pageCursor?.timestamp ?? null, pageCursor?.id ?? null, fromFilter, toFilter],
    );
  } catch {
    throw sanitizedError('CLOUD_INBOX_LIST_FAILED', 'WhatsApp Cloud conversations lookup failed');
  }
  const page = rows.slice(0, pageSize);
  return {
    conversations: page.map(row => ({
      conversationId: String(row.id),
      participant: maskParticipant(row.participant_wa_id),
      lastDirection: row.direction,
      lastMessageType: row.message_type,
      lastDeliveryStatus: row.delivery_status,
      lastMessageAt: row.message_at,
    })),
    nextCursor: rows.length > pageSize ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function listCloudConversationMessages({
  query,
  empresaId,
  conversationId,
  limit = 50,
  cursor = null,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const anchorId = requirePositiveInteger(conversationId, 'conversationId');
  const pageSize = requirePositiveInteger(limit, 'limit');
  if (pageSize > 100) throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid limit');
  const pageCursor = decodeCursor(cursor);
  try {
    const anchors = await runQuery(
      `SELECT participant_wa_id
         FROM public.whatsapp_cloud_messages
        WHERE empresa_id = $1 AND id = $2
        LIMIT 1`,
      [tenantId, anchorId],
    );
    if (anchors.length !== 1) return null;
    const rows = await runQuery(
      `SELECT id, direction, message_type, text_body, media_mime_type,
              media_caption, document_filename, delivery_status, message_at,
              to_char(message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_message_at
         FROM public.whatsapp_cloud_messages
        WHERE empresa_id = $1
          AND participant_wa_id = $2
          AND ($4::timestamptz IS NULL OR (message_at, id) < ($4::timestamptz, $5::bigint))
        ORDER BY message_at DESC, id DESC
        LIMIT $3`,
      [
        tenantId,
        anchors[0].participant_wa_id,
        pageSize + 1,
        pageCursor?.timestamp ?? null,
        pageCursor?.id ?? null,
      ],
      { sensitive: true },
    );
    const page = rows.slice(0, pageSize);
    const nextCursor = rows.length > pageSize ? encodeCursor(page[page.length - 1]) : null;
    return {
      messages: page.reverse().map(row => ({
        id: String(row.id),
        direction: row.direction,
        type: row.message_type,
        text: row.text_body,
        attachment: row.message_type === 'image' || row.message_type === 'document'
          ? {
              mimeType: row.media_mime_type,
              caption: row.media_caption,
              filename: row.document_filename,
              downloadable: false,
            }
          : null,
        deliveryStatus: row.delivery_status,
        messageAt: row.message_at,
      })),
      nextCursor,
    };
  } catch {
    throw sanitizedError('CLOUD_INBOX_HISTORY_FAILED', 'WhatsApp Cloud history lookup failed');
  }
}

export async function getCloudAttachmentMetadata({ query, empresaId, messageId } = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const normalizedMessageId = requirePositiveInteger(messageId, 'messageId');
  try {
    const rows = await runQuery(
      `SELECT id, message_type, media_mime_type, media_caption, document_filename
         FROM public.whatsapp_cloud_messages
        WHERE empresa_id = $1
          AND id = $2
          AND message_type IN ('image', 'document')
        LIMIT 1`,
      [tenantId, normalizedMessageId],
    );
    if (rows.length !== 1) return null;
    return {
      messageId: String(rows[0].id),
      type: rows[0].message_type,
      mimeType: rows[0].media_mime_type,
      caption: rows[0].media_caption,
      filename: rows[0].document_filename,
      downloadable: false,
    };
  } catch {
    throw sanitizedError('CLOUD_INBOX_ATTACHMENT_FAILED', 'WhatsApp Cloud attachment lookup failed');
  }
}

export async function resolveCloudConversationParticipant({ query, empresaId, conversationId } = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const anchorId = requirePositiveInteger(conversationId, 'conversationId');
  try {
    const rows = await runQuery(
      `SELECT participant_wa_id
         FROM public.whatsapp_cloud_messages
        WHERE empresa_id = $1 AND id = $2
        LIMIT 1`,
      [tenantId, anchorId],
    );
    return rows.length === 1 ? rows[0].participant_wa_id : null;
  } catch {
    throw sanitizedError('CLOUD_INBOX_CONVERSATION_FAILED', 'WhatsApp Cloud conversation lookup failed');
  }
}

export async function matchesCloudReplyCorrelation({
  query,
  empresaId,
  outboxId,
  correlationId,
  participant,
  message,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const normalizedOutboxId = requirePositiveInteger(outboxId, 'outboxId');
  const normalizedCorrelationId = requireNonEmptyString(correlationId, 'correlationId');
  const normalizedParticipant = requireNonEmptyString(participant, 'participant');
  const normalizedMessage = requireNonEmptyString(message, 'message');
  try {
    const rows = await runQuery(
      `SELECT id, status,
              telefono = $4 AS same_phone,
              mensaje = $5 AS same_message
         FROM public.wpp_outbox
        WHERE empresa_id = $1
          AND id = $2
          AND transport_origin = 'cloud'
          AND reply_correlation_id = $3
        LIMIT 1`,
      [tenantId, normalizedOutboxId, normalizedCorrelationId, normalizedParticipant, normalizedMessage],
      { sensitive: true },
    );
    return rows.length === 1 && rows[0].same_phone === true && rows[0].same_message === true;
  } catch {
    throw sanitizedError('CLOUD_INBOX_REPLY_LOOKUP_FAILED', 'WhatsApp Cloud reply lookup failed');
  }
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
  const tenantId = requireTenantId(empresaId);
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
  const tenantId = requireTenantId(empresaId);
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
  const tenantId = requireTenantId(empresaId);
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
