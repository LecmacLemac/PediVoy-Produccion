// Presentation only: the screen retains its authenticated business-data APIs.
(() => {
  'use strict';
  const messages = {
    configuration: 'Google Maps no está configurado. Revisá la clave de navegador y el ID de mapa.',
    permission: 'No se pudo acceder al mapa. Se requieren permisos de super admin.',
    authorization: 'Google Maps no autorizó la clave. Revisá los dominios permitidos y Maps JavaScript API.',
    network: 'No se pudo cargar Google Maps. Revisá la conexión y recargá la página.',
  };
  let sdkPromise, authorizationFailed = false, rejectPending;
  const errorNode = () => document.getElementById('mapError');
  function showError(code) {
    const node = errorNode();
    node.textContent = messages[code] || messages.network;
    node.hidden = false;
  }
  function coordinate(latValue, lngValue) {
    if (![latValue, lngValue].every(v => (typeof v === 'number' || typeof v === 'string') && String(v).trim() !== '')) return null;
    const lat = Number(latValue), lng = Number(lngValue);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (!lat && !lng)) return null;
    return { lat, lng };
  }
  function clientKey(item) {
    const p = coordinate(item.cliente_lat, item.cliente_lng);
    return `${item.cliente_id || ''}|${item.telefono || ''}|${p?.lat}|${p?.lng}`;
  }
  function driverKey(item) { return String(item.chofer_id || item.pedido_id || `${item.latitud}|${item.longitud}`); }
  function loadSDK(authFetch, onFailure) {
    if (sdkPromise) return sdkPromise;
    window.gm_authFailure = () => {
      authorizationFailed = true;
      onFailure();
      showError('authorization');
      rejectPending?.(new Error('authorization'));
    };
    // One bounded promise includes configuration, SDK callback and library imports.
    sdkPromise = new Promise((resolve, reject) => {
      const controller = new AbortController();
      let script, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPending = null;
        delete window.marketingGoogleMapsReady;
        if (script) script.onerror = null;
        if (error) { controller.abort(); script?.remove(); reject(error); } else resolve(value);
      };
      rejectPending = finish;
      const timer = setTimeout(() => finish(new Error('network')), 20000);
      (async () => {
        const response = await authFetch('/api/setup/marketing/maps-config', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 503 ? 'configuration' : 'permission');
        const config = await response.json();
        if (!config.ok || typeof config.apiKey !== 'string' || !config.apiKey.trim() || typeof config.mapId !== 'string' || !config.mapId.trim()) throw new Error('configuration');
        if (settled) return;
        if (!window.google?.maps?.importLibrary) {
          await new Promise((sdkResolve, sdkReject) => {
            window.marketingGoogleMapsReady = sdkResolve;
            script = document.createElement('script');
            script.async = true;
            script.referrerPolicy = 'strict-origin-when-cross-origin';
            script.onerror = () => sdkReject(new Error('network'));
            script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key: config.apiKey, callback: 'marketingGoogleMapsReady', libraries: 'maps,marker', loading: 'async', language: 'es', region: 'AR', v: 'weekly' });
            document.head.appendChild(script);
          });
        }
        if (settled) return;
        const [maps, marker] = await Promise.all([google.maps.importLibrary('maps'), google.maps.importLibrary('marker')]);
        if (authorizationFailed) throw new Error('authorization');
        finish(null, { maps, marker, mapId: config.mapId });
      })().catch(error => finish(new Error(messages[error.message] ? error.message : 'network')));
    });
    return sdkPromise;
  }

  function create(authFetch) {
    let map, sdk, scope, revision = 0, fitted = false;
    const clients = new Map(), drivers = new Map();
    let info, line, focusIdleListener, selectedKey = null;
    let latestItems = [], latestTracks = [];
    function clear() {
      for (const marker of [...clients.values(), ...drivers.values()]) marker.map = null;
      clients.clear(); drivers.clear(); info?.close(); line?.setMap(null); line = null;
      focusIdleListener?.remove(); focusIdleListener = null;
    }
    function reset(nextScope) {
      scope = nextScope; revision++; fitted = false; selectedKey = null; latestItems = []; latestTracks = []; clear();
      focusIdleListener?.remove(); focusIdleListener = null;
      if (map) { map.setOptions({ maxZoom: 19 }); map.setCenter({ lat: -24.79, lng: -65.41 }); map.setZoom(12); }
    }
    function popup(lines) {
      const node = document.createElement('div');
      node.className = 'marketing-map-popup';
      for (const [label, value] of lines) {
        const row = document.createElement('div'), title = document.createElement('strong');
        title.textContent = label + ': '; row.append(title, document.createTextNode(String(value ?? '-'))); node.append(row);
      }
      return node;
    }
    function pin(position, title, color, lines, symbol = '●') {
      const content = document.createElement('div');
      content.className = 'marketing-map-pin'; content.style.backgroundColor = color; content.textContent = symbol;
      const marker = new sdk.marker.AdvancedMarkerElement({ map, position, content, title });
      marker.addListener('click', () => { if (authorizationFailed) return; info.setOptions({ disableAutoPan: false }); info.setContent(popup(lines)); info.open({ map, anchor: marker }); });
      return marker;
    }
    function focus(item, changeCamera = true) {
      const p = coordinate(item?.cliente_lat, item?.cliente_lng);
      if (!p) return;
      selectedKey = clientKey(item);
      if (!map || authorizationFailed || !clients.has(selectedKey)) return;
      line?.setMap(null); line = null;
      for (const marker of clients.values()) marker.content.style.outline = '';
      const anchor = clients.get(selectedKey);
      anchor.content.style.outline = '3px solid #22d3ee';
      let nearest;
      // Match the rendered, deduplicated driver positions, not hidden duplicates.
      const seen = new Set();
      for (const driver of latestTracks) {
        const q = coordinate(driver.latitud, driver.longitud), key = driverKey(driver);
        if (!q || seen.has(key) || !drivers.has(key)) continue;
        seen.add(key);
        const radians = value => value * Math.PI / 180;
        const a = Math.sin(radians(q.lat - p.lat) / 2) ** 2 + Math.cos(radians(p.lat)) * Math.cos(radians(q.lat)) * Math.sin(radians(q.lng - p.lng) / 2) ** 2;
        const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
        if (!nearest || km < nearest.km) nearest = { driver, position: q, km };
      }
      const bounds = new google.maps.LatLngBounds(); bounds.extend(p);
      const lines = [['Cliente', item.cliente || 'N/D'], ['Dirección', item.direccion || 'N/D'], ['Tel', item.telefono], ['Conversión', latestItems.some(r => clientKey(r) === selectedKey && r.convirtio) ? '✅ Sí' : '❌ No']];
      if (nearest) {
        bounds.extend(nearest.position);
        line = new google.maps.Polyline({ map, path: [p, nearest.position], strokeColor: '#f59e0b', strokeWeight: 3, strokeOpacity: 0.9, geodesic: false });
        lines.push(['Chofer más cercano', `${nearest.driver.chofer_nombre || 'N/D'} · ${nearest.km.toFixed(2)} km (distancia en línea recta)`]);
      }
      info.setContent(popup(lines));
      const open = () => {
        if (authorizationFailed || !clients.has(selectedKey)) return;
        // Explicit selection may pan to reveal the whole popup; passive refresh must not.
        info.setOptions({ disableAutoPan: !changeCamera });
        info.open({ map, anchor, shouldFocus: false });
      };
      if (changeCamera) {
        focusIdleListener?.remove(); focusIdleListener = null;
        if (nearest) {
          // Open after framing: an earlier autopan would be overwritten by fitBounds.
          map.setOptions({ maxZoom: 16 });
          focusIdleListener = google.maps.event.addListenerOnce(map, 'idle', () => {
            map.setOptions({ maxZoom: 19 }); focusIdleListener = null; open();
          });
          map.fitBounds(bounds, 60);
        } else { map.setOptions({ maxZoom: 19 }); map.setCenter(p); map.setZoom(16); open(); }
      } else open();
    }
    async function render(items, tracks, nextScope) {
      if (scope !== nextScope) reset(nextScope);
      const token = ++revision;
      try {
        const loaded = await loadSDK(authFetch, clear);
        if (token !== revision || scope !== nextScope || authorizationFailed) return;
        sdk = loaded; latestItems = items; latestTracks = tracks;
        if (!map) { map = new sdk.maps.Map(document.getElementById('map'), { center: { lat: -24.79, lng: -65.41 }, zoom: 12, maxZoom: 19, mapId: sdk.mapId, streetViewControl: false, mapTypeControl: false }); info = new google.maps.InfoWindow({ disableAutoPan: true }); }
        errorNode().hidden = true;
        clear();
        const bounds = new google.maps.LatLngBounds(); let count = 0;
        const aggregate = new Map();
        for (const item of items) {
          if (!coordinate(item.cliente_lat, item.cliente_lng)) continue;
          const key = clientKey(item), prev = aggregate.get(key);
          if (!prev) aggregate.set(key, { ...item, convirtio: !!item.convirtio }); else prev.convirtio ||= !!item.convirtio;
        }
        for (const [key, item] of aggregate) {
          const p = coordinate(item.cliente_lat, item.cliente_lng);
          clients.set(key, pin(p, `Cliente: ${item.cliente || 'N/D'}`, item.convirtio ? '#22c55e' : '#ef4444', [['Cliente', item.cliente || 'N/D'], ['Dirección', item.direccion || 'N/D'], ['Tel', item.telefono], ['Conversión', item.convirtio ? '✅ Sí' : '❌ No']]));
          bounds.extend(p); count++;
        }
        for (const item of tracks) {
          const p = coordinate(item.latitud, item.longitud), key = driverKey(item);
          if (!p || drivers.has(key)) continue;
          drivers.set(key, pin(p, `Repartidor: ${item.chofer_nombre || 'Sin nombre'}`, '#2563eb', [['Repartidor', item.chofer_nombre || 'Sin nombre'], ['Pedido', item.pedido_id], ['Estado', item.estado]], '🚚'));
          bounds.extend(p); count++;
        }
        const selected = selectedKey && items.find(r => clientKey(r) === selectedKey);
        if (selected) { focus(selected, !fitted); fitted = true; } else selectedKey = null;
        if (count && !fitted) { if (count === 1) { map.setCenter(bounds.getCenter()); map.setZoom(14); } else map.fitBounds(bounds, 30); fitted = true; }
      } catch (error) { if (token === revision && scope === nextScope) showError(error.message); }
    }
    return { render, reset, focus };
  }
  window.MarketingGoogleMap = { create, coordinate, clientKey };
})();
