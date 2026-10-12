function initRepartidorMapaGpsUI() {
  $('#mapRefBtn').onclick = () => { loadPedidos().then(renderMap); };
  $('#mapCenterMe').onclick = centerMapOnDriver;
  $('#mapSecondaryFilters')?.addEventListener('toggle', () => {
    if (!map) return;
    requestAnimationFrame(resizeRepartidorMap);
  });

}

function setGpsFeedback(message) {
  const status = document.getElementById('gpsStatus');
  if (status) status.textContent = message;
}

function showGpsHelp() {
  const msg = [
    '📍 No se pudo acceder a tu ubicación.',
    '',
    'Si bloqueaste el permiso, habilitalo para este sitio y recargá.',
    'También revisá Android > Apps > Chrome > Permisos > Ubicación.',
    '',
    'Si no está bloqueado, reintentá en 10-15 segundos (puede ser señal/timeout).'
  ].join('\n');
  alert(msg);
}

const GPS_PREF_LS_KEY = 'repartidor:gps-enabled:v1';

function updateGpsButtonUI() {
  const gpsBtn = document.getElementById('btnGpsHelp');
  if (!gpsBtn) return;

  const on = !gpsSyncState.disabled && !gpsSyncState.denied;
  gpsBtn.hidden = on;
  gpsBtn.textContent = '📍 Activar GPS';
  gpsBtn.style.color = 'var(--muted)';
  gpsBtn.style.borderColor = 'var(--border)';
  gpsBtn.classList.toggle('gps-alert', !on);
}

function persistGpsPreference(enabled) {
  try { safeStorage.local.set(GPS_PREF_LS_KEY, enabled ? '1' : '0'); } catch {}
}

async function restoreGpsPreference() {
  if (restoreGpsPreference.pending) return restoreGpsPreference.pending;

  const pending = (async () => {
    gpsSyncState.disabled = true;
    updateGpsButtonUI();

    let enabled = false;
    try { enabled = safeStorage.local.get(GPS_PREF_LS_KEY) === '1'; } catch {}
    if (!enabled || !navigator.permissions?.query) return;

    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      if (permission.state !== 'granted') return;
      await requestGpsActivation();
    } catch {}
  })();

  restoreGpsPreference.pending = pending;
  try {
    await pending;
  } finally {
    if (restoreGpsPreference.pending === pending) delete restoreGpsPreference.pending;
  }
}

function getGeoErrorCode(err) {
  return Number(err?.code || err?.cause?.code || 0);
}

function getGeoErrorMessage(err) {
  const code = getGeoErrorCode(err);
  if (code === 1) return 'Permiso de ubicación bloqueado.';
  if (code === 2) return 'Ubicación temporalmente no disponible.';
  if (code === 3) return 'GPS tardó demasiado (timeout).';
  return 'No se pudo leer tu ubicación.';
}

async function requestGpsActivation() {
  setGpsFeedback('Solicitando permiso de ubicación…');
  if (!navigator.geolocation) {
    setGpsFeedback('GPS no disponible en este dispositivo.');
    return;
  }

  if (!window.isSecureContext) {
    setGpsFeedback('Abrí por HTTPS para usar GPS.');
    showGpsHelp();
    return;
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTS_ACTIVATE);
    });
    updateDriverLocationOnMap(pos);

    gpsSyncState.disabled = false;
    gpsSyncState.denied = false;
    gpsSyncState.lastOkAt = Date.now();
    gpsSyncState.nextInMs = 60_000;
    persistGpsPreference(true);
    updateGpsButtonUI();

    // Ping inicial si ya tiene pedido en ruta
    const activePed = pedidos.find(p => ['en_ruta', 'en_camino'].includes(p.estado));
    if (activePed) {
      api('/api/track/update', {
        method: 'POST',
        body: {
          pedido_id: activePed.id,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }
      }).catch(() => {});
    }

    setGpsFeedback('📍 GPS activado.');
  } catch (e) {
    setGpsFeedback(getGeoErrorMessage(e));
    const code = getGeoErrorCode(e);
    if (code === 1) {
      gpsSyncState.denied = true;
      gpsSyncState.disabled = true;
      persistGpsPreference(false);
      updateGpsButtonUI();
      showGpsHelp();
      return;
    }

    toast(getGeoErrorMessage(e));
  }
}

