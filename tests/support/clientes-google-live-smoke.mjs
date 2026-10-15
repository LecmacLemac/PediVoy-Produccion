// Opt-in live Google SDK. Business HTML/API requests are intercepted locally before navigation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { clientesFixture } from './clientes-google-fixture.mjs';
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
const key = env.GOOGLE_MAPS_BROWSER_API_KEY?.trim();
assert.ok(key, 'Se requiere GOOGLE_MAPS_BROWSER_API_KEY local; no se sustituye por otra clave');
const fixture = clientesFixture({ browserKey: key, mapId: env.GOOGLE_MAPS_MAP_ID });
const server = fixture.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const local = `http://127.0.0.1:${server.address().port}`, origin = 'https://www.pedivoy.com';
let browser, page, stage = 'launch'; const errors = [];
try {
  browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  page = await browser.newPage(); await page.setViewport({ width: 1200, height: 950 });
  page.on('pageerror', e => errors.push(e.message.split(key).join('[OCULTO]')));
  page.on('console', m => { const code = m.text().match(/Google Maps JavaScript API error:\s*(\w+)/); if (code) errors.push(code[1]); });
  await page.setRequestInterception(true);
  page.on('request', async req => {
    const url = new URL(req.url()); if (url.origin !== origin) return req.continue();
    try {
      const res = await fetch(local + url.pathname + url.search, { method: req.method(), headers: { 'Content-Type': 'application/json' }, body: req.postData() });
      await req.respond({ status: res.status, contentType: res.headers.get('content-type') || 'text/plain', body: Buffer.from(await res.arrayBuffer()) });
    } catch { errors.push('Local fixture interception failed'); await req.abort(); }
  });
  stage = 'actual client HTML';
  await page.goto(origin + '/pedidos/inicio/clientes.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[data-action=edit]');
  await page.evaluate(() => { void edit(1001); });
  stage = 'Google initialization';
  await page.waitForFunction(() => typeof map !== 'undefined' && map && marker, { timeout: 30000 });
  await page.$eval('#map', n => n.scrollIntoView({ block: 'center' }));
  stage = 'tiles loaded';
  await page.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Map tiles did not load')), 20000);
    google.maps.event.addListenerOnce(map, 'tilesloaded', () => { clearTimeout(timer); resolve(); }); map.setZoom(15);
  }));
  assert.equal(await page.evaluate(() => marker.gmpDraggable), true);
  const box = await page.$eval('#map', n => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
  stage = 'click and marker render';
  const click = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 };
  await page.mouse.click(click.x, click.y);
  await page.waitForFunction(() => document.querySelector('#c_longitud').value !== '-64.19');
  await page.waitForFunction(({ x, y }) => { const b = document.querySelector('gmp-advanced-marker')?.getBoundingClientRect(); return b && Math.abs(b.x + b.width / 2 - x) < 4 && Math.abs(b.bottom - y) < 4; }, {}, click);
  const pin = await page.$('gmp-advanced-marker'), r = await pin.boundingBox(); assert.ok(r);
  const before = await page.$eval('#c_longitud', n => n.value);
  stage = 'real mouse drag';
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 40, r.y + r.height / 2 + 20, { steps: 15 }); await page.mouse.up();
  await page.waitForFunction(old => document.querySelector('#c_longitud').value !== old, {}, before);
  assert.equal(fixture.writes.length, 0, 'Pin dragging does not auto-save');
  const desktop = path.join(process.env.TMPDIR, 'clientes-google-desktop.png'); await page.screenshot({ path: desktop });
  stage = 'mobile';
  await page.setViewport({ width: 390, height: 844 });
  await page.$eval('#map', n => n.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => { const m = document.querySelector('#map').getBoundingClientRect(); const p = document.querySelector('gmp-advanced-marker')?.getBoundingClientRect(); return p && p.left >= m.left && p.right <= m.right && p.top >= m.top && p.bottom <= m.bottom; });
  const mobile = path.join(process.env.TMPDIR, 'clientes-google-mobile.png'); await page.screenshot({ path: mobile });
  assert.equal(await page.$eval('#clientesMapError', n => n.hidden), true);
  assert.equal(await page.$eval('#modal .modal', n => n.getBoundingClientRect().width <= innerWidth), true);
  stage = 'save synthetic customer';
  const position = await page.evaluate(() => ({ latitud: document.querySelector('#c_latitud').value, longitud: document.querySelector('#c_longitud').value }));
  await page.evaluate(() => save());
  assert.equal(fixture.writes.length, 1); assert.equal(fixture.writes[0].url, '/api/clientes/1001');
  assert.equal(fixture.writes[0].body.latitud, position.latitud); assert.equal(fixture.writes[0].body.longitud, position.longitud);
  assert.deepEqual(fixture.unexpected, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ sdk: 'Google Maps real', origin, configuration: 'local browser key and real authenticated local config route', data: 'synthetic only; no production app/DB traffic', tilesLoaded: true, mapClick: true, realMouseDrag: true, localFixtureSave: true, desktop: true, mobile: true, screenshots: [desktop, mobile], errors }, null, 2));
} catch (error) {
  console.error(stage + ': ' + String(error.message).split(key).join('[OCULTO]')); console.error('Browser errors:', errors);
  if (page) { console.error('Map status:', await page.$eval('#clientesMapError', n => n.textContent).catch(() => 'Unavailable')); await page.screenshot({ path: path.join(process.env.TMPDIR, 'clientes-google-debug.png') }); }
  process.exitCode = 1;
} finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
