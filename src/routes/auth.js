// src/routes/auth.js
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query as defaultQuery } from '../db.js';

const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_WINDOW_MS || 10 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_MAX || 10);
const LICENSE_RENEWAL_PATH = '/pedidos/inicio/licencia.html';
const loginAttempts = new Map();
let authSchemaReady = false;

export function isLicenseExpired(planEstado, planVencimiento, nowMs = Date.now()) {
  const estado = String(planEstado || '').toLowerCase();
  const vencMs = planVencimiento ? new Date(planVencimiento).getTime() : null;
  return estado === 'expired' || (Number.isFinite(vencMs) && vencMs < nowMs);
}

function getClientIp(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function cleanupRateBucket(map, now, windowMs) {
  for (const [key, v] of map.entries()) {
    if (!v || now - v.start > windowMs) map.delete(key);
  }
}

function hitRateLimit(map, key, windowMs, max) {
  const now = Date.now();
  cleanupRateBucket(map, now, windowMs);
  const cur = map.get(key);
  if (!cur || now - cur.start > windowMs) {
    map.set(key, { count: 1, start: now });
    return false;
  }
  cur.count += 1;
  map.set(key, cur);
  return cur.count > max;
}

export function createAuthRouter({ queryFn = defaultQuery } = {}) {
  const router = express.Router();

  async function ensureAuthSchema() {
    if (authSchemaReady) return;
    await queryFn(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS referente_id INTEGER REFERENCES referentes(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
    `);
    authSchemaReady = true;
  }

  function getUserFromRequest(req) {
    let token = null;
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);
    if (!token && req.cookies?.token) token = req.cookies.token;
    if (!token) return null;
    try {
      return jwt.verify(token, process.env.JWT_SECRET || 'dev');
    } catch {
      return null;
    }
  }

  // GET /api/me
  router.get('/me', (req, res) => {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    res.json({ user });
  });

  // GET /api/empresa/config (compat para front legacy)
  router.get('/empresa/config', async (req, res) => {
    try {
      const user = getUserFromRequest(req);
      const empresaId = Number(user?.empresa_id || 0);
      if (!empresaId) return res.status(401).json({ error: 'No autorizado' });

      const rows = await query(
        `SELECT config_integraciones
           FROM empresas
          WHERE id = $1
          LIMIT 1`,
        [empresaId]
      );

      const cfg = rows?.[0]?.config_integraciones || {};
      const pagosCfg = cfg?.pagos || {};

      const canales = {
        efectivo: pagosCfg?.canales?.efectivo !== false,
        transferencia: pagosCfg?.canales?.transferencia !== false,
        qr_dinamico: !!pagosCfg?.canales?.qr_dinamico,
      };

      return res.json({
        pagos: {
          canales,
          preferido: pagosCfg?.preferido || null,
        }
      });
    } catch (e) {
      console.error('EMPRESA CONFIG ERROR:', e);
      return res.status(500).json({ error: 'Error obteniendo config empresa' });
    }
  });

  // POST /api/login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });

      const ip = getClientIp(req);
      const keyIp = `ip:${ip}`;
      const keyUser = `ip:${ip}:user:${String(username).toLowerCase()}`;
      if (
        hitRateLimit(loginAttempts, keyIp, LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS) ||
        hitRateLimit(loginAttempts, keyUser, LOGIN_WINDOW_MS, Math.max(5, Math.floor(LOGIN_MAX_ATTEMPTS / 2)))
      ) {
        return res.status(429).json({ error: 'Demasiados intentos. Reintentá en unos minutos.' });
      }

      await ensureAuthSchema();

      const rows = await queryFn(
        `SELECT u.id, u.username, u.password, u.role, u.empresa_id, u.chofer_id,
                u.referente_id, COALESCE(u.activo, TRUE) AS activo,
                e.plan_estado, e.plan_vencimiento
         FROM usuarios u
         LEFT JOIN empresas e ON u.empresa_id = e.id
         WHERE u.username = $1 LIMIT 1`,
        [username]
      );

      if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });
      const user = rows[0];

      if (user.activo === false) {
        return res.status(403).json({ error: 'Usuario desactivado. Contactá a administración.' });
      }

      const match = await bcrypt.compare(String(password), String(user.password));
      if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

      const role = String(user.role || '').toLowerCase();
      const licenseExpired = role !== 'super' && isLicenseExpired(user.plan_estado, user.plan_vencimiento);

      // Login correcto: limpiamos buckets de rate-limit para esta combinación
      loginAttempts.delete(keyIp);
      loginAttempts.delete(keyUser);

      const responseUser = {
        uid: user.id,
        username: user.username,
        empresa_id: user.empresa_id,
        role: user.role,
        chofer_id: user.chofer_id ?? null,
        referente_id: user.referente_id ?? null,
        licencia_vencida: licenseExpired
      };

      const token = jwt.sign(
        responseUser,
        process.env.JWT_SECRET || 'dev',
        { expiresIn: '8h' }
      );

      await queryFn('UPDATE usuarios SET last_login_at = NOW() WHERE id = $1', [user.id]);

      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 8 * 60 * 60 * 1000
      });

      // Por defecto NO devolvemos el token en JSON (modo seguro: cookie httpOnly).
      // Compat opcional para clientes legacy: ?includeToken=1 o header x-include-token: 1
      const includeToken = String(req.query?.includeToken || req.headers['x-include-token'] || '') === '1';

      if (includeToken) return res.json({ token, user: responseUser, licenseExpired, redirect: licenseExpired ? LICENSE_RENEWAL_PATH : null });
      return res.json({ ok: true, user: responseUser, licenseExpired, redirect: licenseExpired ? LICENSE_RENEWAL_PATH : null });
    } catch (e) {
      console.error('LOGIN ERROR:', e);
      res.status(500).json({ error: 'Error interno' });
    }
  });

  // POST /api/logout
  // Limpia la cookie httpOnly para cerrar sesión (modo seguro: sin tokens en localStorage)
  router.post('/logout', (_req, res) => {
    res.cookie('token', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
    });
    res.json({ ok: true });
  });

  return router;
}
