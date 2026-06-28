// src/routes/tracking.js
import express from 'express';
import { withAuth } from '../services.js';
import { query } from '../db.js';

const MAX_HISTORY_LIMIT = 500;
const MAX_ACK_COMMENT = 500;

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getRole(role) {
  return String(role || '').toLowerCase();
}

function canManageTracking(role) {
  const r = getRole(role);
  return r === 'super' || r === 'admin';
}

function toIsoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function resolveEmpresaId(req, queryFn = query) {
  if (req.user?.empresa_id) return req.user.empresa_id;

  const userId = req.user?.id;
  if (!userId) return null;

  const rows = await queryFn(
    'SELECT empresa_id FROM usuarios WHERE id = $1 LIMIT 1',
    [userId]
  );

  return rows?.[0]?.empresa_id || null;
}

async function resolveTargetEmpresaId(req, queryFn = query) {
  const role = getRole(req.user?.role);
  if (role === 'super') {
    const empresaFromQuery = asNum(req.query?.empresa_id ?? req.query?.empresaId);
    if (Number.isFinite(empresaFromQuery) && empresaFromQuery > 0) return empresaFromQuery;
  }
  return resolveEmpresaId(req, queryFn);
}

export function createTrackingRouter({ queryFn = query, withAuthFn = withAuth } = {}) {
  const router = express.Router();

  // POST /api/track/update (compat)
  // POST /api/track/location (nuevo payload recomendado)
  const saveLocationHandler = async (req, res) => {
    try {
      const body = req.body || {};
      const choferId = req.user?.chofer_id;
      const empresaId = await resolveEmpresaId(req, queryFn);

      if (!choferId || !empresaId) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const pedidoId = asNum(body.pedido_id ?? body.pedidoId);
      const lat = asNum(body.lat ?? body.latitud);
      const lng = asNum(body.lng ?? body.longitud);
      const precision = asNum(body.precision ?? body.accuracy);
      const speed = asNum(body.speed);
      const heading = asNum(body.heading);
      const source = String(body.source || 'gps').slice(0, 30);

      if (!Number.isFinite(pedidoId) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'Datos inválidos' });
      }

      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'Coordenadas fuera de rango' });
      }

      if (lat === 0 && lng === 0) {
        return res.status(400).json({ error: 'Coordenadas inválidas' });
      }

      const pedRows = await queryFn(
        `
        SELECT id, empresa_id, chofer_id, estado
        FROM pedidos
        WHERE id = $1
          AND empresa_id = $2
        LIMIT 1
        `,
        [pedidoId, empresaId]
      );

      if (!pedRows.length) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const ped = pedRows[0];
      if (ped.chofer_id && Number(ped.chofer_id) !== Number(choferId)) {
        return res.status(403).json({ error: 'No puedes actualizar este pedido' });
      }

      await queryFn(
        `
        INSERT INTO pedido_track_points (pedido_id, latitud, longitud, timestamp, source, precision, speed, heading)
        VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)
        `,
        [pedidoId, lat, lng, source, precision, speed, heading]
      );

      return res.json({
        ok: true,
        pedido_id: pedidoId,
        recorded_at: new Date().toISOString(),
        estado: ped.estado
      });
    } catch (e) {
      console.error('TRACK SAVE ERROR:', e);
      return res.status(500).json({ error: 'Error guardando ubicación' });
    }
  };

  router.post('/update', withAuthFn, saveLocationHandler);
  router.post('/location', withAuthFn, saveLocationHandler);

  // GET /api/track/live
  // Vista live para admins/super por empresa (multi-tenant)
  router.get('/live', withAuthFn, async (req, res) => {
    try {
      if (!canManageTracking(req.user?.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaId = await resolveTargetEmpresaId(req, queryFn);
      if (!empresaId) {
        return res.status(400).json({ error: 'Empresa no determinada' });
      }

      const estado = req.query?.estado ? String(req.query.estado) : null;
      const choferId = asNum(req.query?.chofer_id ?? req.query?.choferId);

      const vals = [empresaId];
      let idx = 2;
      const where = ['p.empresa_id = $1'];

      // por defecto, sólo estados activos para el mapa operativo
      if (estado) {
        where.push(`p.estado = $${idx++}`);
        vals.push(estado);
      } else {
        where.push(`p.estado IN ('pendiente', 'en_ruta', 'en_camino')`);
      }

      if (Number.isFinite(choferId)) {
        where.push(`p.chofer_id = $${idx++}`);
        vals.push(choferId);
      }

      const rows = await queryFn(
        `
        WITH ult AS (
          SELECT DISTINCT ON (ptp.pedido_id)
                 ptp.pedido_id,
                 ptp.latitud,
                 ptp.longitud,
                 ptp.timestamp,
                 ptp.speed,
                 ptp.heading,
                 ptp.precision,
                 ptp.source
          FROM pedido_track_points ptp
          ORDER BY ptp.pedido_id, ptp.timestamp DESC
        ),
        ult_chofer AS (
          SELECT DISTINCT ON (p2.chofer_id)
                 p2.chofer_id,
                 ptp.latitud,
                 ptp.longitud,
                 ptp.timestamp,
                 ptp.speed,
                 ptp.heading,
                 ptp.precision,
                 ptp.source
          FROM pedidos p2
          JOIN pedido_track_points ptp ON ptp.pedido_id = p2.id
          WHERE p2.empresa_id = $1
            AND p2.chofer_id IS NOT NULL
          ORDER BY p2.chofer_id, ptp.timestamp DESC
        )
        SELECT
          p.id AS pedido_id,
          p.estado,
          p.fecha,
          p.fecha_entrega,
          p.chofer_id,
          c.nombre AS chofer_nombre,
          pe.cliente,
          pe.direccion,
          pe.ciudad,
          pe.latitud AS dest_lat,
          pe.longitud AS dest_lng,
          COALESCE(u.latitud, uc.latitud) AS latitud,
          COALESCE(u.longitud, uc.longitud) AS longitud,
          COALESCE(u.timestamp, uc.timestamp) AS timestamp,
          COALESCE(u.speed, uc.speed) AS speed,
          COALESCE(u.heading, uc.heading) AS heading,
          COALESCE(u.precision, uc.precision) AS precision,
          COALESCE(u.source, uc.source) AS source,
          ack.acked_at,
          ack.acked_by_username,
          ack.comment AS ack_comment
        FROM pedidos p
        LEFT JOIN choferes c ON c.id = p.chofer_id
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        LEFT JOIN ult u ON u.pedido_id = p.id
        LEFT JOIN ult_chofer uc ON uc.chofer_id = p.chofer_id
        LEFT JOIN LATERAL (
          SELECT tia.acked_at, tia.acked_by_username, tia.comment
          FROM tracking_incident_acks tia
          WHERE tia.empresa_id = p.empresa_id
            AND tia.pedido_id = p.id
          ORDER BY tia.acked_at DESC
          LIMIT 1
        ) ack ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY p.id DESC
        LIMIT 500
        `,
        vals
      );

      return res.json({
        ok: true,
        empresa_id: empresaId,
        items: rows,
        total: rows.length
      });
    } catch (e) {
      console.error('TRACK LIVE ERROR:', e);
      return res.status(500).json({ error: 'Error cargando tracking live' });
    }
  });

  // GET /api/track/drivers/live
  // Última ubicación conocida por chofer (independiente del estado actual del pedido)
  router.get('/drivers/live', withAuthFn, async (req, res) => {
    try {
      if (!canManageTracking(req.user?.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaId = await resolveTargetEmpresaId(req, queryFn);
      if (!empresaId) {
        return res.status(400).json({ error: 'Empresa no determinada' });
      }

      const rows = await queryFn(
        `
        WITH ult_chofer AS (
          SELECT DISTINCT ON (p.chofer_id)
                 p.chofer_id,
                 ptp.pedido_id,
                 ptp.latitud,
                 ptp.longitud,
                 ptp.timestamp,
                 ptp.speed,
                 ptp.heading,
                 ptp.precision,
                 ptp.source
          FROM pedidos p
          JOIN pedido_track_points ptp ON ptp.pedido_id = p.id
          WHERE p.empresa_id = $1
            AND p.chofer_id IS NOT NULL
          ORDER BY p.chofer_id, ptp.timestamp DESC
        )
        SELECT
          c.id AS chofer_id,
          c.nombre AS chofer_nombre,
          c.tipo AS chofer_tipo,
          c.telefono AS chofer_telefono,
          u.pedido_id,
          u.latitud,
          u.longitud,
          u.timestamp,
          u.speed,
          u.heading,
          u.precision,
          u.source
        FROM choferes c
        LEFT JOIN ult_chofer u ON u.chofer_id = c.id
        WHERE c.empresa_id = $1
        ORDER BY c.nombre ASC
        `,
        [empresaId]
      );

      return res.json({
        ok: true,
        empresa_id: empresaId,
        items: rows,
        total: rows.length
      });
    } catch (e) {
      console.error('TRACK DRIVERS LIVE ERROR:', e);
      return res.status(500).json({ error: 'Error cargando ubicación por chofer' });
    }
  });

  // POST /api/track/incidents/:pedidoId/ack
  router.post('/incidents/:pedidoId/ack', withAuthFn, async (req, res) => {
    try {
      if (!canManageTracking(req.user?.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaId = await resolveEmpresaId(req, queryFn);
      const pedidoId = asNum(req.params.pedidoId);
      const comment = String(req.body?.comment || '').trim().slice(0, MAX_ACK_COMMENT) || null;

      if (!empresaId || !Number.isFinite(pedidoId)) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
      }

      const pedRows = await queryFn(
        'SELECT id, empresa_id FROM pedidos WHERE id = $1 AND empresa_id = $2 LIMIT 1',
        [pedidoId, empresaId]
      );

      if (!pedRows.length) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const ackRows = await queryFn(
        `
        INSERT INTO tracking_incident_acks (empresa_id, pedido_id, acked_by_user_id, acked_by_username, comment)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, acked_at, acked_by_username, comment
        `,
        [empresaId, pedidoId, req.user?.id || null, req.user?.username || null, comment]
      );

      const ack = ackRows?.[0] || null;
      return res.json({
        ok: true,
        pedido_id: pedidoId,
        ack: ack
          ? {
              id: ack.id,
              acked_at: toIsoOrNull(ack.acked_at),
              acked_by_username: ack.acked_by_username || null,
              comment: ack.comment || null
            }
          : null
      });
    } catch (e) {
      console.error('TRACK ACK ERROR:', e);
      return res.status(500).json({ error: 'Error registrando ACK' });
    }
  });

  // GET /api/track/history/:pedidoId?limit=200
  router.get('/history/:pedidoId', withAuthFn, async (req, res) => {
    try {
      if (!canManageTracking(req.user?.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaId = await resolveEmpresaId(req, queryFn);
      const pedidoId = asNum(req.params.pedidoId);
      const limitRaw = asNum(req.query?.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limitRaw)))
        : 200;

      if (!empresaId || !Number.isFinite(pedidoId)) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
      }

      const pedRows = await queryFn(
        'SELECT id, empresa_id FROM pedidos WHERE id = $1 AND empresa_id = $2 LIMIT 1',
        [pedidoId, empresaId]
      );

      if (!pedRows.length) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const points = await queryFn(
        `
        SELECT id, pedido_id, latitud, longitud, timestamp, source, precision, speed, heading
        FROM pedido_track_points
        WHERE pedido_id = $1
        ORDER BY timestamp DESC
        LIMIT $2
        `,
        [pedidoId, limit]
      );

      return res.json({
        ok: true,
        pedido_id: pedidoId,
        items: points,
        total: points.length
      });
    } catch (e) {
      console.error('TRACK HISTORY ERROR:', e);
      return res.status(500).json({ error: 'Error cargando historial de tracking' });
    }
  });

  return router;
}
