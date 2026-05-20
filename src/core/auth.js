import jwt from 'jsonwebtoken';
import { cfg } from '../config.js';

const JWT_SECRET = process.env.JWT_SECRET || cfg.jwtSecret || 'dev-secret';

export function withAuth(req, res, next) {
  try {
    let token = null;

    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);

    if (!token && req.headers['x-access-token']) token = req.headers['x-access-token'];
    if (!token && req.cookies?.token) token = req.cookies.token;

    if (!token) return res.status(401).json({ error: 'No token' });

    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

export function isSuper(req) {
  return (req.user?.role || '').toLowerCase() === 'super';
}

export function isRepartidor(req) {
  return (req.user?.role || '').toLowerCase() === 'repartidor';
}

export function isReferente(req) {
  return (req.user?.role || '').toLowerCase() === 'referente';
}

export function isUser(req) {
  return !!req.user;
}
