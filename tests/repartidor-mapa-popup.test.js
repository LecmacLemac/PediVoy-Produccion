import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../pedidos/repartidor-mapa-gps.js', import.meta.url),
  'utf8',
);
const helpersSource = source.slice(
  source.indexOf('function getGoogleMapsDirectionsUrl'),
  source.indexOf('function renderMap'),
);
const context = vm.createContext({
  encodeURIComponent,
  esc: (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]),
});
vm.runInContext(helpersSource, context);

test('popup del mapa ofrece iniciar ruta solo para pedidos pendientes', () => {
  const pending = context.buildRepartidorMapPopup({
    id: 42,
    cliente: 'Cliente',
    direccion: 'Dirección',
    estado: 'pendiente',
    telefono: '351 555-1234',
  }, 'https://maps.test/directions');
  const inRoute = context.buildRepartidorMapPopup({
    id: 42,
    cliente: 'Cliente',
    direccion: 'Dirección',
    estado: 'en_ruta',
    telefono: '351 555-1234',
  }, 'https://maps.test/directions');
  const delivered = context.buildRepartidorMapPopup({
    id: 42,
    cliente: 'Cliente',
    direccion: 'Dirección',
    estado: 'entregado',
    telefono: '351 555-1234',
  }, 'https://maps.test/directions');

  assert.match(pending, /setStatus\(42, 'en_ruta', this\)/);
  assert.match(pending, /Iniciar ruta/);
  assert.doesNotMatch(inRoute, /Iniciar ruta/);
  assert.doesNotMatch(delivered, /Iniciar ruta/);
});

test('popup del mapa normaliza el teléfono del cliente y abre WhatsApp seguro', () => {
  const popup = context.buildRepartidorMapPopup({
    id: 7,
    cliente: 'Ana',
    direccion: 'Mitre 123',
    estado: 'pendiente',
    telefono: '0351 555-1234',
  }, 'https://maps.test/directions');

  assert.match(popup, /href="https:\/\/wa\.me\/5493515551234"/);
  assert.match(popup, /target="_blank"/);
  assert.match(popup, /rel="noopener noreferrer"/);
  assert.match(popup, />💬 Chat<\/a>/);
});

test('popup del mapa no genera enlace de WhatsApp sin teléfono válido', () => {
  const popup = context.buildRepartidorMapPopup({
    id: 7,
    cliente: 'Sin Teléfono',
    direccion: 'Mitre 123',
    estado: 'pendiente',
    telefono: '---',
  }, 'https://maps.test/directions');

  assert.doesNotMatch(popup, /wa\.me/);
  assert.match(popup, /disabled/);
  assert.match(popup, /Sin teléfono/);
});
