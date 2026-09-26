import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('pedidos/repartidor.html');
const core = read('pedidos/repartidor-core.js');
const pedidosSource = read('pedidos/repartidor-pedidos.js');
const gpsSource = read('pedidos/repartidor-mapa-gps.js');
const entregaSource = read('pedidos/repartidor-entrega.js');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('tarjetas y mapa usan controles segmentados accesibles con contadores', () => {
  assert.doesNotMatch(html, /<select[^>]+id="(?:fEstado|mapFiltroEstado)"/);
  const labels = { pedidos: 'Filtrar pedidos de la lista', mapa: 'Filtrar pedidos del mapa' };
  for (const scope of ['pedidos', 'mapa']) {
    assert.match(html, new RegExp(`role="group"[^>]+aria-label="${labels[scope]}"`));
    assert.match(html, new RegExp(`data-filter-scope="${scope}"[\\s\\S]*?data-status-filter="pendiente"[\\s\\S]*?aria-pressed="true"`));
    assert.match(html, new RegExp(`data-filter-scope="${scope}"[\\s\\S]*?data-status-filter="en_ruta"[\\s\\S]*?aria-pressed="false"`));
    assert.match(html, new RegExp(`data-filter-scope="${scope}"[\\s\\S]*?data-status-count="pendiente"`));
    assert.match(html, new RegExp(`data-filter-scope="${scope}"[\\s\\S]*?data-status-count="en_ruta"`));
  }
});

test('el filtro operativo se sincroniza, cuenta estados y persiste con safeStorage', () => {
  const buttons = ['pendiente', 'en_ruta', 'pendiente', 'en_ruta'].map((status) => ({
    dataset: { statusFilter: status },
    attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
  }));
  const counts = ['pendiente', 'en_ruta', 'pendiente', 'en_ruta'].map((status) => ({ dataset: { statusCount: status }, textContent: '' }));
  let saved = null;
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[data-status-filter]') return buttons;
      if (selector === '[data-status-count]') return counts;
      return [];
    },
  };
  const context = vm.createContext({
    document,
    safeStorage: { local: { get: () => null, set: (_key, value) => { saved = JSON.parse(value); } } },
    console,
    setTimeout,
    clearTimeout,
    fetch() {},
    FormData: class {},
  });
  vm.runInContext(core, context);
  vm.runInContext("pedidos = [{estado:'pendiente'}, {estado:'en_ruta'}, {estado:'en_camino'}, {estado:'entregado'}, {estado:'cancelado'}]", context);
  context.setOperationalStatusFilter('en_ruta', { render: false });

  assert.deepEqual(buttons.map((button) => button.attributes['aria-pressed']), ['false', 'true', 'false', 'true']);
  assert.deepEqual(counts.map((count) => count.textContent), ['1', '2', '1', '2']);
  assert.equal(saved.estado, 'en_ruta');
  assert.equal(context.getOperationalStatusFilter(), 'en_ruta');
});

