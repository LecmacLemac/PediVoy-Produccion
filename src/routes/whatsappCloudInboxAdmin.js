import { Router } from 'express';
import { query as defaultQuery, pool as defaultPool } from '../db.js';
import { withAuth as defaultWithAuth } from '../services.js';
import { enqueueWppOutboxCorrelatedReply, normalizeWppOutboxPayload } from '../wpp/enqueue.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import { isLoopbackHostname, parseCanonicalPublicOrigin } from '../bootstrap/env.js';
import {
  getCloudAttachmentMetadata,
  getCloudConversationContext,
  listCloudConversationMessages,
  listCloudConversations,
  markCloudConversationRead,
  matchesCloudReplyCorrelation,
  resolveCloudConversationParticipant,
  searchCloudConversations,
  updateCloudConversationState,
} from '../whatsappCloud/inboxRepository.js';

const PG_INT4_MAX = 2147483647;
const INACTIVE_CLOUD_CONFIG_CODES = new Set([
  'cloud_config_invalida',
  'config_integraciones_invalida',
  'config_whatsapp_invalida',
]);

function configuredCanonicalOrigin(req, override) {
  const configured = override || process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '';
  if (configured) {
    const allowLoopbackHttp = String(process.env.LOCAL_HTTP_DEV || '').toLowerCase() === 'true';
    return parseCanonicalPublicOrigin(configured, { allowLoopbackHttp });
  }
  // Local-only trust boundary: Host is accepted solely for loopback development.
  if (process.env.NODE_ENV === 'production') return null;
  try {
    const parsed = new URL(`${req.protocol || 'http'}://${req.get('host') || ''}`);
    return isLoopbackHostname(parsed.hostname) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function whatsappCloudInboxMutationGuard({ canonicalOrigin } = {}) {
  return function guard(req, res, next) {
    const path = req.path || req.originalUrl || '';
    const guardedMutation = (req.method === 'POST' && (/\/conversations\/[^/]+\/(?:replies|read)\/?$/.test(path)
      || /\/conversations\/search\/?$/.test(path)))
      || (req.method === 'PATCH' && /\/conversations\/[^/]+\/state\/?$/.test(path));
    if (!guardedMutation) {
      return next();
    }
    const mediaType = String(req.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return res.status(415).json({ error: 'content_type_invalid' });
    const expected = configuredCanonicalOrigin(req, canonicalOrigin);
    const supplied = req.get('origin');
    if (!expected || !supplied || supplied === 'null' || supplied.includes(',')) {
      return res.status(403).json({ error: 'request_origin_invalid' });
    }
    try {
      const parsed = new URL(supplied);
      if (parsed.origin !== supplied || parsed.username || parsed.password || supplied !== expected) {
        return res.status(403).json({ error: 'request_origin_invalid' });
      }
    } catch {
      return res.status(403).json({ error: 'request_origin_invalid' });
    }
    return next();
  };
}

function positiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function canonicalUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

function pgInt4Number(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= PG_INT4_MAX
    ? value
    : null;
}

function pgInt4Query(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= PG_INT4_MAX ? parsed : null;
}

function isInvalidArgument(error) {
  return error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT';
}

function resolveTenant(req, { allowBody = false } = {}) {
  if (req.user?.role === 'admin') return pgInt4Number(req.user.empresa_id);
  const queryPresent = req.query?.empresa_id != null;
  const queryTenant = queryPresent ? pgInt4Query(req.query.empresa_id) : null;
  if (!allowBody) return queryTenant;
  const bodyPresent = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'empresa_id');
  const bodyTenant = bodyPresent ? pgInt4Number(req.body.empresa_id) : null;
  if (queryPresent && bodyPresent) {
    return queryTenant && bodyTenant && queryTenant === bodyTenant ? queryTenant : null;
  }
  return bodyPresent ? bodyTenant : queryTenant;
}

function validReplyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.text !== 'string') return null;
  const message = body.text.trim();
  if (!message || message.length > 4096) return null;
  if (typeof body.idempotency_key !== 'string') return null;
  const idempotencyKey = body.idempotency_key;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) return null;
  return { message, idempotencyKey };
}

function validConversationStateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some(key => !['workflowStatus', 'priority', 'expectedVersion', 'empresa_id'].includes(key))) return null;
  const workflowStatus = Object.prototype.hasOwnProperty.call(body, 'workflowStatus')
    ? body.workflowStatus
    : null;
  const priority = Object.prototype.hasOwnProperty.call(body, 'priority') ? body.priority : null;
  if (workflowStatus != null && !['pending', 'resolved'].includes(workflowStatus)) return null;
  if (priority != null && !['normal', 'high', 'urgent'].includes(priority)) return null;
  if (workflowStatus == null && priority == null) return null;
  if (typeof body.expectedVersion !== 'number') return null;
  const expectedVersion = pgInt4Number(body.expectedVersion);
  if (!expectedVersion) return null;
  return { workflowStatus, priority, expectedVersion };
}

function validConversationReadBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(key => !['lastReadMessageId', 'empresa_id'].includes(key))) return null;
  const lastReadMessageId = body.lastReadMessageId;
  if (typeof lastReadMessageId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(lastReadMessageId)
    || BigInt(lastReadMessageId) > 9223372036854775807n) return null;
  return { lastReadMessageId };
}

function pagination(query, defaultLimit) {
  const rawLimit = query?.limit;
  const limit = rawLimit == null ? defaultLimit : positiveInteger(rawLimit);
  if (!limit || limit > 100) return null;
  const cursor = query?.cursor;
  if (cursor != null && (typeof cursor !== 'string' || !cursor)) return null;
  return { limit, cursor: cursor ?? null };
}

function strictIsoUtc(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return undefined;
  return value;
}

function conversationFilters(query) {
  const from = strictIsoUtc(query?.from);
  const to = strictIsoUtc(query?.to);
  if (from === undefined || to === undefined) return null;
  const payment = query?.payment == null || query.payment === '' ? null : String(query.payment);
  if (payment != null && payment !== 'transferencia') return null;
  const workflowStatus = query?.workflowStatus == null || query.workflowStatus === ''
    ? null : String(query.workflowStatus);
  const priority = query?.priority == null || query.priority === '' ? null : String(query.priority);
  const unread = query?.unread == null || query.unread === ''
    ? null
    : query.unread === 'true' ? true : query.unread === 'false' ? false : undefined;
  if (workflowStatus != null && !['pending', 'resolved'].includes(workflowStatus)) return null;
  if (priority != null && !['normal', 'high', 'urgent'].includes(priority)) return null;
  if (unread === undefined) return null;
  if (from && to && Date.parse(from) >= Date.parse(to)) return null;
  return { from, to, payment, workflowStatus, priority, unread };
}

function conversationRevalidateIds(query) {
  if (query?.revalidateIds == null || query.revalidateIds === '') return [];
  if (typeof query.revalidateIds !== 'string') return null;
  const ids = [...new Set(query.revalidateIds.split(','))];
  if (!ids.length || ids.length > 100 || ids.some(id => !canonicalUuid(id))) return null;
  return ids;
}

