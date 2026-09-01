import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(
  new URL('../pedidos/repartidor-core.js', import.meta.url),
  'utf8',
);
const operacionesSource = fs.readFileSync(
  new URL('../pedidos/repartidor-operaciones.js', import.meta.url),
  'utf8',
);

const dateHelpersSource = coreSource.slice(
  coreSource.indexOf('const isoToLocalYMD'),
  coreSource.indexOf('function formatFechaPlanificada'),
);
const resumenDateSource = operacionesSource.slice(
  operacionesSource.indexOf('function getPedidoFechaResumen'),
  operacionesSource.indexOf('function buildRetornablesRutaResumen'),
);

const context = vm.createContext({
  Intl,
  Date,
  Number,
  String,
});

vm.runInContext(dateHelpersSource, context);
vm.runInContext(resumenDateSource, context);

test('resumen de repartidor usa fecha real en pedidos entregados aunque tengan fecha estimada distinta', () => {
  const pedido = {
    estado: 'entregado',
    fecha: '2026-08-31T23:30:00.000Z',
    fecha_entrega: '2026-09-01T14:30:00.000Z',
    fecha_entrega_estimada: '2026-09-03',
  };

  assert.equal(context.getPedidoFechaResumen(pedido), '2026-09-01');
});

test('resumen de repartidor conserva fecha operativa para pedidos activos', () => {
  const pedido = {
    estado: 'en_ruta',
    fecha: '2026-09-01T14:30:00.000Z',
    fecha_entrega_estimada: '2026-09-03',
  };

  assert.equal(context.getPedidoFechaResumen(pedido), '2026-09-03');
});
