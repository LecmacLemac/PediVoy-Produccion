// src/routes/authGuestSignup.js
// Extraído desde server.js para reducir el monolito.

import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const SIGNUP_WINDOW_MS = Number(process.env.SIGNUP_RATE_WINDOW_MS || 60 * 60 * 1000);
const SIGNUP_MAX_ATTEMPTS = Number(process.env.SIGNUP_RATE_MAX || 8);
const signupAttempts = new Map();

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;
const PHONE_RE = /^[0-9+\-\s()]{8,20}$/;

function getClientIp(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function hitRateLimit(map, key, windowMs, max) {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (!v || now - v.start > windowMs) map.delete(k);
  }
  const cur = map.get(key);
  if (!cur || now - cur.start > windowMs) {
    map.set(key, { count: 1, start: now });
    return false;
  }
  cur.count += 1;
  map.set(key, cur);
  return cur.count > max;
}

export function createAuthGuestSignupRouter(deps) {
  const { query, withAuth, pool } = deps || {};
  if (typeof query !== 'function') throw new Error('createAuthGuestSignupRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAuthGuestSignupRouter: falta withAuth(fn)');
  if (!pool || typeof pool.connect !== 'function') throw new Error('createAuthGuestSignupRouter: falta pool.connect(fn)');

  const router = express.Router();

  // ==================================================
  // LÓGICA DE USUARIOS EFÍMEROS (OPCIÓN A)
  // ==================================================

  // POST /api/auth/guest
  router.post('/guest', async (req, res) => {
    try {
      const ip = getClientIp(req);
      const rateKey = `guest:ip:${ip}`;
      if (hitRateLimit(signupAttempts, rateKey, SIGNUP_WINDOW_MS, SIGNUP_MAX_ATTEMPTS * 2)) {
        return res.status(429).json({ error: 'Demasiados intentos. Reintentá más tarde.' });
      }

      const empresa_id = Number(req.body?.empresa_id) || 1;
      const randomSuffix = crypto.randomBytes(4).toString('hex');
      const tempUsername = `guest_${Date.now()}_${randomSuffix}`;

      const result = await query(
        `INSERT INTO usuarios (username, password, role, empresa_id, es_invitado, fecha_expiracion)
         VALUES ($1, NULL, 'guest', $2, TRUE, NOW() + INTERVAL '2 hours')
         RETURNING id, username, role, empresa_id`,
        [tempUsername, empresa_id]
      );

      const user = result[0];

      const token = jwt.sign(
        {
          uid: user.id,
          username: user.username,
          empresa_id: user.empresa_id,
          role: 'guest',
        },
        process.env.JWT_SECRET || 'dev',
        { expiresIn: '2h' }
      );

      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 2 * 60 * 60 * 1000,
      });

      const includeToken = String(req.query?.includeToken || req.headers['x-include-token'] || '') === '1';
      if (includeToken) return res.json({ ok: true, token, user });
      return res.json({ ok: true, user });
    } catch (e) {
      console.error('ERROR GUEST:', e);
      return res.status(500).json({ error: 'Error creando sesión de invitado' });
    }
  });

  // POST /api/auth/register
  router.post('/register', withAuth, async (req, res) => {
    try {
      const { username, password, telefono } = req.body || {};
      const userId = req.user.uid; // token actual

      if (!username || !password) return res.status(400).json({ error: 'Datos incompletos' });
      if (!USERNAME_RE.test(String(username))) return res.status(400).json({ error: 'Usuario inválido' });
      if (String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      if (telefono && !PHONE_RE.test(String(telefono))) return res.status(400).json({ error: 'Teléfono inválido' });

      const check = await query('SELECT es_invitado FROM usuarios WHERE id=$1', [userId]);
      if (!check.length || !check[0].es_invitado) {
        return res.status(400).json({ error: 'Este usuario ya está registrado o no existe.' });
      }

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(String(password), salt);

      await query(
        `UPDATE usuarios
         SET username = $1,
             password = $2,
             telefono = $3,
             es_invitado = FALSE,
             fecha_expiracion = NULL,
             role = 'user'
         WHERE id = $4`,
        [username, hash, telefono || null, userId]
      );

      const newToken = jwt.sign(
        { uid: userId, username, empresa_id: req.user.empresa_id, role: 'user' },
        process.env.JWT_SECRET || 'dev',
        { expiresIn: '7d' }
      );

      res.cookie('token', newToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const includeToken = String(req.query?.includeToken || req.headers['x-include-token'] || '') === '1';
      if (includeToken) return res.json({ ok: true, message: 'Cuenta creada con éxito', token: newToken });
      return res.json({ ok: true, message: 'Cuenta creada con éxito' });
    } catch (e) {
      if (e?.message?.includes('unique')) return res.status(400).json({ error: 'El email ya está en uso' });
      console.error('REGISTER ERROR:', e);
      return res.status(500).json({ error: 'Error en registro' });
    }
  });

  // ==================================================
  // REGISTRO "PRO" (Usuario + Nueva Empresa + Trial)
  // ==================================================

  // POST /api/auth/signup-full
  router.post('/signup-full', async (req, res) => {
    try {
      const { username, password, telefono, email, empresa_nombre, rubro } = req.body || {};

      const ip = getClientIp(req);
      const rateKey = `ip:${ip}`;
      if (hitRateLimit(signupAttempts, rateKey, SIGNUP_WINDOW_MS, SIGNUP_MAX_ATTEMPTS)) {
        return res.status(429).json({ error: 'Demasiados intentos de registro. Reintentá más tarde.' });
      }

      if (!username || !password || !empresa_nombre) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
      }
      if (!USERNAME_RE.test(String(username))) {
        return res.status(400).json({ error: 'Usuario inválido' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      }
      if (telefono && !PHONE_RE.test(String(telefono))) {
        return res.status(400).json({ error: 'Teléfono inválido' });
      }

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(String(password), salt);

      const slug =
        String(empresa_nombre)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '-') +
        '-' +
        Date.now().toString().slice(-4);

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const empRes = await client.query(
          `INSERT INTO empresas (
              nombre, telefono, email, rubro, landing_slug,
              plan_estado, plan_tipo, plan_vencimiento, setup_steps
           )
           VALUES ($1, $2, $3, $4, $5, 'active', 'trial', NOW() + INTERVAL '30 days', '{}')
           RETURNING id`,
          [empresa_nombre, telefono, email, rubro || 'general', slug]
        );

        const newEmpresaId = empRes.rows[0].id;

        const userRes = await client.query(
          `INSERT INTO usuarios (username, password, role, empresa_id, telefono)
           VALUES ($1, $2, 'user', $3, $4)
           RETURNING id, username, role, empresa_id`,
          [username, hash, newEmpresaId, telefono]
        );

        const newUser = userRes.rows[0];

        await client.query('COMMIT');

        const token = jwt.sign(
          {
            uid: newUser.id,
            username: newUser.username,
            empresa_id: newUser.empresa_id,
            role: newUser.role,
          },
          process.env.JWT_SECRET || 'dev',
          { expiresIn: '7d' }
        );

        // Set cookie httpOnly (modo seguro)
        res.cookie('token', token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        // Por defecto NO devolvemos el token en JSON.
        // Compat opcional: ?includeToken=1 o header x-include-token: 1
        const includeToken = String(req.query?.includeToken || req.headers['x-include-token'] || '') === '1';
        // Registro correcto: limpiamos bucket de rate-limit para este IP
        signupAttempts.delete(rateKey);

        if (includeToken) {
          return res.json({ ok: true, token, user: newUser, message: '¡Empresa creada con éxito!' });
        }

        return res.json({ ok: true, user: newUser, message: '¡Empresa creada con éxito!' });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('ROLLBACK SIGNUP:', err);
        if (err?.message?.includes('users_username_key') || err?.message?.includes('unique')) {
          return res.status(400).json({ error: 'El usuario o empresa ya existen.' });
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('SIGNUP ERROR:', e);
      return res.status(500).json({ error: 'Error interno al crear cuenta.' });
    }
  });

  return router;
}
