// Opt-in live Google SDK smoke. All application HTML/API traffic is local and synthetic.
// Only Google SDK/tile requests reach the network; no production app or DB requests.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { dashboardFixture } from './dashboard-google-fixture.mjs';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
const key = env.GOOGLE_MAPS_BROWSER_API_KEY?.trim();
assert.ok(key, 'Se requiere GOOGLE_MAPS_BROWSER_API_KEY local; no se sustituye por otra clave');
const fixture = dashboardFixture({ browserKey: key, mapId: env.GOOGLE_MAPS_MAP_ID });
const server = fixture.app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const local = `http://127.0.0.1:${server.address().port}`;
const origin = 'https://www.pedivoy.com';
const errors = [];
let browser, page;
let stage = 'launch';
try {
  browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 950 });
  page.on('pageerror', e => errors.push(e.message.split(key).join('[OCULTO]')));
  page.on('console', message => { const code = message.text().match(/Google Maps JavaScript API error:\s*(\w+)/); if (code) errors.push(code[1]); });
  page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (url.origin !== origin) return request.continue();
    try {
      const response = await fetch(local + url.pathname + url.search, {
        method: request.method(), headers: { 'Content-Type': 'application/json' }, body: request.postData(),
      });
      const contentType = response.headers.get('content-type') || 'text/plain';
      let body = Buffer.from(await response.arrayBuffer());
      if (url.pathname === '/pedidos/dashboard.html') {
        let html = body.toString();
        const mapHook = "          locationMap.addListener('click',";
        const markerHook = "        locationMarker.addListener('dragend',";
        assert.ok(html.includes(mapHook) && html.includes(markerHook));
        // Observability only; the tested HTML/handlers/SDK logic are unchanged.
        html = html.replace(mapHook, '          window.dashboardSmokeMap = locationMap;\n' + mapHook)
          .replace(markerHook, '        window.dashboardSmokeMarker = locationMarker;\n' + markerHook);
        body = Buffer.from(html);
      }
      await request.respond({ status: response.status, contentType, body });
    } catch (error) {
      errors.push('Local fixture interception failed');
      await request.abort();
    }
  });
  stage = 'load actual HTML';
  await page.goto(origin + '/pedidos/dashboard.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  stage = 'wait for dashboard fixture rows';
  await page.waitForSelector('#rows .btn-location');
  await page.evaluate(() => window.openUbicacion(5001));
  stage = 'wait for Google map and marker';
  await page.waitForFunction(() => window.dashboardSmokeMap && window.dashboardSmokeMarker && document.querySelector('#locationLat').value, { timeout: 30000 });
  stage = 'wait for Google tiles';
  await page.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Google map tiles did not load')), 20000);
    google.maps.event.addListenerOnce(window.dashboardSmokeMap, 'tilesloaded', () => { clearTimeout(timer); resolve(); });
    window.dashboardSmokeMap.setZoom(15);
  }));
  assert.equal(await page.evaluate(() => window.dashboardSmokeMarker.gmpDraggable), true);
  assert.equal(await page.$eval('#locationError', n => n.textContent), '');
  const box = await page.$eval('#locationMap', n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.5);
  stage = 'wait for map click';
  await page.waitForFunction(() => document.querySelector('#locationLng').value !== '-64.1900000');
  // SDK marker positioning is rendered on a later frame than the form update.
  await page.waitForFunction(({ x, y }) => {
    const rect = document.querySelector('gmp-advanced-marker')?.getBoundingClientRect();
    return rect && Math.abs(rect.x + rect.width / 2 - x) < 4 && Math.abs(rect.bottom - y) < 4;
  }, {}, { x: box.x + box.width * 0.65, y: box.y + box.height * 0.5 });
  const marker = await page.$('gmp-advanced-marker');
  const markerBox = await marker.boundingBox();
  assert.ok(markerBox, 'Draggable advanced marker must be visible');
  const beforeDrag = await page.$eval('#locationLng', n => n.value);
  const x = markerBox.x + markerBox.width / 2, y = markerBox.y + markerBox.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 65, y + 25, { steps: 18 }); await page.mouse.up();
  stage = 'wait for real marker drag';
  await page.waitForFunction(value => document.querySelector('#locationLng').value !== value, {}, beforeDrag);
  assert.equal(fixture.writes.length, 0, 'Dragging must not save automatically');
  const scratch = process.env.TMPDIR;
  assert.ok(scratch, 'Expected managed scratch directory');
  const desktop = path.join(scratch, 'dashboard-google-desktop.png');
  await page.screenshot({ path: desktop });
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForFunction(() => {
    const marker = document.querySelector('gmp-advanced-marker')?.getBoundingClientRect();
    const map = document.querySelector('#locationMap').getBoundingClientRect();
    return marker && marker.left >= map.left && marker.right <= map.right && marker.top >= map.top && marker.bottom <= map.bottom;
  });
  assert.equal(await page.$$eval('#dlgUbicacion .modal-footer button', buttons => buttons.every(n => n.getBoundingClientRect().bottom <= window.innerHeight)), true);
  const mobile = path.join(scratch, 'dashboard-google-mobile.png');
  await page.screenshot({ path: mobile });
  assert.equal(await page.$eval('#dlgUbicacion', n => n.getBoundingClientRect().width <= window.innerWidth), true);
  assert.equal(await page.$eval('#locationError', n => n.textContent), '');
  const coordinates = await page.evaluate(() => ({ latitud: Number(document.querySelector('#locationLat').value), longitud: Number(document.querySelector('#locationLng').value) }));
  await page.click('#btnSaveLocation');
  await page.waitForFunction(() => !document.querySelector('#dlgUbicacion').open);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].url, '/api/clientes/1001');
  assert.ok(Math.abs(fixture.writes[0].body.latitud - coordinates.latitud) < 0.0000001);
  assert.ok(Math.abs(fixture.writes[0].body.longitud - coordinates.longitud) < 0.0000001);
  assert.equal(await page.$eval('#locationError', n => n.textContent), '');
  assert.deepEqual(fixture.unexpected, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ sdk: 'Google Maps real', origin, configuration: 'local browser key and authenticated local config route', businessData: 'synthetic only; production app requests intercepted locally', tilesLoaded: true, editableClick: true, realMouseDrag: true, saveLocalFixture: true, desktop: true, mobile: true, errors, screenshots: [desktop, mobile] }, null, 2));
} catch (error) {
  console.error(stage + ': ' + String(error.message).split(key).join('[OCULTO]'));
  console.error('Browser errors:', errors);
  if (page) console.error('UI diagnostic:', await page.evaluate(() => ({ map: !!window.dashboardSmokeMap, marker: !!window.dashboardSmokeMarker, lat: document.querySelector('#locationLat')?.value, lng: document.querySelector('#locationLng')?.value, error: document.querySelector('#locationError')?.textContent, rows: document.querySelectorAll('#rows .btn-location').length })).catch(() => 'Unavailable'));
  if (page) {
    console.error('Marker diagnostic:', await page.evaluate(() => { const n = document.querySelector('gmp-advanced-marker'); const r = n?.getBoundingClientRect(); const p = window.dashboardSmokeMarker?.position; return { draggable: window.dashboardSmokeMarker?.gmpDraggable, box: r && { x:r.x, y:r.y, width:r.width, height:r.height }, position: p && { lat: typeof p.lat === 'function' ? p.lat() : p.lat, lng: typeof p.lng === 'function' ? p.lng() : p.lng } }; }).catch(() => ({})));
    await page.screenshot({ path: path.join(process.env.TMPDIR, 'dashboard-google-debug.png') });
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
