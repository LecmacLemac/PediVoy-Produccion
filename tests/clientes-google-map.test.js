import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import vm from 'node:vm';
import { clientesFixture } from './support/clientes-google-fixture.mjs';

test('coordinate helper rejects missing, placeholder and out-of-range positions', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync('pedidos/inicio/clientes-google-map.js', 'utf8'), context);
  for (const pair of [[null, -64], ['', -64], [' ', -64], [undefined, -64], [-91, -64], [-31, 181], [0, 0], ['wrong', -64]]) {
    assert.equal(context.clientesMapCoordinate(...pair), null);
  }
  assert.equal(context.clientesMapCoordinate('0', '-64').lat, 0);
  assert.equal(context.clientesMapCoordinate('-31.4', '-64.2').lng, -64.2);
});

test('client embedded scripts compile after map migration', () => {
  const html = fs.readFileSync('pedidos/inicio/clientes.html', 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('real client HTML keeps draggable pin, manual inputs, GPS, geocode autosave and safe customer switching', async () => {
  const html = fs.readFileSync('pedidos/inicio/clientes.html', 'utf8');
  assert.equal(/leaflet|\bL\.(?:map|marker|tileLayer)/i.test(html), false, 'Client map must use Google instead of Leaflet');
  const fixture = clientesFixture(); const server = fixture.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 390, height: 844 });
    await page.setRequestInterception(true);
    page.on('request', req => new URL(req.url()).hostname === '127.0.0.1' ? req.continue() : req.abort());
    await page.evaluateOnNewDocument(() => {
      class MapDouble {
        constructor(_el, options) { Object.assign(this, options); this.listeners = {}; window.mapDouble = this; }
        addListener(name, callback) { this.listeners[name] = callback; }
        setCenter(value) { this.center = value; } getCenter() { return this.center; }
        setZoom(value) { this.zoom = value; } getZoom() { return this.zoom; }
      }
      class MarkerDouble {
        constructor(options) { Object.assign(this, options); this.listeners = {}; window.markerDouble = this; }
        addListener(name, callback) { this.listeners[name] = callback; }
      }
      window.google = { maps: { Map: MapDouble, marker: { AdvancedMarkerElement: MarkerDouble }, event: { trigger() {} } } };
      Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(ok) { window.replyGPS = ok; } } });
    });
    const url = `http://127.0.0.1:${server.address().port}/pedidos/inicio/clientes.html`;
    const reload = async () => { await page.goto(url, { waitUntil: 'networkidle0' }); await page.waitForSelector('button[data-action=edit]'); };
    await reload();
    await page.evaluate(() => edit(1001));
    await page.waitForFunction(() => !!window.markerDouble);
    assert.equal(await page.evaluate(() => window.markerDouble.gmpDraggable), true);
    await page.evaluate(() => window.mapDouble.listeners.click({ latLng: { lat: () => -31.43, lng: () => -64.2 } }));
    assert.equal(await page.$eval('#c_latitud', n => n.value), '-31.430000');
    await page.evaluate(() => { window.markerDouble.position = { lat: -31.435, lng: -64.205 }; window.markerDouble.listeners.dragend(); });
    assert.equal(await page.$eval('#c_longitud', n => n.value), '-64.205000');
    assert.equal(fixture.writes.length, 0);
    await page.evaluate(() => { document.querySelector('#c_latitud').value = '-31.45'; document.querySelector('#c_longitud').value = '-64.25'; applyLatLngInputs(); });
    await page.waitForFunction(() => window.markerDouble.position.lat === -31.45);
    await page.evaluate(() => { useMyLocation(); window.replyGPS({ coords: { latitude: -31.46, longitude: -64.26 } }); });
    await page.waitForFunction(() => document.querySelector('#c_latitud').value === '-31.460000');
    await page.evaluate(() => geocodeAddress());
    assert.equal(fixture.writes.length, 1, 'Existing customer geocode retains existing automatic pin save');
    assert.equal(fixture.writes[0].url, '/api/clientes/1001');
    assert.equal(fixture.writes[0].body.latitud, '-31.440000');
    await page.evaluate(() => { closeModal(); openModal(); });
    await page.waitForFunction(() => !document.querySelector('#btnGeocodeAddress').disabled);
    assert.equal(await page.evaluate(() => marker), null, 'New customer must not keep previous marker');
    await page.evaluate(() => { document.querySelector('#c_direccion').value = 'Dirección sintética nueva'; });
    await page.evaluate(() => geocodeAddress());
    assert.equal(fixture.writes.length, 1, 'New customer geocode does not auto-create customer');
    await page.evaluate(() => { document.querySelector('#c_cliente').value = 'Nuevo cliente sintético'; });
    await page.evaluate(() => save());
    assert.equal(fixture.writes[1].url, '/api/clientes');
    assert.equal(fixture.writes[1].body.latitud, '-31.440000');
    await page.evaluate(() => edit(1001));
    await page.evaluate(() => useMyLocation());
    await page.evaluate(() => { closeModal(); });
    await page.evaluate(() => edit(1002));
    await page.evaluate(() => window.replyGPS({ coords: { latitude: -31.9, longitude: -64.9 } }));
    assert.equal(await page.$eval('#c_latitud', n => n.value), '', 'Late GPS must not overwrite another customer');
    let release;
    const started = new Promise(resolve => { fixture.geocode.respond = () => new Promise(reply => { release = reply; resolve(); }); });
    await page.evaluate(() => { void geocodeAddress(); });
    await started;
    await page.evaluate(() => { closeModal(); }); await page.evaluate(() => edit(1001));
    const response = page.waitForResponse(r => r.url().endsWith('/api/clientes/geocode'));
    release({ latitud: -31.8, longitud: -64.8 }); await response;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(fixture.writes.length, 2, 'Late geocode must not save against another customer');
    fixture.env.GOOGLE_MAPS_BROWSER_API_KEY = '';
    await reload(); await page.evaluate(() => edit(1001));
    await page.waitForFunction(() => document.querySelector('#clientesMapError').textContent.includes('configurado'));
    assert.equal(await page.$eval('#c_cliente', n => n.value), 'Cliente sintético A');
    assert.equal(await page.$eval('#btnGeocodeAddress', n => n.disabled), true);
    assert.equal(await page.$eval('#btnSaveCliente', n => n.disabled), false, 'Map failure does not block the customer form');
    fixture.env.GOOGLE_MAPS_BROWSER_API_KEY = 'synthetic-browser-key';
    fixture.user.role = 'super'; fixture.user.empresa_id = null;
    fixture.geocode.respond = async () => ({ latitud: -31.5, longitud: -64.3, zona_id: 3 });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.select('#empFilter', '7'); await page.waitForSelector('button[data-action=edit]');
    await page.evaluate(() => edit(1001)); await page.evaluate(() => geocodeAddress());
    assert.equal(fixture.writes.at(-1).body.empresa_id, '7');
    assert.equal(fixture.writes.at(-1).url, '/api/clientes/1001');
    await page.evaluate(() => window.gm_authFailure());
    assert.match(await page.$eval('#clientesMapError', n => n.textContent), /no autorizó/);
    assert.equal(await page.$eval('#btnUseMyLocation', n => n.disabled), true);
    assert.equal(await page.$eval('#btnSaveCliente', n => n.disabled), false);
    assert.deepEqual(fixture.unexpected, []); assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
