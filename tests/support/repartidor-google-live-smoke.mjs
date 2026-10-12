// Opt-in live browser smoke. Uses synthetic identity/orders, real application HTML,
// real authenticated maps-config route and real Google SDK. Never starts app/DB.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { createWithAuth } from '../../src/core/auth.js';
import { createRepartidorApiRouter } from '../../src/routes/repartidorApi.js';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
// One-off local check only; never writes the server credential to disk/browser config.
const key = env.GOOGLE_MAPS_BROWSER_API_KEY || env.GOOGLE_MAPS_API_KEY;
assert.ok(key, 'Se necesita una clave en .env para la prueba local');
const app = express();
app.use(cookieParser());
const secret = 'synthetic-live-smoke-identity-only';
const user = { id: 1, role: 'repartidor', empresa_id: 7, chofer_id: 4, referente_id: null, activo: true, chofer_valid: true };
app.use('/api/repartidor', createRepartidorApiRouter({
  query: async () => { throw new Error('No DB permitted in browser smoke'); },
  getEmpresaIdFromToken: req => req.user.empresa_id,
  withAuth: createWithAuth({ jwtSecret: secret, queryFn: async (_sql, args) => args[0] === 1 ? [user] : [] }),
  mapsBrowserEnv: { GOOGLE_MAPS_BROWSER_API_KEY: key, GOOGLE_MAPS_MAP_ID: env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID' },
}));
app.get('/pedidos/repartidor.html', (_req, res) => {
  // Skip only production boot (which fetches real business data); all UI scripts remain.
  const html = fs.readFileSync(path.join(root, 'pedidos/repartidor.html'), 'utf8').replace('bootRepartidorPanel();', '/* synthetic smoke: no production boot */');
  res.type('html').send(html);
});
app.use('/pedidos', express.static(path.join(root, 'pedidos')));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
const browserErrors = [];
try {
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  page.on('pageerror', () => browserErrors.push('Error JavaScript en navegador'));
  page.on('console', msg => { const code = msg.text().match(/Google Maps JavaScript API error:\s*(\w+)/); if (code) browserErrors.push(code[1]); });
  await page.setCookie({ name: 'token', value: jwt.sign({ uid: 1, role: 'repartidor' }, secret), url: origin, httpOnly: true });
  await page.goto(`${origin}/pedidos/repartidor.html`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    pedidos = [
      { id: 1, cliente: 'Prueba pendiente', direccion: 'Dirección sintética', telefono: '3515551234', estado: 'pendiente', latitud: -31.416, longitud: -64.184 },
      { id: 2, cliente: 'Prueba en ruta', direccion: 'Dirección sintética', estado: 'en_camino', latitud: -31.419, longitud: -64.188 },
      { id: 3, cliente: 'Prueba entregado', direccion: 'Dirección sintética', estado: 'entregado', fecha_entrega: getOyString(), latitud: -31.418, longitud: -64.186 },
    ];
  });
  await page.click('[data-sec="mapa"]');
  await page.waitForFunction(() => typeof map !== 'undefined' && mapMarkers?.length === 1, { timeout: 30000 });
  await page.evaluate(() => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Google tiles timeout')), 20000);
    google.maps.event.addListenerOnce(map, 'tilesloaded', () => { clearTimeout(timeout); window.smokeTilesLoaded = true; resolve(); });
    map.setZoom(15);
  }));
  assert.equal(await page.evaluate(() => googleMapsAuthorizationFailed), false);
  await page.evaluate(() => google.maps.event.trigger(mapMarkers[0], 'click'));
  await page.waitForFunction(() => document.querySelector('.gm-style-iw')?.textContent.includes('Iniciar ruta'));
  const actions = await page.evaluate(() => document.querySelector('.gm-style-iw').textContent);
  assert.match(actions, /Chat/); assert.match(actions, /Cómo llegar/);
  const screenshot = path.join(process.env.TMPDIR || path.join(root, '.puppeteer'), 'repartidor-google-piloto.png');
  await page.screenshot({ path: screenshot });
  await page.evaluate(async () => { operationalStatusFilter = 'en_ruta'; await renderMap(); });
  assert.equal(await page.evaluate(() => mapMarkers[0].title), 'Prueba en ruta');
  await page.evaluate(async () => { historicalMode = true; await renderMap(); });
  assert.equal(await page.evaluate(() => mapMarkers.length === 1 && mapMarkers[0].title === 'Prueba entregado'), true);
  await page.evaluate(async () => { historicalMode = false; operationalStatusFilter = 'pendiente'; await renderMap(); updateDriverLocationOnMap({coords:{latitude:-31.417,longitude:-64.187,accuracy:25}}); await centerMapOnDriver(); });
  assert.equal(await page.evaluate(() => driverAccuracyCircle.getRadius()), 25);
  assert.equal(await page.evaluate(() => map.getZoom()), 16);
  assert.equal(await page.evaluate(() => Math.abs(map.getCenter().lat() + 31.417) < 0.00001), true);
  await page.evaluate(() => { document.getElementById('mapSecondaryFilters').open = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => resizeRepartidorMap());
  assert.equal(await page.evaluate(() => document.getElementById('mapError').hidden), true);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ sdk: 'Google Maps real', data: 'synthetic test fixtures only', tilesLoaded: true, authenticatedConfig: true, popupActions: true, statusFilter: true, gpsAccuracyAndCenter: true, secondaryFilterResize: true, mobileViewport: true, browserErrors, screenshot }, null, 2));
} catch (error) {
  console.error(String(error.message).split(key).join('[OCULTO]'));
  if (page) console.log(JSON.stringify(await page.evaluate(() => ({hint:document.getElementById('mapHint')?.textContent,error:document.getElementById('mapError')?.textContent, mapType:typeof map, sdk:!!window.google?.maps, markers:typeof mapMarkers !== 'undefined' ? mapMarkers.length : null})), null, 2));
  console.log('Errores navegador:', browserErrors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
