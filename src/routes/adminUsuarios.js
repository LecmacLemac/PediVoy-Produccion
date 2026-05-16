// src/routes/adminUsuarios.js
// Admin: gestión de usuarios + utilidades (extraído desde server.js)

import express from 'express';
import bcrypt from 'bcryptjs';

export function createAdminUsuariosRouter(deps) {
  const { query, withAuth, isSuper, getEmpresaIdFromToken } = deps || {};
  if (typeof query !== 'function') throw new Error('createAdminUsuariosRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAdminUsuariosRouter: falta withAuth(fn)');
  if (typeof isSuper !== 'function') throw new Error('createAdminUsuariosRouter: falta isSuper(fn)');
  if (typeof getEmpresaIdFromToken !== 'function') throw new Error('createAdminUsuariosRouter: falta getEmpresaIdFromToken(fn)');

  const router = express.Router();

  // POST /api/admin/usuarios
  router.post('/usuarios', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const { username, password, role, empresa_id, chofer_id } = req.body || {};
      const cleanUser = String(username || '').trim();
      if (!cleanUser) return res.status(400).json({ error: 'Falta username' });
      if (!password || String(password).length < 6) return res.status(400).json({ error: 'Clave min 6 chars' });

      let targetEmpresa = null;
      if (role === 'super') {
        if (!esSuperAdmin) return res.status(403).json({ error: 'Solo super crea super' });
      } else if (esSuperAdmin) {
        targetEmpresa = Number(empresa_id);
      } else {
        targetEmpresa = getEmpresaIdFromToken(req);
      }

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(String(password), salt);

      const rows = await query(
        `INSERT INTO usuarios (username, password, role, empresa_id, chofer_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username`,
        [cleanUser, hash, role || 'user', targetEmpresa, chofer_id || null]
      );

      return res.json(rows[0]);
    } catch (e) {
      if (e?.message?.includes('unique')) return res.status(400).json({ error: 'Username en uso' });
      return res.status(500).json({ error: 'Error interno' });
    }
  });

  // GET /api/admin/usuarios
  router.get('/usuarios', withAuth, async (req, res) => {
    try {
      const esSuperAdmin = isSuper(req);
      const empresaId = esSuperAdmin ? Number(req.query?.empresa_id) || null : getEmpresaIdFromToken(req);

      let sql = `SELECT id, username, role, empresa_id, chofer_id FROM usuarios`;
      const params = [];
      if (empresaId) {
        sql += ` WHERE empresa_id=$1`;
        params.push(empresaId);
      }
      sql += ` ORDER BY id ASC`;

      const rows = await query(sql, params);
      return res.json(rows);
    } catch {
      return res.status(500).json({ error: 'Error usuarios' });
    }
  });

  // PUT /api/admin/usuarios/:id (solo superadmin)
  router.put('/usuarios/:id', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo superadmin' });

    try {
      const { username, password, role, empresa_id, chofer_id } = req.body || {};
      const sets = [];
      const vals = [];
      let idx = 1;

      if (username) {
        sets.push(`username=$${idx++}`);
        vals.push(username);
      }
      if (password && String(password).trim().length > 0) {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(String(password), salt);
        sets.push(`password=$${idx++}`);
        vals.push(hash);
      }
      if (role) {
        sets.push(`role=$${idx++}`);
        vals.push(role);
      }
      if (empresa_id !== undefined) {
        sets.push(`empresa_id=$${idx++}`);
        vals.push(Number(empresa_id) || null);
      }
      if (chofer_id !== undefined) {
        sets.push(`chofer_id=$${idx++}`);
        vals.push(Number(chofer_id) || null);
      }

      if (!sets.length) return res.json({ ok: true });

      vals.push(req.params.id);
      await query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error actualizando usuario' });
    }
  });

  // DELETE /api/admin/usuarios/:id (solo super)
  router.delete('/usuarios/:id', withAuth, async (req, res) => {
    if (!isSuper(req)) return res.status(403).json({ error: 'Solo super' });

    try {
      await query(`DELETE FROM usuarios WHERE id=$1`, [req.params.id]);
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'Error borrando usuario' });
    }
  });

  // GET /api/admin/empresas-list (solo super)
  router.get('/empresas-list', withAuth, async (req, res) => {
    if (req.user.role !== 'super') return res.sendStatus(403);

    try {
      const empresas = await query('SELECT id, nombre FROM empresas ORDER BY id ASC');
      return res.json(empresas);
    } catch {
      return res.status(500).json({ error: 'Error al listar empresas' });
    }
  });

  return router;
}
