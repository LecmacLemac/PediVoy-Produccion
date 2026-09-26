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

test('Solo Hoy desaparece y los estados operativos incluyen pedidos de cualquier fecha', () => {
  assert.doesNotMatch(html, /Solo Hoy|id="fHoy"|id="mapSoloHoy"/);
  assert.doesNotMatch(core, /soloHoy|#fHoy/);
  assert.doesNotMatch(pedidosSource, /fHoy|#fHoy/);
  assert.doesNotMatch(gpsSource, /mapSoloHoy/);

  const nodes = { '#fZona': { value: '' }, '#fSearch': { value: '' } };
  const cardsContext = vm.createContext({
    $: (selector) => nodes[selector],
    getHistoricalMode: () => false,
    getOperationalStatusFilter: () => 'pendiente',
    getOyString: () => '2026-09-26',
    getPedidoFechaEntregaReal: () => '',
    isPedidoEntregadoReciente: () => false,
    normalizeOperationalStatus: (status) => status,
    pedidos: [
      { id: 1, estado: 'pendiente', fecha_entrega_estimada: '2026-09-20' },
      { id: 2, estado: 'pendiente', fecha_entrega_estimada: '2026-09-26' },
      { id: 3, estado: 'en_ruta', fecha_entrega_estimada: '2026-09-19' },
    ],
  });
  vm.runInContext(slice(pedidosSource, 'function getFilteredPedidos()', 'function renderCards()'), cardsContext);
  assert.deepEqual(Array.from(cardsContext.getFilteredPedidos(), (pedido) => pedido.id), [1, 2]);

  let markers = 0;
  const mapContext = vm.createContext({
    $: (selector) => selector === '#mapHint' ? { textContent: '' } : null,
    map: { invalidateSize() {}, fitBounds() {} },
    mapMarkers: { clearLayers() {} },
    pedidos: [
      { estado: 'pendiente', fecha_entrega_estimada: '2026-09-20', latitud: -31, longitud: -64, cliente: 'A' },
      { estado: 'pendiente', fecha_entrega_estimada: '2026-09-26', latitud: -31.1, longitud: -64.1, cliente: 'B' },
      { estado: 'en_ruta', fecha_entrega_estimada: '2026-09-19', latitud: -31.2, longitud: -64.2, cliente: 'C' },
    ],
    getHistoricalMode: () => false,
    getOperationalStatusFilter: () => 'pendiente',
    getOyString: () => '2026-09-26',
    isPedidoEntregadoReciente: () => false,
    normalizeOperationalStatus: (status) => status,
    getGoogleMapsDirectionsUrl: () => 'url',
    buildRepartidorMapPopup: () => '',
    renderStoredDriverLocationOnMap() {},
    esc: String,
    L: { divIcon: (options) => options, marker: () => ({ addTo() { markers += 1; return this; }, bindPopup() {} }) },
  });
  vm.runInContext(slice(gpsSource, 'function renderMap()', '// --- GPS TRACKING'), mapContext);
  mapContext.renderMap();
  assert.equal(markers, 2);
});

test('los controles operativos quedan visibles y el histórico del mapa se ofrece colapsado por defecto', () => {
  const pedidosSection = html.slice(html.indexOf('<section id="sec-pedidos">'), html.indexOf('<section id="sec-mapa"'));
  const mapSection = html.slice(html.indexOf('<section id="sec-mapa"'), html.indexOf('<section id="sec-gastos"'));
  const filterBox = pedidosSection.slice(pedidosSection.indexOf('<div id="filterBox"'), pedidosSection.indexOf('<div id="cargaPendienteBox"'));

  assert.ok(pedidosSection.indexOf('data-filter-scope="pedidos"') < pedidosSection.indexOf('id="filterBox"'));
  assert.doesNotMatch(filterBox, /data-filter-scope="pedidos"/);
  assert.ok(mapSection.indexOf('data-filter-scope="mapa"') < mapSection.indexOf('id="mapSecondaryFilters"'));
  assert.doesNotMatch(mapSection, /class="row secondary-filters"/);

  assert.match(html, /data-history-toggle="pedidos"[^>]+aria-pressed="false"[\s\S]*?Ver entregados de los últimos 7 días[\s\S]*?data-history-count="pedidos"/);
  assert.match(mapSection, /<details id="mapSecondaryFilters" class="map-secondary-filters">[\s\S]*?<summary[^>]*>[^<]*Filtros secundarios[^<]*<\/summary>[\s\S]*?data-history-toggle="mapa"[^>]+aria-pressed="false"[\s\S]*?Ver entregados de los últimos 7 días[\s\S]*?data-history-count="mapa"[\s\S]*?<\/details>/);

  for (const scope of ['pedidos', 'mapa']) {
    assert.match(html, new RegExp(`data-history-indicator="${scope}"[^>]+hidden[\\s\\S]*?Viendo: Entregados · últimos 7 días[\\s\\S]*?data-history-exit="${scope}"`));
  }
  assert.ok(mapSection.indexOf('</details>') < mapSection.indexOf('data-history-indicator="mapa"'));
  assert.match(html, /id="filtersToggle"[^>]+aria-controls="filterBox"[^>]+aria-expanded="true"/);
});

test('abrir y cerrar los filtros secundarios recalcula el tamaño del mapa en el próximo frame', () => {
  let toggleListener = null;
  let animationFrames = 0;
  let invalidations = 0;
  const nodes = {
    '#mapRefBtn': {},
    '#mapCenterMe': {},
    '#mapSecondaryFilters': {
      open: false,
      addEventListener(type, listener) {
        if (type === 'toggle') toggleListener = listener;
      },
    },
  };
  const context = vm.createContext({
    $: (selector) => nodes[selector],
    map: { invalidateSize() { invalidations += 1; } },
    centerMapOnDriver() {},
    requestAnimationFrame(callback) {
      animationFrames += 1;
      callback();
    },
  });
  vm.runInContext(slice(gpsSource, 'function initRepartidorMapaGpsUI()', 'function setGpsFeedback'), context);

  context.initRepartidorMapaGpsUI();
  assert.equal(typeof toggleListener, 'function');

  nodes['#mapSecondaryFilters'].open = true;
  toggleListener();
  nodes['#mapSecondaryFilters'].open = false;
  toggleListener();

  assert.equal(animationFrames, 2);
  assert.equal(invalidations, 2);
});

test('el resumen de filtros secundarios conserva un foco de teclado visible', () => {
  assert.match(html, /\.map-secondary-filters summary:focus-visible\s*\{[^}]*outline:\s*3px solid [^;]+;[^}]*outline-offset:\s*2px;/s);
});

test('el botón de filtros mantiene aria-expanded sincronizado', () => {
  const box = { hidden: false };
  const toggle = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const context = vm.createContext({
    window: {},
    $: (selector) => selector === '#filterBox' ? box : selector === '#filtersToggle' ? toggle : null,
  });
  vm.runInContext(slice(pedidosSource, 'function toggleFilters()', 'function initRepartidorPedidosUI()'), context);

  context.toggleFilters();
  assert.equal(box.hidden, true);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  context.toggleFilters();
  assert.equal(box.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
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

test('entregados recientes usan fecha real y rango móvil inclusivo sin aceptar futuros', () => {
  const context = vm.createContext({
    document: { querySelector: () => null, querySelectorAll: () => [] },
    safeStorage: { local: { get: () => null, set() {} } },
    console,
    setTimeout,
    clearTimeout,
    fetch() {},
    FormData: class {},
    Date,
    Intl,
  });
  vm.runInContext(core, context);
  const today = '2026-09-26';
  const cases = [
    [{ estado: 'entregado', fecha_entrega: '2026-09-20T03:00:00.000Z' }, true],
    [{ estado: 'entregado', fecha_entrega: '2026-09-26T15:00:00-03:00' }, true],
    [{ estado: 'entregado', fecha_entrega: '2026-09-19T15:00:00-03:00' }, false],
    [{ estado: 'entregado', fecha_entrega: '2026-09-27T15:00:00-03:00' }, false],
    [{ estado: 'entregado', fecha: '2026-09-22T15:00:00-03:00' }, true],
    [{ estado: 'entregado', fecha_entrega_estimada: '2026-09-24', fecha: '2026-09-10' }, false],
    [{ estado: 'pendiente', fecha_entrega: '2026-09-24T15:00:00-03:00' }, false],
  ];

  assert.equal(context.getPedidoFechaEntregaReal({ fecha_entrega: '2026-09-21', fecha: '2026-09-10' }), '2026-09-21');
  assert.equal(context.getPedidoFechaEntregaReal({ fecha: '2026-09-22' }), '2026-09-22');
  assert.equal(context.getPedidoFechaEntregaReal({ fecha_entrega_estimada: '2026-09-24' }), '');
  assert.deepEqual(cases.map(([pedido]) => context.isPedidoEntregadoReciente(pedido, today)), cases.map(([, expected]) => expected));
});

test('hoy y el rango reciente usan fecha argentina aunque el dispositivo esté en UTC', () => {
  const DeviceUtcDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-27T01:00:00.000Z'])); }
    getTimezoneOffset() { return 0; }
    static now() { return new Date('2026-09-27T01:00:00.000Z').getTime(); }
  };
  const context = vm.createContext({
    document: { querySelector: () => null, querySelectorAll: () => [] },
    safeStorage: { local: { get: () => null, set() {} } },
    console,
    setTimeout,
    clearTimeout,
    fetch() {},
    FormData: class {},
    Date: DeviceUtcDate,
    Intl,
  });
  vm.runInContext(core, context);

  const today = vm.runInContext('getOyString()', context);
  assert.equal(today, '2026-09-26');
  assert.deepEqual({ ...context.getRecentDeliveredRange() }, { start: '2026-09-20', end: '2026-09-26' });
  assert.deepEqual({ ...context.getRecentDeliveredRange('2026-09-10') }, { start: '2026-09-04', end: '2026-09-10' });
});

test('el modo histórico es global, persiste y cede al elegir un estado operativo', () => {
  const statusButtons = ['pendiente', 'en_ruta', 'pendiente', 'en_ruta'].map((status) => ({
    dataset: { statusFilter: status }, attributes: {}, classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {},
  }));
  const historyButtons = ['pedidos', 'mapa'].map((scope) => ({
    dataset: { historyToggle: scope }, attributes: {}, classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {},
  }));
  const historyCounts = ['pedidos', 'mapa'].map((scope) => ({ dataset: { historyCount: scope }, textContent: '' }));
  const indicators = ['pedidos', 'mapa'].map((scope) => ({ dataset: { historyIndicator: scope }, hidden: true }));
  const exitButtons = ['pedidos', 'mapa'].map((scope) => ({ dataset: { historyExit: scope }, addEventListener() {} }));
  const saved = [];
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      return {
        '[data-status-filter]': statusButtons,
        '[data-status-count]': [],
        '[data-history-toggle]': historyButtons,
        '[data-history-count]': historyCounts,
        '[data-history-indicator]': indicators,
        '[data-history-exit]': exitButtons,
      }[selector] || [];
    },
  };
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-26T15:00:00-03:00'])); }
    static now() { return new Date('2026-09-26T15:00:00-03:00').getTime(); }
  };
  const context = vm.createContext({
    document,
    safeStorage: { local: { get: () => null, set: (_key, value) => saved.push(JSON.parse(value)) } },
    console, setTimeout, clearTimeout, fetch() {}, FormData: class {}, Date: FixedDate, Intl,
  });
  vm.runInContext(core, context);
  vm.runInContext(`pedidos = [
    {estado:'pendiente'}, {estado:'en_ruta'},
    {estado:'entregado', fecha_entrega:'2026-09-24'},
    {estado:'entregado', fecha_entrega:'2026-09-10'}
  ]`, context);

  context.setHistoricalMode(true, { render: false });
  assert.equal(context.getHistoricalMode(), true);
  assert.deepEqual(statusButtons.map((button) => button.attributes['aria-pressed']), ['false', 'false', 'false', 'false']);
  assert.deepEqual(historyButtons.map((button) => button.attributes['aria-pressed']), ['true', 'true']);
  assert.deepEqual(historyCounts.map((node) => node.textContent), ['1', '1']);
  assert.deepEqual(indicators.map((node) => node.hidden), [false, false]);
  assert.equal(saved.at(-1).historico, true);

  context.setOperationalStatusFilter('en_ruta', { render: false });
  assert.equal(context.getHistoricalMode(), false);
  assert.equal(context.getOperationalStatusFilter(), 'en_ruta');
  assert.deepEqual(statusButtons.map((button) => button.attributes['aria-pressed']), ['false', 'true', 'false', 'true']);
  assert.deepEqual(indicators.map((node) => node.hidden), [true, true]);
  assert.equal(saved.at(-1).historico, false);
});