let driverLocationMarker = null;
let driverAccuracyCircle = null;
let lastDriverLocation = null;

function updateDriverLocationOnMap(position) {
  const lat = Number(position?.coords?.latitude);
  const lng = Number(position?.coords?.longitude);
  const accuracy = Number(position?.coords?.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  lastDriverLocation = { lat, lng, accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null };
  const centerButton = document.getElementById('mapCenterMe');
  if (centerButton) centerButton.disabled = false;
  renderStoredDriverLocationOnMap();
}

function renderStoredDriverLocationOnMap() {
  if (!lastDriverLocation || !map || googleMapsAuthorizationFailed) return;
  const { lat, lng, accuracy } = lastDriverLocation;
  const position = { lat, lng };
  if (!driverLocationMarker) {
    const dot = document.createElement('div');
    dot.className = 'driver-location-dot';
    driverLocationMarker = new google.maps.marker.AdvancedMarkerElement({ map, position, content: dot, title: 'Mi ubicación', zIndex: 1000 });
    driverLocationMarker.addListener('click', () => {
      mapInfoWindow.setContent('<strong>Mi ubicación</strong>');
      mapInfoWindow.open({ map, anchor: driverLocationMarker });
    });
  } else {
    driverLocationMarker.position = position;
  }
  if (accuracy) {
    if (!driverAccuracyCircle) {
      driverAccuracyCircle = new google.maps.Circle({ map, center: position, radius: accuracy, strokeColor: '#2563eb', strokeWeight: 1, fillColor: '#3b82f6', fillOpacity: 0.12, clickable: false });
    } else {
      driverAccuracyCircle.setCenter(position);
      driverAccuracyCircle.setRadius(accuracy);
    }
  } else if (driverAccuracyCircle) {
    driverAccuracyCircle.setMap(null);
    driverAccuracyCircle = null;
  }
}

async function centerMapOnDriver() {
  if (!lastDriverLocation) return;
  if (!map) await renderMap();
  if (!map || googleMapsAuthorizationFailed) return;
  map.setCenter({ lat: lastDriverLocation.lat, lng: lastDriverLocation.lng });
  map.setZoom(16);
  mapInfoWindow.setContent('<strong>Mi ubicación</strong>');
  mapInfoWindow.open({ map, anchor: driverLocationMarker });
}

// --- MAPA ---
function getGoogleMapsDirectionsUrl(latValue, lngValue) {
  if (latValue === null || latValue === undefined || String(latValue).trim() === '') return null;
  if (lngValue === null || lngValue === undefined || String(lngValue).trim() === '') return null;

  const lat = Number(latValue);
  const lng = Number(lngValue);
  const valid = Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;

  if (!valid) return null;

  const destination = encodeURIComponent(`${lat},${lng}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}

function normalizeRepartidorWhatsAppPhone(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.startsWith('549')) {
    // Ya está en formato móvil argentino para WhatsApp.
  } else if (digits.startsWith('54')) {
    digits = `549${digits.slice(2)}`;
  } else if (digits.startsWith('9')) {
    digits = `54${digits}`;
  } else {
    digits = `549${digits}`;
  }

  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

function getRepartidorWhatsAppUrl(rawPhone) {
  const phone = normalizeRepartidorWhatsAppPhone(rawPhone);
  return phone ? `https://wa.me/${encodeURIComponent(phone)}` : null;
}

function canStartRouteFromMap(pedido) {
  return String(pedido?.estado || 'pendiente').toLowerCase() === 'pendiente';
}

function buildRepartidorMapPopup(pedido, directionsUrl) {
  const pedidoId = Number(pedido?.id);
  const whatsappUrl = getRepartidorWhatsAppUrl(pedido?.telefono);
  const startRouteButton = canStartRouteFromMap(pedido) && Number.isFinite(pedidoId)
    ? `<button
        type="button"
        class="iconbtn primary"
        onclick="setStatus(${pedidoId}, 'en_ruta', this)"
      >🚚 Iniciar ruta</button>`
    : '';
  const chatButton = whatsappUrl
    ? `<a
        class="iconbtn ghost"
        href="${whatsappUrl}"
        target="_blank"
        rel="noopener noreferrer"
      >💬 Chat</a>`
    : `<button
        type="button"
        class="iconbtn ghost"
        disabled
        aria-disabled="true"
        title="Cliente sin teléfono válido para WhatsApp"
      >💬 Sin teléfono</button>`;

  return `
    <b>${esc(pedido?.cliente)}</b><br>
    ${esc(pedido?.direccion)}<br>
    ${esc(pedido?.estado || '')}<br>
    <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;">
      <a
        class="iconbtn primary"
        href="${directionsUrl}"
        target="_blank"
        rel="noopener noreferrer"
      >🧭 Cómo llegar</a>
      ${startRouteButton}
      ${chatButton}
    </div>
  `;
}

let googleMapsLoadPromise = null;
let googleMapsAuthorizationFailed = false;
let mapInfoWindow = null;

function showRepartidorMapError(message) {
  const error = document.getElementById('mapError');
  if (error) { error.textContent = message; error.hidden = false; }
  const hint = document.getElementById('mapHint');
  if (hint) hint.textContent = message;
}

function loadRepartidorGoogleMaps() {
  if (googleMapsAuthorizationFailed) return Promise.reject(new Error('authorization'));
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  window.gm_authFailure = () => {
    googleMapsAuthorizationFailed = true;
    showRepartidorMapError('Google Maps no autorizó la clave. Revisá las restricciones y Maps JavaScript API.');
  };
  googleMapsLoadPromise = (async () => {
    const response = await authFetch('/api/repartidor/maps-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 503 ? 'configuration' : 'authentication');
    const config = await response.json();
    if (!config.apiKey) throw new Error('configuration');
    if (!window.google?.maps?.marker?.AdvancedMarkerElement) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          delete window.repartidorGoogleMapsReady;
          script.onerror = null;
          if (error) { script.remove(); reject(error); } else resolve();
        };
        const timeout = setTimeout(() => finish(new Error('load')), 20000);
        window.repartidorGoogleMapsReady = () => finish();
        script.onerror = () => finish(new Error('load'));
        const params = new URLSearchParams({ key: config.apiKey, libraries: 'marker', callback: 'repartidorGoogleMapsReady', loading: 'async', v: 'weekly', language: 'es', region: 'AR' });
        script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
        script.async = true;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        document.head.appendChild(script);
      });
    }
    if (googleMapsAuthorizationFailed) throw new Error('authorization');
    return config;
  })().catch(error => { googleMapsLoadPromise = null; throw error; });
  return googleMapsLoadPromise;
}

