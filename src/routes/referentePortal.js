import express from 'express';
import bcrypt from 'bcryptjs';

import { ensureReferenteNotificationsSchema } from '../services/referenteNotifications.js';

let referenteProfileSchemaReady = false;
let referenteClientesPropuestosSchemaReady = false;

function cleanText(value, max = 280) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

export function createReferentePortalRouter(deps) {
  const { query, withAuth } = deps || {};
  if (typeof query !== 'function') throw new Error('createReferentePortalRouter: falta query(fn)');
  if (typeof withAuth !== 'function') throw new Error('createReferentePortalRouter: falta withAuth(fn)');

  const router = express.Router();

  async function ensureReferenteProfileSchema() {
    if (referenteProfileSchemaReady) return;
    await query(`
      ALTER TABLE referentes
        ADD COLUMN IF NOT EXISTS direccion TEXT
    `);
    referenteProfileSchemaReady = true;
  }

  async function ensureReferenteClientesPropuestosSchema() {
    if (referenteClientesPropuestosSchemaReady) return;
    await query(`
      CREATE TABLE IF NOT EXISTS referente_clientes_propuestos (
        id                    SERIAL PRIMARY KEY,
        empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
        cliente                TEXT NOT NULL,
        telefono               TEXT,
        direccion              TEXT,
        ciudad                 TEXT,
        provincia              TEXT,
        pais                   TEXT,
        email                  TEXT,
        notas                  TEXT,
        estado                 TEXT NOT NULL DEFAULT 'pendiente',
        punto_entrega_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
        reviewed_at            TIMESTAMPTZ,
        reviewed_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        rechazo_motivo         TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_empresa_estado_idx
        ON referente_clientes_propuestos (empresa_id, estado, created_at DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_referente_idx
        ON referente_clientes_propuestos (empresa_id, referente_id, estado)
    `);
    referenteClientesPropuestosSchemaReady = true;
  }

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
      await ensureReferenteProfileSchema();
      const rows = await query(
        `SELECT r.id, r.empresa_id, r.nombre, r.telefono, r.email, r.direccion, r.codigo,
                r.porcentaje_comision, r.vigente_desde, r.vigente_hasta,
                r.activo, r.notas, r.created_at, r.updated_at,
                e.nombre AS empresa_nombre,
                e.landing_slug AS empresa_slug
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
      await ensureReferenteProfileSchema();
      const rows = await query(
        `UPDATE referentes
            SET nombre = COALESCE($3, nombre),
                telefono = $4,
                email = $5,
                direccion = $6,
                notas = $7,
                updated_at = NOW()
          WHERE id = $1
            AND empresa_id = $2
            AND deleted_at IS NULL
          RETURNING id, empresa_id, nombre, telefono, email, direccion, codigo,
                    porcentaje_comision, vigente_desde, vigente_hasta,
                    activo, notas, updated_at`,
        [
          req.user.referente_id,
          req.user.empresa_id,
          cleanText(req.body?.nombre, 120),
          cleanText(req.body?.telefono, 60),
          cleanText(req.body?.email, 180),
          cleanText(req.body?.direccion, 220),
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
               AND cr.estado IN ('activo','desvinculado')
               AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
               AND (
                 cr.desvinculado_at IS NULL
                 OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at
               )) AS pedidos_total,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado IN ('activo','desvinculado')
               AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
               AND (
                 cr.desvinculado_at IS NULL
                 OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at
               )
               AND COALESCE(p.fecha_entrega, p.fecha) >= NOW() - INTERVAL '30 days') AS pedidos_30d,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado IN ('activo','desvinculado')
               AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
               AND (
                 cr.desvinculado_at IS NULL
                 OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at
               )
               AND p.estado = 'entregado') AS pedidos_entregados,
           (SELECT COUNT(DISTINCT p.id)::int
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado IN ('activo','desvinculado')
               AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
               AND (
                 cr.desvinculado_at IS NULL
                 OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at
               )
               AND p.estado IN ('pendiente','en_ruta','en_camino')) AS pedidos_activos,
           (SELECT COALESCE(SUM(COALESCE(p.monto,0)),0)::numeric
              FROM pedidos p
              JOIN cliente_referentes cr
                ON cr.empresa_id = p.empresa_id
               AND cr.punto_entrega_id = p.punto_entrega_id
             WHERE p.empresa_id = $1
               AND cr.referente_id = $2
               AND cr.estado IN ('activo','desvinculado')
               AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
               AND (
                 cr.desvinculado_at IS NULL
                 OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at
               )
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
            AND cr.estado IN ('activo','desvinculado')
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
            AND COALESCE(p.fecha, p.fecha_entrega, NOW()) >= COALESCE(cr.asociado_at, '-infinity'::timestamptz)
            AND (
              cr.desvinculado_at IS NULL
              OR COALESCE(p.fecha, p.fecha_entrega, NOW()) < cr.desvinculado_at
            )
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

  router.get('/clientes-propuestos', async (req, res) => {
    try {
      await ensureReferenteClientesPropuestosSchema();
      const rows = await query(
        `SELECT id, cliente, telefono, direccion, ciudad, provincia, pais, email,
                notas, estado, punto_entrega_id, rechazo_motivo,
                reviewed_at, created_at, updated_at
           FROM referente_clientes_propuestos
          WHERE empresa_id = $1
            AND referente_id = $2
          ORDER BY CASE estado WHEN 'pendiente' THEN 0 WHEN 'aprobado' THEN 1 ELSE 2 END,
                   created_at DESC,
                   id DESC
          LIMIT 300`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTE.PORTAL.CLIENTES_PROPUESTOS.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo clientes propuestos' });
    }
  });

  router.post('/clientes-propuestos', async (req, res) => {
    try {
      await ensureReferenteClientesPropuestosSchema();
      const cliente = cleanText(req.body?.cliente, 160);
      if (!cliente) return res.status(400).json({ error: 'Falta nombre del cliente.' });

      const rows = await query(
        `INSERT INTO referente_clientes_propuestos (
           empresa_id, referente_id, cliente, telefono, direccion, ciudad,
           provincia, pais, email, notas, estado
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendiente')
         RETURNING id, cliente, telefono, direccion, ciudad, provincia, pais, email,
                   notas, estado, created_at`,
        [
          req.user.empresa_id,
          req.user.referente_id,
          cliente,
          cleanText(req.body?.telefono, 80),
          cleanText(req.body?.direccion, 220),
          cleanText(req.body?.ciudad, 120),
          cleanText(req.body?.provincia, 120),
          cleanText(req.body?.pais, 80) || 'Argentina',
          cleanText(req.body?.email, 180),
          cleanText(req.body?.notas, 600),
        ]
      );
      return res.status(201).json(rows[0]);
    } catch (e) {
      console.error('REFERENTE.PORTAL.CLIENTES_PROPUESTOS.CREATE.ERROR', e);
      return res.status(500).json({ error: 'Error enviando cliente a validación' });
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

  router.get('/reglas', async (req, res) => {
    try {
      const rows = await query(
        `SELECT r.codigo, r.porcentaje_comision, r.vigente_desde, r.vigente_hasta,
                e.nombre AS empresa_nombre,
                e.config_operativa->'referentes' AS reglas_config
           FROM referentes r
           JOIN empresas e ON e.id = r.empresa_id
          WHERE r.id = $1
            AND r.empresa_id = $2
            AND r.deleted_at IS NULL
          LIMIT 1`,
        [req.user.referente_id, req.user.empresa_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Referente no encontrado.' });

      const row = rows[0];
      const cfg = parseConfig(row.reglas_config);
      const porcentaje = Number(row.porcentaje_comision || 0);
      const condiciones = asArray(cfg.condiciones).length ? asArray(cfg.condiciones) : [
        'Las comisiones se generan sobre pedidos entregados y productos asignados al referente.',
        'Si un cliente ya tenía compras, el referente comisiona solo los pedidos realizados desde que se cargó su código.',
        'Los pedidos cancelados, rechazados o no entregados no generan comisión.',
        'Administración valida y liquida las comisiones desde el panel interno.',
      ];
      const liquidacion = cleanText(cfg.liquidacion, 300) || 'Las comisiones validadas quedan pendientes hasta que administración las marque como liquidadas.';
      const formaPago = cleanText(cfg.forma_pago || cfg.formaPago, 220) || 'La forma de pago se informa por administración al momento de la liquidación.';
      const contacto = cleanText(cfg.contacto, 220) || 'Ante diferencias o correcciones, contactar a administración.';

      return res.json({
        empresa_nombre: row.empresa_nombre,
        codigo: row.codigo,
        porcentaje_comision: porcentaje,
        vigente_desde: row.vigente_desde,
        vigente_hasta: row.vigente_hasta,
        liquidacion,
        forma_pago: formaPago,
        contacto,
        condiciones,
      });
    } catch (e) {
      console.error('REFERENTE.PORTAL.REGLAS.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo reglas comerciales' });
    }
  });

  router.get('/notificaciones', async (req, res) => {
    try {
      await ensureReferenteNotificationsSchema(query);
      const limit = Math.min(Math.max(Number(req.query?.limit || 50), 1), 100);
      const rows = await query(
        `SELECT id, tipo, titulo, mensaje, pedido_id, comision_id, leida_at, created_at
           FROM referente_notificaciones
          WHERE empresa_id = $1
            AND referente_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [req.user.empresa_id, req.user.referente_id, limit]
      );
      return res.json(rows);
    } catch (e) {
      console.error('REFERENTE.PORTAL.NOTIFICACIONES.ERROR', e);
      return res.status(500).json({ error: 'Error obteniendo notificaciones' });
    }
  });

  router.post('/notificaciones/marcar-leidas', async (req, res) => {
    try {
      await ensureReferenteNotificationsSchema(query);
      const rows = await query(
        `UPDATE referente_notificaciones
            SET leida_at = COALESCE(leida_at, NOW())
          WHERE empresa_id = $1
            AND referente_id = $2
            AND leida_at IS NULL
          RETURNING id`,
        [req.user.empresa_id, req.user.referente_id]
      );
      return res.json({ ok: true, actualizadas: rows.length });
    } catch (e) {
      console.error('REFERENTE.PORTAL.NOTIFICACIONES.READALL.ERROR', e);
      return res.status(500).json({ error: 'Error marcando notificaciones' });
    }
  });

  router.post('/notificaciones/:id/leida', async (req, res) => {
    try {
      await ensureReferenteNotificationsSchema(query);
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'Notificación inválida.' });

      const rows = await query(
        `UPDATE referente_notificaciones
            SET leida_at = COALESCE(leida_at, NOW())
          WHERE id = $1
            AND empresa_id = $2
            AND referente_id = $3
          RETURNING id, leida_at`,
        [id, req.user.empresa_id, req.user.referente_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Notificación no encontrada.' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('REFERENTE.PORTAL.NOTIFICACION.READ.ERROR', e);
      return res.status(500).json({ error: 'Error marcando notificación' });
    }
  });

  return router;
}
