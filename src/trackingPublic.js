import express from 'express';
// MEJORA DE CONTROL: Importamos directo de db.js para máxima estabilidad
import { query } from './db.js'; 

export const trackingPublicRouter = express.Router();

// --------------------------------------------------
// Rate limit simple (in-memory) por IP para tracking público
// --------------------------------------------------
const RL_WINDOW_MS = Number(process.env.TRACK_PUBLIC_RL_WINDOW_MS || 60_000);
const RL_MAX = Number(process.env.TRACK_PUBLIC_RL_MAX || 60); // 60 req/min por IP (default)

/** @type {Map<string, number[]>} */
const rlHits = new Map();

function rateLimitTracking(req, res, next) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || 'unknown';
    const now = Date.now();

    const arr = rlHits.get(ip) || [];
    const cutoff = now - RL_WINDOW_MS;
    const recent = arr.filter((t) => t >= cutoff);
    recent.push(now);
    rlHits.set(ip, recent);

    // limpieza básica para que no crezca infinito
    if (rlHits.size > 10_000) {
      for (const [k, v] of rlHits.entries()) {
        if (!v.length || v[v.length - 1] < cutoff) rlHits.delete(k);
      }
    }

    if (recent.length > RL_MAX) {
      res.setHeader('Retry-After', String(Math.ceil(RL_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Demasiadas solicitudes, intentá de nuevo en un momento.' });
    }

    return next();
  } catch {
    // si falla el rate limiter, no bloqueamos tracking
    return next();
  }
}


/**
 * GET /api/public/tracking/:token
 * Responde con:
 * {
 * pedido: { ... },
 * driverLocation: { latitud, longitud, timestamp } | null
 * }
 */
trackingPublicRouter.get('/tracking/:token', rateLimitTracking, async (req, res) => {
  const { token } = req.params;

  try {
    // 1. Validación estricta del token
    if (!token || typeof token !== 'string' || token.length < 5) {
      console.warn(`[TRACKING] Intento de acceso con token inválido: ${token}`);
      return res.status(400).json({ error: 'Token inválido' });
    }

    // 2. Buscar pedido por tracking_token
    // Usamos JOIN para traer datos útiles del punto de entrega y chofer
    const pedRows = await query(`
      SELECT 
        p.id,
        p.estado,
        p.fecha,
        p.fecha_entrega,
        p.chofer_id,
        pe.cliente,
        pe.direccion,
        pe.ciudad,
        pe.provincia,
        pe.latitud  AS dest_lat,
        pe.longitud AS dest_lng,
        c.nombre    AS chofer_nombre,
        c.telefono  AS chofer_tel
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      LEFT JOIN choferes c    ON c.id = p.chofer_id
      WHERE p.tracking_token = $1
      LIMIT 1
    `, [token]);

    if (!pedRows.length) {
      // No devolvemos 500, sino 404 para que el frontend sepa que no existe
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido = pedRows[0];

    // 3) TTL del tracking: por privacidad, el token expira
    // Usamos fecha_entrega si existe; si no, usamos fecha del pedido.
    const ttlHours = Number(process.env.TRACK_TTL_HOURS || 3);
    const baseDate = pedido.fecha_entrega || pedido.fecha;
    if (Number.isFinite(ttlHours) && ttlHours > 0 && baseDate) {
      const ageMs = Date.now() - new Date(baseDate).getTime();
      if (Number.isFinite(ageMs) && ageMs > ttlHours * 60 * 60 * 1000) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
    }

    // 4. Buscar ubicación del chofer
    // Solo buscamos si el pedido está en progreso o recién entregado.
    let driverLocation = null;

    if (['en_ruta', 'en_camino', 'entregado'].includes(pedido.estado)) {
      const locRows = await query(`
        SELECT 
          latitud,
          longitud,
          timestamp
        FROM pedido_track_points
        WHERE pedido_id = $1
        ORDER BY timestamp DESC
        LIMIT 1
      `, [pedido.id]);

      if (locRows.length > 0) {
        driverLocation = locRows[0];
      }
    }

    // 5) Respuesta saneada: no exponer campos internos innecesarios
    const safePedido = {
      id: pedido.id,
      estado: pedido.estado,
      fecha: pedido.fecha,
      fecha_entrega: pedido.fecha_entrega,
      cliente: pedido.cliente,
      direccion: pedido.direccion,
      ciudad: pedido.ciudad,
      provincia: pedido.provincia,
      dest_lat: pedido.dest_lat,
      dest_lng: pedido.dest_lng,
      chofer_nombre: pedido.chofer_nombre || null,
      chofer_tel: pedido.chofer_tel || null
    };

    return res.json({ pedido: safePedido, driverLocation });

  } catch (err) {
    console.error(`[TRACKING ERROR] Token: ${token}`, err);
    // Es importante devolver JSON incluso en error para que el frontend no se cuelgue parseando HTML de error
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});