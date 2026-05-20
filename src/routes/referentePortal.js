import express from 'express';
import bcrypt from 'bcryptjs';

function cleanText(value, max = 280) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

export function createReferentePortalRouter(deps) {
  const { query, withAuth } = deps || {};
  if (typeof query !== 'function') throw new Error('createReferentePortalRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createReferentePortalRouter: falta withAuth(fn)');

  const router = express.Router();

  function requireReferente(req, res, next) {
    const role = String(req.user?.role || '').toLowerCase();
    const referenteId = Number(req.user?.referente_id || 0);
    const empresaId = Number(req.user?.empresa_id || 0);
    if (role !== 'referente' || !referenteId || !empresaId) {
      return res.status(403).json({ error: 'Acceso exclusivo para referentes.' });
    }
    return next();
  }

  router.use(withAuth, requireReferente);

  router.get('/perfil', async (req, res) => {
    try {
      const rows = await query(
        `SELECT r.id, r.empresa_id, r.nombre, r.telefono, r.email, r.codigo,
                r.porcentaje_comision, r.vigente_desde, r.vigente_hasta,
                r.activo, r.notas, r.created_at, r.updated_at,
                e.nombre AS empresa_nombre
           FROM referentes r
           JOIN empresas e ON e.id = r.empresa_id
          WHERE r.id = $1
            AND r.empresa_id = $2
            AND r.deleted_at IS NULL
          LIMIT 1`,
        [req.user.referente_id, req.user.empresa_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Referente no encontrado.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTE.PORTAL.PERFIL.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo perfil' });
    }
  });

  router.put('/perfil', async (req, res) => {
    try {
      const rows = await query(
        `UPDATE referentes
            SET nombre = COALESCE($3, nombre),
                telefono = $4,
                email = $5,
                notas = $6,
                updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
            AND deleted_at IS NULL
          RETURNING id, empresa_id, nombre, telefono, email, codigo,
                    porcentaje_comision, vigente_desde, vigente_hasta,
                    activo, notas, updated_at`,
        [
          req.user.referente_id,
          req.user.empresa_id,
          cleanText(req.body?.nombre, 120),
          cleanText(req.body?.telefono, 60),
          cleanText(req.body?.email, 180),
          cleanText(req.body?.notas, 500),
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'Referente no encontrado.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTE.PORTAL.PERFIL.UPDATE.ERROR', e);
      return res.status(500).json({ error: 'Error actualizando perfil' });
    }
  });

  router.put('/password', async (req, res) => {
    try {
      const currentPassword = String(req.body?.current_password || '');
      const newPassword = String(req.body?.new_password || '');
      const confirmPassword = String(req.body?.confirm_password || '');

      if (!currentPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Completá clave actual, nueva clave y confirmación.' });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'La nueva clave debe tener al menos 8 caracteres.' });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'La confirmación no coincide con la nueva clave.' });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'La nueva clave debe ser diferente a la actual.' });
      }

      const users = await query(
        `SELECT id, password
           FROM usuarios
          WHERE id = $1
            AND empresa_id = $2
            AND referente_id = $3
            AND LOWER(role) = 'referente'
            AND COALESCE(activo, TRUE) = TRUE
          LIMIT 1`,
        [req.user.uid, req.user.empresa_id, req.user.referente_id]
      );
      if (!users.length) return res.status(404).json({ error: 'Usuario referente no encontrado.' });

      const match = await bcrypt.compare(currentPassword, String(users[0].password || ''));
      if (!match) return res.status(400).json({ error: 'La clave actual no es correcta.' });

      const hash = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
      await query('UPDATE usuarios SET password = $1 WHERE id = $2', [hash, users[0].id]);

      return res.json({ ok: true });
    } catch (e) {
      console.error('REFERENTE.PORTAL.PASSWORD.UPDATE.ERROR', e);
      return res.status(500).json({ error: 'Error actualizando clave' });
    }
  });

  router.get('/resumen', async (req, res) => {
    try {
      const rows = await query(
        `SELECT
           (SELECT COUNT(*)::int
              FROM cliente_referentes
             WHERE empresa_id = $1 AND referente_id = $2 AND estado = 'activo') AS clientes_activos,
           (SELECT COUNT(*)::int
              FROM referente_productos
             WHERE empresa_id = $1 AND referente_id = $2 AND activo = TRUE) AS productos_activos,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado = 'activo') AS pedidos_total,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado = 'activo'
               AND COALESCE(p.fecha_entrega, p.fecha) >= NOW() - INTERVAL '30 days') AS pedidos_30d,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado = 'activo'
               AND p.estado = 'entregado') AS pedidos_entregados,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado = 'activo'
               AND p.estado IN ('pendiente','en_ruta','en_camino')) AS pedidos_activos,
           (SELECT COALESCE(SUM(COALESCE(p.monto,0)),0)::numeric
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado = 'activo'
               AND p.estado = 'entregado') AS ventas_entregadas,
           (SELECT COUNT(*)::int
              FROM referente_comisiones
             WHERE empresa_id = $1 AND referente_id = $2) AS comisiones_count,
           (SELECT COALESCE(SUM(monto_comision),0)::numeric
              FROM referente_comisiones
             WHERE empresa_id = $1 AND referente_id = $2 AND estado IN ('validada','liquidada')) AS comisiones_total,
           (SELECT COALESCE(SUM(monto_comision),0)::numeric
              FROM referente_comisiones
             WHERE empresa_id = $1 AND referente_id = $2 AND estado = 'liquidada') AS comisiones_liquidadas,
           (SELECT COALESCE(SUM(monto_comision),0)::numeric
              FROM referente_comisiones
             WHERE empresa_id = $1 AND referente_id = $2 AND estado = 'validada') AS comisiones_pendientes`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json(rows[0] || {});
    } catch (e) {
      console.error('REFERENTE.PORTAL.RESUMEN.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo resumen' });
    }
  });

  router.get('/pedidos', async (req, res) => {
    try {
      const rows = await query(
        `SELECT p.id, p.fecha, p.fecha_entrega, p.estado, p.monto, p.metodo_pago,
                pe.cliente, pe.telefono, pe.direccion,
                COALESCE(rc.comision_total, 0)::numeric AS comision_total
           FROM pedidos p
           JOIN cliente_referentes cr
             ON cr.empresa_id = p.empresa_id
            AND cr.punto_entrega_id = p.punto_entrega_id
            AND cr.estado = 'activo'
           JOIN puntos_entrega pe
             ON pe.id = p.punto_entrega_id
            AND pe.empresa_id = p.empresa_id
           LEFT JOIN (
             SELECT empresa_id, referente_id, pedido_id, SUM(monto_comision) AS comision_total
               FROM referente_comisiones
              WHERE empresa_id = $1
                AND referente_id = $2
              GROUP BY empresa_id, referente_id, pedido_id
           ) rc
             ON rc.empresa_id = p.empresa_id
            AND rc.referente_id = cr.referente_id
            AND rc.pedido_id = p.id
          WHERE p.empresa_id = $1
            AND cr.referente_id = $2
          ORDER BY COALESCE(p.fecha_entrega, p.fecha) DESC, p.id DESC
          LIMIT 300`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTE.PORTAL.PEDIDOS.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo pedidos' });
    }
  });

  router.get('/comisiones', async (req, res) => {
    try {
      const rows = await query(
        `SELECT rc.id, rc.pedido_id, rc.base_monto, rc.porcentaje,
                rc.monto_comision, rc.estado, rc.validada_at, rc.liquidada_at,
                pe.cliente,
                pr.nombre AS producto_nombre
           FROM referente_comisiones rc
           LEFT JOIN puntos_entrega pe ON pe.id = rc.punto_entrega_id
           LEFT JOIN productos pr ON pr.id = rc.producto_id
          WHERE rc.empresa_id = $1
            AND rc.referente_id = $2
          ORDER BY rc.validada_at DESC, rc.id DESC
          LIMIT 300`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTE.PORTAL.COMISIONES.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo comisiones' });
    }
  });

  router.get('/clientes', async (req, res) => {
    try {
      const rows = await query(
        `SELECT cr.id, cr.estado, cr.asociado_at,
                pe.id AS cliente_id,
                pe.cliente,
                pe.telefono,
                pe.direccion
           FROM cliente_referentes cr
           JOIN puntos_entrega pe
             ON pe.id = cr.punto_entrega_id
            AND pe.empresa_id = cr.empresa_id
          WHERE cr.empresa_id = $1
            AND cr.referente_id = $2
            AND cr.estado = 'activo'
          ORDER BY cr.asociado_at DESC
          LIMIT 300`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTE.PORTAL.CLIENTES.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo clientes' });
    }
  });

  router.get('/productos', async (req, res) => {
    try {
      const rows = await query(
        `SELECT rp.id, rp.producto_id, rp.porcentaje_comision,
                rp.vigente_desde, rp.vigente_hasta, rp.activo,
                p.nombre AS producto_nombre,
                p.precio AS producto_precio
           FROM referente_productos rp
           JOIN productos p ON p.id = rp.producto_id AND p.empresa_id = rp.empresa_id
          WHERE rp.empresa_id = $1
            AND rp.referente_id = $2
            AND rp.activo = TRUE
          ORDER BY p.nombre ASC`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTE.PORTAL.PRODUCTOS.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo productos' });
    }
  });

  return router;
}