function resizeRepartidorMap() {
  if (!map || googleMapsAuthorizationFailed) return;
  const center = map.getCenter();
  google.maps.event.trigger(map, 'resize');
  if (center) map.setCenter(center);
}

async function renderMap(){
  try {
    const config = await loadRepartidorGoogleMaps();
    if (googleMapsAuthorizationFailed) return;
    const error = document.getElementById('mapError');
    if (error) error.hidden = true;
    if (!map) {
      map = new google.maps.Map(document.getElementById('map'), {
        center: { lat: -31.4, lng: -64.18 }, zoom: 12,
        mapId: config.mapId || 'DEMO_MAP_ID', mapTypeControl: false, streetViewControl: false,
      });
      mapMarkers = [];
      mapInfoWindow = new google.maps.InfoWindow();
    }
    resizeRepartidorMap();
    mapInfoWindow.close();
    mapMarkers.forEach(marker => { marker.map = null; });
    mapMarkers = [];
    renderStoredDriverLocationOnMap();

  const historical = getHistoricalMode();
  const today = getOyString();
  const fSt = getOperationalStatusFilter();
  const bounds = [];
  pedidos.forEach(p => {
    const directionsUrl = getGoogleMapsDirectionsUrl(p.latitud, p.longitud);
    if(!directionsUrl) return;
    if(historical) {
      if(!isPedidoEntregadoReciente(p, today)) return;
    } else if(normalizeOperationalStatus(String(p.estado || '').toLowerCase()) !== fSt) return;
    const lat = Number(p.latitud), lng = Number(p.longitud);
    const color = p.estado==='entregado'?'#10b981' : p.estado==='en_ruta'?'#06b6d4':'#f59e0b';
    const label = document.createElement('div');
    label.className = 'm-label';
    label.style.borderLeft = `4px solid ${color}`;
    label.textContent = String(p.cliente || '').split(' ')[0];
    const popup = buildRepartidorMapPopup(p, directionsUrl);
    const marker = new google.maps.marker.AdvancedMarkerElement({ map, position: { lat, lng }, content: label, title: String(p.cliente || '') });
    marker.addListener('click', () => {
      mapInfoWindow.setContent(popup);
      mapInfoWindow.open({ map, anchor: marker });
    });
    mapMarkers.push(marker);
    bounds.push({ lat, lng });
  });
  if(bounds.length) {
    const googleBounds = new google.maps.LatLngBounds();
    bounds.forEach(point => googleBounds.extend(point));
    google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 16) map.setZoom(16); });
    map.fitBounds(googleBounds, 50);
  }
  $('#mapHint').textContent = `${bounds.length} puntos visibles`;
  } catch (error) {
    const messages = {
      configuration: 'Google Maps no está configurado. Configurá una clave de navegador restringida.',
      authentication: 'No se pudo acceder a la configuración del mapa. Iniciá sesión como repartidor.',
      authorization: 'Google Maps no autorizó la clave. Revisá las restricciones y Maps JavaScript API.',
    };
    showRepartidorMapError(messages[error.message] || 'No se pudo cargar Google Maps. Revisá tu conexión y actualizá el mapa.');
  }
}

