// On-demand Google Maps SDK for the client editor; browser key only.
let clientesGoogleLoadPromise = null;
let clientesGoogleAuthorizationFailed = false;
const clientesGoogleAuthorizationMessage = 'Google Maps no autorizó la clave. Revisá los dominios permitidos y Maps JavaScript API.';

async function loadClientesGoogleMaps(authFetch, onAuthorizationError) {
  if (clientesGoogleAuthorizationFailed) throw new Error(clientesGoogleAuthorizationMessage);
  if (clientesGoogleLoadPromise) return clientesGoogleLoadPromise;
  clientesGoogleLoadPromise = (async () => {
    const response = await authFetch('/api/clientes/maps-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 503
      ? 'Google Maps no está configurado. Configurá GOOGLE_MAPS_BROWSER_API_KEY.'
      : 'No se pudo acceder al mapa. Iniciá sesión con permisos administrativos.');
    const config = await response.json();
    if (!config.apiKey) throw new Error('Google Maps no está configurado.');
    let rejectSDK;
    window.gm_authFailure = () => {
      clientesGoogleAuthorizationFailed = true;
      onAuthorizationError?.(clientesGoogleAuthorizationMessage);
      rejectSDK?.(new Error(clientesGoogleAuthorizationMessage));
    };
    if (!window.google?.maps?.marker?.AdvancedMarkerElement) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          delete window.clientesGoogleMapsReady;
          script.onerror = null;
          rejectSDK = null;
          if (error) { script.remove(); reject(error); } else resolve();
        };
        rejectSDK = finish;
        const timer = setTimeout(() => finish(new Error('No se pudo cargar Google Maps. Revisá la conexión e intentá nuevamente.')), 20000);
        window.clientesGoogleMapsReady = () => finish();
        script.onerror = () => finish(new Error('No se pudo cargar Google Maps. Revisá la conexión e intentá nuevamente.'));
        script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({
          key: config.apiKey, libraries: 'marker', callback: 'clientesGoogleMapsReady', loading: 'async', language: 'es', region: 'AR', v: 'weekly',
        });
        script.async = true;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        document.head.appendChild(script);
      });
    }
    if (clientesGoogleAuthorizationFailed) throw new Error(clientesGoogleAuthorizationMessage);
    return config;
  })().catch(error => { clientesGoogleLoadPromise = null; throw error; });
  return clientesGoogleLoadPromise;
}

function clientesMapCoordinate(latValue, lngValue) {
  if (latValue == null || lngValue == null || String(latValue).trim() === '' || String(lngValue).trim() === '') return null;
  const lat = Number(latValue), lng = Number(lngValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}
