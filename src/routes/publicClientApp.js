import express from 'express';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const OTP_TTL_MS = Number(process.env.CLIENT_OTP_TTL_MS || 5 * 60 * 1000);
const OTP_RATE_WINDOW_MS = Number(process.env.CLIENT_OTP_RATE_WINDOW_MS || 10 * 60 * 1000);
const OTP_RATE_MAX = Number(process.env.CLIENT_OTP_RATE_MAX || 5);
const OTP_MIN_RESEND_MS = Number(process.env.CLIENT_OTP_MIN_RESEND_MS || 45 * 1000);
const OTP_VERIFY_RATE_WINDOW_MS = Number(process.env.CLIENT_OTP_VERIFY_RATE_WINDOW_MS || 10 * 60 * 1000);
const OTP_VERIFY_RATE_MAX = Number(process.env.CLIENT_OTP_VERIFY_RATE_MAX || 15);
const OTP_MAX_VERIFY_ATTEMPTS = Number(process.env.CLIENT_OTP_MAX_VERIFY_ATTEMPTS || 5);
const GOOGLE_STATE_TTL_MS = Number(process.env.CLIENT_GOOGLE_STATE_TTL_MS || 10 * 60 * 1000);

const otpStore = new Map();
const otpRate = new Map();
const otpVerifyRate = new Map();
const googleStateStore = new Map();

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

function getIpPrefix(ip) {
  const m = String(ip || '').match(/(\d+)\.(\d+)\./);
  if (m) return `${m[1]}.${m[2]}`;
  return 'na';
}

function userAgentHash(req) {
  return createHash('sha256').update(String(req.headers['user-agent'] || '')).digest('hex').slice(0, 16);
}

