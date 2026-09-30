import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const expectedWriters = new Map([
  ['src/routes/publicLegacyCreatePedido.js', 1],
  ['src/routes/publicClientApp.js', 2],
  ['src/routes/juegos.js', 2],
  ['src/routes/zonas.js', 1],
  ['src/routes/setup.js', 1],
  ['src/routes/referentes.js', 1],
  ['src/routes/clientes.js', 3],
  ['src/routes/repartidorApi.js', 2],
]);

const protocolByFile = new Map([
  ['src/routes/publicLegacyCreatePedido.js', ['deliveryPointIdentity(', 'lockDeliveryPointIdentity(', 'findDeliveryPointsByIdentity(']],
  ['src/routes/publicClientApp.js', ['deliveryPointIdentity(', 'lockDeliveryPointIdentities(', 'findDeliveryPointsByIdentity(']],
  ['src/routes/juegos.js', ['deliveryPointIdentity(', 'lockDeliveryPointIdentity(', 'findDeliveryPointsByIdentity(']],
  ['src/routes/zonas.js', ['lockDeliveryPointRows(']],
  ['src/routes/setup.js', ['lockDeliveryPointRows(']],
  ['src/routes/referentes.js', ['deliveryPointIdentity(', 'lockDeliveryPointIdentities(', 'findDeliveryPointsByIdentity(']],
  ['src/routes/clientes.js', ['deliveryPointIdentity(', 'lockDeliveryPointIdentities(', 'findDeliveryPointsByIdentity(']],
  ['src/routes/repartidorApi.js', ['lockDeliveryPointRows(']],
]);

test('inventario estructural exacto de todos los writers productivos de puntos_entrega', () => {
  const actual = new Map();
  const sourceFiles = readdirSync(new URL('../src/', import.meta.url), { recursive: true })
    .filter(path => String(path).endsWith('.js'))
    .map(path => `src/${String(path).replaceAll('\\', '/')}`)
    .sort();
  for (const path of sourceFiles) {
    const source = read(path);
    const count = [...source.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+puntos_entrega\b/gi)].length;
    if (count) actual.set(path, count);
  }
  assert.deepEqual(actual, expectedWriters);

  for (const [path, requiredCalls] of protocolByFile) {
    const source = read(path);
    for (const call of requiredCalls) {
      assert.ok(source.includes(call), `${path} debe usar ${call}`);
    }
  }
});

test('writers exact-row mantienen tenant scope y RETURNING; creadores escriben empresa e identidad', () => {
  for (const [path] of expectedWriters) {
    const source = read(path);
    for (const match of source.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+puntos_entrega\b[\s\S]{0,900}/gi)) {
      const block = match[0];
      if (/^INSERT/i.test(match[1])) {
        assert.match(block, /empresa_id/i, `${path}: INSERT sin empresa_id`);
        assert.match(block, /RETURNING\s+id/i, `${path}: INSERT sin RETURNING id`);
      } else {
        assert.match(block, /empresa_id/i, `${path}: writer sin tenant scope`);
        assert.match(block, /RETURNING\s+id/i, `${path}: writer sin RETURNING id`);
      }
    }
  }
});

test('resolver público no contiene autoridad por host y carrito conserva canal explícito', () => {
  const resolver = read('src/services/publicPedidoTenant.js');
  const landing = read('pedidos/index.html');
  assert.doesNotMatch(resolver, /req\.hostname|x-forwarded-host|headers\?\.host|landing_domain/i);
  assert.match(resolver, /req\.query\?\.slug/);
  assert.match(resolver, /req\.query\?\.empresa_id/);
  assert.match(landing, /publicTenantParams\.size === 0/);
  assert.match(landing, /fetch\('\/public\/config\?' \+ publicTenantParams\.toString\(\)\)/);
  assert.match(landing, /empresa_id = Number\(d\.empresa_id\)/);
  assert.match(landing, /fetch\('\/public\/pedidos\?' \+ publicTenantParams\.toString\(\)/);
  assert.match(landing, /delete data\.empresa_id/);
  assert.doesNotMatch(landing, /empresa_id\s*=\s*1/);
});
