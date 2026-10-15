import express from 'express';
import { createHash } from 'node:crypto';

const BODY_LIMIT = 16 * 1024;
const RESULT_LIMIT = 2 * 1024 * 1024;
const TOKEN = /^Bearer (pva_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43})$/i;
const failure = (statusCode, code) => Object.assign(new Error('Operación no permitida'), { statusCode, code });
const statuses = new Set([400,401,402,403,404,405,409,413,415,429,500,503]);
const messages = {
  400: 'Solicitud inválida', 401: 'Credencial de agente inválida', 402: 'Licencia no disponible',
  403: 'Operación no permitida', 404: 'Herramienta no encontrada', 405: 'Método no permitido',
  409: 'La operación no es compatible con el estado actual', 413: 'Solicitud demasiado grande',
  415: 'Se requiere JSON sin compresión', 429: 'Límite de solicitudes excedido',
  500: 'No se pudo completar la operación', 503: 'Servicio no disponible',
};
const codes = new Set([
  'INVALID_ARGUMENTS','INVALID_REQUEST','INVALID_AGENT_TOKEN','FORBIDDEN','TOOL_NOT_FOUND',
  'METHOD_NOT_ALLOWED','PAYLOAD_TOO_LARGE','UNSUPPORTED_MEDIA_TYPE','RESULT_TOO_LARGE',
  'ORDER_UNAVAILABLE','ORDER_NOT_CANCELLED','DOMAIN_REJECTED','INTERNAL_ERROR',
  'invalid_agent_token','invalid_identity','identity_changed','scope_denied','license_expired',
  'invalid_company','agents_disabled','canonical_origin_required','schema_required','agent_unavailable',
  'invalid_operation','idempotency_required','idempotency_conflict','rate_limited','operation_failed',
]);
function safeError(error) {
  if (error?.code === 'TRANSACTION_OUTCOME_UNKNOWN' || error?.code === 'outcome_unknown') {
    return { status: 503, body: { ok: false, error: { code: 'TRANSACTION_OUTCOME_UNKNOWN', message: 'Resultado de la operación indeterminado' } } };
  }
  if (error?.type === 'entity.too.large') error = failure(413, 'PAYLOAD_TOO_LARGE');
  else if (error?.type === 'entity.parse.failed') error = failure(400, 'INVALID_REQUEST');
  const candidate = Number(error?.statusCode ?? error?.status);
  const status = statuses.has(candidate) ? candidate : 500;
  const code = codes.has(error?.code) ? error.code : (status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST');
  return { status, body: { ok: false, error: { code, message: messages[status] } } };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function bounded(value) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > RESULT_LIMIT) throw failure(500, 'RESULT_TOO_LARGE');
  return value;
}
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

// Mount at /api/agent/v1. Also safe standalone, without the application's parsers/CORS.
export function createAgentToolsRouter({ service, tools }) {
  if (typeof service?.authenticate !== 'function' || typeof service?.execute !== 'function'
      || !tools || !['list','get','call'].every(key => typeof tools[key] === 'function')) {
    throw new TypeError('service y tools son requeridos');
  }
  const router = express.Router();
  router.use(wrap(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    // Server-to-server API: browser Origin is not an alternative credential.
    if (req.headers.origin !== undefined) throw failure(403, 'FORBIDDEN');
    const authorizationHeaders = (req.rawHeaders || []).filter((_, i) => i % 2 === 0).filter(name => name.toLowerCase() === 'authorization');
    const match = TOKEN.exec(req.get('authorization') || '');
    if (!match || authorizationHeaders.length !== 1) throw failure(401, 'INVALID_AGENT_TOKEN');
    req.agentToken = match[1];
    req.agentContext = await service.authenticate(req.agentToken);
    // Never permit query-carried credentials, tenant selectors or arbitrary filters.
    if (Object.keys(req.query).length) throw failure(400, 'INVALID_REQUEST');
    next();
  }));
  router.get('/tools', wrap(async (req, res) => {
    res.json(bounded({ tools: tools.list(req.agentContext) }));
  }));
  router.post('/tools/:name', (req, _res, next) => {
    if (!req.is('application/json') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
      return next(failure(415, 'UNSUPPORTED_MEDIA_TYPE'));
    }
    next();
  }, express.json({ limit: BODY_LIMIT, strict: true, inflate: false }), wrap(async (req, res) => {
    if (Buffer.byteLength(JSON.stringify(req.body) || '', 'utf8') > BODY_LIMIT) throw failure(413, 'PAYLOAD_TOO_LARGE');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'arguments')
        || !req.body.arguments || typeof req.body.arguments !== 'object' || Array.isArray(req.body.arguments)) {
      throw failure(400, 'INVALID_REQUEST');
    }
    const tool = tools.get(req.params.name);
    if (!tool) throw failure(404, 'TOOL_NOT_FOUND');
    const args = req.body.arguments;
    const write = tool.readOnly === false;
    const options = { scope: tool.scope, tool: tool.name, write };
    if (write) {
      const { operation_id, ...hashArgs } = args;
      options.idempotencyKey = operation_id;
      options.requestHash = createHash('sha256').update(JSON.stringify(canonical({ name: tool.name, args: hashArgs }))).digest('hex');
    }
    const result = await service.execute(req.agentToken, options, async context => {
      const output = await tools.call(tool.name, args, context);
      bounded({ ok: true, result: output }); // Reject before commit/cache/audit-success.
      return output;
    });
    res.json(bounded({ ok: true, result }));
  }));
  router.use((_req, _res, next) => next(failure(405, 'METHOD_NOT_ALLOWED')));
  router.use((error, _req, res, _next) => {
    const { status, body } = safeError(error);
    res.status(status).json(body);
  });
  return router;
}
