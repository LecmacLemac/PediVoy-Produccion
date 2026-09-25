function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WhatsAppCloudEventError('invalid_event', `Invalid ${field}`);
  }
  return value.trim();
}

function sanitizeMessage(message) {
  const type = requireNonEmptyString(message?.type, 'message type');
  const content = {};
  if (type === 'text') {
    if (typeof message?.text?.body !== 'string') {
      throw new WhatsAppCloudEventError('invalid_event', 'Invalid text body');
    }
    content.text = { body: message.text.body };
  } else if (type === 'image') {
    if (typeof message?.image?.id !== 'string') {
      throw new WhatsAppCloudEventError('invalid_event', 'Invalid image id');
    }
    content.image = {
      id: message.image.id,
      ...(typeof message.image.caption === 'string' ? { caption: message.image.caption } : {}),
    };
  }
  return {
    messageId: requireNonEmptyString(message?.id, 'message id'),
    senderId: requireNonEmptyString(message?.from, 'message sender'),
    recipientId: null,
    messageType: type,
    status: null,
    sourceTimestamp: requireNonEmptyString(message?.timestamp, 'message timestamp'),
    content,
  };
}

function sanitizeStatus(status) {
  const normalizedStatus = requireNonEmptyString(status?.status, 'status');
  const sourceTimestamp = requireNonEmptyString(status?.timestamp, 'status timestamp');
  return {
    messageId: requireNonEmptyString(status?.id, 'status message id'),
    senderId: null,
    recipientId: typeof status?.recipient_id === 'string' && status.recipient_id ? status.recipient_id : null,
    messageType: null,
    status: normalizedStatus,
    sourceTimestamp,
    content: {
      ...(typeof status?.conversation?.id === 'string' ? { conversationId: status.conversation.id } : {}),
      ...(typeof status?.pricing?.category === 'string' ? { pricingCategory: status.pricing.category } : {}),
    },
  };
}

export class WhatsAppCloudEventError extends Error {
  constructor(code, message = 'WhatsApp Cloud event rejected') {
    super(message);
    this.name = 'WhatsAppCloudEventError';
    this.code = code;
  }
}

export function createWhatsAppCloudEventHandler({ withTransaction } = {}) {
  if (typeof withTransaction !== 'function') {
    throw new TypeError('withTransaction es requerido');
  }

  return async function handleWhatsAppCloudEvents(events) {
    if (!Array.isArray(events)) throw new WhatsAppCloudEventError('invalid_batch');

    const groups = new Map();
    for (const event of events) {
      const key = typeof event?.phoneNumberId === 'string' && event.phoneNumberId.trim()
        ? event.phoneNumberId.trim()
        : null;
      const group = groups.get(key) || [];
      group.push(event);
      groups.set(key, group);
    }

    let accepted = 0;
    let duplicates = 0;
    let firstError = null;

    for (const groupEvents of groups.values()) {
      try {
        const groupResult = await withTransaction(async (query) => {
          const phoneNumberId = requireNonEmptyString(groupEvents[0]?.phoneNumberId, 'phone number id');
          const tenants = await query(
            `SELECT id AS empresa_id
               FROM empresas
              WHERE jsonb_typeof(config_integraciones::jsonb) = 'object'
                AND config_integraciones::jsonb ? 'whatsapp'
                AND jsonb_typeof((config_integraciones::jsonb)->'whatsapp') = 'object'
                AND LOWER(BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'provider', ''))) = 'cloud'
                AND jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
                AND CASE
                      WHEN jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
                        THEN ((config_integraciones::jsonb)->'whatsapp'->>'enabled')::boolean
                      ELSE FALSE
                    END IS TRUE
                AND BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', '')) = $1
                AND BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'access_token_encrypted', '')) <> ''
              ORDER BY id
              LIMIT 2
              FOR SHARE`,
            [phoneNumberId]
          );
          if (tenants.length !== 1) {
            throw new WhatsAppCloudEventError(
              tenants.length === 0 ? 'unknown_tenant' : 'ambiguous_tenant'
            );
          }
          const empresaId = tenants[0].empresa_id;
          let groupAccepted = 0;
          let groupDuplicates = 0;

          for (const event of groupEvents) {
            let sanitized;
            let dedupeKey;
            if (event?.kind === 'message') {
              sanitized = sanitizeMessage(event.message);
              dedupeKey = `message:${sanitized.messageId}`;
            } else if (event?.kind === 'status') {
              sanitized = sanitizeStatus(event.status);
              dedupeKey = `status:${sanitized.messageId}:${sanitized.status}:${sanitized.sourceTimestamp}`;
            } else {
              throw new WhatsAppCloudEventError('invalid_event_kind');
            }
            const rows = await query(
              `INSERT INTO whatsapp_cloud_events (
                 empresa_id, event_kind, dedupe_key, message_id, entry_id,
                 sender_id, recipient_id, message_type, status, source_timestamp, event_data
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
               ON CONFLICT (empresa_id, dedupe_key) DO NOTHING
               RETURNING id`,
              [
                empresaId,
                event.kind,
                dedupeKey,
                sanitized.messageId,
                typeof event.entryId === 'string' ? event.entryId : null,
                sanitized.senderId,
                sanitized.recipientId,
                sanitized.messageType,
                sanitized.status,
                sanitized.sourceTimestamp,
                sanitized.content,
              ]
            );
            if (rows.length) groupAccepted += 1;
            else groupDuplicates += 1;
          }

          return { accepted: groupAccepted, duplicates: groupDuplicates };
        });
        accepted += groupResult.accepted;
        duplicates += groupResult.duplicates;
      } catch (error) {
        if (!firstError) {
          firstError = error instanceof WhatsAppCloudEventError
            ? error
            : new WhatsAppCloudEventError('processing_failed');
        }
      }
    }

    if (firstError) throw firstError;
    return { accepted, duplicates };
  };
}
