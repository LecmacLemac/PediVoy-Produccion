import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../pedidos/app/main.js', import.meta.url), 'utf8');
const swSource = readFileSync(new URL('../pedidos/sw.js', import.meta.url), 'utf8');

test('cliente público registra service worker y crea suscripción Web Push real', () => {
  assert.match(mainSource, /navigator\.serviceWorker\.register\(['"]\.\.\/sw\.js['"]/);
  assert.match(mainSource, /registration\.pushManager\.subscribe\(/);
  assert.match(mainSource, /fetch\(['"]\/public\/push\/vapid-key['"]/);
  assert.match(mainSource, /fetch\(['"]\/public\/push\/subscribe['"]/);
});

test('cliente espera que el service worker esté activo antes de suscribirse', () => {
  assert.match(mainSource, /await navigator\.serviceWorker\.ready/);
});

test('cliente público vincula push a pedidos propios con tracking token', () => {
  assert.match(mainSource, /tracking_token/);
  assert.match(mainSource, /pedido_id/);
  assert.match(mainSource, /pedidos:\s*linkedOrders\.map/);
  assert.match(mainSource, /if \(!response\.ok\)/);
  assert.match(mainSource, /lastRegisteredPushFingerprint/);
  assert.doesNotMatch(mainSource, /for \(const order of linkedOrders\)/);
});

test('rotación push falla segura y restaura vínculos desde pedidos autorizados', () => {
  assert.doesNotMatch(swSource, /\.\.\.__ctx/);
  const rotation = swSource.slice(swSource.indexOf("self.addEventListener('pushsubscriptionchange'"));
  assert.doesNotMatch(rotation, /fetch\(['"]\/public\/push\/subscribe['"]/);
  assert.match(mainSource, /navigator\.serviceWorker\.addEventListener\(['"]message['"]/);
  assert.match(mainSource, /PUSH_RESUBSCRIBED/);
  assert.match(mainSource, /PUSH_RESUBSCRIBED[\s\S]{0,300}loadOrders\(\)/);
});

test('service worker usa assets servidos en la ruta real de pedidos', () => {
  assert.doesNotMatch(swSource, /\/Pedidos\/img\//);
  assert.match(swSource, /\/pedidos\/img\/brand\/pedivoy-logo-square-red-bg\.png/);
});
