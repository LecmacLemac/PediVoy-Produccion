import express from 'express';
// MEJORA DE CONTROL: Importamos directo de db.js para máxima estabilidad
import { query } from './db.js'; 

export const trackingPublicRouter = express.Router();

/**
 * GET /api/public/tracking/:token
 * Responde con:
 * {
 * pedido: { ... },
 * driverLocation: { latitud, longitud, timestamp } | null
 * }
 */
trackingPublicRouter.get('/tracking/:token', async (req, res) => {
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
        c.nombre    AS chofer_nombre
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
      chofer_nombre: pedido.chofer_nombre || null
    };

    return res.json({ pedido: safePedido, driverLocation });

  } catch (err) {
    console.error(`[TRACKING ERROR] Token: ${token}`, err);
    // Es importante devolver JSON incluso en error para que el frontend no se cuelgue parseando HTML de error
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});