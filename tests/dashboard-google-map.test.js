import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { dashboardFixture } from './support/dashboard-google-fixture.mjs';

test('dashboard Google map supports click, drag, geocode and saves; cancelled reopen stays role-scoped', async () => {
  assert.doesNotMatch(fs.readFileSync('pedidos/dashboard.html', 'utf8'), /leaflet|\bL\.(?:map|marker|tileLayer)/);
  const fixture = dashboardFixture();
  const server = fixture.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
    await page.setViewport({ width: 390, height: 844 });
    await page.setRequestInterception(true);
    page.on('request', req => new URL(req.url()).hostname === '127.0.0.1' ? req.continue() : req.abort());
    await page.evaluateOnNewDocument(() => {
      class MapDouble {
        constructor(element, options) { Object.assign(this, options); this.listeners = {}; window.mapDouble = this; element.textContent = 'Google SDK double (synthetic test)'; }
        addListener(name, callback) { this.listeners[name] = callback; }
        getCenter() { return this.center; } setCenter(value) { this.center = value; }
        getZoom() { return this.zoom; } setZoom(value) { this.zoom = value; }
      }
      class MarkerDouble {
        constructor(options) { Object.assign(this, options); this.listeners = {}; window.markerDouble = this; }
        addListener(name, callback) { this.listeners[name] = callback; }
      }
      window.google = { maps: { Map: MapDouble, marker: { AdvancedMarkerElement: MarkerDouble }, event: { trigger() {} } } };
    });
    const url = `http://127.0.0.1:${server.address().port}/pedidos/dashboard.html`;
    const reload = async () => { await page.goto(url, { waitUntil: 'networkidle0' }); await page.waitForSelector('#rows .btn-location'); };
    await reload();
    await page.evaluate(() => window.openUbicacion(5001));
    await page.waitForFunction(() => document.querySelector('#locationLat').value === '-31.4200000');
    assert.equal(await page.evaluate(() => window.markerDouble.gmpDraggable), true);
    assert.equal(await page.$$eval('#dlgUbicacion .modal-footer button', buttons => buttons.every(n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })), true, 'Location actions must fit inside the mobile viewport');
    await page.evaluate(() => window.mapDouble.listeners.click({ latLng: { lat: () => -31.43, lng: () => -64.2 } }));
    assert.equal(await page.$eval('#locationLat', n => n.value), '-31.4300000');
    await page.evaluate(() => { window.markerDouble.position = { lat: -31.435, lng: -64.205 }; window.markerDouble.listeners.dragend(); });
    assert.equal(await page.$eval('#locationLng', n => n.value), '-64.2050000');
    await page.setViewport({ width: 1200, height: 950 });
    await page.waitForFunction(() => window.mapDouble.center.lat === -31.435, { timeout: 2000 });
    await page.setViewport({ width: 390, height: 844 });
    await page.click('#btnAutoLocation');
    await page.waitForFunction(() => document.querySelector('#locationLat').value === '-31.4400000');
    assert.equal(fixture.writes.length, 0, 'Geocode must not save automatically');
    await page.click('#btnSaveLocation');
    await page.waitForFunction(() => !document.querySelector('#dlgUbicacion').open);
    assert.deepEqual(fixture.writes.shift(), { url: '/api/clientes/1001', body: { latitud: -31.44, longitud: -64.23 } });
    assert.equal(await page.$eval('#locationError', n => n.textContent), '', 'Successful save must refresh without a hidden error');
    await page.evaluate(() => window.openUbicacion(5002));
    await page.waitForFunction(() => document.querySelector('#dlgUbicacion').open && !document.querySelector('#btnAutoLocation').disabled);
    assert.equal(await page.$eval('#locationLat', n => n.value), '');
    await page.click('#btnCloseLocation');
    let releaseGeocode;
    const geocodeStarted = new Promise(resolve => { fixture.geocode.respond = () => new Promise(reply => { releaseGeocode = reply; resolve(); }); });
    await page.evaluate(() => window.openUbicacion(5001));
    await page.waitForFunction(() => !document.querySelector('#btnAutoLocation').disabled);
    await page.click('#btnAutoLocation');
    await geocodeStarted;
    await page.click('#btnCloseLocation');
    await page.evaluate(() => window.openUbicacion(5002));
    await page.waitForFunction(() => !document.querySelector('#btnAutoLocation').disabled);
    const geocodeFinished = page.waitForResponse(r => r.url().endsWith('/api/clientes/geocode'));
    releaseGeocode({ latitud: -31.8, longitud: -64.8 });
    await geocodeFinished;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await page.$eval('#locationLat', n => n.value), '', 'A late geocode must not overwrite the next order');
    await page.click('#btnCloseLocation');
    await page.evaluate(() => window.openPedido(5001));
    await page.waitForFunction(() => !document.querySelector('#btnSaveAll').disabled);
    assert.equal(await page.$eval('#dlg_estado', n => n.disabled), false);
    assert.deepEqual(await page.$eval('#dlg_estado', n => Array.from(n.options).filter(o => !o.disabled).map(o => o.value)), ['pendiente', 'cancelado']);
    await page.select('#dlg_estado', 'pendiente');
    await page.click('#btnSaveAll');
    await page.waitForFunction(() => !document.querySelector('#dlgPedido').open);
    assert.equal(fixture.writes[0].body.estado, 'pendiente');
    assert.equal(Object.hasOwn(fixture.writes[0].body, 'items'), false);
    await page.evaluate(() => window.openPedido(5002));
    await page.waitForFunction(() => !document.querySelector('#btnSaveAll').disabled);
    assert.equal(await page.$eval('#dlg_estado', n => n.disabled), true);
    await page.click('#btnCloseDlg');
    fixture.rows[0].estado = 'cancelado';
    fixture.user.role = 'super'; fixture.user.empresa_id = null;
    await reload();
    await page.evaluate(() => window.openPedido(5001));
    await page.waitForFunction(() => !document.querySelector('#btnSaveAll').disabled);
    assert.equal(await page.$eval('#dlg_estado', n => n.disabled), false);
    fixture.user.role = 'user'; fixture.user.empresa_id = 7;
    await reload();
    await page.evaluate(() => window.openPedido(5001));
    await page.waitForFunction(() => !document.querySelector('#btnSaveAll').disabled);
    assert.equal(await page.$eval('#dlg_estado', n => n.disabled), true);
    fixture.user.role = 'admin'; fixture.config.GOOGLE_MAPS_BROWSER_API_KEY = '';
    await reload();
    await page.evaluate(() => window.openUbicacion(5001));
    await page.waitForFunction(() => document.querySelector('#locationError').textContent.includes('configurado'));
    assert.equal(await page.$eval('#btnSaveLocation', n => n.disabled), true);
    assert.match(await page.$eval('#locationClient', n => n.textContent), /sintético/);
    fixture.config.GOOGLE_MAPS_BROWSER_API_KEY = 'synthetic-browser-key';
    await reload();
    await page.evaluate(() => window.openUbicacion(5001));
    await page.waitForFunction(() => !document.querySelector('#btnSaveLocation').disabled);
    await page.evaluate(() => window.gm_authFailure());
    assert.match(await page.$eval('#locationError', n => n.textContent), /no autorizó/);
    assert.equal(await page.$eval('#btnSaveLocation', n => n.disabled), true);
    assert.equal(await page.$eval('#btnAutoLocation', n => n.disabled), true);
    assert.deepEqual(fixture.unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(r => server.close(r));
  }
});
