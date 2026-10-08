import { Router } from 'express';
import { pool as defaultPool, query as defaultQuery } from '../db.js';
import { withAuth as defaultWithAuth } from '../services.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import { isLoopbackHostname, parseCanonicalPublicOrigin } from '../bootstrap/env.js';
import { createQuickRepliesRepository } from '../whatsappCloud/quickRepliesRepository.js';

const PG_INT4_MAX = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function canonicalOrigin(req, override) {
  const configured = override || process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '';
  if (configured) return parseCanonicalPublicOrigin(configured, { allowLoopbackHttp: String(process.env.LOCAL_HTTP_DEV || '').toLowerCase() === 'true' });
  if (process.env.NODE_ENV === 'production') return null;
  try {
    const parsed = new URL(`${req.protocol || 'http'}://${req.get('host') || ''}`);
    return isLoopbackHostname(parsed.hostname) ? parsed.origin : null;
  } catch { return null; }
}

function mutationGuard(originOverride) {
  return (req, res, next) => {
    const mediaType = String(req.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return res.status(415).json({ error: 'content_type_invalid' });
    const expected = canonicalOrigin(req, originOverride);
    const supplied = req.get('origin');
    if (!expected || !supplied || supplied === 'null' || supplied.includes(',')) return res.status(403).json({ error: 'request_origin_invalid' });
    try {
      const parsed = new URL(supplied);
      if (parsed.origin !== supplied || parsed.username || parsed.password || supplied !== expected) {
        return res.status(403).json({ error: 'request_origin_invalid' });
      }
    } catch { return res.status(403).json({ error: 'request_origin_invalid' }); }
    return next();
  };
}

function int4(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value <= PG_INT4_MAX ? value : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= PG_INT4_MAX ? parsed : null;
}

function normalizeShortcut(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return normalized.length >= 2 && normalized.length <= 32 && /^[a-z0-9][a-z0-9._-]+$/.test(normalized)
    ? normalized : null;
}

function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function bodyText(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096 ? value : null;
}

function resolveGetTenant(req) {
  const keys = Object.keys(req.query || {});
  const allowed = req.user?.role === 'super' ? new Set(['empresa_id', 'include_inactive']) : new Set(['include_inactive']);
  if (keys.some(key => !allowed.has(key))) return null;
  if (req.user?.role === 'admin') return int4(req.user.empresa_id);
  return req.user?.role === 'super' ? int4(req.query.empresa_id) : null;
}

function resolveMutationTenant(req, body) {
  if (Object.keys(req.query || {}).length !== 0) return null;
  if (req.user?.role === 'admin') {
    if (Object.hasOwn(body, 'empresa_id')) return null;
    return int4(req.user.empresa_id);
  }
  if (req.user?.role !== 'super' || !Object.hasOwn(body, 'empresa_id')) return null;
  return int4(body.empresa_id);
}

function parseCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const allowed = new Set(['empresa_id', 'shortcut', 'title', 'body', 'sortOrder', 'isActive']);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  const shortcut = normalizeShortcut(body.shortcut);
  const title = shortText(body.title, 80);
  const text = bodyText(body.body);
  const sortOrder = body.sortOrder == null ? 0 : body.sortOrder;
  const isActive = body.isActive == null ? true : body.isActive;
  if (!shortcut || !title || !text || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000 || typeof isActive !== 'boolean') return null;
  return { shortcut, title, body: text, sortOrder, isActive };
}

