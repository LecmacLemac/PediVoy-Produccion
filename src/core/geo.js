import { cfg } from '../config.js';
import { query } from '../db.js';

export async function geocodeIfNeeded({ direccion, ciudad, provincia, pais }) {
  try {
    if (!cfg.mapsKey) return { lat: null, lng: null };

    const q = encodeURIComponent([direccion, ciudad, provincia, pais].filter(Boolean).join(', '));
    if (!q) return { lat: null, lng: null };

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${cfg.mapsKey}`;

    const r = await fetch(url);
    if (!r.ok) return { lat: null, lng: null };

    const j = await r.json();
    const loc = j?.results?.[0]?.geometry?.location;

    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return { lat: null, lng: null };
    }

    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    console.error('geocodeIfNeeded ERROR', err);
    return { lat: null, lng: null };
  }
}

export async function pointInAnyZone({ empresa_id, lat, lng }) {
  if (!empresa_id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  try {
    const sql = `
      SELECT id
      FROM zonas_geograficas
      WHERE empresa_id = $1
        AND geom IS NOT NULL
        AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))
      LIMIT 1
    `;

    const rows = await query(sql, [empresa_id, lng, lat]);
    return rows.length > 0 ? rows[0].id : null;
  } catch (err) {
    console.error('[ZoneCheck] Error en PostGIS:', err);
    return null;
  }
}
