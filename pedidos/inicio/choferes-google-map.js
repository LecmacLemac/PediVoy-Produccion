// Google Maps renderer for the administrative fleet-tracking screen only.
var trackingGoogleLoadPromise = null;
var trackingGoogleAuthFailed = false;
var trackingInfoWindow = null;
var trackingHasFitted = false;
var trackingMapScope = null;

function trackingMapError(message) {
  const node = document.getElementById('trackingMapError');
  if (node) { node.hidden = false; node.textContent = message; }
}

async function loadTrackingGoogleMaps() {
  if (trackingGoogleAuthFailed) throw new Error('authorization');
  if (trackingGoogleLoadPromise) return trackingGoogleLoadPromise;
  window.gm_authFailure = () => {
    trackingGoogleAuthFailed = true;
    trackingMapError('Google Maps no autorizó la clave. Revisá los dominios permitidos y Maps JavaScript API.');
  };
  trackingGoogleLoadPromise = (async () => {
    const response = await authFetch('/api/choferes/maps-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 503 ? 'configuration' : 'authentication');
    const config = await response.json();
    if (!config.apiKey) throw new Error('configuration');
    if (!window.google?.maps?.marker?.AdvancedMarkerElement) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer); delete window.choferesGoogleMapsReady;
          script.onerror = null;
          if (error) { script.remove(); reject(error); } else resolve();
        };
        const timer = setTimeout(() => finish(new Error('network')), 20000);
        window.choferesGoogleMapsReady = () => finish();
        script.onerror = () => finish(new Error('network'));
        script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key: config.apiKey, libraries: 'marker', callback: 'choferesGoogleMapsReady', loading: 'async', language: 'es', region: 'AR', v: 'weekly' });
        script.async = true;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        document.head.appendChild(script);
      });
    }
    if (trackingGoogleAuthFailed) throw new Error('authorization');
    return config;
  })().catch(error => { trackingGoogleLoadPromise = null; throw error; });
  return trackingGoogleLoadPromise;
}

async function initTrackingMap() {
  if (trackingMap) return !trackingGoogleAuthFailed;
  try {
    const config = await loadTrackingGoogleMaps();
    if (!trackingMap) {
      trackingMap = new google.maps.Map(document.getElementById('trackingMap'), { center: { lat: -24.79, lng: -65.41 }, zoom: 12, mapId: config.mapId || 'DEMO_MAP_ID', streetViewControl: false, mapTypeControl: false });
      trackingInfoWindow = new google.maps.InfoWindow();
      trackingMarkersLayer = [];
      trackingTrailLayer = [];
    }
    const error = document.getElementById('trackingMapError');
    if (error) error.hidden = true;
    return true;
  } catch (error) {
    const messages = { configuration: 'Google Maps no está configurado. Configurá GOOGLE_MAPS_BROWSER_API_KEY.', authentication: 'No se pudo acceder al mapa. Iniciá sesión con permisos administrativos.', authorization: 'Google Maps no autorizó la clave. Revisá los dominios permitidos y Maps JavaScript API.' };
    trackingMapError(messages[error.message] || 'No se pudo cargar Google Maps. Revisá tu conexión y reintentá.');
    return false;
  }
}

function resizeTrackingMap() {
  if (!trackingMap || trackingGoogleAuthFailed) return;
  const center = trackingMap.getCenter();
  google.maps.event.trigger(trackingMap, 'resize');
  if (center) trackingMap.setCenter(center);
}

