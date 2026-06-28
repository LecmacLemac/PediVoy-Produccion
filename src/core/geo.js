import { cfg } from '../config.js';
import { query } from '../db.js';

function buildAddressQuery({ direccion, ciudad, provincia, pais }) {
  return [direccion, ciudad, provincia, pais]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

function normalizeCountry(pais) {
  const value = String(pais || '').trim();
  if (/^ar$/i.test(value)) return 'Argentina';
  return value;
}

function uniqueAddressQueries({ direccion, ciudad, provincia, pais }) {
  const country = normalizeCountry(pais) || 'Argentina';
  const street = String(direccion || '').trim();
  const city = String(ciudad || '').trim();
  const state = String(provincia || '').trim();

  const candidates = [
    buildAddressQuery({ direccion: street, ciudad: city, provincia: state, pais: country }),
    buildAddressQuery({ direccion: street, ciudad: city, pais: country }),
    buildAddressQuery({ direccion: street, provincia: state, pais: country }),
    buildAddressQuery({ direccion: street, pais: country }),
    buildAddressQuery({ ciudad: city, provincia: state, pais: country }),
  ];

  return Array.from(new Set(candidates.filter(Boolean)));
}

function parseLocation(loc) {
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng ?? loc?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function geocodeWithGoogle(q) {
  if (!cfg.mapsKey) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${cfg.mapsKey}`;
  const r = await fetch(url);
  if (!r.ok) return null;

  const j = await r.json();
  return parseLocation(j?.results?.[0]?.geometry?.location);
}

async function geocodeStructuredWithNominatim({ direccion, ciudad, provincia, pais }) {
  const params = new URLSearchParams({
    format: 'json',
    limit: '1',
    addressdetails: '0',
  });

  const street = String(direccion || '').trim();
  const city = String(ciudad || '').trim();
  const state = String(provincia || '').trim();
  const country = normalizeCountry(pais) || 'Argentina';

  if (street) params.set('street', street);
  if (city) params.set('city', city);
  if (state) params.set('state', state);
  if (country) params.set('country', country);
  if (!street && !city && !state) return null;

  const r = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      'User-Agent': 'PediVoy/1.1 geocoding fallback',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) return null;

  const j = await r.json();
  return parseLocation(Array.isArray(j) ? j[0] : null);
}

async function geocodeWithNominatim(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'PediVoy/1.1 geocoding fallback',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) return null;

  const j = await r.json();
  return parseLocation(Array.isArray(j) ? j[0] : null);
}

export async function geocodeIfNeeded({ direccion, ciudad, provincia, pais }) {
  try {
    const candidates = uniqueAddressQueries({ direccion, ciudad, provincia, pais });
    if (!candidates.length) return { lat: null, lng: null };

    for (const q of candidates) {
      const googleLoc = await geocodeWithGoogle(q);
      if (googleLoc) return googleLoc;
    }

    const structuredLoc = await geocodeStructuredWithNominatim({ direccion, ciudad, provincia, pais });
    if (structuredLoc) return structuredLoc;

    for (const q of candidates) {
      const nominatimLoc = await geocodeWithNominatim(q);
      if (nominatimLoc) return nominatimLoc;
    }

    return { lat: null, lng: null };
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
