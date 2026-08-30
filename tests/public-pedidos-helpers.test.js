import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calcularFechaEntregaReal,
  normalizarDiasEntrega,
  resolverConfigEntregaPorZona,
} from '../src/utils.js';

import {
  toNum,
  inRange,
  round,
  normalizeText,
  buildOrderSummary,
} from '../src/public/pedidosLegacyHelpers.js';

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

test('resolverConfigEntregaPorZona prioriza días propios de zona', () => {
  const cfg = resolverConfigEntregaPorZona(
    { dias_habiles: [1, 2, 3, 4, 5], tiempo_entrega_dias: 0 },
    { nombre: 'Norte', dias_entrega: [4, 2, 2, 9, 'x'] }
  );

  assert.deepEqual(normalizarDiasEntrega([4, 2, 2, 9, 'x']), [2, 4]);
  assert.deepEqual(cfg.dias_habiles, [2, 4]);
  assert.equal(cfg.zona_nombre, 'Norte');
});

test('calcularFechaEntregaReal programa al próximo día definido por zona', () => {
  const cfg = resolverConfigEntregaPorZona(
    { dias_habiles: [1, 2, 3, 4, 5], tiempo_entrega_dias: 0 },
    { dias_entrega: [3] }
  );
  const result = calcularFechaEntregaReal(cfg, new Date('2026-08-30T15:00:00-03:00'));

  assert.equal(result.fecha.getDay(), 3);
  assert.equal(result.fecha.toISOString().slice(0, 10), '2026-09-02');
});