function buildRiskFingerprint(req) {
  return `${getIpPrefix(getClientIp(req))}:${userAgentHash(req)}`;
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

function cleanupRateMap(map, now = Date.now()) {
  for (const [key, value] of map.entries()) {
    if (!value || now > value.resetAt) map.delete(key);
  }
}

function cleanupOtpStore(now = Date.now()) {
  for (const [key, value] of otpStore.entries()) {
    if (!value || now > value.expiresAt) otpStore.delete(key);
  }
}

function cleanupGoogleState(now = Date.now()) {
  for (const [key, value] of googleStateStore.entries()) {
    if (!value || now > value.expiresAt) googleStateStore.delete(key);
  }
}

function hashOtp({ key, code }) {
  const secret = String(process.env.JWT_SECRET || 'dev');
  return createHash('sha256').update(`${key}:${code}:${secret}`).digest('hex');
}

function secureEquals(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function signClientToken({ empresaId, telefono, telefonoNorm, amr, riskFp, email = null }) {
  return jwt.sign(
    {
      type: 'client',
      empresa_id: empresaId,
      telefono: telefono,
      telefono_norm: telefonoNorm,
      email,
      amr: amr || 'otp',
      risk_fp: riskFp,
    },
    process.env.JWT_SECRET || 'dev',
    { expiresIn: '30d' }
  );
}

function getClientFromRequest(req, { strictRisk = false } = {}) {
  const token = req.cookies?.client_token;
  if (!token) return { payload: null, needsRevalidation: false };
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev');
    if (payload?.type !== 'client') return { payload: null, needsRevalidation: false };
    const riskNow = buildRiskFingerprint(req);
    const needsRevalidation = Boolean(payload.risk_fp && payload.risk_fp !== riskNow);
    if (strictRisk && needsRevalidation) return { payload: null, needsRevalidation: true };
    return { payload, needsRevalidation };
  } catch {
    return { payload: null, needsRevalidation: false };
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

function setClientCookie(res, token) {
  res.cookie('client_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

async function getLastProfileByPhone(query, empresaId, telefonoNorm) {
  const contactoRows = await query(
    `SELECT id, cliente, telefono, direccion, ciudad, provincia, pais, email
     FROM puntos_entrega
     WHERE empresa_id = $1
       AND telefono_normalizado LIKE '%' || $2
     ORDER BY id DESC
     LIMIT 1`,
    [empresaId, telefonoNorm]
  );
  return contactoRows[0] || null;
}

export function createPublicClientAppRouter({ query }) {
  if (typeof query !== 'function') throw new Error('createPublicClientAppRouter: falta query(fn)');

  const router = express.Router();

  router.post('/auth/request-otp', async (req, res) => {
    try {
      const now = Date.now();
      cleanupOtpStore(now);
      cleanupRateMap(otpRate, now);

      const empresaId = await resolveEmpresaId(query, req.body?.empresa_id, req.body?.slug);
      const telefonoNorm = normalizePhone(req.body?.telefono);
      if (!empresaId || !telefonoNorm) return res.status(400).json({ error: 'empresa_id/slug y telefono son requeridos' });

      const ip = getClientIp(req);
      if (
        hitRate(otpRate, `otp:ip:${ip}`, OTP_RATE_WINDOW_MS, OTP_RATE_MAX) ||
        hitRate(otpRate, `otp:emp:${empresaId}:tel:${telefonoNorm}`, OTP_RATE_WINDOW_MS, OTP_RATE_MAX)
      ) {
        return res.status(429).json({ error: 'Demasiados intentos. Reintentá en unos minutos.' });
      }

      const key = `${empresaId}:${telefonoNorm}`;
      const existingOtp = otpStore.get(key);
      if (existingOtp && now < (existingOtp.lastSentAt + OTP_MIN_RESEND_MS)) {
        const waitSec = Math.ceil((existingOtp.lastSentAt + OTP_MIN_RESEND_MS - now) / 1000);
        return res.status(429).json({ error: 'Esperá antes de pedir otro código', retry_after_sec: waitSec });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const msg = `PediVoy: tu código de ingreso es ${code}. Vence en 5 minutos.`;
      const telefonoOutbox = digitsOnly(req.body?.telefono);

      otpStore.set(key, {
        codeHash: hashOtp({ key, code }),
        expiresAt: now + OTP_TTL_MS,
        lastSentAt: now,
        tries: 0,
      });

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
      const now = Date.now();
      cleanupOtpStore(now);
      cleanupRateMap(otpVerifyRate, now);

      const empresaId = await resolveEmpresaId(query, req.body?.empresa_id, req.body?.slug);
      const telefonoRaw = String(req.body?.telefono || '').trim();
      const telefonoNorm = normalizePhone(telefonoRaw);
      const code = String(req.body?.code || '').trim();

      if (!empresaId || !telefonoNorm || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }

      const ip = getClientIp(req);
      const verifyKeyRate = `verify:ip:${ip}:emp:${empresaId}:tel:${telefonoNorm}`;
      if (hitRate(otpVerifyRate, verifyKeyRate, OTP_VERIFY_RATE_WINDOW_MS, OTP_VERIFY_RATE_MAX)) {
        return res.status(429).json({ error: 'Demasiados intentos de validación. Reintentá en unos minutos.' });
      }

      const key = `${empresaId}:${telefonoNorm}`;
      const otp = otpStore.get(key);
      if (!otp || now > otp.expiresAt) {
        otpStore.delete(key);
        return res.status(401).json({ error: 'Código vencido o inválido' });
      }

      otp.tries += 1;
      if (otp.tries > OTP_MAX_VERIFY_ATTEMPTS) {
        otpStore.delete(key);
        return res.status(401).json({ error: 'Código inválido' });
      }

      const inputHash = hashOtp({ key, code });
      if (!secureEquals(otp.codeHash, inputHash)) {
        otpStore.set(key, otp);
        return res.status(401).json({ error: 'Código inválido' });
      }

      otpStore.delete(key);

      const token = signClientToken({
        empresaId,
        telefono: telefonoRaw,
        telefonoNorm,
        amr: 'otp',
        riskFp: buildRiskFingerprint(req),
      });
      setClientCookie(res, token);

      const profile = await getLastProfileByPhone(query, empresaId, telefonoNorm);
      return res.json({ ok: true, profile });
    } catch (e) {
      console.error('CLIENT OTP VERIFY ERROR', e);
      return res.status(500).json({ error: 'No se pudo validar el código' });
    }
  });

  router.get('/auth/google/start', async (req, res) => {
    try {
      const empresaId = await resolveEmpresaId(query, req.query?.empresa_id, req.query?.slug);
      if (!empresaId) return res.status(400).json({ error: 'empresa_id/slug inválido' });

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI;
      if (!clientId || !redirectUri) {
        return res.status(400).json({ error: 'Google OAuth no configurado (GOOGLE_CLIENT_ID/GOOGLE_REDIRECT_URI)' });
      }

      cleanupGoogleState();
      const state = randomBytes(24).toString('hex');
      googleStateStore.set(state, {
        empresaId,
        slug: String(req.query?.slug || ''),
        expiresAt: Date.now() + GOOGLE_STATE_TTL_MS,
      });

      const qp = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });

      return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${qp.toString()}`);
    } catch (e) {
      console.error('CLIENT GOOGLE START ERROR', e);
      return res.status(500).json({ error: 'No se pudo iniciar login con Google' });
    }
  });

  router.get('/auth/google/callback', async (req, res) => {
    try {
      cleanupGoogleState();
      const state = String(req.query?.state || '');
      const code = String(req.query?.code || '');
      const stateData = googleStateStore.get(state);
      googleStateStore.delete(state);

      if (!stateData || !code) return res.status(401).send('Google login inválido');

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI;
      if (!clientId || !clientSecret || !redirectUri) return res.status(400).send('Google OAuth no configurado');

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResp.ok) return res.status(401).send('No se pudo validar Google');
      const tokenJson = await tokenResp.json();
      const accessToken = tokenJson?.access_token;
      if (!accessToken) return res.status(401).send('Token Google inválido');

      const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userResp.ok) return res.status(401).send('No se pudo obtener perfil de Google');
      const u = await userResp.json();

      const email = String(u?.email || '').trim().toLowerCase();
      const nombre = String(u?.name || '').trim();
      if (!email) return res.status(401).send('Google sin email');

      const empresaId = Number(stateData.empresaId);
      let profile = null;

      const byEmail = await query(
        `SELECT id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, email
         FROM puntos_entrega
         WHERE empresa_id = $1 AND LOWER(COALESCE(email,'')) = $2
         ORDER BY id DESC LIMIT 1`,
        [empresaId, email]
      );

      if (byEmail.length) {
        profile = byEmail[0];
      } else {
        const ins = await query(
          `INSERT INTO puntos_entrega (empresa_id, cliente, nombre, email)
           VALUES ($1, $2, $3, $4)
           RETURNING id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, email`,
          [empresaId, nombre || email.split('@')[0], nombre || null, email]
        );
        profile = ins[0] || null;
      }

      const telefono = String(profile?.telefono || '').trim();
      const telefonoNorm = normalizePhone(profile?.telefono_normalizado || profile?.telefono || '00000000');

      const token = signClientToken({
        empresaId,
        telefono: telefono || email,
        telefonoNorm: telefonoNorm || `mail-${createHash('sha256').update(email).digest('hex').slice(0, 10)}`,
        email,
        amr: 'google',
        riskFp: buildRiskFingerprint(req),
      });
      setClientCookie(res, token);

      const slugQ = stateData.slug ? `?slug=${encodeURIComponent(stateData.slug)}` : '';
      return res.redirect(`/pedidos/app/${slugQ}`);
    } catch (e) {
      console.error('CLIENT GOOGLE CALLBACK ERROR', e);
      return res.status(500).send('Error en login con Google');
    }
  });

  router.post('/profile', async (req, res) => {
    try {
      const session = getClientFromRequest(req, { strictRisk: true });
      if (!session.payload) {
        if (session.needsRevalidation) {
          return res.status(401).json({ error: 'Revalidación requerida por cambio de dispositivo/red', revalidate_required: true });
        }
        return res.status(401).json({ error: 'No autenticado' });
      }

      const payload = session.payload;
      const empresaId = Number(payload.empresa_id);
      const cliente = String(req.body?.cliente || '').trim();
      const direccion = String(req.body?.direccion || '').trim();
      const telefonoIn = String(req.body?.telefono || payload.telefono || '').trim();
      const email = String(req.body?.email || payload.email || '').trim().toLowerCase() || null;

      if (!cliente || !direccion) return res.status(400).json({ error: 'cliente y direccion son requeridos' });

      const telefonoNorm = normalizePhone(telefonoIn);
      if (!telefonoNorm) return res.status(400).json({ error: 'telefono inválido' });

      let rows = await query(
        `SELECT id FROM puntos_entrega
         WHERE empresa_id = $1
           AND telefono_normalizado LIKE '%' || $2
         ORDER BY id DESC LIMIT 1`,
        [empresaId, telefonoNorm]
      );

      if (!rows.length && email) {
        rows = await query(
          `SELECT id FROM puntos_entrega
           WHERE empresa_id = $1
             AND LOWER(COALESCE(email,'')) = $2
           ORDER BY id DESC LIMIT 1`,
          [empresaId, email]
        );
      }

      let profile;
      if (rows.length) {
        const upd = await query(
          `UPDATE puntos_entrega
              SET cliente=$1, nombre=$2, direccion=$3, telefono=$4, telefono_normalizado=$5, email=COALESCE($6, email)
            WHERE id=$7
            RETURNING id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, email`,
          [cliente, cliente, direccion, telefonoIn, telefonoNorm, email, rows[0].id]
        );
        profile = upd[0] || null;
      } else {
        const ins = await query(
          `INSERT INTO puntos_entrega (empresa_id, cliente, nombre, direccion, telefono, telefono_normalizado, email)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, email`,
          [empresaId, cliente, cliente, direccion, telefonoIn, telefonoNorm, email]
        );
        profile = ins[0] || null;
      }

      const newToken = signClientToken({
        empresaId,
        telefono: telefonoIn,
        telefonoNorm,
        email,
        amr: payload.amr || 'otp',
        riskFp: buildRiskFingerprint(req),
      });
      setClientCookie(res, newToken);

      return res.json({ ok: true, profile });
    } catch (e) {
      console.error('CLIENT APP /profile ERROR', e);
      return res.status(500).json({ error: 'No se pudo guardar perfil' });
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
      const session = getClientFromRequest(req, { strictRisk: true });
      if (!session.payload) {
        if (session.needsRevalidation) {
          return res.status(401).json({ error: 'Revalidación requerida por cambio de dispositivo/red', revalidate_required: true });
        }
        return res.status(401).json({ error: 'No autenticado' });
      }

      const payload = session.payload;
      let profile = await getLastProfileByPhone(
        query,
        Number(payload.empresa_id),
        String(payload.telefono_norm || '')
      );

      if (!profile && payload?.email) {
        const byEmail = await query(
          `SELECT id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, email
           FROM puntos_entrega
           WHERE empresa_id = $1 AND LOWER(COALESCE(email,'')) = $2
           ORDER BY id DESC LIMIT 1`,
          [Number(payload.empresa_id), String(payload.email).toLowerCase()]
        );
        profile = byEmail[0] || null;
      }

      return res.json({
        ok: true,
        session: {
          empresa_id: Number(payload.empresa_id),
          telefono: payload.telefono,
          telefono_norm: payload.telefono_norm,
          amr: payload.amr || 'otp',
        },
        profile: profile || null,
      });
    } catch (e) {
      console.error('CLIENT APP /me ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo sesión' });
    }
  });

  return router;
}