// --- GPS TRACKING LOOP (endurecido) ---
// Objetivo: no spamear requests, manejar mala señal, y evitar concurrencia.

function scheduleNextGpsTick(mult = 1) {
  gpsSyncState.nextInMs = Math.min(Math.max(15_000, Math.floor(gpsSyncState.nextInMs * mult)), gpsSyncState.maxMs);
}

async function gpsTick() {
  if (gpsSyncState.disabled) return;

  // Solo si hay pedidos en ruta
  const activePed = pedidos.find(p => ['en_ruta', 'en_camino'].includes(p.estado));
  if (!activePed) return;

  // Si el navegador dice offline, no insistimos
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
    scheduleNextGpsTick(1.8);
    return;
  }

  if (!navigator.geolocation || gpsSyncState.denied) {
    // Sin GPS o permiso denegado: frenamos y no molestamos
    gpsSyncState.disabled = true;
    updateGpsButtonUI();
    return;
  }

  try {
    await withLock('gps:track', async () => {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTS_TRACK);
      });
      updateDriverLocationOnMap(pos);

      await api('/api/track/update', {
        method: 'POST',
        body: {
          pedido_id: activePed.id,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }
      });
    });

    gpsSyncState.lastOkAt = Date.now();
    gpsSyncState.nextInMs = 60_000; // reset al ritmo normal
    updateGpsButtonUI();
  } catch (e) {
    // Si es permiso denegado, deshabilitar definitivamente
    const code = e?.cause?.code; // geolocation error code
    if (code === 1) { // PERMISSION_DENIED
      gpsSyncState.denied = true;
      gpsSyncState.disabled = true;
      persistGpsPreference(false);
      updateGpsButtonUI();
      toast('📍 GPS desactivado: sin permiso.');
      return;
    }

    // Backoff progresivo ante fallos (red/timeout/etc)
    scheduleNextGpsTick(1.6);
    // Evitar spam de toasts; solo avisar si hace rato no sincroniza
    if (!gpsSyncState.lastOkAt || (Date.now() - gpsSyncState.lastOkAt) > 5 * 60_000) {
      console.warn('GPS sync failed', e);
    }
  }
}

(async function gpsLoop(){
  while (true) {
    await gpsTick();
    await new Promise(r => setTimeout(r, gpsSyncState.nextInMs));
  }
})();