function trackingCoordinate(latValue, lngValue) {
  if (latValue == null || lngValue == null || String(latValue).trim() === '' || String(lngValue).trim() === '') return null;
  const lat = Number(latValue), lng = Number(lngValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

function pushTrailPoint(pedidoId, lat, lng) {
  if (!trackingCoordinate(lat, lng)) return;
  const key = String(pedidoId || '0');
  const points = trackingTrails.get(key) || [];
  const last = points.at(-1);
  if (!last || last[0] !== lat || last[1] !== lng) points.push([lat, lng]);
  if (points.length > 15) points.shift();
  trackingTrails.set(key, points);
}

function trackingPin(position, title, symbol, className, popup) {
  const content = document.createElement('div');
  content.className = 'map-pin ' + className;
  content.textContent = symbol;
  const marker = new google.maps.marker.AdvancedMarkerElement({ map: trackingMap, position, content, title });
  if (popup) marker.addListener('click', () => { trackingInfoWindow.setContent(popup); trackingInfoWindow.open({ map: trackingMap, anchor: marker }); });
  trackingMarkersLayer.push(marker);
  return marker;
}

function focusIncident(pedidoId) {
  const marker = trackingMarkerByPedido.get(String(pedidoId));
  if (!marker || !trackingMap || trackingGoogleAuthFailed) return;
  trackingMap.setCenter(marker.position);
  trackingMap.setZoom(16);
  if (marker.trackingPopup) { trackingInfoWindow.setContent(marker.trackingPopup); trackingInfoWindow.open({ map: trackingMap, anchor: marker }); }
}

function renderTrackingMap(items = [], presenceItems = [], { refit = false } = {}) {
  if (!trackingMap || trackingGoogleAuthFailed) return;
  const scope = String(STATE.isSuper ? $('#empFilter')?.value || '' : STATE.user?.empresa_id || '');
  if (scope !== trackingMapScope) {
    trackingMapScope = scope;
    trackingTrails.clear();
    trackingHasFitted = false;
  }
  trackingInfoWindow.close();
  trackingMarkersLayer.forEach(marker => { marker.map = null; });
  trackingTrailLayer.forEach(line => line.setMap(null));
  trackingMarkersLayer = []; trackingTrailLayer = [];
  trackingMarkerByPedido.clear();
  const bounds = [];
  items.forEach(item => {
    const position = trackingCoordinate(item.latitud, item.longitud);
    if (!position) return;
    const pedidoId = Number(item.pedido_id || 0);
    pushTrailPoint(pedidoId, position.lat, position.lng);
    const popup = `<div style="min-width:190px"><strong>Pedido #${pedidoId}</strong><br><small>${esc(item.chofer_nombre || 'Sin chofer')} · ${esc(item.estado || '-')}</small><br><small>Cliente: ${esc(item.cliente || '-')}</small><br><small>Última señal: ${esc(fmtAgo(item.timestamp))}</small></div>`;
    const marker = trackingPin(position, item.chofer_nombre || 'Repartidor', '🚚', 'map-pin-truck', popup);
    marker.trackingPopup = popup;
    trackingMarkerByPedido.set(String(pedidoId), marker);
    const trail = trackingTrails.get(String(pedidoId));
    if (trail?.length > 1) trackingTrailLayer.push(new google.maps.Polyline({ map: trackingMap, path: trail.map(([lat,lng]) => ({lat,lng})), strokeColor: '#22d3ee', strokeWeight: 2, strokeOpacity: .6 }));
    bounds.push(position);
    const destination = trackingCoordinate(item.dest_lat, item.dest_lng);
    if (destination) trackingPin(destination, 'Domicilio', '🏠', 'map-pin-home');
  });
  const activeDriverBounds = presenceItems.filter(item => !isStale(item.timestamp, 180)).map(item => trackingCoordinate(item.latitud, item.longitud)).filter(Boolean);
  let selected = activeDriverBounds.length ? activeDriverBounds : bounds;
  if ($('#trackingFocusAlerts')?.checked) {
    const alerts = items.filter(item => buildAlert(item).text !== 'Normal').map(item => trackingCoordinate(item.latitud, item.longitud)).filter(Boolean);
    if (alerts.length) selected = alerts;
  }
  if (selected.length && (!trackingHasFitted || refit)) {
    const box = new google.maps.LatLngBounds();
    selected.forEach(point => box.extend(point));
    google.maps.event.addListenerOnce(trackingMap, 'idle', () => { if (trackingMap.getZoom() > 15) trackingMap.setZoom(15); });
    trackingMap.fitBounds(box, 40);
    trackingHasFitted = true;
  }
}
