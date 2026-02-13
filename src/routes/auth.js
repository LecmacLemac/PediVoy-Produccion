// src/routes/auth.js
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';

export function createAuthRouter() {
  const router = express.Router();

  // GET /api/me
  router.get('/me', (req, res) => {
    try {
      let token = null;
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) token = h.slice(7);
      if (!token && req.cookies?.token) token = req.cookies.token;
      if (!token) return res.status(401).json({ error: 'No token' });

      const user = jwt.verify(token, process.env.JWT_SECRET || 'dev');
      res.json({ user });
    } catch {
      res.status(401).json({ error: 'Token inválido' });
    }
  });

  // POST /api/login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });

      const rows = await query(
        `SELECT u.id, u.username, u.password, u.role, u.empresa_id, u.chofer_id,
                e.plan_estado, e.plan_vencimiento
         FROM usuarios u
         LEFT JOIN empresas e ON u.empresa_id = e.id
         WHERE u.username = $1 LIMIT 1`,
        [username]
      );

      if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });
      const user = rows[0];

      if (user.role !== 'super' && user.plan_estado === 'expired') {
        return res.status(402).json({
          error: '⛔ Tu licencia ha vencido. Realiza el pago para reactivar el servicio.'
        });
      }

      const match = await bcrypt.compare(String(password), String(user.password));
      if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

      const token = jwt.sign(
        {
          uid: user.id,
          username: user.username,
          empresa_id: user.empresa_id,
          role: user.role,
          chofer_id: user.chofer_id ?? null
        },
        process.env.JWT_SECRET || 'dev',
        { expiresIn: '8h' }
      );

      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 8 * 60 * 60 * 1000
      });

      res.json({ token });
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
