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

function requireCanonicalInt8(value, field) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', `Invalid ${field}`);
  }
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n || String(parsed) !== value) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return value;
}

// Deprecated compatibility for legacy numeric message anchors. Removal is gated by a
// PII-free counter of legacy-vs-stable resolution; never record the anchor or participant.
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

function requireActorRole(value) {
  if (value !== 'admin' && value !== 'super') {
    throw sanitizedError('CLOUD_INBOX_ACTOR_FORBIDDEN', 'WhatsApp Cloud actor forbidden');
  }
  return value;
}

async function lockAndRevalidateMutationActor(client, { usuarioId, actorRole, empresaId }) {
  const result = await client.query(
    `SELECT role, empresa_id, activo
       FROM public.usuarios
      WHERE id = $1
      FOR UPDATE`,
    [usuarioId],
  );
  const actor = result.rows[0];
  const authorized = actor?.activo === true
    && actor.role === actorRole
    && (actorRole === 'admin'
      ? Number(actor.empresa_id) === empresaId
      : actor.empresa_id == null);
  if (!authorized) {
    throw sanitizedError('CLOUD_INBOX_ACTOR_FORBIDDEN', 'WhatsApp Cloud actor forbidden');
  }
}

function maskParticipant(value) {
  const digits = String(value || '');
  if (!/^\d{6,15}$/.test(digits)) return '***';
  return `${'*'.repeat(Math.max(3, digits.length - 4))}${digits.slice(-4)}`;
}

function requireSignedCanonicalInt8(value, field) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', `Invalid ${field}`);
  }
  const parsed = BigInt(value);
  if (parsed < -9223372036854775808n || parsed > 9223372036854775807n || String(parsed) !== value) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return value;
}

function encodeConversationCursor(row) {
  return Buffer.from(JSON.stringify([
    Number(row.queue_bucket),
    Number(row.cursor_priority_rank),
    String(row.queue_activity_key),
    String(row.id),
    String(row.conversation_id),
  ])).toString('base64url');
}

function decodeConversationCursor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid cursor');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 5) throw new Error('invalid cursor');
    const [bucket, priorityRank, activityKey, id, conversationId] = parsed;
    if (!Number.isInteger(bucket) || bucket < 0 || bucket > 3
      || !Number.isInteger(priorityRank) || priorityRank < 0 || priorityRank > 2) {
      throw new Error('invalid cursor');
    }
    return {
      bucket,
      priorityRank,
      activityKey: requireSignedCanonicalInt8(activityKey, 'cursorActivityKey'),
      id: requireCanonicalInt8(id, 'cursorId'),
      conversationId: requireConversationId(conversationId),
    };
  } catch {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid cursor');
  }
}

function encodeMessageCursor(row) {
  const timestamp = row.cursor_message_at || new Date(row.message_at).toISOString();
  return Buffer.from(JSON.stringify([timestamp, String(row.id)])).toString('base64url');
}

