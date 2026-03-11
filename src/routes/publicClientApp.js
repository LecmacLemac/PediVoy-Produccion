import express from 'express';
import jwt from 'jsonwebtoken';

const OTP_TTL_MS = Number(process.env.CLIENT_OTP_TTL_MS || 5 * 60 * 1000);
const OTP_RATE_WINDOW_MS = Number(process.env.CLIENT_OTP_RATE_WINDOW_MS || 10 * 60 * 1000);
const OTP_RATE_MAX = Number(process.env.CLIENT_OTP_RATE_MAX || 5);

const otpStore = new Map();
const otpRate = new Map();

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function normalizePhone(v) {
  const d = digitsOnly(v);
  if (d.length < 8) return '';
  return d.slice(-10);
}

function getClientIp(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function hitRate(map, key, windowMs, max) {
  const now = Date.now();
  const cur = map.get(key);
  if (!cur || now > cur.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  cur.count += 1;
  map.set(key, cur);
  return cur.count > max;
}

function getClientFromRequest(req) {
  const token = req.cookies?.client_token;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev');
    if (payload?.type !== 'client') return null;
    return payload;
  } catch {
    return null;
  }
}

async function resolveEmpresaId(query, rawEmpresaId, rawSlug) {
  if (Number(rawEmpresaId) > 0) return Number(rawEmpresaId);
  const slug = String(rawSlug || '').trim().toLowerCase();
  if (!slug) return null;

  const rows = await query(
    `SELECT id FROM empresas WHERE LOWER(landing_slug) = $1 LIMIT 1`,
    [slug]
  );
  if (!rows.length) return null;
  return Number(rows[0].id);
}

export function createPublicClientAppRouter({ query }) {
  if (typeof query !== 'function') throw new Error('createPublicClientAppRouter: falta query(fn)');

  const router = express.Router();

  router.post('/auth/request-otp', async (req, res) => {
    try {
      const empresaId = await resolveEmpresaId(query, req.body?.empresa_id, req.body?.slug);
      const telefonoNorm = normalizePhone(req.body?.telefono);
      if (!empresaId || !telefonoNorm) return res.status(400).json({ error: 'empresa_id/slug y telefono son requeridos' });

      const ip = getClientIp(req);
      if (hitRate(otpRate, `otp:ip:${ip}`, OTP_RATE_WINDOW_MS, OTP_RATE_MAX)) {
        return res.status(429).json({ error: 'Demasiados intentos. Reintentá en unos minutos.' });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const key = `${empresaId}:${telefonoNorm}`;
      otpStore.set(key, {
        code,
        expiresAt: Date.now() + OTP_TTL_MS,
        tries: 0,
      });

      const msg = `PediVoy: tu código de ingreso es ${code}. Vence en 5 minutos.`;
      const telefonoOutbox = digitsOnly(req.body?.telefono);

      if (telefonoOutbox) {
        await query(
          `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
           VALUES ($1, $2, $3, 'pending', NOW())`,
          [empresaId, telefonoOutbox, msg]
        );
      }

      const response = { ok: true, sent: true };
      if (process.env.NODE_ENV !== 'production') response.debug_code = code;
      return res.json(response);
    } catch (e) {
      console.error('CLIENT OTP REQUEST ERROR', e);
      return res.status(500).json({ error: 'No se pudo enviar el código' });
    }
  });

  router.post('/auth/verify-otp', async (req, res) => {
    try {
      const empresaId = await resolveEmpresaId(query, req.body?.empresa_id, req.body?.slug);
      const telefonoRaw = String(req.body?.telefono || '').trim();
      const telefonoNorm = normalizePhone(telefonoRaw);
      const code = String(req.body?.code || '').trim();

      if (!empresaId || !telefonoNorm || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }

      const key = `${empresaId}:${telefonoNorm}`;
      const otp = otpStore.get(key);
      if (!otp || Date.now() > otp.expiresAt) {
        return res.status(401).json({ error: 'Código vencido o inválido' });
      }

      otp.tries += 1;
      if (otp.tries > 5) {
        otpStore.delete(key);
        return res.status(401).json({ error: 'Código inválido' });
      }

      if (otp.code !== code) {
        otpStore.set(key, otp);
        return res.status(401).json({ error: 'Código inválido' });
      }

      otpStore.delete(key);

      const token = jwt.sign(
        {
          type: 'client',
          empresa_id: empresaId,
          telefono: telefonoRaw,
          telefono_norm: telefonoNorm,
        },
        process.env.JWT_SECRET || 'dev',
        { expiresIn: '30d' }
      );

      res.cookie('client_token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      const contactoRows = await query(
        `SELECT id, cliente, telefono, direccion, ciudad, provincia, pais
         FROM puntos_entrega
         WHERE empresa_id = $1
           AND telefono_normalizado LIKE '%' || $2
         ORDER BY id DESC
         LIMIT 1`,
        [empresaId, telefonoNorm]
      );

      return res.json({ ok: true, profile: contactoRows[0] || null });
    } catch (e) {
      console.error('CLIENT OTP VERIFY ERROR', e);
      return res.status(500).json({ error: 'No se pudo validar el código' });
    }
  });

  router.post('/auth/logout', (_req, res) => {
    res.cookie('client_token', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
    });
    return res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    try {
      const client = getClientFromRequest(req);
      if (!client) return res.status(401).json({ error: 'No autenticado' });

      const contactoRows = await query(
        `SELECT id, cliente, telefono, direccion, ciudad, provincia, pais
         FROM puntos_entrega
         WHERE empresa_id = $1
           AND telefono_normalizado LIKE '%' || $2
         ORDER BY id DESC
         LIMIT 1`,
        [Number(client.empresa_id), String(client.telefono_norm || '')]
      );

      return res.json({
        ok: true,
        session: {
          empresa_id: Number(client.empresa_id),
          telefono: client.telefono,
          telefono_norm: client.telefono_norm,
        },
        profile: contactoRows[0] || null,
      });
    } catch (e) {
      console.error('CLIENT APP /me ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo sesión' });
    }
  });

  return router;
}