test('tarjetas y mapa consumen el mismo filtro operativo sin selectores duplicados', () => {
  assert.doesNotMatch(pedidosSource, /#fEstado/);
  assert.doesNotMatch(gpsSource, /#mapFiltroEstado/);
  assert.match(pedidosSource, /getOperationalStatusFilter\(\)/);
  assert.match(gpsSource, /getOperationalStatusFilter\(\)/);
  assert.match(pedidosSource, /initOperationalStatusFilters\(\)/);
});

test('el mapa ofrece centrar la ubicación y define el punto azul pulsante', () => {
  assert.match(html, /id="mapCenterMe"[^>]*disabled[^>]*>[^<]*Centrar en mi ubicación/);
  assert.match(html, /\.driver-location-dot[\s\S]*background:\s*#(?:2563eb|3b82f6)/i);
  assert.match(html, /@keyframes driverLocationPulse/);
  assert.match(html, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.driver-location-dot::after\s*\{[\s\S]*?animation:\s*none/);
});

test('la ubicación GPS actualiza marcador y precisión sin recentrar automáticamente', () => {
  let markerCreates = 0;
  let circleCreates = 0;
  let setViewCalls = 0;
  const centerButton = { disabled: true };
  const marker = {
    popup: '',
    addTo() { return this; },
    bindPopup(value) { this.popup = value; return this; },
    setLatLng(value) { this.latlng = value; return this; },
  };
  const circle = {
    addTo() { return this; },
    setLatLng(value) { this.latlng = value; return this; },
    setRadius(value) { this.radius = value; return this; },
  };
  const context = vm.createContext({
    document: { getElementById: (id) => id === 'mapCenterMe' ? centerButton : null },
    map: { setView() { setViewCalls += 1; }, removeLayer() {} },
    L: {
      divIcon: (options) => options,
      marker: () => { markerCreates += 1; return marker; },
      circle: () => { circleCreates += 1; return circle; },
    },
    Number,
  });
  const locationSource = slice(gpsSource, 'let driverLocationMarker', '// --- MAPA ---');
  vm.runInContext(locationSource, context);

  context.updateDriverLocationOnMap({ coords: { latitude: -31.4, longitude: -64.18, accuracy: 24 } });
  context.updateDriverLocationOnMap({ coords: { latitude: -31.41, longitude: -64.19, accuracy: 12 } });

  assert.equal(markerCreates, 1);
  assert.equal(circleCreates, 1);
  assert.deepEqual(Array.from(marker.latlng), [-31.41, -64.19]);
  assert.equal(circle.radius, 12);
  assert.match(marker.popup, /Mi ubicación/);
  assert.equal(centerButton.disabled, false);
  assert.equal(setViewCalls, 0);
});

test('activación y gpsTick refrescan la ubicación visible sin traza', () => {
  const activation = slice(gpsSource, 'async function requestGpsActivation()', 'let driverLocationMarker');
  const tick = slice(gpsSource, 'async function gpsTick()', '(async function gpsLoop');
  assert.match(activation, /updateDriverLocationOnMap\(pos\)/);
  assert.match(tick, /updateDriverLocationOnMap\(pos\)/);
  assert.doesNotMatch(gpsSource, /L\.polyline|locationHistory|gpsTrail/i);
});

test('activar GPS trackea un pedido en_camino con una sola lectura de ubicación', async () => {
  let gpsReads = 0;
  let markerUpdates = 0;
  const trackCalls = [];
  const context = vm.createContext({
    document: { getElementById: () => null },
    navigator: { geolocation: { getCurrentPosition(resolve) {
      gpsReads += 1;
      resolve({ coords: { latitude: -31.4, longitude: -64.18 } });
    } } },
    window: { isSecureContext: true },
    GEO_OPTS_ACTIVATE: {},
    gpsSyncState: { disabled: true, denied: false },
    pedidos: [{ id: 41, estado: 'en_camino' }],
    api: async (url, options) => { trackCalls.push({ url, options }); },
    persistGpsPreference() {},
    updateGpsButtonUI() {},
    updateDriverLocationOnMap() { markerUpdates += 1; },
    setGpsFeedback() {},
    getGeoErrorCode: () => 0,
    getGeoErrorMessage: () => '',
    showGpsHelp() {},
    toast() {},
    Date,
  });
  vm.runInContext(slice(gpsSource, 'async function requestGpsActivation()', 'let driverLocationMarker'), context);

  await context.requestGpsActivation();

  assert.equal(gpsReads, 1);
  assert.equal(markerUpdates, 1);
  assert.equal(trackCalls.length, 1);
  assert.equal(trackCalls[0].options.body.pedido_id, 41);
});

test('gpsTick trackea un pedido en_camino con una sola lectura y una actualización visible', async () => {
  let gpsReads = 0;
  let markerUpdates = 0;
  const trackCalls = [];
  const context = vm.createContext({
    navigator: {
      onLine: true,
      geolocation: { getCurrentPosition(resolve) {
        gpsReads += 1;
        resolve({ coords: { latitude: -31.41, longitude: -64.19 } });
      } },
    },
    GEO_OPTS_TRACK: {},
    gpsSyncState: { disabled: false, denied: false, nextInMs: 60_000, maxMs: 300_000 },
    pedidos: [{ id: 42, estado: 'en_camino' }],
    withLock: async (_key, action) => action(),
    api: async (url, options) => { trackCalls.push({ url, options }); },
    updateDriverLocationOnMap() { markerUpdates += 1; },
    updateGpsButtonUI() {},
    persistGpsPreference() {},
    toast() {},
    console,
    Date,
  });
  vm.runInContext(slice(gpsSource, 'function scheduleNextGpsTick', '(async function gpsLoop'), context);

  await context.gpsTick();

  assert.equal(gpsReads, 1);
  assert.equal(markerUpdates, 1);
  assert.equal(trackCalls.length, 1);
  assert.equal(trackCalls[0].options.body.pedido_id, 42);
});

test('setStatus actualiza el marcador inmediatamente al iniciar ruta sin otra lectura GPS', async () => {
  let gpsReads = 0;
  let markerUpdates = 0;
  const apiCalls = [];
  const position = { coords: { latitude: -31.42, longitude: -64.2 } };
  const context = vm.createContext({
    setActionBusy: () => () => {},
    withLock: async (_key, action) => action(),
    pedidos: [],
    pagosCanales: {},
    resolverZonaParaPedido: async () => null,
    api: async (url, options) => { apiCalls.push({ url, options }); },
    navigator: { geolocation: { getCurrentPosition(resolve) {
      gpsReads += 1;
      resolve(position);
    } } },
    gpsSyncState: {},
    persistGpsPreference() {},
    updateGpsButtonUI() {},
    updateDriverLocationOnMap(received) {
      markerUpdates += 1;
      assert.equal(received, position);
    },
    getGeoErrorCode: () => 0,
    getGeoErrorMessage: () => '',
    GEO_OPTS_ACTIVATE: {},
    loadPedidos: async () => {},
    notifyError(error) { throw error; },
    toast() {},
    confirm: () => true,
    console,
  });
  vm.runInContext(slice(entregaSource, 'async function setStatus', 'async function setPay'), context);

  await context.setStatus(51, 'en_ruta');

  assert.equal(gpsReads, 1);
  assert.equal(markerUpdates, 1);
  assert.equal(apiCalls.filter(({ url }) => url === '/api/track/update').length, 1);
});

test('renderizar clientes conserva y restaura la capa de ubicación del repartidor', () => {
  const render = slice(gpsSource, 'function renderMap()', '// --- GPS TRACKING');
  assert.match(render, /mapMarkers\.clearLayers\(\)/);
  assert.match(render, /renderStoredDriverLocationOnMap\(\)/);
  assert.doesNotMatch(render, /removeLayer\(driverLocationMarker|removeLayer\(driverAccuracyCircle/);
});