function parsePatch(body, { disableOnly = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const allowed = disableOnly
    ? new Set(['empresa_id', 'expectedVersion'])
    : new Set(['empresa_id', 'shortcut', 'title', 'body', 'sortOrder', 'isActive', 'expectedVersion']);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  const expectedVersion = int4(body.expectedVersion);
  if (!expectedVersion) return null;
  const result = { expectedVersion };
  if (!disableOnly) {
    let changes = 0;
    if (Object.hasOwn(body, 'shortcut')) { result.shortcut = normalizeShortcut(body.shortcut); changes += 1; if (!result.shortcut) return null; }
    if (Object.hasOwn(body, 'title')) { result.title = shortText(body.title, 80); changes += 1; if (!result.title) return null; }
    if (Object.hasOwn(body, 'body')) { result.body = bodyText(body.body); changes += 1; if (!result.body) return null; }
    if (Object.hasOwn(body, 'sortOrder')) { result.sortOrder = body.sortOrder; changes += 1; if (!Number.isInteger(result.sortOrder) || result.sortOrder < 0 || result.sortOrder > 100000) return null; }
    if (Object.hasOwn(body, 'isActive')) { result.isActive = body.isActive; changes += 1; if (typeof result.isActive !== 'boolean') return null; }
    if (changes === 0) return null;
  }
  return result;
}

function sendOutcome(res, result, successStatus = 200) {
  if (result?.outcome === 'conflict') return res.status(409).json({ error: 'quick_reply_shortcut_conflict' });
  if (result?.outcome === 'stale') return res.status(409).json({ error: 'stale_quick_reply_version', current: result.quickReply });
  if (result?.outcome === 'not_found') return res.status(404).json({ error: 'quick_reply_not_found' });
  return res.status(successStatus).json(result.quickReply);
}

function sendFailure(res, error) {
  if (error?.code === 'QUICK_REPLY_ACTOR_FORBIDDEN') return res.status(403).json({ error: 'actor_forbidden' });
  if (error?.code === 'QUICK_REPLY_OUTCOME_UNKNOWN') return res.status(503).json({ error: 'quick_reply_outcome_unknown' });
  if (error?.code === 'QUICK_REPLY_INVALID') return res.status(400).json({ error: 'quick_reply_invalid' });
  return res.status(500).json({ error: 'quick_replies_unavailable' });
}

export function createWhatsAppCloudQuickRepliesAdminRouter({
  pool = defaultPool,
  query = defaultQuery,
  withAuth = defaultWithAuth,
  repository = createQuickRepliesRepository({ pool, query }),
  canonicalOrigin: originOverride,
} = {}) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('Pragma', 'no-cache'); next(); });

  router.get('/', withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const empresaId = resolveGetTenant(req);
    const rawInactive = req.query?.include_inactive;
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (rawInactive != null && rawInactive !== 'true' && rawInactive !== 'false') return res.status(400).json({ error: 'quick_reply_invalid' });
    try {
      const quickReplies = await repository.list({ empresaId, includeInactive: rawInactive === 'true' });
      return res.json({ quickReplies });
    } catch (error) { return sendFailure(res, error); }
  });

  router.post('/', mutationGuard(originOverride), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    const parsed = parseCreate(req.body);
    const empresaId = parsed ? resolveMutationTenant(req, req.body) : null;
    const usuarioId = int4(req.user?.uid);
    if (!parsed) return res.status(400).json({ error: 'quick_reply_invalid' });
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'actor_forbidden' });
    try {
      return sendOutcome(res, await repository.create({ ...parsed, empresaId, usuarioId, actorRole: req.user.role }), 201);
    } catch (error) { return sendFailure(res, error); }
  });

  router.patch('/:id', mutationGuard(originOverride), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'quick_reply_invalid' });
    const parsed = parsePatch(req.body);
    const empresaId = parsed ? resolveMutationTenant(req, req.body) : null;
    const usuarioId = int4(req.user?.uid);
    if (!parsed) return res.status(400).json({ error: 'quick_reply_invalid' });
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'actor_forbidden' });
    try {
      return sendOutcome(res, await repository.update({ ...parsed, id: req.params.id, empresaId, usuarioId, actorRole: req.user.role }));
    } catch (error) { return sendFailure(res, error); }
  });

  router.delete('/:id', mutationGuard(originOverride), withAuth, requireCanonicalBackofficeRole, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'quick_reply_invalid' });
    const parsed = parsePatch(req.body, { disableOnly: true });
    const empresaId = parsed ? resolveMutationTenant(req, req.body) : null;
    const usuarioId = int4(req.user?.uid);
    if (!parsed) return res.status(400).json({ error: 'quick_reply_invalid' });
    if (!empresaId) return res.status(400).json({ error: 'empresa_id_required' });
    if (!usuarioId) return res.status(403).json({ error: 'actor_forbidden' });
    try {
      return sendOutcome(res, await repository.disable({ ...parsed, id: req.params.id, empresaId, usuarioId, actorRole: req.user.role }));
    } catch (error) { return sendFailure(res, error); }
  });
  return router;
}
