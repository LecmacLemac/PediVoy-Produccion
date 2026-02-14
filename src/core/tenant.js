import { isSuper } from './auth.js';

export function getEmpresaIdFromToken(req) {
  return req.user?.empresa_id || 1;
}

export function resolveEmpresaId(req) {
  if (isSuper(req)) {
    const q = Number(req.query?.empresa_id);
    if (Number.isFinite(q) && q > 0) return q;

    const b = Number(req.body?.empresa_id);
    if (Number.isFinite(b) && b > 0) return b;
  }
  return getEmpresaIdFromToken(req);
}