function validConversationSearch(req) {
  if (Object.keys(req.query || {}).length !== 0) return null;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const allowed = new Set([
    'query', 'empresa_id', 'limit', 'cursor', 'from', 'to', 'payment',
    'workflowStatus', 'priority', 'unreadOnly',
  ]);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  if (typeof body.query !== 'string') return null;
  const searchQuery = body.query.trim();
  if (searchQuery.length < 2 || searchQuery.length > 80) return null;
  const limit = body.limit == null ? 25 : pgInt4Number(body.limit);
  if (!limit || limit > 100) return null;
  const cursor = body.cursor == null ? null : body.cursor;
  if (cursor != null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))) return null;
  const from = strictIsoUtc(body.from);
  const to = strictIsoUtc(body.to);
  if (from === undefined || to === undefined || (from && to && Date.parse(from) >= Date.parse(to))) return null;
  const payment = body.payment == null || body.payment === '' ? null : body.payment;
  if (payment != null && payment !== 'transferencia') return null;
  const workflowStatus = body.workflowStatus == null || body.workflowStatus === '' ? null : body.workflowStatus;
  if (workflowStatus != null && !['pending', 'resolved'].includes(workflowStatus)) return null;
  const priority = body.priority == null || body.priority === '' ? null : body.priority;
  if (priority != null && !['normal', 'high', 'urgent'].includes(priority)) return null;
  const unread = body.unreadOnly == null ? null : body.unreadOnly;
  if (unread != null && typeof unread !== 'boolean') return null;
  return { searchQuery, limit, cursor, from, to, payment, workflowStatus, priority, unread };
}

function resolveSearchTenant(req) {
  if (req.user?.role === 'admin') {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'empresa_id')) return null;
    return pgInt4Number(req.user.empresa_id);
  }
  if (req.user?.role !== 'super' || !Object.prototype.hasOwnProperty.call(req.body || {}, 'empresa_id')) return null;
  return pgInt4Number(req.body.empresa_id);
}

function validContextTenant(req) {
  const keys = Object.keys(req.query || {});
  if (req.user?.role === 'admin') return keys.length === 0 ? pgInt4Number(req.user.empresa_id) : null;
  if (req.user?.role !== 'super' || keys.length !== 1 || keys[0] !== 'empresa_id') return null;
  return pgInt4Query(req.query.empresa_id);
}

