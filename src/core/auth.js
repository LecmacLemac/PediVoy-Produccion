import jwt from 'jsonwebtoken';
import { cfg } from '../config.js';
import { query as defaultQuery } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || cfg.jwtSecret || 'dev-secret';
const USER_ROLES = new Set(['user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin', 'super']);

export function createWithAuth({ queryFn = defaultQuery, jwtSecret = JWT_SECRET } = {}) {
  return async function withAuth(req, res, next) {
    try {
      let token = null;
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) token = h.slice(7);
      if (!token && req.headers['x-access-token']) token = req.headers['x-access-token'];
      if (!token && req.cookies?.token) token = req.cookies.token;
      if (!token) return res.status(401).json({ error: 'No token' });

      const claims = jwt.verify(token, jwtSecret);
      // System-user tokens have no type. Client tokens use their own middleware.
      if (claims.type !== undefined || !Number.isSafeInteger(claims.uid) || claims.uid <= 0 || !USER_ROLES.has(claims.role)) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const rows = await queryFn(
        `SELECT id, role, empresa_id, chofer_id, referente_id, activo
           FROM usuarios WHERE id = $1 LIMIT 1`,
        [claims.uid]
      );
      const user = rows?.[0];
      if (!user || user.activo !== true || !USER_ROLES.has(user.role)) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      req.user = {
        ...claims,
        uid: user.id,
        role: user.role,
        empresa_id: user.empresa_id,
        chofer_id: user.chofer_id ?? null,
        referente_id: user.referente_id ?? null,
      };
    } catch {
      return res.status(401).json({ error: 'Token inválido' });
    }
    return next();
  };
}

export const withAuth = createWithAuth();

export function isSuper(req) {
  return req.user?.role === 'super';
}

export function isRepartidor(req) {
  return req.user?.role === 'repartidor';
}

export function isReferente(req) {
  return req.user?.role === 'referente';
}

export function isUser(req) {
  return !!req.user;
}