function decodeMessageCursor(value) {
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
  usuarioId,
  limit = 25,
  cursor = null,
  from = null,
  to = null,
  payment = null,
  workflowStatus = null,
  priority = null,
  unread = null,
} = {}) {
  const runQuery = requireQuery(query);
  const tenantId = requireTenantId(empresaId);
  const actorId = requirePositiveInteger(usuarioId, 'usuarioId');
  const pageSize = requirePositiveInteger(limit, 'limit');
  if (pageSize > 100) throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid limit');
  const pageCursor = decodeConversationCursor(cursor);
  const fromFilter = from == null ? null : requireNonEmptyString(from, 'from');
  const toFilter = to == null ? null : requireNonEmptyString(to, 'to');
  const paymentFilter = payment == null ? null : requireNonEmptyString(payment, 'payment').toLowerCase();
  if (paymentFilter != null && paymentFilter !== 'transferencia') {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid payment');
  }
  if (workflowStatus != null && !['pending', 'resolved'].includes(workflowStatus)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid workflowStatus');
  }
  if (priority != null && !['normal', 'high', 'urgent'].includes(priority)) {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid priority');
  }
  if (unread != null && typeof unread !== 'boolean') {
    throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid unread');
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
  const includeCounters = pageCursor == null;
  const countersCte = includeCounters
    ? `, counters AS (
         SELECT COUNT(*)::INTEGER AS total_count,
                COUNT(*) FILTER (WHERE queue_bucket = 0)::INTEGER AS pending_count,
                COUNT(*) FILTER (WHERE queue_bucket = 2)::INTEGER AS in_process_count,
                COUNT(*) FILTER (WHERE queue_bucket = 1)::INTEGER AS review_count,
                COUNT(*) FILTER (WHERE queue_bucket = 3)::INTEGER AS resolved_count
           FROM ordered
       )`
    : '';
  const counterSelect = includeCounters
    ? 'counters.total_count, counters.pending_count, counters.in_process_count, counters.review_count, counters.resolved_count'
    : 'NULL::INTEGER AS total_count, NULL::INTEGER AS pending_count, NULL::INTEGER AS in_process_count, NULL::INTEGER AS review_count, NULL::INTEGER AS resolved_count';
  const resultFrom = includeCounters
    ? 'FROM counters LEFT JOIN filtered ON TRUE'
    : 'FROM filtered';
  let rows;
  try {
    rows = await runQuery(
      `WITH latest_messages AS MATERIALIZED (
         SELECT DISTINCT ON (message.participant_wa_id)
                message.participant_wa_id,
                message.id,
                message.direction,
                message.message_type,
                message.delivery_status,
                message.message_at
           FROM public.whatsapp_cloud_messages AS message
          WHERE message.empresa_id = $1
            AND ($5::timestamptz IS NULL OR message.message_at >= $5::timestamptz)
            AND ($6::timestamptz IS NULL OR message.message_at < $6::timestamptz)
          ORDER BY message.participant_wa_id, message.message_at DESC, message.id DESC
       ), inbound_stats AS MATERIALIZED (
         SELECT conversation.id AS conversation_id,
                pg_catalog.MAX(message.message_at) AS last_inbound_at,
                COUNT(*) FILTER (
                  WHERE message.id > COALESCE(read_mark.last_read_message_id, 0)
                )::INTEGER AS unread_count
           FROM public.whatsapp_cloud_conversations AS conversation
           JOIN public.whatsapp_cloud_messages AS message
             ON message.empresa_id = conversation.empresa_id
            AND message.participant_wa_id = conversation.participant_wa_id
            AND message.direction = 'inbound'
            AND ($5::timestamptz IS NULL OR message.message_at >= $5::timestamptz)
            AND ($6::timestamptz IS NULL OR message.message_at < $6::timestamptz)
           LEFT JOIN public.whatsapp_cloud_conversation_reads AS read_mark
             ON read_mark.empresa_id = conversation.empresa_id
            AND read_mark.conversation_id = conversation.id
            AND read_mark.usuario_id = $7
          WHERE conversation.empresa_id = $1
          GROUP BY conversation.id, read_mark.last_read_message_id
       ), base AS (
         SELECT conversation.id AS conversation_id,
                conversation.participant_wa_id,
                conversation.workflow_status,
                conversation.priority,
                conversation.version,
                latest.id,
                latest.direction,
                latest.message_type,
                latest.delivery_status,
                latest.message_at,
                inbound.last_inbound_at,
                COALESCE(inbound.unread_count, 0)::INTEGER AS unread_count
           FROM public.whatsapp_cloud_conversations AS conversation
           JOIN latest_messages AS latest
             ON latest.participant_wa_id = conversation.participant_wa_id
           LEFT JOIN inbound_stats AS inbound ON inbound.conversation_id = conversation.id
          WHERE conversation.empresa_id = $1
            AND $3::text IS NULL
            ${transferCondition}
       ), classified AS (
         SELECT base.*,
                CASE
                  WHEN workflow_status = 'resolved' THEN 3
                  WHEN direction = 'outbound' AND delivery_status IN ('failed','outcome_unknown') THEN 1
                  WHEN direction = 'outbound' AND delivery_status IN ('queued','pending','sending') THEN 2
                  WHEN workflow_status = 'pending' AND (unread_count > 0 OR direction = 'inbound') THEN 0
                  ELSE 3
                END AS queue_bucket,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END AS priority_rank
           FROM base
       ), ordered AS (
         SELECT classified.*,
                CASE WHEN queue_bucket = 0 THEN priority_rank ELSE 0 END AS cursor_priority_rank,
                CASE WHEN queue_bucket = 0 THEN COALESCE(last_inbound_at, message_at) ELSE message_at END
                  AS effective_activity_at,
                pg_catalog.ROUND(EXTRACT(EPOCH FROM message_at) * 1000000)::BIGINT
                  AS last_message_activity_key,
                CASE WHEN last_inbound_at IS NULL THEN NULL
                     ELSE pg_catalog.ROUND(EXTRACT(EPOCH FROM last_inbound_at) * 1000000)::BIGINT
                 END AS last_inbound_activity_key,
                (CASE WHEN queue_bucket = 0 THEN 1 ELSE -1 END
                  * pg_catalog.ROUND(EXTRACT(EPOCH FROM
                      CASE WHEN queue_bucket = 0 THEN COALESCE(last_inbound_at, message_at) ELSE message_at END
                    ) * 1000000))::BIGINT AS queue_activity_key
           FROM classified
       )${countersCte}, filtered AS (
         SELECT * FROM ordered
          WHERE ($8::text IS NULL OR workflow_status = $8)
            AND ($9::text IS NULL OR priority = $9)
            AND ($10::boolean IS NULL OR (unread_count > 0) = $10)
            AND ($11::integer IS NULL OR (
                  queue_bucket, cursor_priority_rank, queue_activity_key, id, conversation_id
                ) > (
                  $11::integer, $12::integer, $13::bigint, $4::bigint, $14::uuid
                ))
          ORDER BY queue_bucket ASC, cursor_priority_rank ASC, queue_activity_key ASC, id ASC, conversation_id ASC
          LIMIT $2
       )
       SELECT filtered.*, customer.customer_name, customer.delivery_address, customer.payment_method,
              ${counterSelect}
         ${resultFrom}
         LEFT JOIN LATERAL (
           SELECT NULLIF(BTRIM(COALESCE(pe.nombre, pe.cliente)), '') AS customer_name,
                  NULLIF(BTRIM(COALESCE(pe.direccion_completa,
                    NULLIF(CONCAT_WS(', ', NULLIF(pe.direccion, ''), NULLIF(pe.ciudad, '')), '')
                  )), '') AS delivery_address,
                  payment.payment_method
             FROM public.puntos_entrega pe
             LEFT JOIN LATERAL (
               SELECT LOWER(NULLIF(BTRIM(p.metodo_pago), '')) AS payment_method, p.fecha, p.id
                 FROM public.pedidos p
                WHERE p.empresa_id = pe.empresa_id AND p.punto_entrega_id = pe.id
                  AND LOWER(NULLIF(BTRIM(p.metodo_pago), '')) IN ('efectivo', 'transferencia')
                ORDER BY p.fecha DESC NULLS LAST, p.id DESC LIMIT 1
             ) payment ON TRUE
            WHERE pe.empresa_id = $1
              AND RIGHT(regexp_replace(COALESCE(pe.telefono_normalizado, pe.telefono, ''), '\\D', '', 'g'), 10)
                  = RIGHT(regexp_replace(filtered.participant_wa_id, '\\D', '', 'g'), 10)
            ORDER BY payment.fecha DESC NULLS LAST, payment.id DESC, pe.id DESC LIMIT 1
         ) customer ON TRUE
        ORDER BY filtered.queue_bucket ASC, filtered.cursor_priority_rank ASC,
                 filtered.queue_activity_key ASC, filtered.id ASC, filtered.conversation_id ASC`,
      [
        tenantId, pageSize + 1, null, pageCursor?.id ?? null, fromFilter, toFilter,
        actorId, workflowStatus, priority, unread,
        pageCursor?.bucket ?? null, pageCursor?.priorityRank ?? null, pageCursor?.activityKey ?? null,
        pageCursor?.conversationId ?? null,
      ],
    );
  } catch {
    throw sanitizedError('CLOUD_INBOX_LIST_FAILED', 'WhatsApp Cloud conversations lookup failed');
  }
  const counterRow = rows[0] || {};
  const conversationRows = rows.filter(row => row.conversation_id != null);
  const page = conversationRows.slice(0, pageSize);
  return {
    conversations: page.map(row => ({
      conversationId: String(row.conversation_id),
      participant: maskParticipant(row.participant_wa_id),
      customerName: row.customer_name ? String(row.customer_name).slice(0, 120) : null,
      customerAddress: row.delivery_address ? String(row.delivery_address).slice(0, 180) : null,
      paymentMethod: ['efectivo', 'transferencia'].includes(String(row.payment_method || '').toLowerCase())
        ? String(row.payment_method).toLowerCase()
        : null,
      unreadCount: Number(row.unread_count) || 0,
      workflowStatus: row.workflow_status,
      priority: row.priority,
      version: row.version,
      lastDirection: row.direction,
      lastMessageType: row.message_type,
      lastDeliveryStatus: row.delivery_status,
      lastMessageAt: row.message_at,
      queueBucket: Number(row.queue_bucket),
      queuePriorityRank: Number(row.cursor_priority_rank),
      queueActivityKey: String(row.queue_activity_key),
      effectiveActivityAt: row.effective_activity_at,
      lastMessageActivityKey: String(row.last_message_activity_key),
      lastInboundActivityKey: row.last_inbound_activity_key == null ? null : String(row.last_inbound_activity_key),
      lastMessageId: String(row.id),
    })),
    counters: includeCounters ? {
      total: Number(counterRow.total_count) || 0,
      pending: Number(counterRow.pending_count) || 0,
      inProcess: Number(counterRow.in_process_count) || 0,
      review: Number(counterRow.review_count) || 0,
      resolved: Number(counterRow.resolved_count) || 0,
    } : null,
    nextCursor: conversationRows.length > pageSize ? encodeConversationCursor(page[page.length - 1]) : null,
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
  const pageCursor = decodeMessageCursor(cursor);
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
    const nextCursor = rows.length > pageSize ? encodeMessageCursor(page[page.length - 1]) : null;
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
  pool,
  client: transactionClient = null,
  empresaId,
  usuarioId,
  actorRole,
  conversationId,
  workflowStatus = null,
  priority = null,
  expectedVersion,
} = {}) {
  const ownsTransaction = transactionClient == null;
  if (ownsTransaction && (!pool || typeof pool.connect !== 'function')) throw new TypeError('pool es requerido');
  if (!ownsTransaction && typeof transactionClient?.query !== 'function') throw new TypeError('client es inválido');
  const tenantId = requireTenantId(empresaId);
  const actorId = requirePositiveInteger(usuarioId, 'usuarioId');
  const expectedActorRole = requireActorRole(actorRole);
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
  const client = ownsTransaction ? await pool.connect() : transactionClient;
  let commitAttempted = false;
  let releaseError;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    // Canonical mutation lock order: actor row -> conversation/projection rows.
    await lockAndRevalidateMutationActor(client, {
      usuarioId: actorId, actorRole: expectedActorRole, empresaId: tenantId,
    });
    const current = await client.query(
      `SELECT id, workflow_status, priority, version
         FROM public.whatsapp_cloud_conversations
        WHERE empresa_id = $1 AND id = $2::uuid
        FOR UPDATE`,
      [tenantId, stableConversationId],
    );
    let result;
    if (current.rows.length === 0) {
      result = { outcome: 'not_found', conversation: null };
    } else {
      const currentConversation = conversationStateDto(current.rows[0]);
      const versionMatches = currentConversation.version === normalizedVersion;
      const isNoOp = versionMatches
        && (workflowStatus == null || currentConversation.workflowStatus === workflowStatus)
        && (priority == null || currentConversation.priority === priority);
      if (!versionMatches) {
        result = { outcome: 'stale', conversation: currentConversation };
      } else if (isNoOp) {
        result = { outcome: 'unchanged', conversation: currentConversation };
      } else {
        const updated = await client.query(
          `UPDATE public.whatsapp_cloud_conversations
              SET workflow_status = COALESCE($3, workflow_status),
                  priority = COALESCE($4, priority),
                  version = version + 1,
                  updated_at = pg_catalog.NOW()
            WHERE empresa_id = $1 AND id = $2::uuid AND version = $5
          RETURNING id, workflow_status, priority, version`,
          [tenantId, stableConversationId, workflowStatus, priority, normalizedVersion],
        );
        if (updated.rows.length !== 1) throw new Error('conversation state write lost locked row');
        result = { outcome: 'updated', conversation: conversationStateDto(updated.rows[0]) };
      }
    }
    if (ownsTransaction) {
      commitAttempted = true;
      await client.query('COMMIT');
    }
    return result;
  } catch (error) {
    if (ownsTransaction && commitAttempted) {
      releaseError = sanitizedError('CLOUD_INBOX_STATE_OUTCOME_UNKNOWN', 'WhatsApp Cloud state outcome unknown');
      throw releaseError;
    }
    if (ownsTransaction) {
      await client.query('ROLLBACK').catch(() => {
        releaseError = sanitizedError('CLOUD_INBOX_STATE_FAILED', 'WhatsApp Cloud conversation state update failed');
      });
    }
    if (error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT' || error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN') throw error;
    throw sanitizedError('CLOUD_INBOX_STATE_FAILED', 'WhatsApp Cloud conversation state update failed');
  } finally {
    if (ownsTransaction) client.release(releaseError);
  }
}