export function createWhatsAppCloudInboxAdminRouter({
  query = defaultQuery,
  pool = defaultPool,
  withAuth = defaultWithAuth,
  enqueueReply = enqueueWppOutboxCorrelatedReply,
  canonicalOrigin,
} = {}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    next();
  });
  router.get('/conversations', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveTenant(req);
    const usuarioId = pgInt4Number(req.user?.uid);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'Acceso denegado' });
    const page = pagination(req.query, 25);
    if (!page) return res.status(400).json({ error: 'pagination_invalid' });
    const filters = conversationFilters(req.query);
    if (!filters) return res.status(400).json({ error: 'filters_invalid' });
    const revalidateIds = conversationRevalidateIds(req.query);
    if (!revalidateIds) return res.status(400).json({ error: 'revalidate_ids_invalid' });
    try {
      const result = await listCloudConversations({ query, empresaId, usuarioId, ...page, ...filters, revalidateIds });
      return res.json(result);
    } catch (error) {
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'pagination_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.post('/conversations/search', whatsappCloudInboxMutationGuard({ canonicalOrigin }), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const search = validConversationSearch(req);
    if (!search) return res.status(400).json({ error: 'search_invalid' });
    const empresaId = resolveSearchTenant(req);
    const usuarioId = pgInt4Number(req.user?.uid);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'Acceso denegado' });
    try {
      const result = await searchCloudConversations({ query, empresaId, usuarioId, ...search });
      return res.json(result);
    } catch (error) {
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'search_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.get('/conversations/:conversationId/context', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = validContextTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!canonicalUuid(req.params.conversationId)) return res.status(400).json({ error: 'conversation_id_invalid' });
    try {
      const result = await getCloudConversationContext({
        query, empresaId, conversationId: req.params.conversationId, orderLimit: 5,
      });
      if (!result) return res.status(404).json({ error: 'conversation_not_found' });
      return res.json(result);
    } catch (error) {
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'conversation_id_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.get('/conversations/:conversationId/messages', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!canonicalUuid(req.params.conversationId) && !positiveInteger(req.params.conversationId)) {
      return res.status(400).json({ error: 'conversation_id_invalid' });
    }
    const page = pagination(req.query, 50);
    if (!page) return res.status(400).json({ error: 'pagination_invalid' });
    try {
      const result = await listCloudConversationMessages({
        query,
        empresaId,
        conversationId: req.params.conversationId,
        ...page,
      });
      if (!result) return res.status(404).json({ error: 'conversation_not_found' });
      return res.json(result);
    } catch (error) {
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'pagination_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  const attachmentGuards = [withAuth, requireCanonicalBackofficeRole];
  router.get('/conversations/:conversationId/messages/:messageId/attachment', ...attachmentGuards, async (req, res) => {
    const empresaId = resolveTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!canonicalUuid(req.params.conversationId)) return res.status(400).json({ error: 'conversation_id_invalid' });
    if (!positiveInteger(req.params.messageId)) return res.status(400).json({ error: 'message_id_invalid' });
    try {
      const metadata = await getCloudAttachmentMetadata({
        query, empresaId, conversationId: req.params.conversationId, messageId: req.params.messageId,
      });
      if (!metadata) return res.status(404).json({ error: 'attachment_not_found' });
      return res.json(metadata);
    } catch {
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.get('/conversations/:conversationId/messages/:messageId/attachment/download', ...attachmentGuards, async (req, res) => {
    const empresaId = resolveTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!canonicalUuid(req.params.conversationId)) return res.status(400).json({ error: 'conversation_id_invalid' });
    if (!positiveInteger(req.params.messageId)) return res.status(400).json({ error: 'message_id_invalid' });
    try {
      const metadata = await getCloudAttachmentMetadata({
        query, empresaId, conversationId: req.params.conversationId, messageId: req.params.messageId,
      });
      if (!metadata) return res.status(404).json({ error: 'attachment_not_found' });
      return res.status(409).json({ error: 'attachment_download_unavailable' });
    } catch {
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  // Transitional legacy message-only attachment route: tenant-scoped and non-global.
  router.get('/messages/:messageId/attachment', ...attachmentGuards, async (req, res) => {
    const empresaId = resolveTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!positiveInteger(req.params.messageId)) return res.status(400).json({ error: 'message_id_invalid' });
    try {
      const metadata = await getCloudAttachmentMetadata({
        query,
        empresaId,
        messageId: req.params.messageId,
      });
      if (!metadata) return res.status(404).json({ error: 'attachment_not_found' });
      return res.json(metadata);
    } catch {
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.get('/messages/:messageId/attachment/download', ...attachmentGuards, async (req, res) => {
    const empresaId = resolveTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!positiveInteger(req.params.messageId)) return res.status(400).json({ error: 'message_id_invalid' });
    try {
      const metadata = await getCloudAttachmentMetadata({
        query,
        empresaId,
        messageId: req.params.messageId,
      });
      if (!metadata) return res.status(404).json({ error: 'attachment_not_found' });
      return res.status(409).json({ error: 'attachment_download_unavailable' });
    } catch {
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.post('/conversations/:conversationId/replies', whatsappCloudInboxMutationGuard({ canonicalOrigin }), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveTenant(req, { allowBody: true });
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!canonicalUuid(req.params.conversationId) && !positiveInteger(req.params.conversationId)) {
      return res.status(400).json({ error: 'conversation_id_invalid' });
    }
    const reply = validReplyBody(req.body);
    if (!reply) return res.status(400).json({ error: 'reply_invalid' });
    try {
      const participant = await resolveCloudConversationParticipant({
        query,
        empresaId,
        conversationId: req.params.conversationId,
      });
      if (!participant) return res.status(404).json({ error: 'conversation_not_found' });
      const canonicalPayload = normalizeWppOutboxPayload({ phone: participant, message: reply.message });
      if (!canonicalPayload) return res.status(502).json({ error: 'reply_enqueue_failed' });
      const correlationId = `admin:${reply.idempotencyKey}`;
      const result = await enqueueReply({
        empresaId,
        phone: participant,
        message: reply.message,
        transportOrigin: 'cloud',
        correlationId,
      }, pool);
      if (!result.queued) {
        let matchesOriginal;
        try {
          matchesOriginal = await matchesCloudReplyCorrelation({
            query,
            empresaId,
            outboxId: result.id,
            correlationId,
            participant: canonicalPayload.phone,
            message: canonicalPayload.message,
          });
        } catch {
          return res.status(503).json({ error: 'reply_enqueue_outcome_unknown' });
        }
        if (!matchesOriginal) return res.status(409).json({ error: 'idempotency_key_conflict' });
      }
      return res.status(result.queued ? 202 : 200).json({
        accepted: true,
        deduplicated: result.queued !== true,
        id: result.id == null ? null : String(result.id),
        // Public acceptance state: the original durable enqueue exists. This
        // intentionally does not expose or imply its current delivery state.
        status: 'accepted',
      });
    } catch (error) {
      if (error?.code === 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({ error: 'reply_enqueue_outcome_unknown' });
      }
      if (INACTIVE_CLOUD_CONFIG_CODES.has(error?.code)) {
        return res.status(409).json({ error: 'cloud_config_inactive' });
      }
      return res.status(502).json({ error: 'reply_enqueue_failed' });
    }
  });
  router.post('/conversations/:conversationId/read', whatsappCloudInboxMutationGuard({ canonicalOrigin }), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveTenant(req, { allowBody: true });
    const usuarioId = pgInt4Number(req.user?.uid);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'Acceso denegado' });
    if (!canonicalUuid(req.params.conversationId)) {
      return res.status(400).json({ error: 'conversation_id_invalid' });
    }
    const read = validConversationReadBody(req.body);
    if (!read) {
      return res.status(400).json({ error: 'last_read_message_id_invalid' });
    }
    try {
      const result = await markCloudConversationRead({
        pool, empresaId, conversationId: req.params.conversationId, usuarioId,
        actorRole: req.user.role, lastReadMessageId: read.lastReadMessageId,
      });
      if (!result) return res.status(404).json({ error: 'conversation_not_found' });
      return res.json(result);
    } catch (error) {
      if (error?.code === 'CLOUD_INBOX_READ_OUTCOME_UNKNOWN') {
        return res.status(503).json({ error: 'read_outcome_unknown' });
      }
      if (error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN') {
        return res.status(403).json({ error: 'actor_forbidden' });
      }
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'last_read_message_id_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.patch('/conversations/:conversationId/state', whatsappCloudInboxMutationGuard({ canonicalOrigin }), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveTenant(req, { allowBody: true });
    const usuarioId = pgInt4Number(req.user?.uid);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'Acceso denegado' });
    if (!canonicalUuid(req.params.conversationId)) {
      return res.status(400).json({ error: 'conversation_id_invalid' });
    }
    const state = validConversationStateBody(req.body);
    if (!state) return res.status(400).json({ error: 'conversation_state_invalid' });
    try {
      const result = await updateCloudConversationState({
        pool,
        empresaId,
        usuarioId,
        actorRole: req.user.role,
        conversationId: req.params.conversationId,
        ...state,
      });
      if (result.outcome === 'not_found') return res.status(404).json({ error: 'conversation_not_found' });
      if (result.outcome === 'stale') {
        return res.status(409).json({
          error: 'stale_conversation_version',
          current: result.conversation,
        });
      }
      return res.json(result.conversation);
    } catch (error) {
      if (error?.code === 'CLOUD_INBOX_STATE_OUTCOME_UNKNOWN') {
        return res.status(503).json({ error: 'state_outcome_unknown' });
      }
      if (error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN') {
        return res.status(403).json({ error: 'actor_forbidden' });
      }
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'conversation_state_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  return router;
}