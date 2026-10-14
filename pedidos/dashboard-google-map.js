// On-demand SDK loader for the dashboard's editable delivery-location map.
let loadPromise = null;
let authorizationFailed = false;
const authorizationMessage = 'Google Maps no autorizó la clave. Revisá los dominios permitidos y Maps JavaScript API.';

export async function loadDashboardGoogleMaps(authFetch, onAuthorizationError) {
  if (authorizationFailed) throw new Error(authorizationMessage);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const response = await authFetch('/api/pedidos/maps-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 503
      ? 'Google Maps no está configurado. Configurá GOOGLE_MAPS_BROWSER_API_KEY.'
      : 'No se pudo acceder al mapa. Iniciá sesión con permisos administrativos.');
    const config = await response.json();
    if (!config.apiKey) throw new Error('Google Maps no está configurado.');
    let rejectSDK;
    window.gm_authFailure = () => {
      authorizationFailed = true;
      onAuthorizationError?.(authorizationMessage);
      rejectSDK?.(new Error(authorizationMessage));
    };
    if (!window.google?.maps?.marker?.AdvancedMarkerElement) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          delete window.dashboardGoogleMapsReady;
          script.onerror = null;
          rejectSDK = null;
          if (error) { script.remove(); reject(error); } else resolve();
        };
        rejectSDK = finish;
        const timer = setTimeout(() => finish(new Error('No se pudo cargar Google Maps. Revisá la conexión e intentá nuevamente.')), 20000);
        window.dashboardGoogleMapsReady = () => finish();
        script.onerror = () => finish(new Error('No se pudo cargar Google Maps. Revisá la conexión e intentá nuevamente.'));
        script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({
          key: config.apiKey, libraries: 'marker', callback: 'dashboardGoogleMapsReady', loading: 'async', language: 'es', region: 'AR', v: 'weekly',
        });
        script.async = true;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        document.head.appendChild(script);
      });
    }
    if (authorizationFailed) throw new Error(authorizationMessage);
    return config;
  })().catch(error => { loadPromise = null; throw error; });
  return loadPromise;
}
