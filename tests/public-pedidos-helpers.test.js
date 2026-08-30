import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toNum,
  inRange,
  round,
  normalizeText,
  buildOrderSummary,
} from '../src/public/pedidosLegacyHelpers.js';
import { calcularFechaEntregaReal } from '../src/utils.js';

test('toNum convierte números válidos y devuelve null en inválidos', () => {
  assert.equal(toNum('10.5'), 10.5);
  assert.equal(toNum(7), 7);
  assert.equal(toNum(''), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum('abc'), null);
});

test('inRange valida inclusivo en extremos', () => {
  assert.equal(inRange(5, 1, 10), true);
  assert.equal(inRange(1, 1, 10), true);
  assert.equal(inRange(10, 1, 10), true);
  assert.equal(inRange(0, 1, 10), false);
});

test('round redondea con precisión configurable', () => {
  assert.equal(round(1.23456789), 1.234568);
  assert.equal(round(1.23456789, 2), 1.23);
});

test('normalizeText normaliza acentos, espacios y mayúsculas', () => {
  assert.equal(normalizeText('  Árbol   de   NAVIDAD  '), 'arbol de navidad');
  assert.equal(normalizeText(null), '');
});

test('buildOrderSummary devuelve formato correcto para 1 ítem y múltiples', () => {
  const uno = buildOrderSummary([
    { cantidad: 2, producto: 'Bidón 20L', precio_unitario: 3500 },
  ]);
  assert.match(uno, /^2 × Bidón 20L — /);

  const varios = buildOrderSummary([
    { cantidad: 2, producto: 'Bidón 20L', precio_unitario: 3500 },
    { cantidad: 1, producto: 'Soda', precio_unitario: 1200 },
  ]);
  assert.match(varios, /^3 artículos — /);
});

test('calcularFechaEntregaReal respeta días configurados por zona', () => {
  const base = new Date('2026-08-31T12:00:00Z'); // lunes
  const { fecha } = calcularFechaEntregaReal({ dias_habiles: [4] }, base);

  assert.equal(fecha.getDay(), 4);
});
