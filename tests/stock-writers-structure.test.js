import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../src/', import.meta.url);
const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const expectedWriterCounts = new Map([
  ['src/routes/stock.js', 6],
  ['src/routes/gastos.js', 4],
  ['src/routes/repartidorApi.js', 2],
]);

function productiveJsFiles() {
  return readdirSync(root, { recursive: true })
    .filter(relative => String(relative).endsWith('.js'))
    .map(relative => `src/${String(relative).replaceAll('\\', '/')}`)
    .sort();
}

function countStockWrites(source) {
  return [...source.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+chofer_stock(?:_mov)?\b/gi)].length;
}

test('inventario estructural exacto: todos los writers de stock usan el protocolo compartido', () => {
  const actual = new Map();
  for (const relative of productiveJsFiles()) {
    const count = countStockWrites(read(relative));
    if (count > 0) actual.set(relative, count);
  }
  assert.deepEqual(actual, expectedWriterCounts);

  for (const relative of expectedWriterCounts.keys()) {
    const source = read(relative);
    assert.match(source, /services\/stockLocking\.js/);
    assert.match(source, /lockStockContext\s*\(/);
  }
});

test('namespace y orden global de stock tienen una sola implementación productiva', () => {
  const service = read('src/services/stockLocking.js');
  assert.match(service, /referencia[^\n]*chofer[^\n]*producto[^\n]*depósitos[^\n]*saldos\/movimientos/i);
  assert.match(service, /balance:\$\{productId\}:deposito:\$\{depositoId\}/);
  assert.match(service, /\.sort\(\(a, b\) => a - b\)/);

  for (const relative of expectedWriterCounts.keys()) {
    if (relative === 'src/services/stockLocking.js') continue;
    const source = read(relative);
    assert.doesNotMatch(source, /stock:\$\{Number\(empresaId\)\}/);
    assert.doesNotMatch(source, /async function advisoryLock/);
  }
});

test('writers con saldo físico escriben saldo antes que movimiento', () => {
  const gastos = read('src/routes/gastos.js');
  const gastoApply = gastos.slice(
    gastos.indexOf('async function applyStockIngresoFromGasto'),
    gastos.indexOf('async function registrarLedgerRetornableDesdeGasto'),
  );
  assert.ok(gastoApply.indexOf('INSERT INTO chofer_stock (') < gastoApply.indexOf('INSERT INTO chofer_stock_mov'));

  const stock = read('src/routes/stock.js');
  const ajuste = stock.slice(
    stock.indexOf("router.post('/ajuste'"),
    stock.indexOf('// GET /api/stock/kardex'),
  );
  assert.ok(ajuste.indexOf('INSERT INTO chofer_stock (') < ajuste.indexOf('INSERT INTO chofer_stock_mov'));

  const reparto = read('src/routes/repartidorApi.js');
  const entrega = reparto.slice(
    reparto.indexOf('// 8. DESCUENTO DE STOCK DEL CHOFER'),
    reparto.indexOf('// 8.b RETORNABLES'),
  );
  assert.ok(entrega.indexOf('INSERT INTO chofer_stock (') < entrega.indexOf('INSERT INTO chofer_stock_mov'));
});
