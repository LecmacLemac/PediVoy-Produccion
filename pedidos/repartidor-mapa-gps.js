function initRepartidorMapaGpsUI() {
  $('#mapFiltroEstado').addEventListener('change', renderMap);
  $('#mapSoloHoy').addEventListener('change', renderMap);
  $('#mapRefBtn').onclick = () => { loadPedidos().then(renderMap); };

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

function restoreGpsPreference() {
  try {
    const raw = safeStorage.local.get(GPS_PREF_LS_KEY);
    if (raw === '1') gpsSyncState.disabled = false;
  } catch {}
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
  if (!navigator.geolocation) {
    toast('GPS no disponible');
    return;
  }

  if (!window.isSecureContext) {
    toast('Abrí por HTTPS para usar GPS');
    showGpsHelp();
    return;
  }

  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTS_ACTIVATE);
    });

    gpsSyncState.disabled = false;
    gpsSyncState.denied = false;
    gpsSyncState.lastOkAt = Date.now();
    gpsSyncState.nextInMs = 60_000;
    persistGpsPreference(true);
    updateGpsButtonUI();

    // Ping inicial si ya tiene pedido en ruta
    const activePed = pedidos.find(p => p.estado === 'en_ruta');
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

    toast('📍 GPS activado');
  } catch (e) {
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

function renderMap(){
  if(!map) { map = L.map('map').setView([-31.4, -64.18], 12); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map); mapMarkers = L.layerGroup().addTo(map); }
  map.invalidateSize(); mapMarkers.clearLayers();

  const fSt = $('#mapFiltroEstado').value, fHoy = $('#mapSoloHoy').checked, today = getOyString();
  const bounds = [];
  pedidos.forEach(p => {
    const directionsUrl = getGoogleMapsDirectionsUrl(p.latitud, p.longitud);
    if(!directionsUrl) return;
    if(fHoy && getPedidoFechaOperativa(p) !== today) return;
    if(fSt && p.estado !== fSt) return;
    const lat = Number(p.latitud), lng = Number(p.longitud);
    const color = p.estado==='entregado'?'#10b981' : p.estado==='en_ruta'?'#06b6d4':'#f59e0b';
    const icon = L.divIcon({ className: '', html: `<div class="m-label" style="border-left:4px solid ${color}">${esc(p.cliente.split(' ')[0])}</div>` });
    const popup = buildRepartidorMapPopup(p, directionsUrl);
    L.marker([lat, lng], {icon}).addTo(mapMarkers).bindPopup(popup);
    bounds.push([lat, lng]);
  });
  if(bounds.length) map.fitBounds(bounds, {padding:[50,50], maxZoom:16});
  $('#mapHint').textContent = `${bounds.length} puntos visibles`;
}

// --- GPS TRACKING LOOP (endurecido) ---
// Objetivo: no spamear requests, manejar mala señal, y evitar concurrencia.

function scheduleNextGpsTick(mult = 1) {
  gpsSyncState.nextInMs = Math.min(Math.max(15_000, Math.floor(gpsSyncState.nextInMs * mult)), gpsSyncState.maxMs);
}

async function gpsTick() {
  if (gpsSyncState.disabled) return;

  // Solo si hay pedidos en ruta
  const activePed = pedidos.find(p => p.estado === 'en_ruta');
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