export async function markCloudConversationRead({
  pool, empresaId, conversationId, usuarioId, actorRole, lastReadMessageId,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool es requerido');
  const tenantId = requireTenantId(empresaId);
  const stableConversationId = requireConversationId(conversationId);
  const actorId = requirePositiveInteger(usuarioId, 'usuarioId');
  const expectedActorRole = requireActorRole(actorRole);
  const renderedInboundId = requireCanonicalInt8(lastReadMessageId, 'lastReadMessageId');
  const client = await pool.connect();
  let commitAttempted = false;
  let releaseError;
  try {
    await client.query('BEGIN');
    // Canonical mutation lock order: actor row -> projection namespace -> conversation.
    await lockAndRevalidateMutationActor(client, {
      usuarioId: actorId, actorRole: expectedActorRole, empresaId: tenantId,
    });
    await client.query('SELECT public.whatsapp_cloud_messages_lock_projection($1)', [tenantId]);
    const conversation = await client.query(
      `SELECT conversation.participant_wa_id
         FROM public.whatsapp_cloud_conversations AS conversation
        WHERE conversation.empresa_id = $1 AND conversation.id = $2::uuid
        FOR UPDATE`,
      [tenantId, stableConversationId],
    );
    if (conversation.rows.length !== 1) {
      await client.query('ROLLBACK');
      return null;
    }
    const renderedInbound = await client.query(
      `SELECT message.id
         FROM public.whatsapp_cloud_messages AS message
        WHERE message.empresa_id = $1
          AND message.participant_wa_id = $2
          AND message.id = $3::bigint
          AND message.direction = 'inbound'
        LIMIT 1`,
      [tenantId, conversation.rows[0].participant_wa_id, renderedInboundId],
    );
    if (renderedInbound.rows.length !== 1) {
      await client.query('ROLLBACK');
      throw sanitizedError('CLOUD_INBOX_INVALID_ARGUMENT', 'Invalid lastReadMessageId');
    }
    const updated = await client.query(
      `INSERT INTO public.whatsapp_cloud_conversation_reads
         (empresa_id, conversation_id, usuario_id, last_read_message_id, updated_at)
       VALUES ($1, $2::uuid, $3, $4::bigint, pg_catalog.NOW())
       ON CONFLICT (empresa_id, conversation_id, usuario_id) DO UPDATE
         SET last_read_message_id = GREATEST(
               COALESCE(public.whatsapp_cloud_conversation_reads.last_read_message_id, 0),
               EXCLUDED.last_read_message_id
             ),
             updated_at = pg_catalog.NOW()
       RETURNING last_read_message_id`,
      [tenantId, stableConversationId, actorId, renderedInboundId],
    );
    commitAttempted = true;
    await client.query('COMMIT');
    return {
      conversationId: stableConversationId,
      lastReadMessageId: String(updated.rows[0].last_read_message_id),
    };
  } catch (error) {
    if (commitAttempted) {
      releaseError = sanitizedError('CLOUD_INBOX_READ_OUTCOME_UNKNOWN', 'WhatsApp Cloud read outcome unknown');
      throw releaseError;
    }
    if (error?.code !== 'CLOUD_INBOX_INVALID_ARGUMENT') {
      await client.query('ROLLBACK').catch(rollbackError => { releaseError = rollbackError; });
    }
    if (error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT' || error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN') throw error;
    throw sanitizedError('CLOUD_INBOX_READ_FAILED', 'WhatsApp Cloud read watermark failed');
  } finally {
    client.release(releaseError);
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
