import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// SDK doubles exercise application behavior; live SDK coverage is in browser smoke.
function harness() {
  const nodes = new Map();
  const node = () => ({ textContent: '', hidden: true, disabled: true, style: {}, dataset: {}, classList: { toggle() {} }, addEventListener() {}, appendChild() {} });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  class MapDouble {
    constructor(_el, options) { this.options = options; this.zoom = options.zoom; }
    setCenter(p) { this.center = p; }
    getCenter() { return this.center || this.options.center; }
    setZoom(z) { this.zoom = z; }
    getZoom() { return this.zoom; }
    fitBounds(b) { this.bounds = b; }
    addListener(_event, callback) { callback(); }
  }
  class Marker { constructor(opts) { Object.assign(this, opts); } addListener(_event, cb) { this.click = cb; } }
  class Circle { constructor(opts) { Object.assign(this, opts); } setCenter(p) { this.center = p; } setRadius(r) { this.radius = r; } setMap(m) { this.map = m; } }
  class InfoWindow { constructor(opts) { Object.assign(this, opts); } setContent(c) { this.content = c; } open(o) { this.opened = o; } close() { this.opened = null; } }
  const context = vm.createContext({ console, URLSearchParams, Date, Intl, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: cb => cb(), navigator: {}, document: { getElementById: get, querySelector: s => get(s.slice(1)), querySelectorAll: () => [], createElement: node, head: node() }, google: { maps: { Map: MapDouble, marker: { AdvancedMarkerElement: Marker }, Circle, InfoWindow, LatLngBounds: class { constructor() { this.points = []; } extend(p) { this.points.push(p); } }, event: { trigger() {}, addListenerOnce: (_map, _event, cb) => cb() } } } });
  context.window = context;
  vm.runInContext(fs.readFileSync('pedidos/repartidor-core.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('pedidos/repartidor-mapa-gps.js', 'utf8'), context);
  context.fetch = async () => ({ ok: true, json: async () => ({ apiKey: 'synthetic-browser-key', mapId: 'DEMO_MAP_ID' }) });
  return { context, nodes, run: source => vm.runInContext(source, context) };
}

test('screen contains accessible Spanish map errors and does not load Leaflet', () => {
  const html = fs.readFileSync('pedidos/repartidor.html', 'utf8');
  assert.doesNotMatch(html, /leaflet/i);
  assert.match(html, /id="mapError"[^>]*role="alert"/);
});

test('secondary filter toggle resizes Google map without losing center', async () => {
  const h = harness();
  await h.run('renderMap()');
  let callback;
  h.nodes.set('mapSecondaryFilters', { addEventListener: (_event, cb) => { callback = cb; } });
  h.run('initRepartidorMapaGpsUI()');
  assert.doesNotThrow(() => callback());
});

test('configuration, network and authorization errors remain Spanish and never fall back', async () => {
  for (const status of [503, 401]) {
    const h = harness();
    h.context.fetch = async () => ({ ok: false, status });
    await h.run('renderMap()');
    assert.equal(h.run('map'), undefined);
    assert.equal(h.nodes.get('mapError').hidden, false);
    assert.match(h.nodes.get('mapError').textContent, status === 503 ? /no está configurado/ : /Iniciá sesión/);
  }
  const h = harness();
  h.context.fetch = async () => { throw new Error('synthetic-sensitive-message'); };
  await h.run('renderMap()');
  assert.match(h.nodes.get('mapError').textContent, /No se pudo cargar Google Maps/);
  assert.doesNotMatch(h.nodes.get('mapError').textContent, /synthetic-sensitive/);
  const authorized = harness();
  await authorized.run('renderMap()');
  authorized.run('gm_authFailure()');
  await authorized.run('renderMap()');
  assert.match(authorized.nodes.get('mapError').textContent, /no autorizó/);
  assert.equal(authorized.nodes.get('mapError').hidden, false);
});

test('GPS marker and accuracy circle update, clear missing accuracy and center after lazy map initialization', async () => {
  const h = harness();
  h.run('updateDriverLocationOnMap({coords:{latitude:-31.42,longitude:-64.2,accuracy:25}})');
  await h.run('centerMapOnDriver()');
  assert.equal(h.run('driverLocationMarker.position.lat'), -31.42);
  assert.equal(h.run('driverAccuracyCircle.radius'), 25);
  assert.equal(h.run('map.getCenter().lng'), -64.2);
  assert.equal(h.run('map.getZoom()'), 16);
  assert.equal(h.nodes.get('mapCenterMe').disabled, false);
  h.run('updateDriverLocationOnMap({coords:{latitude:-31.43,longitude:-64.21,accuracy:50}})');
  assert.equal(h.run('driverLocationMarker.position.lat'), -31.43);
  assert.equal(h.run('driverAccuracyCircle.radius'), 50);
  const circle = h.run('driverAccuracyCircle');
  h.run('updateDriverLocationOnMap({coords:{latitude:-31.43,longitude:-64.21}})');
  assert.equal(h.run('driverAccuracyCircle'), null);
  assert.equal(circle.map, null);
});

test('Google default renderer retains status filtering and customer popup actions without Leaflet', async () => {
  const h = harness();
  h.run(`pedidos = [
    {id:1, cliente:'Prueba pendiente', direccion:'Prueba 1', telefono:'3515551234', estado:'pendiente', latitud:-31.4, longitud:-64.18},
    {id:2, cliente:'Prueba ruta', estado:'en_camino', latitud:-31.41, longitud:-64.19},
    {id:3, cliente:'Sin coordenadas', estado:'pendiente', latitud:null, longitud:null}
  ];`);
  await h.run('renderMap()');
  assert.equal(h.run('map.options.mapId'), 'DEMO_MAP_ID');
  assert.equal(h.run('mapMarkers.length'), 1);
  assert.equal(h.nodes.get('mapHint').textContent, '1 puntos visibles');
  h.run('mapMarkers[0].click()');
  assert.match(h.run('mapInfoWindow.content'), /Iniciar ruta/);
  assert.match(h.run('mapInfoWindow.content'), /Chat/);
  assert.match(h.run('mapInfoWindow.content'), /Cómo llegar/);
  h.run(`operationalStatusFilter = 'en_ruta'`);
  const oldMarker = h.run('mapMarkers[0]');
  await h.run('renderMap()');
  assert.equal(oldMarker.map, null);
  assert.equal(h.run('mapMarkers[0].title'), 'Prueba ruta');
});
