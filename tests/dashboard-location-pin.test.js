import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('dashboard-data expone identidad y ubicación del punto de entrega', async () => {
  const source = await read('src/routes/pedidos.js');

  assert.match(source, /pe\.id AS punto_entrega_id/);
  assert.match(source, /pe\.latitud/);
  assert.match(source, /pe\.longitud/);
  assert.match(source, /pe\.ciudad/);
  assert.match(source, /pe\.provincia/);
  assert.match(source, /pe\.pais/);
});

test('dashboard ofrece pin editable manual y geocodificación automática', async () => {
  const html = await read('pedidos/dashboard.html');

  assert.match(html, /leaflet(?:\.css|@1\.9\.4)/i);
  assert.match(html, /id="dlgUbicacion"/);
  assert.match(html, /id="locationMap"/);
  assert.match(html, /openUbicacion\(/);
  assert.match(html, /locationMap\.on\(['"]click['"]/);
  assert.match(html, /dragend/);
  assert.match(html, /\/api\/clientes\/geocode/);
  assert.match(html, /\/api\/clientes\/\$\{[^}]+\}/);
  assert.match(html, /Ubicar automáticamente/);
  assert.match(html, /Guardar ubicación/);
});

test('dashboard bloquea edición si el pedido no tiene punto de entrega', async () => {
  const html = await read('pedidos/dashboard.html');

  assert.match(html, /punto_entrega_id/);
  assert.match(html, /No se puede editar la ubicación/i);
});

test('validador de coordenadas no convierte valores ausentes en Null Island', async () => {
  const { hasValidCoordinates } = await import('../pedidos/location-utils.js');

  assert.equal(hasValidCoordinates(null, null), false);
  assert.equal(hasValidCoordinates(undefined, undefined), false);
  assert.equal(hasValidCoordinates('', ''), false);
  assert.equal(hasValidCoordinates('   ', '   '), false);
  assert.equal(hasValidCoordinates(-32.4113, -63.2374), true);
  assert.equal(hasValidCoordinates(-91, -63.2374), false);
  assert.equal(hasValidCoordinates(-32.4113, 181), false);
});

test('cada JOIN pedido-punto de entrega exige coincidencia de empresa', async () => {
  const source = await read('src/routes/pedidos.js');
  const joinPattern = /LEFT JOIN puntos_entrega pe\s+ON pe\.id = p\.punto_entrega_id([\s\S]*?)(?=\n\s+(?:LEFT JOIN|WHERE|GROUP BY|ORDER BY|LIMIT|`))/g;
  const joins = [...source.matchAll(joinPattern)];

  assert.ok(joins.length > 0, 'No se encontraron JOIN de puntos_entrega para auditar');
  for (const [index, join] of joins.entries()) {
    assert.match(join[1], /AND pe\.empresa_id = p\.empresa_id/, `JOIN puntos_entrega #${index + 1} sin aislamiento tenant`);
  }
});
