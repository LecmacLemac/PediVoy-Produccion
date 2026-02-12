// src/services.js — versión escalable + PostgreSQL + limpia
// Notas de coordenadas:
// - Usamos siempre estándar GeoJSON: [lng, lat] en todo el sistema.
import jwt from 'jsonwebtoken';
import { cfg } from './config.js';
import { query } from './db.js';

// ===============================================
// AUTH
// ===============================================

const JWT_SECRET = process.env.JWT_SECRET || cfg.jwtSecret || 'dev-secret';

/**
 * Middleware de autenticación simple.
 * Verifica token y adjunta req.user.
 */
export function withAuth(req, res, next) {
  try {
    let token = null;

    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);

    if (!token && req.headers['x-access-token']) token = req.headers['x-access-token'];
    if (!token && req.cookies?.token) token = req.cookies.token;

    if (!token) return res.status(401).json({ error: 'No token' });

    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

/**
 * Obtiene la empresa del token.
 */
export function getEmpresaIdFromToken(req) {
  return req.user?.empresa_id || 1;
}

/**
 * ¿Usuario es super admin?
 */
export function isSuper(req) {
  return (req.user?.role || '').toLowerCase() === 'super';
}

/**
 * ¿Usuario es chofer / repartidor?
 */
export function isRepartidor(req) {
  return (req.user?.role || '').toLowerCase() === 'repartidor';
}

/**
 * ¿Usuario autenticado (cualquier rol)?
 */
export function isUser(req) {
  return !!req.user;
}

/**
 * Resuelve empresa_id según permisos.
 *  - super admin puede cambiar empresa por query/body
 *  - usuarios normales usan su propia empresa
 */
export function resolveEmpresaId(req) {
  if (isSuper(req)) {
    const q = Number(req.query?.empresa_id);
    if (Number.isFinite(q) && q > 0) return q;

    const b = Number(req.body?.empresa_id);
    if (Number.isFinite(b) && b > 0) return b;
  }
  return getEmpresaIdFromToken(req);
}

// ===============================================
// LICENCIAS
// ===============================================

/**
 * Middleware de licencia.
 * - Super admin nunca se bloquea.
 * - Empresa sin licencia o vencida → 402 y redirección a /pedidos/licencia.html
 */
export async function checkLicencia(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    // Super admin: sin bloqueo de licencia
    if (isSuper(req)) return next();

    const empresaId = getEmpresaIdFromToken(req);
    if (!empresaId) {
      return res.status(400).json({ error: 'Sin empresa asociada' });
    }

    const rows = await query(
      `SELECT plan_estado, plan_vencimiento 
         FROM empresas 
        WHERE id = $1`,
      [empresaId]
    );

    if (!rows.length) {
      return res.status(403).json({ error: 'Empresa no encontrada' });
    }

    const { plan_estado, plan_vencimiento } = rows[0];

    const ahoraMs = Date.now();
    const vencMs = plan_vencimiento ? new Date(plan_vencimiento).getTime() : null;

    // Vencida si:
    //  - estado = 'expired' (cron o admin la marcó)
    //  - o la fecha de vencimiento ya pasó
    const vencida =
      plan_estado === 'expired' ||
      (vencMs !== null && vencMs < ahoraMs);

    if (vencida) {
      return res.status(402).json({
        error: 'licencia_vencida',
        message: '⛔ Tu licencia ha vencido. Realizá el pago para reactivar el servicio.',
        redirect: '/pedidos/licencia.html'
      });
    }

    return next();
  } catch (e) {
    console.error('Error en checkLicencia:', e);
    return res.status(500).json({ error: 'Error al validar licencia' });
  }
}


// ===============================================
// GEO-CODING (Google Maps)
// ===============================================

/**
 * geocodeIfNeeded
 * Devuelve {lat, lng} o {lat:null, lng:null}
 */
export async function geocodeIfNeeded({ direccion, ciudad, provincia, pais }) {
  try {
    if (!cfg.mapsKey) return { lat: null, lng: null };

    const q = encodeURIComponent(
      [direccion, ciudad, provincia, pais].filter(Boolean).join(', ')
    );
    if (!q) return { lat: null, lng: null };

    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${cfg.mapsKey}`;

    const r = await fetch(url);
    if (!r.ok) return { lat: null, lng: null };

    const j = await r.json();
    const loc = j?.results?.[0]?.geometry?.location;

    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return { lat: null, lng: null };
    }

    // Google devuelve { lat, lng } — ya listo para guardar como números
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error('geocodeIfNeeded ERROR', err);
    return { lat: null, lng: null };
  }
}

// ===============================================
// ZONAS (PostGIS Optimizado)
// ===============================================

/**
 * pointInAnyZone — Determina zona por coordenadas usando PostGIS.
 * Se mapea como 'corePointInAnyZone' en backend.js.
 */

export async function pointInAnyZone({ empresa_id, lat, lng }) {
  // 1. Validaciones básicas
  if (!empresa_id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  try {
    // 2. CONSULTA ESPACIAL NATIVA
    // PostGIS ST_MakePoint requiere orden (Longitud X, Latitud Y)
    // ST_SetSRID(..., 4326) define el sistema de coordenadas GPS WGS84
    const sql = `
      SELECT id
      FROM zonas_geograficas
      WHERE empresa_id = $1
        AND geom IS NOT NULL
        AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))
      LIMIT 1
    `;

    // Parámetros: $1=empresa, $2=lng (X), $3=lat (Y)
    const rows = await query(sql, [empresa_id, lng, lat]);

    if (rows.length > 0) {
      return rows[0].id;
    }

    return null;
  } catch (err) {
    console.error('[ZoneCheck] Error en PostGIS:', err);
    return null;
  }
}

// ===============================================
// UTILIDADES — formato de datos
// ===============================================

export function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

export function normalizePhone(s) {
  // Nos quedamos con los últimos 10 dígitos (Argentina sin 0/15)
  return digitsOnly(s).slice(-10);
}

export function moneyARS0(n) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(Math.round(Number(n || 0)));
  } catch {
    return '$' + String(Math.round(Number(n || 0)));
  }
}

// ===============================================
// EXPORT GENERAL
// ===============================================

/**
 * Encola mensaje de WhatsApp con validación Argentina y Anti-Spam.
 */
export async function enqueueWppMessage({ phone, message, empresa_id = null }) {
  if (!phone || !message) return;

  // 1. Limpieza básica
  let cleanPhone = String(phone).replace(/\D+/g, '');
  const cleanMsg = String(message).trim();

  // 2. PARCHE ARGENTINA: Si tiene 10 dígitos (ej: 3534123456), agregar 549
  if (cleanPhone.length === 10) {
    cleanPhone = '549' + cleanPhone;
  }

  try {
    // 3. ANTI-SPAM: Verificar duplicados recientes (5 min)
    const duplicados = await query(`
      SELECT id FROM wpp_outbox 
      WHERE telefono = $1 
        AND mensaje = $2 
        AND created_at > (NOW() - INTERVAL '5 minutes')
      LIMIT 1
    `, [cleanPhone, cleanMsg]);

    if (duplicados.length > 0) return;

    // 4. Insertar
    await query(`
      INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
      VALUES ($1, $2, $3, 'pending', NOW())
    `, [empresa_id, cleanPhone, cleanMsg]);

  } catch (e) {
    console.error('Error en enqueueWppMessage (service):', e);
  }
}


export { query };