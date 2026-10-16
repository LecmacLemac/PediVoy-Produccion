import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { createWithAuth } from '../src/core/auth.js';
import { registerCompanyManual } from '../src/routes/companyManual.js';
import { applyCompanyManualNavigation } from '../pedidos/dashboard-nav.js';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('src/views/company-manual.html', root), 'utf8');
const secret = 'synthetic-manual-test-only';
const token = (claims = {}) => jwt.sign({ uid: 1, role: 'admin', ...claims }, secret, { expiresIn: '5m' });

export async function harness(t, role = 'admin') {
  const identity = { id: 1, username: 'synthetic', role, empresa_id: role === 'super' ? null : 7,
    chofer_id: null, referente_id: null, activo: true };
  if (role === 'repartidor') Object.assign(identity, { chofer_id: 2, chofer_valid: true });
  if (role === 'referente') Object.assign(identity, { referente_id: 3, referente_valid: true });
  const app = express();
  app.use(cookieParser());
  const queries = [];
  registerCompanyManual(app, { withAuth: createWithAuth({ jwtSecret: secret, queryFn: async (sql, params) => {
    queries.push({ sql, params });
    return [identity];
  } }) });
  app.use('/pedidos', express.static(new URL('pedidos/', root).pathname));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, identity, queries };
}

