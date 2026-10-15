import express from 'express';

function validOrigin(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ? value : '';
  } catch { return ''; }
}

/** Install BEFORE compatible CORS and the application's general body parser. */
export function personalAgentHttpBoundary({ canonicalOrigin = '' } = {}) {
  const expectedOrigin = validOrigin(canonicalOrigin);
  const parse = express.json({ limit: '16kb', strict: true });
  return function protectPersonalAgentBoundary(req, res, next) {
    // Express mounts are case-insensitive unless configured otherwise.
    const management = /^\/api\/mi-agente(?:\/|$)/i.test(req.path);
    const protocol = /^\/api\/agent\/v1(?:\/|$)/i.test(req.path);
    if (!management && !protocol) return next();
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    res.vary('Origin');
    const reject = (status, code, message) => res.status(status).json({ ok: false, error: { code, message } });
    const origin = req.get('Origin');
    if ((protocol && origin !== undefined) || (management && origin !== undefined && (!expectedOrigin || origin !== expectedOrigin))) {
      return reject(403, 'origin_forbidden', 'Origen no autorizado para esta integración.');
    }
    if (req.get('Sec-Fetch-Site') === 'cross-site') return reject(403, 'origin_forbidden', 'Solicitud entre sitios no autorizada.');
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (management && mutation && (!expectedOrigin || origin !== expectedOrigin)) {
      return reject(403, 'origin_required', 'La operación debe realizarse desde PediVoy.');
    }
    if (mutation && !req.is('application/json')) return reject(415, 'json_required', 'La solicitud debe usar JSON.');
    return parse(req, res, error => {
      if (!error) return next();
      if (error.type === 'entity.too.large') return reject(413, 'payload_too_large', 'La solicitud excede el tamaño permitido.');
      return reject(400, 'invalid_json', 'La solicitud JSON no es válida.');
    });
  };
}
