// src/routes/adminUsuarios.js
// Admin: gestión de usuarios + utilidades (extraído desde server.js)

import express from 'express';
import bcrypt from 'bcryptjs';
import { withTransaction as dbWithTransaction } from '../db.js';

const OPERATIONAL_ROLES = new Set(['user', 'repartidor', 'referente', 'facturacion', 'contable']);
const MANAGED_ROLES = new Set(['admin', 'super', ...OPERATIONAL_ROLES]);
const PRIVILEGED_ROLES = new Set(['admin', 'super']);

function normalizeRoleInput(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalStoredRole(value) {
  return typeof value === 'string' && MANAGED_ROLES.has(value) ? value : null;
}

function positiveInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function pgErrorResponse(error, fallbackMessage) {
  if (error?.code === '23505') return { status: 400, payload: { error: 'Username en uso' } };
  if (error?.code === '23503') return { status: 409, payload: { error: 'Referencia inválida' } };
  return { status: 500, payload: { error: fallbackMessage } };
}

function sendResult(res, result) {
  return res.status(result.status || 200).json(result.payload);
}

export function createAdminUsuariosRouter(deps) {
  const {
    query,
    withTransaction = dbWithTransaction,
    withAuth,
  } = deps || {};
  if (typeof query !== 'function') throw new Error('createAdminUsuariosRouter: falta query(fn)');
  if (typeof withTransaction !== 'function') throw new Error('createAdminUsuariosRouter: falta withTransaction(fn)');
  if (typeof withAuth !== 'function') throw new Error('createAdminUsuariosRouter: falta withAuth(fn)');

  const router = express.Router();

  function requireUserToken(req, res, next) {
    const type = req.user?.type;
    if ((type && type !== 'user') || positiveInteger(req.user?.uid) === null) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    return next();
  }

  async function loadEffectiveActor(txQuery, req) {
    const actorId = positiveInteger(req.user?.uid);
    const rows = await txQuery(
      `SELECT id, role, empresa_id, activo
         FROM usuarios
        WHERE id=$1
        FOR SHARE`,
      [actorId],
    );
    const row = rows[0];
    if (!row || row.activo !== true) return null;

    const role = canonicalStoredRole(row.role);
    if (!PRIVILEGED_ROLES.has(role)) return null;

    const empresaId = positiveInteger(row.empresa_id);
    if (role === 'admin' && empresaId === null) return null;
    return { id: positiveInteger(row.id), role, empresaId };
  }

  async function lockEmpresa(txQuery, empresaId) {
    const rows = await txQuery(
      'SELECT id FROM empresas WHERE id=$1 FOR KEY SHARE',
      [empresaId],
    );
    return rows.length === 1;
  }

  async function validateRoleLinks(txQuery, role, empresaId, rawChoferId, rawReferenteId) {
    const hasChofer = rawChoferId !== undefined && rawChoferId !== null;
    const hasReferente = rawReferenteId !== undefined && rawReferenteId !== null;

    if (role !== 'repartidor' && hasChofer) return { error: 'chofer_id incompatible con el rol' };
    if (role !== 'referente' && hasReferente) return { error: 'referente_id incompatible con el rol' };

    let choferId = null;
    if (hasChofer) {
      choferId = positiveInteger(rawChoferId);
      if (choferId === null) return { error: 'Chofer inválido' };
      const rows = await txQuery(
        `SELECT id FROM choferes
          WHERE id=$1 AND empresa_id=$2 AND activo IS TRUE
          FOR SHARE`,
        [choferId, empresaId],
      );
      if (rows.length !== 1) return { error: 'Chofer inválido' };
    }

    let referenteId = null;
    if (hasReferente) {
      referenteId = positiveInteger(rawReferenteId);
      if (referenteId === null) return { error: 'Referente inválido' };
      const rows = await txQuery(
        `SELECT id FROM referentes
          WHERE id=$1 AND empresa_id=$2
            AND activo IS TRUE AND deleted_at IS NULL
          FOR SHARE`,
        [referenteId, empresaId],
      );
      if (rows.length !== 1) return { error: 'Referente inválido' };
    }

    return { choferId, referenteId };
  }

  async function lockTarget(txQuery, actor, userId) {
    const params = [userId];
    let sql = `SELECT id, role, empresa_id, chofer_id, referente_id
                 FROM usuarios
                WHERE id=$1`;
    if (actor.role === 'admin') {
      sql += ' AND empresa_id=$2';
      params.push(actor.empresaId);
    }
    sql += ' FOR UPDATE';
    const rows = await txQuery(sql, params);
    return rows[0] || null;
  }

  router.use('/usuarios', withAuth, requireUserToken);

  router.post('/usuarios', async (req, res) => {
    try {
      const result = await withTransaction(async txQuery => {
        const actor = await loadEffectiveActor(txQuery, req);
        if (!actor) return { status: 403, payload: { error: 'No autorizado' } };

        const body = req.body || {};
        const { username, password, empresa_id, chofer_id, referente_id, activo } = body;
        const cleanUser = String(username || '').trim();
        const role = normalizeRoleInput(body.role || 'user');

        if (!cleanUser) return { status: 400, payload: { error: 'Falta username' } };
        if (!password || String(password).length < 6) return { status: 400, payload: { error: 'Clave min 6 chars' } };
        if (!MANAGED_ROLES.has(role)) return { status: 400, payload: { error: 'Rol inválido' } };
        if (activo !== undefined && typeof activo !== 'boolean') {
          return { status: 400, payload: { error: 'activo debe ser booleano' } };
        }
        if (actor.role === 'admin' && !OPERATIONAL_ROLES.has(role)) {
          return { status: 403, payload: { error: 'Solo super gestiona roles administrativos' } };
        }
        if (role === 'super' && empresa_id !== undefined && empresa_id !== null && empresa_id !== '') {
          return { status: 400, payload: { error: 'Super no pertenece a una empresa' } };
        }

        let targetEmpresa = null;
        if (role !== 'super') {
          targetEmpresa = actor.role === 'super' ? positiveInteger(empresa_id) : actor.empresaId;
          if (targetEmpresa === null || !(await lockEmpresa(txQuery, targetEmpresa))) {
            return { status: 400, payload: { error: 'Empresa inválida' } };
          }
        }

        const links = await validateRoleLinks(txQuery, role, targetEmpresa, chofer_id, referente_id);
        if (links.error) return { status: 400, payload: { error: links.error } };

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(String(password), salt);
        const rows = await txQuery(
          `INSERT INTO usuarios (username, password, role, empresa_id, chofer_id, referente_id, activo)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
           RETURNING id, username`,
          [cleanUser, hash, role, targetEmpresa, links.choferId, links.referenteId, activo ?? null],
        );
        if (rows.length !== 1) return { status: 409, payload: { error: 'No se pudo crear el usuario' } };
        return { status: 200, payload: rows[0] };
      });
      return sendResult(res, result);
    } catch (error) {
      return sendResult(res, pgErrorResponse(error, 'Error interno'));
    }
  });

  router.get('/usuarios', async (req, res) => {
    try {
      const result = await withTransaction(async txQuery => {
        const actor = await loadEffectiveActor(txQuery, req);
        if (!actor) return { status: 403, payload: { error: 'No autorizado' } };

        let empresaId = null;
        if (actor.role === 'super') {
          if (req.query?.empresa_id !== undefined && req.query.empresa_id !== '') {
            empresaId = positiveInteger(req.query.empresa_id);
            if (empresaId === null) return { status: 400, payload: { error: 'Empresa inválida' } };
          }
        } else {
          empresaId = actor.empresaId;
        }

        let sql = 'SELECT id, username, role, empresa_id, chofer_id, referente_id, COALESCE(activo, TRUE) AS activo, last_login_at FROM usuarios';
        const params = [];
        if (empresaId !== null) {
          sql += ' WHERE empresa_id=$1';
          params.push(empresaId);
        }
        sql += ' ORDER BY id ASC';
        return { status: 200, payload: await txQuery(sql, params) };
      });
      return sendResult(res, result);
    } catch {
      return res.status(500).json({ error: 'Error usuarios' });
    }
  });

  router.put('/usuarios/:id', async (req, res) => {
    try {
      const result = await withTransaction(async (txQuery, client) => {
        const actor = await loadEffectiveActor(txQuery, req);
        if (!actor) return { status: 403, payload: { error: 'No autorizado' } };

        const userId = positiveInteger(req.params.id);
        if (userId === null) return { status: 400, payload: { error: 'Usuario inválido' } };

        const body = req.body || {};
        const { username, password, chofer_id, referente_id, activo } = body;
        if (activo !== undefined && typeof activo !== 'boolean') {
          return { status: 400, payload: { error: 'activo debe ser booleano' } };
        }
        if (password !== undefined
          && String(password).trim().length > 0
          && String(password).length < 6) {
          return { status: 400, payload: { error: 'Clave min 6 chars' } };
        }

        const requestedRole = body.role === undefined ? null : normalizeRoleInput(body.role);
        if (requestedRole !== null && !MANAGED_ROLES.has(requestedRole)) {
          return { status: 400, payload: { error: 'Rol inválido' } };
        }
        if (actor.role === 'admin' && requestedRole !== null && !OPERATIONAL_ROLES.has(requestedRole)) {
          return { status: 403, payload: { error: 'Solo super gestiona roles administrativos' } };
        }
        if (actor.role === 'admin' && body.empresa_id !== undefined
          && positiveInteger(body.empresa_id) !== actor.empresaId) {
          return { status: 403, payload: { error: 'No puede cambiar la empresa' } };
        }

        const target = await lockTarget(txQuery, actor, userId);
        if (!target) return { status: 404, payload: { error: 'Usuario no encontrado' } };
        const targetRole = canonicalStoredRole(target.role);
        if (actor.role === 'admin' && !OPERATIONAL_ROLES.has(targetRole)) {
          return { status: 403, payload: { error: 'Solo super gestiona roles administrativos' } };
        }
        if (targetRole === null && requestedRole === null) {
          return { status: 409, payload: { error: 'Rol actual inválido' } };
        }

        const resultingRole = requestedRole ?? targetRole;
        let requestedEmpresa = body.empresa_id === undefined
          ? positiveInteger(target.empresa_id)
          : positiveInteger(body.empresa_id);
        if (actor.role === 'admin') requestedEmpresa = actor.empresaId;

        if (resultingRole === 'super') {
          if (body.empresa_id !== undefined && body.empresa_id !== null && body.empresa_id !== '') {
            return { status: 400, payload: { error: 'Super no pertenece a una empresa' } };
          }
          requestedEmpresa = null;
        } else if (requestedEmpresa === null || !(await lockEmpresa(txQuery, requestedEmpresa))) {
          return { status: 400, payload: { error: 'Empresa inválida' } };
        }

        const hasChoferField = hasOwn(body, 'chofer_id');
        const hasReferenteField = hasOwn(body, 'referente_id');
        if (resultingRole !== 'repartidor' && hasChoferField && chofer_id !== null) {
          return { status: 400, payload: { error: 'chofer_id incompatible con el rol' } };
        }
        if (resultingRole !== 'referente' && hasReferenteField && referente_id !== null) {
          return { status: 400, payload: { error: 'referente_id incompatible con el rol' } };
        }

        const rawFinalChofer = resultingRole === 'repartidor'
          ? (hasChoferField ? chofer_id : target.chofer_id)
          : null;
        const rawFinalReferente = resultingRole === 'referente'
          ? (hasReferenteField ? referente_id : target.referente_id)
          : null;
        const links = await validateRoleLinks(
          txQuery,
          resultingRole,
          requestedEmpresa,
          rawFinalChofer,
          rawFinalReferente,
        );
        if (links.error) return { status: 400, payload: { error: links.error } };

        const sets = [];
        const values = [];
        let index = 1;
        if (username) {
          sets.push(`username=$${index++}`);
          values.push(username);
        }
        if (password && String(password).trim().length > 0) {
          const salt = await bcrypt.genSalt(10);
          const hash = await bcrypt.hash(String(password), salt);
          sets.push(`password=$${index++}`);
          values.push(hash);
        }
        if (requestedRole !== null) {
          sets.push(`role=$${index++}`);
          values.push(requestedRole);
        }
        const mustSetEmpresa = body.empresa_id !== undefined
          || (requestedRole === 'super' && positiveInteger(target.empresa_id) !== null);
        if (mustSetEmpresa) {
          sets.push(`empresa_id=$${index++}`);
          values.push(requestedEmpresa);
        }
        const currentChofer = positiveInteger(target.chofer_id);
        const currentReferente = positiveInteger(target.referente_id);
        if (hasChoferField || currentChofer !== links.choferId) {
          sets.push(`chofer_id=$${index++}`);
          values.push(links.choferId);
        }
        if (hasReferenteField || currentReferente !== links.referenteId) {
          sets.push(`referente_id=$${index++}`);
          values.push(links.referenteId);
        }
        if (activo !== undefined) {
          sets.push(`activo=$${index++}`);
          values.push(activo);
        }

        if (!sets.length) return { status: 200, payload: { ok: true } };

        values.push(userId);
        let sql = `UPDATE usuarios SET ${sets.join(', ')} WHERE id=$${index++}`;
        if (actor.role === 'admin') {
          sql += ` AND empresa_id=$${index++} AND role NOT IN ('admin', 'super')`;
          values.push(actor.empresaId);
        } else {
          sql += ` AND empresa_id IS NOT DISTINCT FROM $${index++}`;
          values.push(positiveInteger(target.empresa_id));
        }
        sql += ' RETURNING id';
        const writeResult = await client.query(sql, values);
        if (writeResult.rowCount === 0) return { status: 404, payload: { error: 'Usuario no encontrado' } };
        if (writeResult.rowCount !== 1 || writeResult.rows?.length !== 1) {
          return { status: 409, payload: { error: 'Actualización concurrente' } };
        }
        return { status: 200, payload: { ok: true } };
      });
      return sendResult(res, result);
    } catch (error) {
      return sendResult(res, pgErrorResponse(error, 'Error actualizando usuario'));
    }
  });

  router.delete('/usuarios/:id', async (req, res) => {
    try {
      const result = await withTransaction(async (txQuery, client) => {
        const actor = await loadEffectiveActor(txQuery, req);
        if (!actor) return { status: 403, payload: { error: 'No autorizado' } };

        const userId = positiveInteger(req.params.id);
        if (userId === null) return { status: 400, payload: { error: 'Usuario inválido' } };
        const target = await lockTarget(txQuery, actor, userId);
        if (!target) return { status: 404, payload: { error: 'Usuario no encontrado' } };
        if (actor.role === 'admin' && !OPERATIONAL_ROLES.has(canonicalStoredRole(target.role))) {
          return { status: 403, payload: { error: 'Solo super gestiona roles administrativos' } };
        }

        const params = [userId];
        let sql = 'DELETE FROM usuarios WHERE id=$1';
        if (actor.role === 'admin') {
          sql += " AND empresa_id=$2 AND role NOT IN ('admin', 'super')";
          params.push(actor.empresaId);
        }
        sql += ' RETURNING id';
        const writeResult = await client.query(sql, params);
        if (writeResult.rowCount === 0) return { status: 404, payload: { error: 'Usuario no encontrado' } };
        if (writeResult.rowCount !== 1 || writeResult.rows?.length !== 1) {
          return { status: 409, payload: { error: 'Borrado concurrente' } };
        }
        return { status: 200, payload: { ok: true } };
      });
      return sendResult(res, result);
    } catch (error) {
      return sendResult(res, pgErrorResponse(error, 'Error borrando usuario'));
    }
  });

  // GET /api/admin/empresas-list (solo super); fuera del alcance de /usuarios.
  router.get('/empresas-list', withAuth, requireUserToken, async (req, res) => {
    try {
      const result = await withTransaction(async txQuery => {
        const actor = await loadEffectiveActor(txQuery, req);
        if (!actor || actor.role !== 'super') {
          return { status: 403, payload: { error: 'No autorizado' } };
        }
        const empresas = await txQuery('SELECT id, nombre FROM empresas ORDER BY id ASC');
        return { status: 200, payload: empresas };
      });
      return sendResult(res, result);
    } catch {
      return res.status(500).json({ error: 'Error al listar empresas' });
    }
  });

  return router;
}
