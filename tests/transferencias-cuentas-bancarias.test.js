import test from 'node:test';
import assert from 'node:assert/strict';

import { matchCuentaBancariaDestino } from '../src/transferenciasServices.js';

const cuentas = [
  {
    id: 11,
    banco: 'Banco Galicia',
    alias: 'PEDIVOY.GALICIA',
    cbu: '0070123456789012345678',
    titular: 'PediVoy SRL',
  },
  {
    id: 22,
    banco: 'Mercado Pago',
    alias: 'PEDIVOY.MP',
    cbu: '0000003100012345678901',
    titular: 'PediVoy SRL',
  },
];

test('detecta la cuenta bancaria destino por CBU/CVU exacto aunque venga con espacios', () => {
  const match = matchCuentaBancariaDestino(cuentas, {
    banco_destino: 'Mercado Pago',
    cbu_destino: '00000031 00012345678901',
  });

  assert.equal(match?.cuenta_bancaria_id, 22);
  assert.equal(match?.confianza, 100);
  assert.match(match?.fuente || '', /cbu/);
});

test('detecta la cuenta bancaria destino por alias normalizado', () => {
  const match = matchCuentaBancariaDestino(cuentas, {
    alias_destino: 'pedivoy-galicia',
  });

  assert.equal(match?.cuenta_bancaria_id, 11);
  assert.equal(match?.confianza, 95);
  assert.equal(match?.fuente, 'alias');
});

test('no asigna cuenta si solo coincide el banco', () => {
  const match = matchCuentaBancariaDestino(cuentas, {
    banco_destino: 'Banco Galicia',
  });

  assert.equal(match, null);
});