test('manual requires authentication and rejects invalid, expired and client tokens', async t => {
  const { origin, queries } = await harness(t);
  for (const cookie of ['', 'token=invalid']) {
    const response = await fetch(origin + '/pedidos/ayuda', { headers: { cookie } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.doesNotMatch(await response.text(), /Tu operación diaria/);
  }
  for (const invalid of [jwt.sign({ uid: 1, role: 'admin' }, secret, { expiresIn: -1 }), token({ type: 'client' })]) {
    assert.equal((await fetch(origin + '/pedidos/ayuda', { headers: { cookie: `token=${invalid}` } })).status, 401);
  }
  assert.equal(queries.length, 0);
});

test('admin and super can read the manual without tenant selection or writes', async t => {
  for (const role of ['admin', 'super']) {
    const { origin, queries } = await harness(t, role);
    const response = await fetch(origin + '/pedidos/ayuda?empresa_id=999', { headers: { cookie: `token=${token({ role })}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), html);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql.trim(), /^SELECT /);
    assert.deepEqual(queries[0].params, [1]);
    const head = await fetch(origin + '/pedidos/ayuda', { method: 'HEAD', headers: { cookie: `token=${token()}` } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('current role and active status override stale admin claims', async t => {
  for (const role of ['user', 'repartidor', 'referente', 'facturacion', 'contable']) {
    const { origin } = await harness(t, role);
    const response = await fetch(origin + '/pedidos/ayuda', { headers: { cookie: `token=${token()}` } });
    assert.equal(response.status, 403, role);
    assert.doesNotMatch(await response.text(), /Tu operación diaria/);
  }
  const { origin, identity } = await harness(t);
  identity.activo = false;
  assert.equal((await fetch(origin + '/pedidos/ayuda', { headers: { cookie: `token=${token()}` } })).status, 401);
});

test('manual document has no public static alias and application registers guarded route', async t => {
  const { origin } = await harness(t);
  for (const path of ['/pedidos/company-manual.html', '/pedidos/ayuda.html', '/src/views/company-manual.html', '/pedidos/ayuda/']) {
    const response = await fetch(origin + path);
    assert.ok([401, 404].includes(response.status), path);
    assert.doesNotMatch(await response.text(), /Tu operación diaria/);
  }
  const app = readFileSync(new URL('src/app.js', root), 'utf8');
  assert.match(app, /import \{ registerCompanyManual \} from '.\/routes\/companyManual.js'/);
  assert.ok(app.indexOf('registerCompanyManual(app, { withAuth })') < app.indexOf("app.use('/pedidos', express.static"));
});

test('dashboard help navigation starts hidden and follows exact admin/super roles', () => {
  const dashboard = readFileSync(new URL('pedidos/dashboard.html', root), 'utf8');
  assert.match(dashboard, /id="companyManualNavItem" hidden><a href="\/pedidos\/ayuda">Ayuda y manual/);
  assert.match(dashboard, /applyCompanyManualNavigation\(document, user\?\.role\)/);
  const item = { hidden: true };
  const document = { querySelector(selector) { assert.equal(selector, '#companyManualNavItem'); return item; } };
  for (const role of ['admin', 'super', 'user', 'repartidor', 'referente', 'facturacion', 'contable', 'Admin', ' admin', null, undefined]) {
    const allowed = ['admin', 'super'].includes(role);
    assert.equal(applyCompanyManualNavigation(document, role), allowed);
    assert.equal(item.hidden, !allowed);
  }
});

test('Spanish manual covers scope, verified modules and safe support with valid local links', () => {
  assert.match(html, /<html lang="es">/);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  for (const id of ['inicio', 'lista', 'pedidos', 'catalogo', 'clientes', 'pagos', 'whatsapp', 'configuracion', 'permisos', 'soporte']) {
    assert.ok(html.includes(`<section id="${id}"`), id);
    assert.ok(html.includes(`href="#${id}"`), id);
  }
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = match[1];
    if (url.startsWith('#')) assert.ok(html.includes(`id="${url.slice(1)}"`), url);
    else { assert.ok(url.startsWith('/pedidos/'), url); assert.ok(existsSync(new URL(url.slice(1), root)), url); }
  }
  assert.match(html, /propietarios y administradores/);
  assert.match(html, /no guardan progreso ni cambian datos/);
  assert.match(html, /Un comprobante no demuestra/);
  assert.match(html, /Nunca envíes contraseñas, tokens/);
  assert.doesNotMatch(html, /<script|mailto:|https?:\/\//);
});

test('manual explains every configurable product group and the effects of its options', () => {
  const requiredGuidance = [
    'Nombre del producto', 'Precio ($)', 'Descripción', 'SKU / Código interno', 'Categoría', 'Orden (prioridad)',
    'Stock mínimo', 'Estado: Activo / Inactivo', 'Producto retornable / con envase a devolver',
    'Es un activo físico', 'Cobrar alquiler mientras esté en el cliente', 'Monto alquiler mensual ($)', 'Plazo mínimo (meses)',
    'Etiqueta (Promo)', 'Imagen principal, Imagen 2 e Imagen 3 (URL)', 'App Catálogo', 'Web Landing',
    'Regalo por única vez por cliente', 'Producto de regalo', 'Alcance de la promo única', 'Mínimo total del pedido ($)',
    'Cantidad mínima del producto disparador', 'Producto adicional requerido (combo)', 'Descuento (%) y Descuento fijo ($)',
    'Tope total de usos / Tope de usos por día', 'Prioridad de promo', 'Combinación con otras promos', 'Vigencia desde / hasta',
    'Programar este producto', 'Repetición: Cada semana / Fechas puntuales', 'Abrir y cerrar: días antes y hora',
    'Permitir pedidos anticipados', 'Cupo diario compartido', 'Reglas por canal', 'Excepciones por fecha',
    'Vista previa de lo guardado'
  ];
  for (const text of requiredGuidance) assert.ok(html.includes(text), text);
  assert.match(html, /la etiqueta promocional no activa una promoción/i);
  assert.match(html, /Cupo diario compartido[\s\S]*Vacío significa ilimitado; 0 significa agotado/);
  assert.match(html, /Pausar nuevas compras no cancela pedidos existentes/);
});

test('manual works without JavaScript on mobile and desktop, with keyboard-accessible controls', async t => {
  const { default: puppeteer } = await import('puppeteer');
  const { origin } = await harness(t);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setCookie({ name: 'token', value: token(), url: origin, httpOnly: true });
  const external = [];
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().startsWith(origin)) request.continue();
    else { external.push(request.url()); request.abort(); }
  });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewport({ width, height: 900 });
    assert.equal((await page.goto(origin + '/pedidos/ayuda')).status(), 200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
    assert.equal(await page.$eval('h1', element => element.textContent), 'Tu operación diaria, paso a paso');
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
  assert.notEqual(await page.$eval('.skip-link', el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'contenido');
  await page.focus('summary');
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('details', el => el.open), true);
  await page.focus('.checklist input');
  await page.keyboard.press('Space');
  assert.equal(await page.$eval('.checklist input', el => el.checked), true);
  assert.deepEqual(external, []);
});