test('restoreFiltrosUI recupera el modo histórico persistido con safeStorage', () => {
  const historyButton = { dataset: { historyToggle: 'pedidos' }, attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; } };
  const indicator = { hidden: true };
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[data-history-toggle]') return [historyButton];
      if (selector === '[data-history-indicator]') return [indicator];
      return [];
    },
  };
  const context = vm.createContext({
    document,
    safeStorage: { local: { get: () => JSON.stringify({ estado: 'en_ruta', historico: true }) } },
    console, setTimeout, clearTimeout, fetch() {}, FormData: class {}, Date, Intl,
  });
  vm.runInContext(core, context);

  context.restoreFiltrosUI();

  assert.equal(context.getHistoricalMode(), true);
  assert.equal(context.getOperationalStatusFilter(), 'en_ruta');
  assert.equal(historyButton.attributes['aria-pressed'], 'true');
  assert.equal(indicator.hidden, false);
});

test('las tarjetas históricas conservan zona y búsqueda y ordenan por entrega descendente', () => {
  const nodes = {
    '#fZona': { value: '7' },
    '#fSearch': { value: 'ana' },
  };
  const context = vm.createContext({
    $: (selector) => nodes[selector],
    getHistoricalMode: () => true,
    getOperationalStatusFilter: () => 'pendiente',
    getOyString: () => '2026-09-26',
    getPedidoFechaOperativa: () => '2026-09-26',
    getPedidoFechaEntregaReal: (pedido) => pedido.fecha_entrega || pedido.fecha || '',
    isPedidoEntregadoReciente: (pedido) => pedido.estado === 'entregado' && (pedido.fecha_entrega || pedido.fecha) >= '2026-09-20' && (pedido.fecha_entrega || pedido.fecha) <= '2026-09-26',
    isPedidoActivoCarga: (pedido) => ['pendiente', 'en_ruta', 'en_camino'].includes(pedido.estado),
    normalizeOperationalStatus: (status) => status === 'en_camino' ? 'en_ruta' : status,
    pedidos: [
      { id: 1, estado: 'entregado', fecha_entrega: '2026-09-24', zona_id: 7, cliente: 'Ana Sur' },
      { id: 2, estado: 'entregado', fecha_entrega: '2026-09-26', zona_id: 7, cliente: 'Ana Norte' },
      { id: 3, estado: 'entregado', fecha_entrega: '2026-09-20', zona_id: 7, cliente: 'Beto' },
      { id: 4, estado: 'entregado', fecha_entrega: '2026-09-19', zona_id: 7, cliente: 'Ana vieja' },
      { id: 5, estado: 'entregado', fecha_entrega: '2026-09-27', zona_id: 7, cliente: 'Ana futura' },
      { id: 6, estado: 'entregado', fecha_entrega: '2026-09-25', zona_id: 8, cliente: 'Ana otra zona' },
      { id: 7, estado: 'pendiente', fecha_entrega: '2026-09-26', zona_id: 7, cliente: 'Ana pendiente' },
    ],
  });
  vm.runInContext(slice(pedidosSource, 'function getFilteredPedidos()', 'function renderCards()'), context);

  assert.deepEqual(Array.from(context.getFilteredPedidos(), (pedido) => pedido.id), [2, 1]);
});

