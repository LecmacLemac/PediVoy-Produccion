import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findDeliveryPointsByIdentity,
  normalizeDeliveryPointAddress,
  normalizeGeneralPhoneIdentity,
  sameDeliveryPointIdentity,
  deliveryPointIdentity,
} from '../src/services/deliveryPointIdentity.js';
import { normalizePhone as normalizeProductionPhone } from '../src/core/format.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const normalizePhone = value => String(value || '').replace(/\D/g, '');

test('la identidad telefónica pública acepta sólo los cuatro formatos argentinos completos', () => {
  const valid = [
    '3535551212',
    '03535551212',
    '+54 353 555-1212',
    '+54 9 353 555-1212',
  ];
  for (const value of valid) {
    assert.equal(normalizeGeneralPhoneIdentity(normalizePhone, value), '3535551212', value);
  }

  const invalid = [
    '1',
    '1234567',
    '123456789',
    '12345678901',
    '773535551212',
    '9995493535551212',
  ];
  for (const value of invalid) {
    assert.equal(normalizeGeneralPhoneIdentity(normalizePhone, value), '', value);
  }
});

test('la identidad pública valida los dígitos crudos aunque el normalizador productivo trunque', () => {
  assert.equal(normalizeGeneralPhoneIdentity(normalizeProductionPhone, '3535551212'), '3535551212');
  assert.equal(normalizeGeneralPhoneIdentity(normalizeProductionPhone, '+54 9 353 555-1212'), '3535551212');
  assert.equal(normalizeGeneralPhoneIdentity(normalizeProductionPhone, '12345678901'), '');
  assert.equal(normalizeGeneralPhoneIdentity(normalizeProductionPhone, '773535551212'), '');
  assert.equal(normalizeGeneralPhoneIdentity(normalizeProductionPhone, '9995493535551212'), '');
});

test('normaliza tildes, puntuación, espacios y abreviaturas viales comunes', () => {
  const variants = [
    'Bv. San Martín 123',
    'Boulevard San Martin 123',
    '  BOULEVARD, SAN   MARTÍN Nº 123  ',
  ];
  const normalized = variants.map(normalizeDeliveryPointAddress);
  assert.deepEqual(new Set(normalized).size, 1);

  assert.equal(
    normalizeDeliveryPointAddress('Av. Vélez Sársfield 450'),
    normalizeDeliveryPointAddress('Avenida Velez Sarsfield 450')
  );
});

test('no fusiona direcciones con números de calle distintos', () => {
  assert.notEqual(
    normalizeDeliveryPointAddress('Av. Colón 123'),
    normalizeDeliveryPointAddress('Avenida Colon 124')
  );

  const left = deliveryPointIdentity({ normalizePhoneFn: normalizePhone, telefono: '353 555-1212', direccion: 'Av. Colón 123' });
  const right = deliveryPointIdentity({ normalizePhoneFn: normalizePhone, telefono: '3535551212', direccion: 'Avenida Colon 124' });
  assert.equal(sameDeliveryPointIdentity(left, right), false);
});

test('PostgreSQL real usa la misma normalización canónica sin confundir numeraciones', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE puntos_entrega (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL,
        cliente text,
        telefono text,
        telefono_normalizado text,
        direccion text,
        ciudad text,
        provincia text,
        pais text,
        notas text,
        latitud numeric,
        longitud numeric,
        zona_id integer
      );
      INSERT INTO puntos_entrega (id, empresa_id, telefono, telefono_normalizado, direccion, notas) VALUES
        (1, 7, '3535551212', '3535551212', 'Bv. San Martín Nº 123', 'No debe salir del helper de identidad'),
        (2, 7, '3535551212', '3535551212', 'Boulevard San Martin 124', 'Tampoco debe salir');
    `);
    const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const identity = deliveryPointIdentity({
      normalizePhoneFn: normalizePhone,
      telefono: '3535551212',
      direccion: 'BOULEVARD, SAN MARTÍN 123',
    });
    const rows = await findDeliveryPointsByIdentity(query, { empresaId: 7, identity });
    assert.deepEqual(rows.map(row => row.id), [1]);
    assert.equal(Object.hasOwn(rows[0], 'notas'), false);
  });
});
