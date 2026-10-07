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

function requireConversationId(value) {
  const normalized = requireNonEmptyString(value, 'conversationId').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid conversationId');
  }
  return normalized;
}

// Transitional legacy message anchors remain tenant-scoped and unambiguous.
function requireConversationReference(value) {
  try {
    return { kind: 'stable', id: requireConversationId(value) };
  } catch {
    return { kind: 'legacy', id: requirePositiveInteger(value, 'conversationId') };
  }
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
           WHERE p.empresa_id = conversation.empresa_id
             AND LOWER(p.metodo_pago) = 'transferencia'
             AND RIGHT(regexp_replace(COALESCE(pe.telefono_normalizado, pe.telefono, ''), '\\D', '', 'g'), 10)
                 = RIGHT(regexp_replace(conversation.participant_wa_id, '\\D', '', 'g'), 10)
       )`
    : '';
  let rows;
  try {
    rows = await runQuery(
      `SELECT conversation.id AS conversation_id,
              conversation.participant_wa_id,
              conversation.workflow_status,
              conversation.priority,
              conversation.version,
              latest.id, latest.direction, latest.message_type, latest.delivery_status,
              latest.message_at, latest.cursor_message_at,
              customer.customer_name, customer.delivery_address, customer.payment_method
         FROM public.whatsapp_cloud_conversations AS conversation
         JOIN LATERAL (
           SELECT message.id, message.direction, message.message_type,
                  message.delivery_status, message.message_at,
                  to_char(message.message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_message_at
             FROM public.whatsapp_cloud_messages AS message
            WHERE message.empresa_id = conversation.empresa_id
              AND message.participant_wa_id = conversation.participant_wa_id
              AND ($5::timestamptz IS NULL OR message.message_at >= $5::timestamptz)
              AND ($6::timestamptz IS NULL OR message.message_at < $6::timestamptz)
            ORDER BY message.message_at DESC, message.id DESC
            LIMIT 1
         ) latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT
                  NULLIF(BTRIM(COALESCE(pe.nombre, pe.cliente)), '') AS customer_name,
                  NULLIF(BTRIM(COALESCE(
                    pe.direccion_completa,
                    NULLIF(CONCAT_WS(', ', NULLIF(pe.direccion, ''), NULLIF(pe.ciudad, '')), '')
                  )), '') AS delivery_address,
                  payment.payment_method
             FROM public.puntos_entrega pe
             LEFT JOIN LATERAL (
               SELECT LOWER(NULLIF(BTRIM(p.metodo_pago), '')) AS payment_method,
                      p.fecha,
                      p.id
                 FROM public.pedidos p
                WHERE p.empresa_id = pe.empresa_id
                  AND p.punto_entrega_id = pe.id
                  AND LOWER(NULLIF(BTRIM(p.metodo_pago), '')) IN ('efectivo', 'transferencia')
                ORDER BY p.fecha DESC NULLS LAST, p.id DESC
                LIMIT 1
             ) payment ON TRUE
            WHERE pe.empresa_id = conversation.empresa_id
              AND RIGHT(regexp_replace(COALESCE(pe.telefono_normalizado, pe.telefono, ''), '\\D', '', 'g'), 10)
                  = RIGHT(regexp_replace(conversation.participant_wa_id, '\\D', '', 'g'), 10)
            ORDER BY payment.fecha DESC NULLS LAST, payment.id DESC, pe.id DESC
            LIMIT 1
         ) customer ON TRUE
        WHERE conversation.empresa_id = $1
          AND ($3::timestamptz IS NULL OR (latest.message_at, latest.id) < ($3::timestamptz, $4::bigint))
          ${transferCondition}
        ORDER BY latest.message_at DESC, latest.id DESC
        LIMIT $2`,
      [tenantId, pageSize + 1, pageCursor?.timestamp ?? null, pageCursor?.id ?? null, fromFilter, toFilter],
    );
  } catch {
    throw sanitizedError('CLOUD_INBOX_LIST_FAILED', 'WhatsApp Cloud conversations lookup failed');
  }
  const page = rows.slice(0, pageSize);
  return {
    conversations: page.map(row => ({
      conversationId: String(row.conversation_id),
      participant: maskParticipant(row.participant_wa_id),
      customerName: row.customer_name ? String(row.customer_name).slice(0, 120) : null,
      customerAddress: row.delivery_address ? String(row.delivery_address).slice(0, 180) : null,
      paymentMethod: ['efectivo', 'transferencia'].includes(String(row.payment_method || '').toLowerCase())
        ? String(row.payment_method).toLowerCase()
        : null,
      workflowStatus: row.workflow_status,
      priority: row.priority,
      version: row.version,
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
  const conversationReference = requireConversationReference(conversationId);
  const pageSize = requirePositiveInteger(limit, 'limit');
  if (pageSize > 100) throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid limit');
  const pageCursor = decodeCursor(cursor);
  try {
    const anchors = await runQuery(
      conversationReference.kind === 'stable'
        ? `SELECT participant_wa_id
             FROM public.whatsapp_cloud_conversations AS conversation
            WHERE conversation.empresa_id = $1 AND conversation.id = $2::uuid
            LIMIT 1`
        : `SELECT participant_wa_id
             FROM public.whatsapp_cloud_messages
            WHERE empresa_id = $1 AND id = $2
            LIMIT 1`,
      [tenantId, conversationReference.id],
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

export async function getCloudAttachmentMetadata({ query, empresaId, conversationId = null, messageId } = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const normalizedMessageId = requirePositiveInteger(messageId, 'messageId');
  const stableConversationId = conversationId == null ? null : requireConversationId(conversationId);
  try {
    const rows = await runQuery(
      `SELECT message.id, message.message_type, message.media_mime_type,
              message.media_caption, message.document_filename
         FROM public.whatsapp_cloud_messages AS message
         ${stableConversationId == null ? '' : `JOIN public.whatsapp_cloud_conversations AS conversation
           ON conversation.empresa_id = message.empresa_id
          AND conversation.participant_wa_id = message.participant_wa_id`}
        WHERE message.empresa_id = $1
          AND message.id = $2
          ${stableConversationId == null ? '' : 'AND conversation.id = $3::uuid'}
          AND message.message_type IN ('image', 'document')
        LIMIT 1`,
      stableConversationId == null
        ? [tenantId, normalizedMessageId]
        : [tenantId, normalizedMessageId, stableConversationId],
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
  const conversationReference = requireConversationReference(conversationId);
  try {
    const rows = await runQuery(
      conversationReference.kind === 'stable'
        ? `SELECT participant_wa_id
             FROM public.whatsapp_cloud_conversations AS conversation
            WHERE conversation.empresa_id = $1 AND conversation.id = $2::uuid
            LIMIT 1`
        : `SELECT participant_wa_id
             FROM public.whatsapp_cloud_messages
            WHERE empresa_id = $1 AND id = $2
            LIMIT 1`,
      [tenantId, conversationReference.id],
    );
    return rows.length === 1 ? rows[0].participant_wa_id : null;
  } catch {
    throw sanitizedError('CLOUD_INBOX_CONVERSATION_FAILED', 'WhatsApp Cloud conversation lookup failed');
  }
}

function conversationStateDto(row) {
  return {
    conversationId: String(row.id),
    workflowStatus: row.workflow_status,
    priority: row.priority,
    version: row.version,
  };
}

export async function updateCloudConversationState({
  query,
  empresaId,
  conversationId,
  workflowStatus = null,
  priority = null,
  expectedVersion,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const stableConversationId = requireConversationId(conversationId);
  const normalizedVersion = requirePositiveInteger(expectedVersion, 'expectedVersion');
  if (workflowStatus != null && !['pending', 'resolved'].includes(workflowStatus)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid workflowStatus');
  }
  if (priority != null && !['normal', 'high', 'urgent'].includes(priority)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid priority');
  }
  if (workflowStatus == null && priority == null) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Conversation state change required');
  }
  try {
    const updated = await runQuery(
      `UPDATE public.whatsapp_cloud_conversations
          SET workflow_status = COALESCE($3, workflow_status),
              priority = COALESCE($4, priority),
              version = version + 1,
              updated_at = pg_catalog.NOW()
        WHERE empresa_id = $1 AND id = $2::uuid AND version = $5
      RETURNING id, workflow_status, priority, version`,
      [tenantId, stableConversationId, workflowStatus, priority, normalizedVersion],
    );
    if (updated.length === 1) {
      return { outcome: 'updated', conversation: conversationStateDto(updated[0]) };
    }
    const current = await runQuery(
      `SELECT id, workflow_status, priority, version
         FROM public.whatsapp_cloud_conversations
        WHERE empresa_id = $1 AND id = $2::uuid
        LIMIT 1`,
      [tenantId, stableConversationId],
    );
    if (current.length === 0) return { outcome: 'not_found', conversation: null };
    return { outcome: 'stale', conversation: conversationStateDto(current[0]) };
  } catch (error) {
    if (error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT') throw error;
    throw sanitizedError('CLOUD_INBOX_STATE_FAILED', 'WhatsApp Cloud conversation state update failed');
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