test('el mapa histórico muestra sólo entregados recientes en verde y conserva GPS', () => {
  const nodes = { '#mapHint': { textContent: '' } };
  const markerIcons = [];
  let gpsRenders = 0;
  const context = vm.createContext({
    $: (selector) => nodes[selector],
    map: { invalidateSize() {}, fitBounds() {} },
    mapMarkers: { clearLayers() {} },
    pedidos: [
      { id: 1, estado: 'entregado', fecha_entrega: '2026-09-24', latitud: -31, longitud: -64, cliente: 'Ana' },
      { id: 2, estado: 'entregado', fecha_entrega: '2026-09-19', latitud: -31.1, longitud: -64.1, cliente: 'Viejo' },
      { id: 3, estado: 'entregado', fecha_entrega: '2026-09-27', latitud: -31.2, longitud: -64.2, cliente: 'Futuro' },
      { id: 4, estado: 'pendiente', fecha_entrega: '2026-09-26', latitud: -31.3, longitud: -64.3, cliente: 'Pendiente' },
    ],
    getHistoricalMode: () => true,
    getOperationalStatusFilter: () => 'pendiente',
    getOyString: () => '2026-09-26',
    getPedidoFechaOperativa: () => '2026-09-19',
    isPedidoEntregadoReciente: (pedido) => pedido.estado === 'entregado' && pedido.fecha_entrega >= '2026-09-20' && pedido.fecha_entrega <= '2026-09-26',
    normalizeOperationalStatus: (status) => status,
    getGoogleMapsDirectionsUrl: () => 'url',
    buildRepartidorMapPopup: () => '',
    renderStoredDriverLocationOnMap() { gpsRenders += 1; },
    esc: String,
    L: {
      divIcon(options) { return options; },
      marker(_position, options) { markerIcons.push(options.icon.html); return { addTo() { return this; }, bindPopup() {} }; },
    },
  });
  vm.runInContext(slice(gpsSource, 'function renderMap()', '// --- GPS TRACKING'), context);

  context.renderMap();

  assert.equal(markerIcons.length, 1);
  assert.match(markerIcons[0], /#10b981/);
  assert.equal(gpsRenders, 1);
  assert.equal(nodes['#mapHint'].textContent, '1 puntos visibles');
});

test('tarjetas y mapa consumen el mismo filtro operativo sin selectores duplicados', () => {
  assert.doesNotMatch(pedidosSource, /#fEstado/);
  assert.doesNotMatch(gpsSource, /#mapFiltroEstado/);
  assert.match(pedidosSource, /getOperationalStatusFilter\(\)/);
  assert.match(gpsSource, /getOperationalStatusFilter\(\)/);
  assert.match(pedidosSource, /initOperationalStatusFilters\(\)/);
});

test('el mapa superpone un botón GPS circular, accesible y deshabilitado hasta tener ubicación', () => {
  const mapSection = html.slice(html.indexOf('<section id="sec-mapa"'), html.indexOf('<section id="sec-gastos"'));
  assert.match(mapSection, /<div class="map-stage">[\s\S]*?<div id="map"[^>]*>[\s\S]*?<button type="button" class="map-center-button" id="mapCenterMe" aria-label="Centrar mi ubicación" title="Centrar mi ubicación" disabled>[\s\S]*?aria-hidden="true"[\s\S]*?<\/button>[\s\S]*?<\/div>/);
  assert.doesNotMatch(mapSection, />[^<]*Centrar (?:en )?mi ubicación[^<]*<\/button>/);
  assert.match(html, /\.map-stage\s*\{[\s\S]*?position:\s*relative/);
  assert.match(html, /\.map-center-button\s*\{[\s\S]*?position:\s*absolute[\s\S]*?border-radius:\s*50%/);
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
