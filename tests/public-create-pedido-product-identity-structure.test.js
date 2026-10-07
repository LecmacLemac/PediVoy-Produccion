import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('inventario estructural de writers productivos de items_pedido conserva identidad canónica', () => {
  const publicRoute = read('src/routes/publicLegacyCreatePedido.js');
  const adminItems = read('src/routes/pedidosItems.js');
  const adminItemsMutation = read('src/routes/pedidoItemsMutation.js');
  const automaticReorder = read('src/handlers.js');
  const games = read('src/routes/juegos.js');
  const legacyService = read('src/postgresServices.js');
  const app = read('src/app.js');

  assert.match(app, /registerPublicLegacyCreatePedidoRoute\(app/);
  assert.match(app, /resolveEmpresaIdFn: resolvePublicPedidoEmpresaId/);
  assert.match(publicRoute, /resolveProductIdentityItems\(txQuery/);
  assert.match(publicRoute, /producto_id: z\.number\(\)\.safe\(\)\.int\(\)\.positive\(\)\.optional\(\)/);
  assert.match(publicRoute, /INSERT INTO items_pedido[\s\S]*producto_id/);

  assert.match(adminItems, /resolveAndLockPedidoProducts\(txQuery/);
  assert.match(adminItemsMutation, /lockProductIdentityNamespaces\(txQuery/);
  assert.match(adminItemsMutation, /productoId: Number\(product\.id\), productName: product\.nombre/);
  assert.match(automaticReorder, /resolveProductIdentityItems\(txQuery/);
  assert.match(automaticReorder, /item\.producto_resuelto_id/);
  assert.match(games, /WHERE id = \$1[\s\S]*AND empresa_id = \$2[\s\S]*AND deleted_at IS NULL/);
  assert.match(games, /lockDeliveryPointIdentity\(q/);
  assert.match(games, /\[pedido\.id, product\.nombre, product\.id\]/);

  assert.doesNotMatch(app, /updatePedidoItems/);
  assert.equal((legacyService.match(/INSERT INTO items_pedido/g) || []).length, 1);
});
