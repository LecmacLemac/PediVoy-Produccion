import { Router } from 'express';
import { query as defaultQuery, pool as defaultPool } from '../db.js';
import { withAuth as defaultWithAuth } from '../services.js';
import { enqueueWppOutboxCorrelatedReply, normalizeWppOutboxPayload } from '../wpp/enqueue.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import { isLoopbackHostname, parseCanonicalPublicOrigin } from '../bootstrap/env.js';
import {
  getCloudAttachmentMetadata,
  listCloudConversationMessages,
  listCloudConversations,
  matchesCloudReplyCorrelation,
  resolveCloudConversationParticipant,
} from '../whatsappCloud/inboxRepository.js';

const PG_INT4_MAX = 2147483647;

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
    if (req.method !== 'POST' || !/\/conversations\/[^/]+\/replies\/?$/.test(req.path || req.originalUrl || '')) {
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

function pagination(query, defaultLimit) {
  const rawLimit = query?.limit;
  const limit = rawLimit == null ? defaultLimit : positiveInteger(rawLimit);
  if (!limit || limit > 100) return null;
  const cursor = query?.cursor;
  if (cursor != null && (typeof cursor !== 'string' || !cursor)) return null;
  return { limit, cursor: cursor ?? null };
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
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    const page = pagination(req.query, 25);
    if (!page) return res.status(400).json({ error: 'pagination_invalid' });
    try {
      const result = await listCloudConversations({ query, empresaId, ...page });
      return res.json(result);
    } catch (error) {
      if (isInvalidArgument(error)) return res.status(400).json({ error: 'pagination_invalid' });
      return res.status(500).json({ error: 'cloud_inbox_unavailable' });
    }
  });
  router.get('/conversations/:conversationId/messages', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveTenant(req);
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!positiveInteger(req.params.conversationId)) {
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
    if (!positiveInteger(req.params.conversationId)) {
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
        const matchesOriginal = await matchesCloudReplyCorrelation({
          query,
          empresaId,
          outboxId: result.id,
          correlationId,
          participant: canonicalPayload.phone,
          message: canonicalPayload.message,
        });
        if (!matchesOriginal) return res.status(409).json({ error: 'idempotency_key_conflict' });
      }
      return res.status(result.queued ? 202 : 200).json({
        queued: result.queued === true,
        id: result.id == null ? null : String(result.id),
        status: result.status ?? null,
      });
    } catch (error) {
      if (error?.code === 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({ error: 'reply_enqueue_outcome_unknown' });
      }
      return res.status(502).json({ error: 'reply_enqueue_failed' });
    }
  });
  return router;
}