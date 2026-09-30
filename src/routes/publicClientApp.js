import express from 'express';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { enqueueWppOutbox } from '../wpp/enqueue.js';
import { withTransaction as defaultWithTransaction } from '../db.js';
import { resolvePublicPedidoEmpresaId } from '../services/publicPedidoTenant.js';
import {
  deliveryPointConflict,
  deliveryPointIdentity,
  deliveryPointIdentityFromRow,
  findDeliveryPointsByIdentity,
  lockGeneralPhoneIdentity,
  lockDeliveryPointIdentities,
  sameDeliveryPointIdentity,
} from '../services/deliveryPointIdentity.js';

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

function normalizeWhatsappOutboxPhone(v) {
  const d = digitsOnly(v);
  if (!d) return '';
  if (d.length === 10) return `549${d}`;
  return d;
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

function getCanonicalPublicSelector(req, empresaId) {
  const slug = typeof req.query?.slug === 'string' ? req.query.slug.trim().toLowerCase() : '';
  const empresaIdRaw = typeof req.query?.empresa_id === 'string' ? req.query.empresa_id : '';
  const hasSlug = Boolean(slug);
  const hasEmpresaId = Boolean(empresaIdRaw);
  if (hasSlug && hasEmpresaId) {
    return { selectorType: 'both', slug, empresaId: String(empresaId) };
  }
  if (hasSlug) return { selectorType: 'slug', slug, empresaId: null };
  if (hasEmpresaId) return { selectorType: 'empresa_id', slug: null, empresaId: String(empresaId) };
  return null;
}

function buildClientAppRedirect(selector, resolvedEmpresaId) {
  if (!selector || !['slug', 'empresa_id', 'both'].includes(selector.selectorType)) return null;
  const params = new URLSearchParams();
  if (selector.selectorType === 'slug' || selector.selectorType === 'both') {
    const slug = String(selector.slug || '').trim().toLowerCase();
    if (!slug) return null;
    params.set('slug', slug);
  }
  if (selector.selectorType === 'empresa_id' || selector.selectorType === 'both') {
    const empresaId = String(selector.empresaId || '');
    if (empresaId !== String(resolvedEmpresaId)) return null;
    params.set('empresa_id', empresaId);
  }
  return `/pedidos/app/?${params.toString()}`;
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

function signClientToken({ empresaId, profileId = null, telefono, telefonoNorm, amr, riskFp, email = null }) {
  return jwt.sign(
    {
      type: 'client',
      empresa_id: empresaId,
      profile_id: profileId,
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

function setClientCookie(res, token) {
  res.cookie('client_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

const PUBLIC_PROFILE_FIELDS = `id, cliente, telefono, telefono_normalizado,
  direccion, ciudad, provincia, pais, notas, email`;

function publicIdentityConflict(message = 'La identidad del cliente es ambigua') {
  const error = new Error(message);
  error.code = 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS';
  error.statusCode = 409;
  return error;
}

async function lockPublicIdentity(queryFn, { empresaId, kind, value }) {
  if (kind === 'phone') {
    await lockGeneralPhoneIdentity(queryFn, {
      normalizePhoneFn: normalizePhone,
      telefono: value,
    });
  }
  await queryFn(
    'SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
    [empresaId, `public-client:${kind}:${value}`]
  );
}

function cardinality(rows) {
  if (!rows.length) return { status: 'none', profile: null };
  if (rows.length !== 1) return { status: 'ambiguous', profile: null };
  return { status: 'unique', profile: rows[0] };
}

async function resolveProfileByPhone(queryFn, empresaId, telefonoNorm) {
  if (!telefonoNorm) return { status: 'none', profile: null };
  const rows = await queryFn(
    `SELECT ${PUBLIC_PROFILE_FIELDS}
       FROM puntos_entrega
      WHERE empresa_id = $1
        AND RIGHT(REGEXP_REPLACE(COALESCE(telefono_normalizado, telefono, ''), '\\D', '', 'g'), LENGTH($2)) = $2
      ORDER BY id
      LIMIT 2`,
    [empresaId, telefonoNorm]
  );
  return cardinality(rows);
}

async function resolveProfileByEmail(queryFn, empresaId, email) {
  if (!email) return { status: 'none', profile: null };
  const rows = await queryFn(
    `SELECT ${PUBLIC_PROFILE_FIELDS}
       FROM puntos_entrega
      WHERE empresa_id = $1 AND LOWER(COALESCE(email,'')) = $2
      ORDER BY id
      LIMIT 2`,
    [empresaId, email]
  );
  return cardinality(rows);
}

async function resolveSessionProfile(queryFn, empresaId, payload) {
  const profileId = Number(payload?.profile_id);
  if (Number.isSafeInteger(profileId) && profileId > 0) {
    const rows = await queryFn(
      `SELECT ${PUBLIC_PROFILE_FIELDS}
         FROM puntos_entrega
        WHERE id = $1 AND empresa_id = $2`,
      [profileId, empresaId]
    );
    if (rows.length !== 1) throw publicIdentityConflict('El perfil de la sesión ya no es válido');
    return rows[0];
  }

  const telefonoNorm = normalizePhone(payload?.telefono_norm || payload?.telefono || '');
  const email = String(payload?.email || '').trim().toLowerCase();
  const phoneResolution = await resolveProfileByPhone(queryFn, empresaId, telefonoNorm);
  const emailResolution = await resolveProfileByEmail(queryFn, empresaId, email);
  if (phoneResolution.status === 'ambiguous' || emailResolution.status === 'ambiguous') {
    throw publicIdentityConflict();
  }
  const ids = new Set([phoneResolution.profile?.id, emailResolution.profile?.id].filter(Boolean).map(Number));
  if (ids.size > 1) throw publicIdentityConflict('Teléfono y email corresponden a perfiles diferentes');
  return phoneResolution.profile || emailResolution.profile || null;
}

async function getClientCompaniesByPhone(query, telefonoNorm, empresaId) {
  if (!telefonoNorm) return [];
  const rows = await query(
    `SELECT DISTINCT e.id, e.nombre, e.landing_slug, e.landing_domain
     FROM puntos_entrega pe
     JOIN empresas e ON e.id = pe.empresa_id
     WHERE pe.telefono_normalizado LIKE '%' || $1
       AND e.id = $2
     ORDER BY e.nombre ASC, e.id ASC
     LIMIT 50`,
    [telefonoNorm, empresaId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    nombre: String(row.nombre || `Empresa #${row.id}`),
    landing_slug: row.landing_slug ? String(row.landing_slug) : null,
    landing_domain: row.landing_domain ? String(row.landing_domain) : null,
  }));
}

export function createPublicClientAppRouter({
  query,
  pool,
  withTransaction = defaultWithTransaction,
  resolveEmpresaIdFn = resolvePublicPedidoEmpresaId,
}) {
  if (typeof query !== 'function') throw new Error('createPublicClientAppRouter: falta query(fn)');

  const router = express.Router();
  const runTransaction = pool?.connect && typeof withTransaction === 'function'
    ? (work) => withTransaction(work, { pool, maxRetries: 0 })
    : (work) => work(query);

  function tenantError(code, message, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  function publicFailure(res, error, fallback, { text = false } = {}) {
    const status = Number(error?.statusCode) || 500;
    if (text) return res.status(status).send(status < 500 ? error.message : fallback);
    return res.status(status).json({
      error: status < 500 ? error.message : fallback,
      ...(error?.code ? { code: error.code } : {}),
    });
  }

  async function resolveRequestTenant(req) {
    return resolveEmpresaIdFn(req, query);
  }

  async function resolveSessionTenant(req, payload) {
    const empresaId = await resolveRequestTenant(req);
    const sessionEmpresaId = Number(payload?.empresa_id);
    if (!Number.isSafeInteger(sessionEmpresaId) || sessionEmpresaId <= 0 || sessionEmpresaId !== empresaId) {
      throw tenantError('PUBLIC_TENANT_CONFLICT', 'La sesión no coincide con la empresa pública', 403);
    }
    return empresaId;
  }

  router.get('/auth/providers', (_req, res) => {
    return res.json({
      ok: true,
      google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REDIRECT_URI),
    });
  });

  router.post('/auth/companies', async (req, res) => {
    try {
      const preferredEmpresaId = await resolveRequestTenant(req);
      const telefonoNorm = normalizePhone(req.body?.telefono);
      if (!telefonoNorm) return res.status(400).json({ error: 'telefono inválido' });

      const companies = await getClientCompaniesByPhone(query, telefonoNorm, preferredEmpresaId);

      return res.json({
        ok: true,
        companies,
        preferred_empresa_id: preferredEmpresaId || null,
      });
    } catch (e) {
      console.error('CLIENT COMPANIES LOOKUP ERROR', e);
      return publicFailure(res, e, 'No se pudieron obtener las empresas del cliente');
    }
  });

  router.post('/auth/request-otp', async (req, res) => {
    try {
      const now = Date.now();
      cleanupOtpStore(now);
      cleanupRateMap(otpRate, now);

      const empresaId = await resolveRequestTenant(req);
      const telefonoNorm = normalizePhone(req.body?.telefono);
      if (!telefonoNorm) return res.status(400).json({ error: 'telefono inválido' });

      const identity = await runTransaction(async (txQuery) => {
        await lockPublicIdentity(txQuery, { empresaId, kind: 'phone', value: telefonoNorm });
        const resolved = await resolveProfileByPhone(txQuery, empresaId, telefonoNorm);
        if (resolved.status === 'ambiguous') throw publicIdentityConflict();
        return resolved;
      });

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
      const telefonoOutbox = normalizeWhatsappOutboxPhone(req.body?.telefono);

      otpStore.set(key, {
        codeHash: hashOtp({ key, code }),
        expiresAt: now + OTP_TTL_MS,
        lastSentAt: now,
        tries: 0,
        profileId: identity.profile?.id ? Number(identity.profile.id) : null,
        identityStatus: identity.status,
      });

      if (telefonoOutbox) {
        await enqueueWppOutbox({ empresaId, phone: telefonoOutbox, message: msg }, pool);
      }

      const response = { ok: true, sent: true };
      if (process.env.NODE_ENV !== 'production') response.debug_code = code;
      return res.json(response);
    } catch (e) {
      console.error('CLIENT OTP REQUEST ERROR', e);
      return publicFailure(res, e, 'No se pudo enviar el código');
    }
  });

  router.post('/auth/verify-otp', async (req, res) => {
    try {
      const now = Date.now();
      cleanupOtpStore(now);
      cleanupRateMap(otpVerifyRate, now);

      const empresaId = await resolveRequestTenant(req);
      const telefonoRaw = String(req.body?.telefono || '').trim();
      const telefonoNorm = normalizePhone(telefonoRaw);
      const code = String(req.body?.code || '').trim();

      if (!telefonoNorm || !/^\d{6}$/.test(code)) {
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

      const identity = await runTransaction(async (txQuery) => {
        await lockPublicIdentity(txQuery, { empresaId, kind: 'phone', value: telefonoNorm });
        const resolved = await resolveProfileByPhone(txQuery, empresaId, telefonoNorm);
        if (resolved.status === 'ambiguous') throw publicIdentityConflict();
        const currentProfileId = resolved.profile?.id ? Number(resolved.profile.id) : null;
        if (resolved.status !== otp.identityStatus || currentProfileId !== otp.profileId) {
          throw publicIdentityConflict('La identidad cambió desde que se emitió el código');
        }
        return resolved;
      }).catch((error) => {
        if (error?.code === 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS') otpStore.delete(key);
        throw error;
      });

      otpStore.delete(key);

      const token = signClientToken({
        empresaId,
        profileId: identity.profile?.id ? Number(identity.profile.id) : null,
        telefono: telefonoRaw,
        telefonoNorm,
        amr: 'otp',
        riskFp: buildRiskFingerprint(req),
      });
      setClientCookie(res, token);

      return res.json({ ok: true, profile: identity.profile });
    } catch (e) {
      console.error('CLIENT OTP VERIFY ERROR', e);
      return publicFailure(res, e, 'No se pudo validar el código');
    }
  });

  router.get('/auth/google/start', async (req, res) => {
    try {
      const empresaId = await resolveRequestTenant(req);

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI;
      if (!clientId || !redirectUri) {
        return res.status(400).json({ error: 'Google OAuth no configurado (GOOGLE_CLIENT_ID/GOOGLE_REDIRECT_URI)' });
      }

      cleanupGoogleState();
      const state = randomBytes(24).toString('hex');
      const selector = getCanonicalPublicSelector(req, empresaId);
      if (!selector) return res.status(400).json({ error: 'Selector público inválido' });
      googleStateStore.set(state, {
        empresaId,
        selector,
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
      return publicFailure(res, e, 'No se pudo iniciar login con Google');
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

      const empresaId = await resolveEmpresaIdFn({
        method: 'GET',
        query: { empresa_id: String(stateData.empresaId) },
      }, query);
      const redirectTarget = buildClientAppRedirect(stateData.selector, empresaId);
      if (!redirectTarget) return res.status(401).send('Google login inválido');

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

      const identity = await runTransaction(async (txQuery) => {
        await lockPublicIdentity(txQuery, { empresaId, kind: 'email', value: email });
        const resolved = await resolveProfileByEmail(txQuery, empresaId, email);
        if (resolved.status === 'ambiguous') throw publicIdentityConflict();
        return resolved;
      });

      let profile = identity.profile;
      if (!profile) {
        // No crear un punto incompleto: la identidad canónica requiere teléfono + dirección.
        // El endpoint /profile lo crea bajo el namespace bloqueado cuando el usuario completa ambos.
        profile = {
          id: null,
          cliente: nombre || email.split('@')[0],
          telefono: null,
          telefono_normalizado: null,
          direccion: null,
          ciudad: null,
          provincia: null,
          pais: null,
          notas: null,
          email,
        };
      }

      const telefono = String(profile?.telefono || '').trim();
      const telefonoNorm = normalizePhone(profile?.telefono_normalizado || profile?.telefono || '00000000');

      const token = signClientToken({
        empresaId,
        profileId: profile?.id ? Number(profile.id) : null,
        telefono: telefono || email,
        telefonoNorm: telefonoNorm || `mail-${createHash('sha256').update(email).digest('hex').slice(0, 10)}`,
        email,
        amr: 'google',
        riskFp: buildRiskFingerprint(req),
      });
      setClientCookie(res, token);

      return res.redirect(redirectTarget);
    } catch (e) {
      console.error('CLIENT GOOGLE CALLBACK ERROR', e);
      return publicFailure(res, e, 'Error en login con Google', { text: true });
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
      const empresaId = await resolveSessionTenant(req, payload);
      const cliente = String(req.body?.cliente || '').trim();
      const direccion = String(req.body?.direccion || '').trim();
      const ciudad = String(req.body?.ciudad || '').trim() || null;
      const notas = String(req.body?.notas || '').trim() || null;
      const telefonoIn = String(req.body?.telefono || payload.telefono || '').trim();
      const email = String(req.body?.email || payload.email || '').trim().toLowerCase() || null;

      if (!cliente || !direccion) return res.status(400).json({ error: 'cliente y direccion son requeridos' });

      const telefonoNorm = normalizePhone(telefonoIn);
      if (!telefonoNorm) return res.status(400).json({ error: 'telefono inválido' });

      const profile = await runTransaction(async (txQuery) => {
        const sessionProfileId = Number(payload.profile_id);
        const hasSessionProfileId = Number.isSafeInteger(sessionProfileId) && sessionProfileId > 0;
        const candidateRows = hasSessionProfileId
          ? await txQuery(
              `SELECT id, empresa_id, cliente, nombre, telefono, telefono_normalizado, direccion,
                      ciudad, provincia, pais, notas, email, zona_id
                 FROM puntos_entrega
                WHERE id = $1 AND empresa_id = $2`,
              [sessionProfileId, empresaId]
            )
          : await txQuery(
              `SELECT id, empresa_id, cliente, nombre, telefono, telefono_normalizado, direccion,
                      ciudad, provincia, pais, notas, email, zona_id
                 FROM puntos_entrega
                WHERE empresa_id = $1
                  AND (
                    RIGHT(REGEXP_REPLACE(COALESCE(telefono_normalizado, telefono, ''), '\\D', '', 'g'), 7) = $2
                    OR ($3::text IS NOT NULL AND LOWER(COALESCE(email,'')) = $3)
                  )
                ORDER BY id
                LIMIT 2`,
              [empresaId, telefonoNorm.slice(-7), email]
            );
        if (candidateRows.length > 1) throw deliveryPointConflict('Perfil de cliente ambiguo');
        if (hasSessionProfileId && candidateRows.length !== 1) {
          throw deliveryPointConflict('El perfil de la sesión ya no es válido');
        }

        const candidate = candidateRows[0] || null;
        const oldIdentity = deliveryPointIdentityFromRow(normalizePhone, candidate);
        const newIdentity = deliveryPointIdentity({
          normalizePhoneFn: normalizePhone,
          telefono: telefonoIn,
          direccion,
        });
        if (!newIdentity) throw deliveryPointConflict('Teléfono o dirección inválidos para identificar el punto');

        await lockDeliveryPointIdentities(txQuery, {
          empresaId,
          identities: [oldIdentity, newIdentity],
        });
        if (email) {
          await lockPublicIdentity(txQuery, { empresaId, kind: 'email', value: email });
          const emailResolution = await resolveProfileByEmail(txQuery, empresaId, email);
          if (emailResolution.status === 'ambiguous') throw deliveryPointConflict('Email de cliente ambiguo');
          if (emailResolution.status === 'unique'
              && Number(emailResolution.profile.id) !== Number(candidate?.id || 0)) {
            throw deliveryPointConflict('El email quedó asociado a otro perfil');
          }
        }

        let lockedCandidate = null;
        if (candidate) {
          const lockedRows = await txQuery(
            `SELECT id, empresa_id, cliente, nombre, telefono, telefono_normalizado, direccion,
                    ciudad, provincia, pais, notas, email, zona_id
               FROM puntos_entrega
              WHERE id = $1 AND empresa_id = $2
              FOR UPDATE`,
            [candidate.id, empresaId]
          );
          if (lockedRows.length !== 1) throw deliveryPointConflict('El perfil cambió durante la actualización');
          lockedCandidate = lockedRows[0];
          const lockedIdentity = deliveryPointIdentityFromRow(normalizePhone, lockedCandidate);
          if ((oldIdentity || lockedIdentity) && !sameDeliveryPointIdentity(oldIdentity, lockedIdentity)) {
            throw deliveryPointConflict('El perfil cambió durante la actualización');
          }
        }

        const conflicts = await findDeliveryPointsByIdentity(txQuery, {
          empresaId,
          identity: newIdentity,
          excludeId: lockedCandidate?.id || null,
        });
        if (conflicts.length > 1 || (conflicts.length === 1 && lockedCandidate)) {
          throw deliveryPointConflict('Ya existe otro punto con ese teléfono y dirección');
        }

        const target = lockedCandidate || conflicts[0] || null;
        if (target) {
          const upd = await txQuery(
            `UPDATE puntos_entrega
                SET cliente=$1, nombre=$2, direccion=$3, ciudad=$4, notas=$5,
                    telefono=$6, telefono_normalizado=$7, email=COALESCE($8, email)
              WHERE id=$9 AND empresa_id=$10
              RETURNING id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, notas, email`,
            [cliente, cliente, direccion, ciudad, notas, telefonoIn, telefonoNorm, email, target.id, empresaId]
          );
          if (upd.length !== 1) throw deliveryPointConflict('No se pudo actualizar exactamente un punto');
          return upd[0];
        }

        const ins = await txQuery(
          `INSERT INTO puntos_entrega (empresa_id, cliente, nombre, direccion, ciudad, telefono, telefono_normalizado, notas, email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, cliente, telefono, telefono_normalizado, direccion, ciudad, provincia, pais, notas, email`,
          [empresaId, cliente, cliente, direccion, ciudad, telefonoIn, telefonoNorm, notas, email]
        );
        if (ins.length !== 1) throw deliveryPointConflict('No se pudo crear exactamente un punto');
        return ins[0];
      });

      const newToken = signClientToken({
        empresaId,
        profileId: Number(profile.id),
        telefono: telefonoIn,
        telefonoNorm,
        email,
        amr: payload.amr || 'otp',
        riskFp: buildRiskFingerprint(req),
      });
      setClientCookie(res, newToken);

      return res.json({ ok: true, profile });
    } catch (e) {
      if (e?.code === 'DELIVERY_POINT_IDENTITY_CONFLICT') {
        return res.status(409).json({ error: e.message, code: e.code });
      }
      if (e?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
        return res.status(503).json({
          error: 'No se pudo confirmar el guardado del perfil',
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
        });
      }
      console.error('CLIENT APP /profile ERROR', e);
      return publicFailure(res, e, 'No se pudo guardar perfil');
    }
  });

  router.get('/orders', async (req, res) => {
    try {
      const session = getClientFromRequest(req, { strictRisk: true });
      if (!session.payload) {
        if (session.needsRevalidation) {
          return res.status(401).json({ error: 'Revalidación requerida por cambio de dispositivo/red', revalidate_required: true });
        }
        return res.status(401).json({ error: 'No autenticado' });
      }

      const payload = session.payload;
      const empresaId = await resolveSessionTenant(req, payload);
      const profile = await resolveSessionProfile(query, empresaId, payload);
      if (!profile) return res.json({ ok: true, orders: [] });

      const orders = await query(
        `SELECT p.id, p.fecha, p.estado, p.metodo_pago, p.monto, p.tracking_token,
                pe.cliente, pe.direccion
         FROM pedidos p
         JOIN puntos_entrega pe
           ON pe.id = p.punto_entrega_id
          AND pe.empresa_id = p.empresa_id
         WHERE p.empresa_id = $1
           AND pe.empresa_id = $1
           AND p.punto_entrega_id = $2
         ORDER BY p.fecha DESC, p.id DESC
         LIMIT 30`,
        [empresaId, Number(profile.id)]
      );

      return res.json({ ok: true, orders });
    } catch (e) {
      console.error('CLIENT APP /orders ERROR', e);
      return publicFailure(res, e, 'No se pudo obtener historial');
    }
  });

  router.get('/orders/:id/items', async (req, res) => {
    try {
      const session = getClientFromRequest(req, { strictRisk: true });
      if (!session.payload) {
        if (session.needsRevalidation) {
          return res.status(401).json({ error: 'Revalidación requerida por cambio de dispositivo/red', revalidate_required: true });
        }
        return res.status(401).json({ error: 'No autenticado' });
      }

      const payload = session.payload;
      const empresaId = await resolveSessionTenant(req, payload);
      const profile = await resolveSessionProfile(query, empresaId, payload);
      const pedidoId = Number(req.params.id || 0);
      if (!pedidoId) return res.status(400).json({ error: 'id inválido' });
      if (!profile) return res.status(404).json({ error: 'Pedido no encontrado' });

      const owns = await query(
        `SELECT p.id
         FROM pedidos p
         JOIN puntos_entrega pe
           ON pe.id = p.punto_entrega_id
          AND pe.empresa_id = p.empresa_id
         WHERE p.id = $1
           AND p.empresa_id = $2
           AND pe.empresa_id = $2
           AND p.punto_entrega_id = $3
         LIMIT 1`,
        [pedidoId, empresaId, Number(profile.id)]
      );

      if (!owns.length) return res.status(404).json({ error: 'Pedido no encontrado' });

      const items = await query(
        `SELECT producto, producto_id, cantidad, precio_unitario
         FROM items_pedido
         WHERE pedido_id = $1
         ORDER BY id ASC`,
        [pedidoId]
      );

      return res.json({ ok: true, items });
    } catch (e) {
      console.error('CLIENT APP /orders/:id/items ERROR', e);
      return publicFailure(res, e, 'No se pudo obtener detalle del pedido');
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
      const empresaId = await resolveSessionTenant(req, payload);
      const profile = await resolveSessionProfile(query, empresaId, payload);

      return res.json({
        ok: true,
        session: {
          empresa_id: empresaId,
          telefono: payload.telefono,
          telefono_norm: payload.telefono_norm,
          amr: payload.amr || 'otp',
        },
        profile: profile || null,
      });
    } catch (e) {
      console.error('CLIENT APP /me ERROR', e);
      return publicFailure(res, e, 'Error obteniendo sesión');
    }
  });

  return router;
}
