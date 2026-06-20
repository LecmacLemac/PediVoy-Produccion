import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
// MEJORA DE CONTROL: Importamos directo de db.js para máxima estabilidad
import { query } from './db.js';

export function createTrackingPublicRouter({ queryFn = query } = {}) {
  const router = express.Router();

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

function publicAssetUrlOrNull(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith('/')) return raw;

  const root = process.cwd();
  const filePath = path.resolve(root, raw.replace(/^\/+/, ''));
  if (!filePath.startsWith(root + path.sep)) return null;

  return fs.existsSync(filePath) ? raw : null;
}

function buildEmpresaPublicLink(pedido) {
  const domain = String(pedido?.empresa_landing_domain || '').trim();
  if (domain) {
    return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  }

  const slug = String(pedido?.empresa_landing_slug || '').trim();
  if (slug) return `/pedidos/?slug=${encodeURIComponent(slug)}`;

  const id = Number(pedido?.empresa_id || 0);
  return id > 0 ? `/pedidos/?empresa_id=${encodeURIComponent(id)}` : '/pedidos/';
}


/**
 * GET /api/public/tracking/:token
 * Responde con:
 * {
 * pedido: { ... },
 * driverLocation: { latitud, longitud, timestamp } | null
 * }
 */
router.get('/tracking/:token', rateLimitTracking, async (req, res) => {
  const { token } = req.params;

  try {
    // 1. Validación estricta del token
    if (!token || typeof token !== 'string' || token.length < 5) {
      console.warn(`[TRACKING] Intento de acceso con token inválido: ${token}`);
      return res.status(400).json({ error: 'Token inválido' });
    }

    // 2. Buscar pedido por tracking_token
    // Usamos JOIN para traer datos útiles del punto de entrega y chofer
    const pedRows = await queryFn(`
      SELECT 
        p.id,
        p.empresa_id,
        p.estado,
        p.fecha,
        p.fecha_entrega,
        p.chofer_id,
        p.monto,
        p.metodo_pago,
        pe.cliente,
        pe.direccion,
        pe.ciudad,
        pe.provincia,
        pe.latitud  AS dest_lat,
        pe.longitud AS dest_lng,
        c.nombre    AS chofer_nombre,
        c.telefono  AS chofer_tel,
        e.nombre    AS empresa_nombre,
        e.logo_url  AS empresa_logo_url,
        e.landing_domain AS empresa_landing_domain,
        e.landing_slug   AS empresa_landing_slug
      FROM pedidos p
      JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
      LEFT JOIN choferes c    ON c.id = p.chofer_id
      LEFT JOIN empresas e    ON e.id = p.empresa_id
      WHERE p.tracking_token = $1
      LIMIT 1
    `, [token]);

    if (!pedRows.length) {
      // No devolvemos 500, sino 404 para que el frontend sepa que no existe
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido = pedRows[0];

    const estadoPedido = String(pedido.estado || '').toLowerCase();

    // 3) TTL del tracking: por privacidad, el token expira después del cierre.
    // No debe cortar pedidos activos, porque el cliente perdería el seguimiento
    // aunque el repartidor siga enviando ubicación.
    const ttlHours = Number(process.env.TRACK_TTL_HOURS || 3);
    const estadosActivos = new Set(['en_ruta', 'en_camino']);
    const estadosFinales = new Set(['entregado', 'cancelado']);
    const baseDate = pedido.fecha_entrega || pedido.fecha;
    if (estadosFinales.has(estadoPedido) && !estadosActivos.has(estadoPedido) && Number.isFinite(ttlHours) && ttlHours > 0 && baseDate) {
      const ageMs = Date.now() - new Date(baseDate).getTime();
      if (Number.isFinite(ageMs) && ageMs > ttlHours * 60 * 60 * 1000) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
    }

    // 4. Buscar ubicación del chofer
    // Solo buscamos si el pedido está en progreso o recién entregado.
    let driverLocation = null;

    if (['en_ruta', 'en_camino', 'entregado'].includes(estadoPedido)) {
      const locRows = await queryFn(`
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

    const items = await queryFn(`
      SELECT producto, cantidad, precio_unitario
      FROM items_pedido
      WHERE pedido_id = $1
      ORDER BY id ASC
    `, [pedido.id]);

    const itemsSafe = (items || []).slice(0, 50).map((item) => ({
      producto: String(item.producto || ''),
      cantidad: Number(item.cantidad || 0),
      precio_unitario: Number(item.precio_unitario || 0),
    }));

    const totalItems = itemsSafe.reduce(
      (acc, item) => acc + Number(item.cantidad || 0) * Number(item.precio_unitario || 0),
      0
    );

    // 5) Respuesta saneada: no exponer campos internos innecesarios
    const safePedido = {
      id: pedido.id,
      estado: pedido.estado,
      fecha: pedido.fecha,
      fecha_entrega: pedido.fecha_entrega,
      monto: Number(pedido.monto || 0) || Math.round(totalItems * 100) / 100,
      metodo_pago: pedido.metodo_pago || null,
      cliente: pedido.cliente,
      direccion: pedido.direccion,
      ciudad: pedido.ciudad,
      provincia: pedido.provincia,
      dest_lat: pedido.dest_lat,
      dest_lng: pedido.dest_lng,
      chofer_nombre: pedido.chofer_nombre || null,
      chofer_tel: pedido.chofer_tel || null,
      empresa_nombre: pedido.empresa_nombre || null,
      empresa_logo_url: publicAssetUrlOrNull(pedido.empresa_logo_url),
      empresa_link: buildEmpresaPublicLink(pedido),
      items: itemsSafe,
    };

    return res.json({ pedido: safePedido, driverLocation });

  } catch (err) {
    console.error(`[TRACKING ERROR] Token: ${token}`, err);
    // Es importante devolver JSON incluso en error para que el frontend no se cuelgue parseando HTML de error
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

  return router;
}

export const trackingPublicRouter = createTrackingPublicRouter();
