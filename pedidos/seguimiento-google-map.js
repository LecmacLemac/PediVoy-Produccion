// Public order tracking uses the same validated token and TTL as the data API.
var seguimientoGoogleLoadPromise = null;
var seguimientoGoogleAuthFailed = false;
var seguimientoMapResizeObserver = null;

function showSeguimientoMapError(message) {
  const node = document.getElementById('googleMapError');
  if (node) { node.hidden = false; node.textContent = message; }
}

function resizeSeguimientoMap() {
  const element = document.getElementById('map');
  const card = document.getElementById('hudCard');
  // Keep Google's attribution and controls above the customer card, not hidden by it.
  if (element && card) element.style.height = Math.max(160, card.getBoundingClientRect().top - 8) + 'px';
  if (!map || seguimientoGoogleAuthFailed) return;
  const center = map.getCenter();
  google.maps.event.trigger(map, 'resize');
  if (center) map.setCenter(center);
}

async function initMap() {
  if (!TOKEN || seguimientoGoogleAuthFailed) return false;
  if (map) return true;
  try {
    if (!seguimientoGoogleLoadPromise) {
      window.gm_authFailure = () => {
        seguimientoGoogleAuthFailed = true;
        if (driverMarker) { driverMarker.map = null; driverMarker = null; }
        if (trajectoryLine) { trajectoryLine.setMap(null); trajectoryLine = null; }
        showSeguimientoMapError('Google Maps no autorizó el mapa. Los datos de tu pedido siguen disponibles.');
      };
      seguimientoGoogleLoadPromise = (async () => {
        const response = await fetch(`/api/public/tracking/${encodeURIComponent(TOKEN)}?map_config=1`, { cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 503 ? 'configuration' : 'access');
        const config = await response.json();
        if (!config.apiKey) throw new Error('configuration');
        if (!window.google?.maps?.marker?.AdvancedMarkerElement) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            let settled = false;
            const finish = error => {
              if (settled) return;
              settled = true; clearTimeout(timer); delete window.seguimientoGoogleMapsReady;
              script.onerror = null;
              if (error) { script.remove(); reject(error); } else resolve();
            };
            const timer = setTimeout(() => finish(new Error('network')), 20000);
            window.seguimientoGoogleMapsReady = () => finish();
            script.onerror = () => finish(new Error('network'));
            script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key: config.apiKey, libraries: 'marker', callback: 'seguimientoGoogleMapsReady', loading: 'async', language: 'es', region: 'AR', v: 'weekly' });
            script.async = true;
            script.referrerPolicy = 'strict-origin-when-cross-origin';
            document.head.appendChild(script);
          });
        }
        return config;
      })().catch(error => { seguimientoGoogleLoadPromise = null; throw error; });
    }
    const config = await seguimientoGoogleLoadPromise;
    if (seguimientoGoogleAuthFailed) return false;
    if (!map) {
      resizeSeguimientoMap();
      map = new google.maps.Map(document.getElementById('map'), { center: { lat: -38.4161, lng: -63.6167 }, zoom: 4, mapId: config.mapId || 'DEMO_MAP_ID', mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
      if (window.ResizeObserver) {
        seguimientoMapResizeObserver = new ResizeObserver(resizeSeguimientoMap);
        seguimientoMapResizeObserver.observe(document.getElementById('hudCard'));
      }
      window.addEventListener('resize', resizeSeguimientoMap);
    }
    document.getElementById('googleMapError').hidden = true;
    return true;
  } catch (error) {
    const message = error.message === 'configuration'
      ? 'El mapa no está configurado. Los datos de tu pedido siguen disponibles.'
      : error.message === 'access'
        ? 'No se pudo autorizar el mapa con este enlace de seguimiento.'
        : 'No se pudo cargar Google Maps. Revisá tu conexión; los datos de tu pedido siguen disponibles.';
    showSeguimientoMapError(message);
    return false;
  }
}
