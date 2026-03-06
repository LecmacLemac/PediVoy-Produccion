// src/routes/tracking.js
import express from 'express';
import { withAuth } from '../services.js';
import { query } from '../db.js';

const MAX_HISTORY_LIMIT = 500;

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function canManageTracking(role) {
  const r = String(role || '').toLowerCase();
  return r === 'super' || r === 'admin';
}

async function resolveEmpresaId(req) {
  if (req.user?.empresa_id) return req.user.empresa_id;

  const userId = req.user?.id;
  if (!userId) return null;

  const rows = await query(
    'SELECT empresa_id FROM usuarios WHERE id = $1 LIMIT 1',
    [userId]
  );

  return rows?.[0]?.empresa_id || null;
}

export function createTrackingRouter() {
  const router = express.Router();

  // POST /api/track/update (compat)
  // POST /api/track/location (nuevo payload recomendado)
  const saveLocationHandler = async (req, res) => {
    try {
      const body = req.body || {};
      const choferId = req.user?.chofer_id;
      const empresaId = await resolveEmpresaId(req);

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

      const pedRows = await query(
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

      await query(
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

  router.post('/update', withAuth, saveLocationHandler);
  router.post('/location', withAuth, saveLocationHandler);

  // GET /api/track/live
  // Vista live para admins/super por empresa (multi-tenant)
  router.get('/live', withAuth, async (req, res) => {
    try {
      if (!canManageTracking(req.user?.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaId = await resolveEmpresaId(req);
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

      const rows = await query(
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
          u.latitud,
          u.longitud,
          u.timestamp,
          u.speed,
          u.heading,
          u.precision,
          u.source
        FROM pedidos p
        LEFT JOIN choferes c ON c.id = p.chofer_id
        LEFT JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        LEFT JOIN ult u ON u.pedido_id = p.id
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

  // GET /api/track/history/:pedidoId?limit=200
  router.get('/history/:pedidoId', withAuth, async (req, res) => {
    try {
      if (!canManageTracking(req.user?.role)) {
        return res.status(403).json({ error: 'No autorizado' });
      }

      const empresaId = await resolveEmpresaId(req);
      const pedidoId = asNum(req.params.pedidoId);
      const limitRaw = asNum(req.query?.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limitRaw)))
        : 200;

      if (!empresaId || !Number.isFinite(pedidoId)) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
      }

      const pedRows = await query(
        'SELECT id, empresa_id FROM pedidos WHERE id = $1 AND empresa_id = $2 LIMIT 1',
        [pedidoId, empresaId]
      );

      if (!pedRows.length) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      const points = await query(
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
