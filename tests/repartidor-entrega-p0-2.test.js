import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import vm from 'node:vm';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';
import { createRetornablesRouter } from '../src/routes/retornables.js';
import { registrarMovimientosActivosDesdePedido } from '../src/adm/pedidoActivosService.js';
import { withTransaction as dbWithTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const entregaSource = read('pedidos/repartidor-entrega.js');
const html = read('pedidos/repartidor.html');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const validChecklist = {
  cliente_confirmado: true,
  producto_entregado: true,
  cobro_confirmado: true,
};

function buildApp(client, overrides = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async () => [],
    pool: { connect: async () => client },
    withAuth: (req, _res, next) => {
      req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' };
      next();
    },
    getEmpresaIdFromToken: () => 3,
    notifyEstadoPedidoPush: async () => {},
    notificarEnRuta: async () => {},
    notificarPedidoTransferencia: async () => {},
    ejecutarEstrategiaVecinos: async () => {},
    awardPointsForDeliveredOrder: async () => {},
    generateComisionesForDeliveredOrder: async () => {},
    registrarMovimientosActivosDesdePedido: async () => {},
    ...overrides,
  }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deliveryClient({
  estado = 'en_ruta',
  choferRows = [{ id: 7 }],
  metodoPago = 'efectivo',
  retornables = [],
  activos = [],
  consumibles = [],
  saldo = 0,
  zonaId = 5,
  puntoEntregaTenantId = 9,
  puntoRows = [{ id: 9, cuenta_corriente_habilitada: false }],
  zonaRows = [{ zona_id: 5 }],
  finalUpdateRows = [{ id: 42 }],
  puntoUpdateRows = [{ id: 9 }],
  commitError = null,
  rollbackError = null,
  stockWriteRows = null,
} = {}) {
  const calls = [];
  const releases = [];
  const compositionItems = new Map();
  const compositionProducts = new Map();
  for (const [index, row] of activos.entries()) {
    const itemId = Number(row.item_pedido_id || 1000 + index);
    const productId = Number(row.producto_id);
    compositionItems.set(itemId, {
      id: itemId,
      producto_id: productId,
      producto: row.nombre || `Producto ${productId}`,
      cantidad: row.cantidad,
    });
    compositionProducts.set(productId, {
      id: productId,
      nombre: row.nombre || `Producto ${productId}`,
      retornable: false,
      config_activo: { es_activo: true },
    });
  }
  for (const [index, row] of retornables.entries()) {
    const productId = Number(row.producto_id);
    const existingItem = Array.from(compositionItems.values()).find(item => item.producto_id === productId);
    if (!existingItem) {
      const itemId = 2000 + index;
      compositionItems.set(itemId, {
        id: itemId,
        producto_id: productId,
        producto: row.nombre || `Producto ${productId}`,
        cantidad: row.entregados,
      });
    }
    const existingProduct = compositionProducts.get(productId) || {};
    compositionProducts.set(productId, {
      id: productId,
      nombre: row.nombre || existingProduct.nombre || `Producto ${productId}`,
      retornable: true,
      config_activo: existingProduct.config_activo || {},
    });
  }
  for (const [index, row] of consumibles.entries()) {
    const productId = Number(row.producto_id);
    const itemId = Number(row.item_pedido_id || 3000 + index);
    compositionItems.set(itemId, {
      id: itemId,
      producto_id: productId,
      producto: row.nombre || `Producto ${productId}`,
      cantidad: row.cantidad,
    });
    compositionProducts.set(productId, {
      id: productId,
      nombre: row.nombre || `Producto ${productId}`,
      retornable: false,
      config_activo: {},
    });
  }
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'COMMIT' && commitError) throw commitError;
      if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: 42,
          empresa_id: 3,
          chofer_id: 7,
          estado,
          metodo_pago: metodoPago,
          zona_id: zonaId,
          punto_entrega_id: 9,
          punto_entrega_tenant_id: puntoEntregaTenantId,
          monto: 1200,
          cuenta_corriente_habilitada: false,
        }] };
      }
      if (sql.includes('FROM choferes') && sql.includes('FOR SHARE')) return { rows: choferRows };
      if (sql.includes('to_jsonb(pe)') && !sql.includes('FOR UPDATE')) return { rows: [{ id: 9, empresa_id: 3 }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM puntos_entrega') && sql.includes('FOR')) return { rows: puntoRows };
      if (sql.includes('FROM zona_chofer')) return { rows: zonaRows };
      if (sql.includes('FROM items_pedido') && sql.includes('ORDER BY id')) {
        return { rows: Array.from(compositionItems.values()) };
      }
      if (sql.includes('FROM productos') && sql.includes('id = ANY') && !sql.includes('FOR SHARE')) {
        return { rows: Array.from(compositionProducts.keys()).sort((a, b) => a - b).map(id => ({ id })) };
      }
      if (sql.includes('FROM productos') && sql.includes('FOR SHARE')) {
        return { rows: Array.from(compositionProducts.values()).sort((a, b) => a.id - b.id) };
      }
      if (sql.includes('COALESCE(p.retornable') && sql.includes('FROM items_pedido ip')) {
        return { rows: retornables };
      }
      if (sql.includes('config_activo') && sql.includes('FROM items_pedido ip') && sql.includes('item_pedido_id')) {
        return { rows: activos };
      }
      if (sql.includes('FROM cliente_retornables_saldos') && sql.includes('FOR UPDATE')) {
        return { rows: [{ saldo: String(saldo) }] };
      }
      if (sql.includes('INSERT INTO cliente_retornables_saldos') && sql.includes('DO NOTHING')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE cliente_retornables_saldos')) return { rows: [] };
      if (sql.includes('INSERT INTO retornables_saldos')) return { rows: [{ saldo: String(saldo) }] };
      if (sql.includes('INSERT INTO cliente_retornables_movimientos')) return { rows: [{ id: 91 }] };
      if (sql.includes('INSERT INTO retornables_movimientos')) return { rows: [{ id: 92, saldo_resultante: String(saldo) }] };
      if (sql.includes('INSERT INTO chofer_stock_mov')) return { rows: [{ id: 93 }] };
      if (sql.includes('UPDATE chofer_stock') && sql.includes('cantidad >= $4')) {
        return { rows: stockWriteRows ?? [{ empresa_id: 3, chofer_id: 7, producto_id: Number(params[2]) }] };
      }
      if (sql.includes('INSERT INTO chofer_stock')) return { rows: [{ empresa_id: 3, chofer_id: 7, producto_id: Number(params[2]) }] };
      if (sql.includes('FROM items_pedido ip') && sql.includes('JOIN productos p')) return { rows: [] };
      if (sql.includes("UPDATE pedidos") && sql.includes("estado = 'entregado'")) return { rows: finalUpdateRows };
      if (sql.includes('UPDATE puntos_entrega')) return { rows: puntoUpdateRows };
      if (sql.includes('INSERT INTO entregas_evidencias')) return { rows: [] };
      if (sql.includes('FROM comprobantes_transferencia')) return { rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    release(error) { releases.push(error); },
  };
  return { client, calls, releases };
}

async function postDelivery(client, body) {
  const app = buildApp(client);
  let result;
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    result = { status: response.status, body: await response.json() };
  });
  return result;
}

test('endpoint directo de activos queda retirado y no consulta ni muta', async () => {
  let queryCalls = 0;
  let serviceCalls = 0;
  const app = buildApp({}, {
    query: async () => {
      queryCalls += 1;
      return [];
    },
    registrarMovimientosActivosDesdePedido: async () => {
      serviceCalls += 1;
      return { ok: true };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/activos-movimientos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [{ tipoOperacion: 'entrega', activoId: 101 }] }),
    });
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /cierre de entrega/i);
  });

  assert.equal(queryCalls, 0);
  assert.equal(serviceCalls, 0);
});

test('estado de entrega se autoriza sólo con valores canónicos exactos', async (t) => {
  const rechazados = ['pendiente', 'cancelado', 'EN_RUTA', ' en_ruta', 'en_ruta ', 'Entregado', null];
  for (const estado of rechazados) {
    await t.test(String(estado), async () => {
      const { client, calls } = deliveryClient({ estado });
      const result = await postDelivery(client, { movimientos: [], checklist: validChecklist });
      assert.equal(result.status, 409);
      assert.equal(calls.some(({ sql }) => sql.includes("UPDATE pedidos") && sql.includes("estado = 'entregado'")), false);
    });
  }

  await t.test('en_camino exacto', async () => {
    const { client } = deliveryClient({ estado: 'en_camino' });
    const result = await postDelivery(client, { movimientos: [], checklist: validChecklist });
    assert.equal(result.status, 200);
  });
});

test('entrega simple abre el modal universal y no hace POST automático', () => {
  const abrir = slice(entregaSource, 'async function abrirActivosPaso', 'function setupFirmaEntregaCanvas');
  assert.doesNotMatch(abrir, /\/api\/repartidor\/pedidos\/\$\{pedidoId\}\/entregar/);
  assert.match(abrir, /\$\('#activosModal'\)\.hidden = false/);
  assert.match(html, /id="amChkCobro"(?![^>]*checked)/);
});

test('el cierre exige las tres confirmaciones antes de enviar', () => {
  const confirmar = slice(entregaSource, 'async function confirmarEntregaConActivos', 'async function confirmarEntregaScanner');
  assert.match(confirmar, /cliente_confirmado/);
  assert.match(confirmar, /producto_entregado/);
  assert.match(confirmar, /cobro_confirmado/);
  assert.match(confirmar, /Falta confirmar:/i);
  assert.match(confirmar, /faltantesChecklist\.push\('cliente'\)/);
  assert.match(confirmar, /faltantesChecklist\.push\('producto'\)/);
  assert.match(confirmar, /faltantesChecklist\.push\('cobro'\)/);
  assert.ok(confirmar.indexOf('Falta confirmar') < confirmar.indexOf('/entregar'));
});

test('scanner conserva movimientos y restaura el mismo DOM universal sin recargar', () => {
  const scanner = slice(entregaSource, 'async function confirmarEntregaScanner', 'function cerrarModalEscaneo');
  assert.doesNotMatch(scanner, /\/entregar/);
  assert.doesNotMatch(scanner, /abrirActivosPaso\(/);
  assert.match(scanner, /activosModalState\.movimientosIniciales\s*=\s*movimientos\.map/);
  assert.match(scanner, /universalModal\.hidden\s*=\s*false/);
});

test('acciones universales de retiro y cambio conservan itemPedidoId y productoId', () => {
  const confirmar = slice(entregaSource, 'async function confirmarEntregaConActivos', 'async function confirmarEntregaScanner');
  const routeSource = read('src/routes/repartidorApi.js');
  assert.match(routeSource, /a\.producto_id[\s\S]*FROM empresa_activos a/);
  assert.match(entregaSource, /data-am-item-id="\$\{itemPedidoId\}"/);
  assert.match(entregaSource, /data-am-producto-id="\$\{productoId\}"/);
  assert.match(confirmar, /itemPedidoId,[\s\S]*productoId/);
});

test('UI de retornables preserva crédito negativo al calcular máximo y sugerido', async () => {
  assert.match(entregaSource, /const maxExigible = Math\.max\(0, saldoPrevio \+ entregados\)/);
  assert.doesNotMatch(entregaSource, /Math\.max\(0, saldoPrevio\) \+ entregados/);
  assert.match(entregaSource, /max="\$\{maxExigible\}"/);
  assert.match(entregaSource, /Máximo a recibir:\s*<b>\$\{maxExigible\}<\/b>/);
  const confirmar = slice(entregaSource, 'async function confirmarEntregaConActivos', 'async function confirmarEntregaScanner');
  assert.match(confirmar, /Number\.isSafeInteger\(devueltos\)/);
  assert.match(confirmar, /supera el máximo exigible/i);
  assert.match(confirmar, /debe ser un entero mayor o igual a 0/i);

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true,
      value: '',
      checked: false,
      dataset: {},
      style: {},
      addEventListener() {},
      focus() {},
      getContext: () => ({ clearRect() {} }),
    });
    return elements.get(id);
  };
  const context = {
    console,
    api: async () => ({
      pedido: { cliente: 'Cliente crédito', direccion: 'Calle 1', monto: 100, metodo_pago: 'efectivo' },
      items_activos: [],
      retornables_resumen: { items: [{ producto_id: 55, producto: 'Bidón', cantidad_entregada: 2, saldo_actual: -3 }] },
      activos_cliente: [],
      activos_disponibles: [],
      movimientos_existentes: [],
    }),
    activosModalState: { pedidoId: null, data: null, movimientosIniciales: [] },
    $: (selector) => element(selector.replace(/^#/, '')),
    $$: () => [],
    esc: String,
    money: String,
    setupFirmaEntregaCanvas() {},
    limpiarFirmaEntrega() {},
    alert(message) { throw new Error(`alert inesperado: ${message}`); },
    formatFechaHoraAR: String,
  };
  vm.runInNewContext(`${slice(entregaSource, 'async function abrirActivosPaso', 'function setupFirmaEntregaCanvas')}\nthis.abrirActivosPaso = abrirActivosPaso;`, context);
  await context.abrirActivosPaso(42);
  const rendered = element('amContenido').innerHTML;
  assert.match(rendered, /Deuda previa: <b>-3<\/b>/);
  assert.match(rendered, /Máximo a recibir: <b>0<\/b>/);
  assert.match(rendered, /max="0"/);
  assert.match(rendered, /value="0"/);
});

function scannerUiHarness({ itemsActivos = [{ item_pedido_id: 8, producto_id: 55, producto: 'Dispenser', cantidad: 2 }] } = {}) {
  const apiCalls = [];
  const alerts = [];
  const toasts = [];
  const scannerButton = {
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    click() { return this.listeners.click?.(); },
  };
  const scannerInputs = { asignar: [], retirar: [] };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true,
      value: '',
      checked: false,
      dataset: {},
      style: { display: 'none' },
      textContent: '',
      innerHTML: '',
      addEventListener() {},
      focus() {},
      getContext: () => ({ clearRect() {} }),
    });
    return elements.get(id);
  };
  const lista = element('listaActivosEscanear');
  Object.defineProperty(lista, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(value) {
      this._innerHTML = value;
      scannerInputs.asignar = [];
      scannerInputs.retirar = [];
      for (const match of value.matchAll(/class="input-asignar"[^>]*data-item-id="(\d+)"[^>]*data-prod-id="(\d+)"/g)) {
        scannerInputs.asignar.push({ value: '', dataset: { itemId: match[1], prodId: match[2] }, style: {} });
      }
      for (const match of value.matchAll(/class="input-retirar"[^>]*data-item-id="(\d+)"[^>]*data-prod-id="(\d+)"/g)) {
        scannerInputs.retirar.push({ value: '', dataset: { itemId: match[1], prodId: match[2] }, style: {} });
      }
    },
  });
  const resumen = {
    pedido: { cliente: 'Cliente real', direccion: 'Calle 1', monto: 100, metodo_pago: 'efectivo' },
    items_activos: itemsActivos,
    retornables_resumen: { items: [] },
    activos_cliente: [],
    activos_disponibles: [{ id: 101, codigo: 'EQ-101' }, { id: 102, codigo: 'EQ-102' }],
    movimientos_existentes: [],
  };
  const context = {
    console: { error() {} },
    activosModalState: { pedidoId: null, data: null, movimientosIniciales: [] },
    pedidoEnProcesoId: null,
    document: {
      getElementById: (id) => element(id),
      querySelectorAll: (selector) => {
        if (selector === '.input-asignar') return scannerInputs.asignar;
        if (selector === '.input-retirar') return scannerInputs.retirar;
        if (selector === '.input-asignar, .input-retirar') return [...scannerInputs.asignar, ...scannerInputs.retirar];
        return [];
      },
    },
    api: async (url, options) => {
      apiCalls.push({ url, options });
      if (options?.method === 'POST') throw new Error('POST inesperado');
      return structuredClone(resumen);
    },
    $: (selector) => element(selector.replace(/^#/, '')),
    $$: (selector) => selector === '#activosModal button[data-abrir-scanner]' && element('amContenido').innerHTML.includes('data-abrir-scanner')
      ? [scannerButton]
      : [],
    esc: String,
    money: String,
    setupFirmaEntregaCanvas() {},
    limpiarFirmaEntrega() {},
    alert(message) { alerts.push(message); },
    toast(message) { toasts.push(message); },
    formatFechaHoraAR: String,
  };
  const abrir = slice(entregaSource, 'async function abrirActivosPaso', 'function setupFirmaEntregaCanvas');
  const scanner = slice(entregaSource, 'function limpiarEstadoScannerActivos', 'async function abrirModalPagoQR');
  vm.runInNewContext(`${abrir}\n${scanner}\nthis.abrirActivosPaso = abrirActivosPaso; this.confirmarEntregaScanner = confirmarEntregaScanner; this.cerrarModalEscaneo = cerrarModalEscaneo;`, context);
  return { context, element, scannerButton, scannerInputs, apiCalls, alerts, toasts, resumen };
}

test('recorrido productivo abre scanner desde el cierre universal y vuelve con movimientos sin POST', async () => {
  const h = scannerUiHarness();

  await h.context.abrirActivosPaso(42);
  assert.equal(h.context.activosModalState.pedidoId, 42);
  assert.match(h.element('amContenido').innerHTML, /Escanear activos\/equipos/);
  assert.equal(typeof h.scannerButton.listeners.click, 'function');

  await h.scannerButton.click();
  assert.equal(h.context.pedidoEnProcesoId, 42);
  assert.equal(h.element('activosModal').hidden, true);
  assert.equal(h.element('modalEscanearActivos').style.display, 'flex');
  assert.equal(h.scannerInputs.asignar.length, 2);
  assert.equal(h.scannerInputs.retirar.length, 2);
  assert.deepEqual(h.scannerInputs.asignar.map(input => input.dataset.prodId), ['55', '55']);
  assert.deepEqual(h.scannerInputs.asignar.map(input => input.dataset.itemId), ['8', '8']);

  h.scannerInputs.asignar[0].value = '101';
  h.scannerInputs.asignar[1].value = '102';
  await h.context.confirmarEntregaScanner();

  assert.equal(h.element('modalEscanearActivos').style.display, 'none');
  assert.equal(h.element('activosModal').hidden, false);
  assert.equal(h.context.activosModalState.pedidoId, 42);
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.context.activosModalState.movimientosIniciales.map(({ tipoOperacion, activoId, itemPedidoId, productoId }) => ({ tipoOperacion, activoId, itemPedidoId, productoId })))),
    [
      { tipoOperacion: 'entrega', activoId: 101, itemPedidoId: 8, productoId: 55 },
      { tipoOperacion: 'entrega', activoId: 102, itemPedidoId: 8, productoId: 55 },
    ],
  );
  assert.equal(h.apiCalls.filter(({ options }) => options?.method === 'POST').length, 0);
});

test('cancelar scanner restaura el cierre universal y limpia sólo el estado scanner', async () => {
  const h = scannerUiHarness({ itemsActivos: [{ item_pedido_id: 8, producto_id: 55, producto: 'Dispenser', cantidad: 1 }] });
  await h.context.abrirActivosPaso(42);
  await h.scannerButton.click();
  h.scannerInputs.asignar[0].value = '101';

  h.context.cerrarModalEscaneo();

  assert.equal(h.element('modalEscanearActivos').style.display, 'none');
  assert.equal(h.element('activosModal').hidden, false);
  assert.equal(h.context.activosModalState.pedidoId, 42);
  assert.equal(h.context.activosModalState.data.pedido.cliente, 'Cliente real');
  assert.equal(h.context.pedidoEnProcesoId, null);
  assert.equal(h.element('listaActivosEscanear').innerHTML, '');
  assert.equal(h.apiCalls.length, 1);
});

test('scanner no abre con cantidades o IDs ambiguos y muestra feedback', async () => {
  for (const item of [
    { item_pedido_id: 8, producto_id: null, producto: 'Sin ID', cantidad: 1 },
    { item_pedido_id: 8, producto_id: 55, producto: 'Cantidad decimal', cantidad: 1.5 },
    { item_pedido_id: 8, producto_id: 55, producto: 'Cantidad vacía', cantidad: 0 },
  ]) {
    const h = scannerUiHarness({ itemsActivos: [item] });
    await h.context.abrirActivosPaso(42);
    await h.scannerButton.click();
    assert.equal(h.element('modalEscanearActivos').style.display, 'none');
    assert.equal(h.element('activosModal').hidden, false);
    assert.equal(h.context.pedidoEnProcesoId, null);
    assert.match(h.toasts.at(-1), /datos válidos|activos requeridos/i);
  }
});

test('scanner rechaza IDs escaneados ambiguos sin abandonar el modal', async () => {
  const h = scannerUiHarness({ itemsActivos: [{ item_pedido_id: 8, producto_id: 55, producto: 'Dispenser', cantidad: 1 }] });
  await h.context.abrirActivosPaso(42);
  await h.scannerButton.click();
  h.scannerInputs.asignar[0].value = '1e2';

  await h.context.confirmarEntregaScanner();

  assert.equal(h.element('modalEscanearActivos').style.display, 'flex');
  assert.equal(h.element('activosModal').hidden, true);
  assert.equal(h.context.pedidoEnProcesoId, 42);
  assert.match(h.toasts.at(-1), /equipo a entregar/i);
  assert.equal(h.apiCalls.length, 1);
});

test('scanner rechaza una fila con retiro pero sin equipo a entregar', async () => {
  const h = scannerUiHarness({ itemsActivos: [{ item_pedido_id: 8, producto_id: 55, producto: 'Dispenser', cantidad: 1 }] });
  await h.context.abrirActivosPaso(42);
  await h.scannerButton.click();
  h.scannerInputs.retirar[0].value = '201';

  await h.context.confirmarEntregaScanner();

  assert.equal(h.element('modalEscanearActivos').style.display, 'flex');
  assert.equal(h.context.activosModalState.movimientosIniciales.length, 0);
  assert.match(h.toasts.at(-1), /equipo a entregar.*obligatorio/i);
});

test('scanner rechaza IDs duplicados entre filas y operaciones', async () => {
  const h = scannerUiHarness();
  await h.context.abrirActivosPaso(42);
  await h.scannerButton.click();
  h.scannerInputs.asignar[0].value = '101';
  h.scannerInputs.retirar[0].value = '201';
  h.scannerInputs.asignar[1].value = '101';

  await h.context.confirmarEntregaScanner();

  assert.equal(h.element('modalEscanearActivos').style.display, 'flex');
  assert.equal(h.context.activosModalState.movimientosIniciales.length, 0);
  assert.match(h.toasts.at(-1), /ID.*repetido/i);
});

test('scanner confirma sin reconstruir y conserva valores del cierre universal', async () => {
  const h = scannerUiHarness({ itemsActivos: [{ item_pedido_id: 8, producto_id: 55, producto: 'Dispenser', cantidad: 1 }] });
  await h.context.abrirActivosPaso(42);
  h.element('amObs').value = 'Observación preservada';
  h.element('amChkCliente').checked = true;
  h.element('amChkProducto').checked = true;
  h.element('amChkCobro').checked = true;
  const contenidoOriginal = h.element('amContenido').innerHTML;
  await h.scannerButton.click();
  h.scannerInputs.asignar[0].value = '101';

  await h.context.confirmarEntregaScanner();

  assert.equal(h.element('modalEscanearActivos').style.display, 'none');
  assert.equal(h.element('activosModal').hidden, false);
  assert.equal(h.element('amContenido').innerHTML, contenidoOriginal);
  assert.equal(h.element('amObs').value, 'Observación preservada');
  assert.equal(h.element('amChkCliente').checked, true);
  assert.equal(h.element('amChkProducto').checked, true);
  assert.equal(h.element('amChkCobro').checked, true);
  assert.equal(h.context.activosModalState.movimientosIniciales.length, 1);
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls.some(({ url }) => url.endsWith('/entregar')), false);
});

test('backend exige checklist exacto antes de cualquier escritura', async () => {
  for (const checklist of [null, {}, { ...validChecklist, cobro_confirmado: false }, { ...validChecklist, cobro_confirmado: 1 }]) {
    const { client, calls } = deliveryClient();
    const result = await postDelivery(client, { movimientos: [], checklist });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'Checklist de entrega incompleto' });
    assert.equal(calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);
    assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  }
});

test('backend mantiene idempotencia sin checklist para pedido ya entregado', async () => {
  const { client, calls } = deliveryClient({ estado: 'entregado' });
  const result = await postDelivery(client, { movimientos: [] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, already: true });
  assert.equal(calls.filter(({ sql }) => sql.includes('FROM choferes') && sql.includes('FOR SHARE')).length, 1);
  assert.equal(calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);

  const inactive = deliveryClient({ estado: 'entregado', choferRows: [] });
  const inactiveResult = await postDelivery(inactive.client, { movimientos: [] });
  assert.equal(inactiveResult.status, 403);
  assert.deepEqual(inactiveResult.body, { error: 'Chofer no autorizado' });
  assert.equal(inactive.calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);
  assert.equal(inactive.calls.some(({ sql }) => sql === 'COMMIT'), false);
});

test('chofer inactivo, inexistente o cross-tenant falla cerrado antes de mutar o ejecutar postcommit', async (t) => {
  const casos = [
    ['inactivo', []],
    ['inexistente', []],
    ['cross-tenant', []],
    ['resultado múltiple inválido', [{ id: 7 }, { id: 7 }]],
  ];
  for (const [caso, choferRows] of casos) {
    await t.test(caso, async () => {
      const { client, calls } = deliveryClient({ choferRows });
      const effects = [];
      const app = buildApp(client, {
        notifyEstadoPedidoPush: () => effects.push('push'),
        ejecutarRecompensaReferido: () => effects.push('recompensa'),
        ejecutarEstrategiaReferidos: () => effects.push('referidos'),
        ejecutarPostEntregaUpsell: () => effects.push('upsell'),
        awardPointsForDeliveredOrder: () => effects.push('puntos'),
        generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
        notificarPedidoTransferencia: () => effects.push('transferencia'),
      });
      let result;
      await withServer(app, async baseUrl => {
        const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
          movimientos: [],
          checklist: validChecklist,
        });
        result = { status: response.status, body: await response.json() };
      });

      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'Chofer no autorizado' });
      const choferQuery = calls.find(({ sql }) => sql.includes('FROM choferes'));
      assert.ok(choferQuery);
      assert.match(choferQuery.sql, /WHERE\s+id\s*=\s*\$1[\s\S]*empresa_id\s*=\s*\$2[\s\S]*activo\s+IS\s+TRUE[\s\S]*FOR\s+SHARE/i);
      assert.deepEqual(choferQuery.params, [7, 3]);
      assert.equal(calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);
      assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
      assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
      assert.deepEqual(effects, []);
    });
  }
});

test('locks de entrega respetan pedido -> chofer -> punto/zona', async () => {
  const { client, calls } = deliveryClient();
  const result = await postDelivery(client, { movimientos: [], checklist: validChecklist, zona_id: 5 });
  assert.equal(result.status, 200);
  const pedidoIndex = calls.findIndex(({ sql }) => sql.includes('FROM pedidos p') && sql.includes('FOR UPDATE'));
  const choferIndex = calls.findIndex(({ sql }) => sql.includes('FROM choferes') && sql.includes('FOR SHARE'));
  const puntoIndex = calls.findIndex(({ sql }) => sql.includes('FROM puntos_entrega') && sql.includes('FOR SHARE'));
  const zonaIndex = calls.findIndex(({ sql }) => sql.includes('FROM zona_chofer') && sql.includes('FOR SHARE'));
  assert.ok(pedidoIndex >= 0 && choferIndex > pedidoIndex && puntoIndex > choferIndex && zonaIndex > choferIndex);
});

test('metodo_pago de cierre exige allowlist canónica exacta antes de abrir transacción', async (t) => {
  const invalidos = ['inventado', 'Efectivo', ' efectivo', 'efectivo ', null, 1, true, {}];
  for (const metodo_pago of invalidos) {
    await t.test(JSON.stringify(metodo_pago), async () => {
      const { client, calls } = deliveryClient();
      const result = await postDelivery(client, {
        movimientos: [],
        checklist: validChecklist,
        metodo_pago,
      });
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'Método de pago inválido' });
      assert.equal(calls.length, 0);
    });
  }
});

test('método persistido no canónico falla cerrado al cerrar sin override', async (t) => {
  for (const metodoPago of ['inventado', 'Efectivo', ' efectivo', 'efectivo ', null]) {
    await t.test(String(metodoPago), async () => {
      const { client, calls } = deliveryClient({ metodoPago });
      const result = await postDelivery(client, { movimientos: [], checklist: validChecklist });
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: 'El pedido tiene un método de pago inválido' });
      assert.equal(calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);
      assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
    });
  }
});

test('cuenta corriente persistida se valida con el método final y lock tenant-scoped', async () => {
  const { client, calls } = deliveryClient({
    metodoPago: 'cuenta_corriente',
    puntoRows: [{ id: 9, cuenta_corriente_habilitada: false }],
  });
  const result = await postDelivery(client, { movimientos: [], checklist: validChecklist });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: 'Este cliente no está habilitado para cuenta corriente' });
  const puntoLock = calls.find(({ sql }) => sql.includes('FROM puntos_entrega') && sql.includes('FOR'));
  assert.ok(puntoLock);
  assert.match(puntoLock.sql, /WHERE\s+id\s*=\s*\$1[\s\S]*empresa_id\s*=\s*\$2[\s\S]*FOR SHARE/i);
  assert.deepEqual(puntoLock.params, [9, 3]);
  assert.equal(calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);
});

test('zona explícita exige asociación tenant-scoped bloqueada antes de mutar', async (t) => {
  for (const zonaIdPersistida of [null, 5]) {
    await t.test(`zona persistida ${String(zonaIdPersistida)}`, async () => {
      const { client, calls } = deliveryClient({ zonaId: zonaIdPersistida, zonaRows: [] });
      const result = await postDelivery(client, {
        movimientos: [],
        checklist: validChecklist,
        zona_id: 77,
      });
      assert.equal(result.status, 400);
      const zonaLock = calls.find(({ sql }) => sql.includes('FROM zona_chofer'));
      assert.ok(zonaLock);
      assert.match(zonaLock.sql, /empresa_id\s*=\s*\$2/);
      assert.match(zonaLock.sql, /zona_id\s*=\s*\$3/);
      assert.match(zonaLock.sql, /FOR SHARE/i);
      assert.deepEqual(zonaLock.params, [7, 3, 77]);
      assert.equal(calls.some(({ sql }) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql)), false);
    });
  }
});

test('UPDATE final conserva estado esperado exacto para en_ruta y en_camino', async (t) => {
  for (const estado of ['en_ruta', 'en_camino']) {
    await t.test(estado, async () => {
      const { client, calls } = deliveryClient({ estado });
      const result = await postDelivery(client, { movimientos: [], checklist: validChecklist });
      assert.equal(result.status, 200);
      const finalUpdate = calls.find(({ sql }) => sql.includes("SET estado = 'entregado'"));
      assert.ok(finalUpdate);
      assert.match(finalUpdate.sql, /AND estado = \$7/);
      assert.equal(finalUpdate.params[6], estado);
    });
  }
});

test('UPDATE final exact-row vacío revierte y no ejecuta stock ni postcommit', async () => {
  const { client, calls } = deliveryClient({ finalUpdateRows: [] });
  const effects = [];
  const app = buildApp(client, {
    notifyEstadoPedidoPush: () => effects.push('push'),
    ejecutarRecompensaReferido: () => effects.push('recompensa'),
    ejecutarEstrategiaReferidos: () => effects.push('referidos'),
    ejecutarPostEntregaUpsell: () => effects.push('upsell'),
    awardPointsForDeliveredOrder: () => effects.push('puntos'),
    generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
  });
  await withServer(app, async baseUrl => {
    const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      movimientos: [],
      checklist: validChecklist,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'El pedido cambió durante el cierre' });
  });
  const finalUpdate = calls.find(({ sql }) => sql.includes("SET estado = 'entregado'"));
  assert.match(finalUpdate.sql, /WHERE\s+id\s*=\s*\$1[\s\S]*empresa_id\s*=\s*\$5[\s\S]*chofer_id\s*=\s*\$6[\s\S]*estado\s*=\s*\$7[\s\S]*RETURNING\s+id/i);
  assert.deepEqual(finalUpdate.params.slice(4), [3, 7, 'en_ruta']);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO chofer_stock_mov')), false);
  assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.deepEqual(effects, []);
});

for (const caso of ['saldo inexistente', 'saldo insuficiente']) {
  test(`entrega con ${caso} falla cerrado y revierte todas las mutaciones derivadas`, async () => {
    const { client, calls } = deliveryClient({
      consumibles: [{ producto_id: 55, cantidad: 3, nombre: 'Pack' }],
      stockWriteRows: [],
    });
    const effects = [];
    const app = buildApp(client, {
      notifyEstadoPedidoPush: () => effects.push('push'),
      ejecutarRecompensaReferido: () => effects.push('recompensa'),
      ejecutarEstrategiaReferidos: () => effects.push('referidos'),
      ejecutarPostEntregaUpsell: () => effects.push('upsell'),
      awardPointsForDeliveredOrder: () => effects.push('puntos'),
      generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
    });

    await withServer(app, async baseUrl => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        movimientos: [],
        checklist: validChecklist,
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'Stock insuficiente para completar la entrega' });
    });

    const stockWrite = calls.find(({ sql }) => sql.includes('UPDATE chofer_stock'));
    assert.ok(stockWrite);
    assert.match(stockWrite.sql, /WHERE\s+empresa_id\s*=\s*\$1[\s\S]*chofer_id\s*=\s*\$2[\s\S]*producto_id\s*=\s*\$3[\s\S]*cantidad\s*>=\s*\$4[\s\S]*RETURNING/i);
    assert.deepEqual(stockWrite.params, [3, 7, 55, 3]);
    assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
    assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO chofer_stock_mov')), false);
    assert.equal(calls.some(({ sql }) => sql.includes('cliente_retornables_movimientos')), false);
    assert.equal(calls.some(({ sql }) => sql.includes('retornables_movimientos')), false);
    assert.deepEqual(effects, []);
  });
}

test('modo estricto bloquea todos los activos tenant-scoped en orden global antes de mutar', () => {
  const serviceSource = read('src/adm/pedidoActivosService.js');
  assert.match(serviceSource, /ORDER BY id\s+FOR UPDATE/);
  assert.match(serviceSource, /id = ANY\(\$2::int\[\]\)/);
  assert.ok(serviceSource.indexOf('ORDER BY id') < serviceSource.lastIndexOf('for (const rawMov of movimientos)'));
});

test('asignaciones activas cuentan entrega y cambio con total exacto', async () => {
  const requeridos = [{ item_pedido_id: 8, producto_id: 55, cantidad: '2' }];
  const valido = deliveryClient({ activos: requeridos });
  const ok = await postDelivery(valido.client, {
    checklist: validChecklist,
    movimientos: [
      { tipoOperacion: 'cambio', activoId: 101, activoRelacionadoId: 201, itemPedidoId: 8, productoId: 55 },
      { tipoOperacion: 'entrega', activoId: 102, itemPedidoId: 8, productoId: 55 },
    ],
  });
  assert.equal(ok.status, 200);

  const exceso = deliveryClient({ activos: [{ item_pedido_id: 8, producto_id: 55, cantidad: '1' }] });
  const rechazado = await postDelivery(exceso.client, {
    checklist: validChecklist,
    movimientos: [
      { tipoOperacion: 'entrega', activoId: 102, itemPedidoId: 8, productoId: 55 },
      { tipoOperacion: 'cambio', activoId: 101, activoRelacionadoId: 201, itemPedidoId: 8, productoId: 55 },
    ],
  });
  assert.equal(rechazado.status, 400);
  assert.match(rechazado.body.error, /Movimientos de activos inválidos/);
});

test('API directa no puede omitir entregas activas requeridas ni usar asociaciones incorrectas', async (t) => {
  const activos = [{ item_pedido_id: 8, producto_id: 55, cantidad: '2' }];
  const cases = [
    ['faltantes', [], 'Movimientos de activos inválidos'],
    ['exceso', [
      { tipoOperacion: 'entrega', activoId: 101, itemPedidoId: 8, productoId: 55 },
      { tipoOperacion: 'entrega', activoId: 102, itemPedidoId: 8, productoId: 55 },
      { tipoOperacion: 'entrega', activoId: 103, itemPedidoId: 8, productoId: 55 },
    ], 'Movimientos de activos inválidos'],
    ['item ajeno', [
      { tipoOperacion: 'entrega', activoId: 101, itemPedidoId: 999, productoId: 55 },
      { tipoOperacion: 'entrega', activoId: 102, itemPedidoId: 8, productoId: 55 },
    ], 'Movimientos de activos inválidos'],
    ['producto ajeno', [
      { tipoOperacion: 'entrega', activoId: 101, itemPedidoId: 8, productoId: 66 },
      { tipoOperacion: 'entrega', activoId: 102, itemPedidoId: 8, productoId: 55 },
    ], 'Movimientos de activos inválidos'],
    ['activo duplicado', [
      { tipoOperacion: 'entrega', activoId: 101, itemPedidoId: 8, productoId: 55 },
      { tipoOperacion: 'entrega', activoId: 101, itemPedidoId: 8, productoId: 55 },
    ], 'Movimientos de activos inválidos'],
  ];

  for (const [name, movimientos, error] of cases) {
    await t.test(name, async () => {
      const { client, calls } = deliveryClient({ activos });
      const result = await postDelivery(client, { movimientos, checklist: validChecklist });
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error });
      assert.equal(calls.some(({ sql }) => sql.includes("estado = 'entregado'")), false);
      assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
    });
  }
});

test('backend rechaza sobredevolución y revierte sin mutaciones durables', async () => {
  const { client, calls } = deliveryClient({
    retornables: [{ producto_id: 55, nombre: 'Bidón', entregados: '3' }],
    saldo: 2,
  });
  const result = await postDelivery(client, {
    movimientos: [],
    checklist: validChecklist,
    retornables: [{ producto_id: 55, devueltos: 6 }],
  });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: 'La devolución de retornables supera el máximo exigible' });
  assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(({ sql }) => sql.includes("estado = 'entregado'")), false);
  assert.equal(calls.some(({ sql }) => sql.includes('cliente_retornables_movimientos')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('retornables_movimientos')), false);
});

test('backend preserva crédito negativo y no acepta vacíos sobre el máximo real', async () => {
  const rejected = deliveryClient({
    retornables: [{ producto_id: 55, nombre: 'Bidón', entregados: '2' }],
    saldo: -3,
  });
  const rejectedResult = await postDelivery(rejected.client, {
    movimientos: [],
    checklist: validChecklist,
    retornables: [{ producto_id: 55, devueltos: 1 }],
  });
  assert.equal(rejectedResult.status, 400);
  assert.deepEqual(rejectedResult.body, { error: 'La devolución de retornables supera el máximo exigible' });

  const accepted = deliveryClient({
    retornables: [{ producto_id: 55, nombre: 'Bidón', entregados: '2' }],
    saldo: -3,
  });
  const acceptedResult = await postDelivery(accepted.client, {
    movimientos: [],
    checklist: validChecklist,
    retornables: [{ producto_id: 55, devueltos: 0 }],
  });
  assert.equal(acceptedResult.status, 200);
  const clienteUpdate = accepted.calls.find(({ sql }) => sql.includes('UPDATE cliente_retornables_saldos'));
  const ledgerUpdate = accepted.calls.find(({ sql }) => sql.includes('INSERT INTO retornables_saldos'));
  assert.equal(clienteUpdate.params[3], -1);
  assert.equal(ledgerUpdate.params[4], -1);
});

test('COMMIT ambiguo responde 503, no revierte ni ejecuta tareas post-entrega y descarta conexión', async () => {
  const commitError = new Error('detalle privado del commit');
  const { client, calls, releases } = deliveryClient({ commitError });
  let pushCalls = 0;
  let upsellCalls = 0;
  let transferCalls = 0;
  let recompensaCalls = 0;
  let referidosCalls = 0;
  let pointsCalls = 0;
  let comisionesCalls = 0;
  const app = buildApp(client, {
    notifyEstadoPedidoPush: async () => { pushCalls += 1; },
    ejecutarPostEntregaUpsell: async () => { upsellCalls += 1; },
    notificarPedidoTransferencia: async () => { transferCalls += 1; },
    ejecutarRecompensaReferido: async () => { recompensaCalls += 1; },
    ejecutarEstrategiaReferidos: async () => { referidosCalls += 1; },
    awardPointsForDeliveredOrder: async () => { pointsCalls += 1; },
    generateComisionesForDeliveredOrder: async () => { comisionesCalls += 1; },
  });
  let result;
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [], checklist: validChecklist }),
    });
    result = { status: response.status, body: await response.json() };
  });

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'Resultado de entrega indeterminado', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
  assert.equal(JSON.stringify(result.body).includes('detalle privado'), false);
  assert.equal(calls.filter(({ sql }) => sql === 'COMMIT').length, 1);
  assert.equal(calls.some(({ sql }) => sql === 'ROLLBACK'), false);
  assert.deepEqual(releases, [commitError]);
  assert.equal(pushCalls, 0);
  assert.equal(upsellCalls, 0);
  assert.equal(transferCalls, 0);
  assert.equal(recompensaCalls, 0);
  assert.equal(referidosCalls, 0);
  assert.equal(pointsCalls, 0);
  assert.equal(comisionesCalls, 0);
});

test('throws síncronos y rechazos de tareas postcommit no cambian el éxito ni intentan rollback', async () => {
  const { client, calls: sqlCalls } = deliveryClient();
  const taskCalls = [];
  const syncFailure = name => () => {
    taskCalls.push(name);
    throw new Error(`${name} sync privado`);
  };
  const asyncFailure = name => () => {
    taskCalls.push(name);
    return Promise.reject(new Error(`${name} async privado`));
  };
  const app = buildApp(client, {
    notifyEstadoPedidoPush: syncFailure('push'),
    ejecutarRecompensaReferido: asyncFailure('recompensa'),
    ejecutarEstrategiaReferidos: asyncFailure('estrategia'),
    ejecutarPostEntregaUpsell: syncFailure('upsell'),
    awardPointsForDeliveredOrder: asyncFailure('puntos'),
    generateComisionesForDeliveredOrder: asyncFailure('comisiones'),
    notificarPedidoTransferencia: asyncFailure('transferencia'),
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        movimientos: [],
        checklist: validChecklist,
        metodo_pago: 'transferencia',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(taskCalls.sort(), [
    'comisiones',
    'estrategia',
    'puntos',
    'push',
    'recompensa',
    'transferencia',
    'upsell',
  ]);
  assert.equal(sqlCalls.filter(({ sql }) => sql === 'COMMIT').length, 1);
  assert.equal(sqlCalls.some(({ sql }) => sql === 'ROLLBACK'), false);
});

test('UPDATE tenant-scoped de zona sin fila exacta revierte la entrega', async () => {
  const { client, calls } = deliveryClient({ zonaId: null, puntoUpdateRows: [] });
  const result = await postDelivery(client, {
    movimientos: [],
    checklist: validChecklist,
    zona_id: 5,
  });

  assert.equal(result.status, 500);
  const puntoUpdate = calls.find(({ sql }) => sql.includes('UPDATE puntos_entrega'));
  assert.match(puntoUpdate.sql, /WHERE\s+id\s*=\s*\$2[\s\S]*empresa_id\s*=\s*\$3[\s\S]*RETURNING\s+id/i);
  assert.deepEqual(puntoUpdate.params, [5, 9, 3]);
  assert.equal(calls.some(({ sql }) => sql.includes("UPDATE pedidos") && sql.includes("estado = 'entregado'")), true);
  assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
});

test('commit válido dispara estrategias de referidos inyectadas sin esperarlas', async () => {
  const { client } = deliveryClient();
  const calls = [];
  const app = buildApp(client, {
    ejecutarRecompensaReferido: async (args) => { calls.push(['recompensa', args]); },
    ejecutarEstrategiaReferidos: async (args) => { calls.push(['referidos', args]); },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [], checklist: validChecklist }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(calls, [
    ['recompensa', { pedidoId: 42, empresaId: 3 }],
    ['referidos', { pedidoId: 42, empresaId: 3 }],
  ]);
});

test('commit válido dispara puntos y comisiones inyectados después del COMMIT', async () => {
  const { client, calls: sqlCalls } = deliveryClient();
  const calls = [];
  const app = buildApp(client, {
    awardPointsForDeliveredOrder: args => { calls.push(['points', args, sqlCalls.at(-1)?.sql]); },
    generateComisionesForDeliveredOrder: args => { calls.push(['comisiones', args, sqlCalls.at(-1)?.sql]); },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movimientos: [], checklist: validChecklist }),
    });
    assert.equal(response.status, 200);
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'points');
  assert.equal(calls[1][0], 'comisiones');
  assert.equal(calls[0][2], 'COMMIT');
  assert.equal(calls[1][2], 'COMMIT');
  assert.equal(typeof calls[0][1].queryFn, 'function');
  assert.deepEqual({ ...calls[0][1], queryFn: undefined }, {
    queryFn: undefined,
    empresaId: 3,
    puntoEntregaId: 9,
    pedidoId: 42,
    monto: 1200,
  });
  assert.deepEqual({ ...calls[1][1], queryFn: undefined }, {
    queryFn: undefined,
    empresaId: 3,
    pedidoId: 42,
  });
});

test('si ROLLBACK falla preserva el error primario y descarta la conexión', async () => {
  const rollbackError = new Error('rollback roto');
  const { client, releases } = deliveryClient({ rollbackError });
  const result = await postDelivery(client, { movimientos: [], checklist: null });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: 'Checklist de entrega incompleto' });
  assert.deepEqual(releases, [rollbackError]);
});

test('backend rechaza retornables duplicados, inválidos o ajenos al pedido', async (t) => {
  const cases = [
    ['duplicado', [{ producto_id: 55, devueltos: 1 }, { producto_id: 55, devueltos: 1 }], 'Producto retornable duplicado'],
    ['decimal', [{ producto_id: 55, devueltos: 1.5 }], 'Cantidad devuelta inválida'],
    ['negativo', [{ producto_id: 55, devueltos: -1 }], 'Cantidad devuelta inválida'],
    ['texto', [{ producto_id: 55, devueltos: '2' }], 'Cantidad devuelta inválida'],
    ['desconocido', [{ producto_id: 999, devueltos: 1 }], 'Producto retornable desconocido'],
  ];
  for (const [name, retornablesPayload, error] of cases) {
    await t.test(name, async () => {
      const { client, calls } = deliveryClient({
        retornables: [{ producto_id: 55, nombre: 'Bidón', entregados: '3' }],
        saldo: 2,
      });
      const result = await postDelivery(client, {
        movimientos: [],
        checklist: validChecklist,
        retornables: retornablesPayload,
      });
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error });
      assert.equal(calls.some(({ sql }) => sql.includes("estado = 'entregado'")), false);
      assert.equal(calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
    });
  }
});

test('backend bloquea saldos retornables en orden estable para evitar deadlocks', () => {
  const routeSource = read('src/routes/repartidorApi.js');
  assert.match(routeSource, /Array\.from\(retornablesPedido\.values\(\)\)\.sort\(\(a, b\) => a\.productoId - b\.productoId\)/);
});

test('entrega escribe todos los saldos antes de insertar cualquier movimiento retornable', async () => {
  const { client, calls } = deliveryClient({
    retornables: [{ producto_id: 55, nombre: 'Bidón', entregados: '3' }],
    saldo: 2,
  });

  const result = await postDelivery(client, {
    movimientos: [],
    checklist: validChecklist,
    retornables: [{ producto_id: 55, devueltos: 1 }],
  });

  assert.equal(result.status, 200);
  const clienteLockIndex = calls.findIndex(({ sql }) => sql.includes('FROM cliente_retornables_saldos') && sql.includes('FOR UPDATE'));
  const clienteWriteIndex = calls.findIndex(({ sql }) => sql.includes('UPDATE cliente_retornables_saldos'));
  const ledgerWriteIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO retornables_saldos'));
  const movementIndexes = calls
    .map(({ sql }, index) => (/INSERT INTO (cliente_retornables_movimientos|retornables_movimientos)/.test(sql) ? index : -1))
    .filter((index) => index >= 0);

  assert.ok(clienteLockIndex >= 0);
  assert.ok(clienteLockIndex < ledgerWriteIndex);
  assert.ok(clienteWriteIndex < ledgerWriteIndex);
  assert.equal(movementIndexes.length, 2);
  assert.ok(ledgerWriteIndex < Math.min(...movementIndexes));
});

test('entrega multi-producto bloquea en orden y escribe todos los saldos antes de cualquier movimiento', async () => {
  const { client, calls } = deliveryClient({
    retornables: [
      { producto_id: 66, nombre: 'Sifón', entregados: '2' },
      { producto_id: 55, nombre: 'Bidón', entregados: '3' },
    ],
    saldo: 1,
  });

  const result = await postDelivery(client, {
    movimientos: [],
    checklist: validChecklist,
    retornables: [
      { producto_id: 55, devueltos: 1 },
      { producto_id: 66, devueltos: 1 },
    ],
  });

  assert.equal(result.status, 200);
  const locks = calls.filter(({ sql }) => sql.includes('FROM cliente_retornables_saldos') && sql.includes('FOR UPDATE'));
  assert.deepEqual(locks.map(({ params }) => params[2]), [55, 66]);
  const saldoIndexes = calls
    .map(({ sql }, index) => (/UPDATE cliente_retornables_saldos|INSERT INTO retornables_saldos/.test(sql) ? index : -1))
    .filter((index) => index >= 0);
  const movementIndexes = calls
    .map(({ sql }, index) => (/INSERT INTO (cliente_retornables_movimientos|retornables_movimientos)/.test(sql) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(saldoIndexes.length, 4);
  assert.equal(movementIndexes.length, 4);
  assert.ok(Math.max(...saldoIndexes) < Math.min(...movementIndexes));
});

test('PostgreSQL real revierte sobredevolución sin mutar pedido, saldo ni movimientos', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await pool.query(`
      CREATE TABLE empresas (id integer PRIMARY KEY, config_entrega jsonb);
      CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true);
      CREATE TABLE zonas_geograficas (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
      CREATE TABLE puntos_entrega (
        id integer PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        cuenta_corriente_habilitada boolean DEFAULT false,
        zona_id integer
      );
      CREATE TABLE productos (
        id integer PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        nombre text,
        retornable boolean DEFAULT false,
        config_activo jsonb DEFAULT '{}'::jsonb,
        stock_infinito boolean DEFAULT false
      );
      CREATE TABLE pedidos (
        id integer PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        chofer_id integer REFERENCES choferes(id),
        estado text,
        metodo_pago text,
        zona_id integer,
        punto_entrega_id integer REFERENCES puntos_entrega(id),
        monto numeric,
        fecha_entrega_estimada date,
        fecha_entrega timestamptz,
        cantidad numeric DEFAULT 0,
        cantidad_entregada numeric DEFAULT 0
      );
      CREATE TABLE items_pedido (
        id serial PRIMARY KEY,
        pedido_id integer REFERENCES pedidos(id),
        producto_id integer REFERENCES productos(id),
        producto text,
        cantidad numeric
      );
      CREATE TABLE chofer_stock_mov (id serial PRIMARY KEY);
      CREATE TABLE gastos_repartidor (id integer PRIMARY KEY);
      CREATE TABLE entregas_evidencias (
        empresa_id integer,
        pedido_id integer PRIMARY KEY,
        chofer_id integer,
        checklist jsonb,
        evidencia jsonb,
        updated_at timestamptz
      );
      CREATE TABLE cliente_retornables_saldos (
        empresa_id integer REFERENCES empresas(id),
        punto_entrega_id integer REFERENCES puntos_entrega(id),
        producto_id integer REFERENCES productos(id),
        saldo numeric NOT NULL DEFAULT 0,
        updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
      );
      CREATE TABLE cliente_retornables_movimientos (
        id serial PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        punto_entrega_id integer REFERENCES puntos_entrega(id),
        pedido_id integer REFERENCES pedidos(id),
        chofer_id integer REFERENCES choferes(id),
        producto_id integer REFERENCES productos(id),
        entregados numeric DEFAULT 0,
        devueltos numeric DEFAULT 0,
        delta numeric DEFAULT 0,
        saldo_resultante numeric,
        observacion text,
        fecha timestamptz DEFAULT now(),
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE retornables_saldos (
        empresa_id integer REFERENCES empresas(id),
        sujeto_tipo text,
        sujeto_id integer,
        producto_id integer REFERENCES productos(id),
        saldo numeric NOT NULL DEFAULT 0,
        updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (empresa_id, sujeto_tipo, sujeto_id, producto_id)
      );
      CREATE TABLE retornables_movimientos (
        id serial PRIMARY KEY,
        empresa_id integer REFERENCES empresas(id),
        fecha timestamptz DEFAULT now(),
        producto_id integer REFERENCES productos(id),
        sujeto_tipo text,
        sujeto_id integer,
        contraparte_tipo text,
        contraparte_id integer,
        pedido_id integer REFERENCES pedidos(id),
        gasto_id integer REFERENCES gastos_repartidor(id),
        chofer_id integer REFERENCES choferes(id),
        proveedor_id integer,
        deposito_id integer,
        tipo text,
        cantidad_llenos numeric DEFAULT 0,
        cantidad_vacios numeric DEFAULT 0,
        delta_saldo numeric DEFAULT 0,
        saldo_resultante numeric,
        observacion text,
        origen text,
        referencia text,
        created_by text,
        created_at timestamptz DEFAULT now()
      );
      INSERT INTO empresas VALUES (3, '{}'::jsonb);
      INSERT INTO choferes VALUES (7, 3);
      INSERT INTO puntos_entrega (id, empresa_id) VALUES (9, 3);
      INSERT INTO productos VALUES (55, 3, 'Bidón retornable', true, '{}'::jsonb);
      INSERT INTO pedidos (id, empresa_id, chofer_id, estado, metodo_pago, zona_id, punto_entrega_id, monto)
      VALUES (42, 3, 7, 'en_ruta', 'efectivo', 5, 9, 1200);
      INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad)
      VALUES (42, 55, 'Bidón retornable', 3);
    `);

    const app = express();
    app.use(express.json());
    app.use('/api/repartidor', createRepartidorApiRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool,
      withAuth: (req, _res, next) => {
        req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' };
        next();
      },
      getEmpresaIdFromToken: () => 3,
      notifyEstadoPedidoPush: async () => {},
      notificarEnRuta: async () => {},
      notificarPedidoTransferencia: async () => {},
      ejecutarEstrategiaVecinos: async () => {},
      awardPointsForDeliveredOrder: async () => {},
      generateComisionesForDeliveredOrder: async () => {},
      registrarMovimientosActivosDesdePedido: async () => {},
    }));

    await pool.query(`
      INSERT INTO cliente_retornables_saldos
        (empresa_id, punto_entrega_id, producto_id, saldo)
      VALUES (3, 9, 55, 2)
    `);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checklist: validChecklist,
          movimientos: [],
          retornables: [{ producto_id: 55, devueltos: 6 }],
        }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'La devolución de retornables supera el máximo exigible' });
    });

    const pedido = await pool.query('SELECT estado, fecha_entrega FROM pedidos WHERE id = 42');
    const saldo = await pool.query('SELECT saldo FROM cliente_retornables_saldos WHERE empresa_id = 3 AND punto_entrega_id = 9 AND producto_id = 55');
    const movimientos = await pool.query('SELECT COUNT(*)::int AS total FROM cliente_retornables_movimientos');
    const espejo = await pool.query('SELECT COUNT(*)::int AS total FROM retornables_movimientos');
    assert.deepEqual(pedido.rows, [{ estado: 'en_ruta', fecha_entrega: null }]);
    assert.equal(Number(saldo.rows[0].saldo), 2);
    assert.equal(movimientos.rows[0].total, 0);
    assert.equal(espejo.rows[0].total, 0);
  });
});

async function createRetornablesFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY, config_entrega jsonb);
    CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id), activo boolean NOT NULL DEFAULT true);
    CREATE TABLE zonas_geograficas (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
      empresa_id integer REFERENCES empresas(id),
      cuenta_corriente_habilitada boolean DEFAULT false,
      zona_id integer
    );
    CREATE TABLE proveedores (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
    CREATE TABLE depositos (id integer PRIMARY KEY, empresa_id integer REFERENCES empresas(id));
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer REFERENCES empresas(id),
      nombre text,
      retornable boolean DEFAULT false,
      deleted_at timestamptz,
      config_activo jsonb DEFAULT '{}'::jsonb,
      stock_infinito boolean DEFAULT false
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY,
      empresa_id integer REFERENCES empresas(id),
      chofer_id integer REFERENCES choferes(id),
      estado text,
      metodo_pago text,
      zona_id integer,
      punto_entrega_id integer REFERENCES puntos_entrega(id),
      monto numeric,
      fecha_entrega_estimada date,
      fecha_entrega timestamptz,
      cantidad numeric DEFAULT 0,
      cantidad_entregada numeric DEFAULT 0
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer REFERENCES pedidos(id),
      producto_id integer REFERENCES productos(id),
      producto text,
      cantidad numeric
    );
    CREATE TABLE chofer_stock_mov (
      id serial PRIMARY KEY,
      empresa_id integer,
      chofer_id integer,
      producto_id integer,
      cantidad numeric,
      tipo text,
      motivo text,
      referencia text,
      fecha timestamptz
    );
    CREATE TABLE chofer_stock (
      empresa_id integer,
      chofer_id integer,
      producto_id integer,
      cantidad numeric,
      PRIMARY KEY (empresa_id, chofer_id, producto_id)
    );
    CREATE TABLE gastos_repartidor (id integer PRIMARY KEY);
    CREATE TABLE entregas_evidencias (
      empresa_id integer,
      pedido_id integer PRIMARY KEY,
      chofer_id integer,
      checklist jsonb,
      evidencia jsonb,
      updated_at timestamptz
    );
    CREATE TABLE cliente_retornables_saldos (
      empresa_id integer REFERENCES empresas(id),
      punto_entrega_id integer REFERENCES puntos_entrega(id),
      producto_id integer REFERENCES productos(id),
      saldo numeric NOT NULL DEFAULT 0,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
    );
    CREATE TABLE cliente_retornables_movimientos (
      id serial PRIMARY KEY,
      empresa_id integer REFERENCES empresas(id),
      punto_entrega_id integer REFERENCES puntos_entrega(id),
      pedido_id integer REFERENCES pedidos(id),
      chofer_id integer REFERENCES choferes(id),
      producto_id integer REFERENCES productos(id),
      entregados numeric DEFAULT 0,
      devueltos numeric DEFAULT 0,
      delta numeric DEFAULT 0,
      saldo_resultante numeric,
      observacion text,
      fecha timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE retornables_saldos (
      empresa_id integer REFERENCES empresas(id),
      sujeto_tipo text,
      sujeto_id integer,
      producto_id integer REFERENCES productos(id),
      saldo numeric NOT NULL DEFAULT 0,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (empresa_id, sujeto_tipo, sujeto_id, producto_id)
    );
    CREATE TABLE retornables_movimientos (
      id serial PRIMARY KEY,
      empresa_id integer REFERENCES empresas(id),
      fecha timestamptz DEFAULT now(),
      producto_id integer REFERENCES productos(id),
      sujeto_tipo text,
      sujeto_id integer,
      contraparte_tipo text,
      contraparte_id integer,
      pedido_id integer REFERENCES pedidos(id),
      gasto_id integer REFERENCES gastos_repartidor(id),
      chofer_id integer REFERENCES choferes(id),
      proveedor_id integer,
      deposito_id integer,
      tipo text,
      cantidad_llenos numeric DEFAULT 0,
      cantidad_vacios numeric DEFAULT 0,
      delta_saldo numeric DEFAULT 0,
      saldo_resultante numeric,
      observacion text,
      origen text,
      referencia text,
      created_by text,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO empresas VALUES (3, '{}'::jsonb);
    INSERT INTO choferes VALUES (7, 3);
    INSERT INTO puntos_entrega (id, empresa_id) VALUES (9, 3);
    INSERT INTO productos VALUES (55, 3, 'Bidón retornable', true, NULL, '{}'::jsonb);
    INSERT INTO pedidos (id, empresa_id, chofer_id, estado, metodo_pago, zona_id, punto_entrega_id, monto)
    VALUES (42, 3, 7, 'en_ruta', 'efectivo', 5, 9, 1200);
    INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad)
    VALUES (42, 55, 'Bidón retornable', 3);
    INSERT INTO chofer_stock VALUES (3, 7, 55, 100);
    INSERT INTO cliente_retornables_saldos VALUES (3, 9, 55, 2, NOW());
    INSERT INTO retornables_saldos VALUES (3, 'cliente', 9, 55, 2, NOW());
  `);
}

function buildPostgresDeliveryApp(pool, { activosService = async () => {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    pool,
    withAuth: (req, _res, next) => {
      req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' };
      next();
    },
    getEmpresaIdFromToken: () => 3,
    notifyEstadoPedidoPush: async () => {},
    notificarEnRuta: async () => {},
    notificarPedidoTransferencia: async () => {},
    ejecutarEstrategiaVecinos: async () => {},
    awardPointsForDeliveredOrder: async () => {},
    generateComisionesForDeliveredOrder: async () => {},
    registrarMovimientosActivosDesdePedido: activosService,
  }));
  return app;
}

test('PostgreSQL real: desactivación que gana el lock hace esperar y rechaza la entrega sin efectos', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createActivosFixture(pool);
    const choferQueryStarted = deferred();
    const effects = [];
    const deliveryPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            if (sql.includes('FROM choferes') && sql.includes('FOR SHARE')) {
              choferQueryStarted.resolve();
            }
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/repartidor', createRepartidorApiRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool: deliveryPool,
      withAuth(req, _res, next) {
        req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' };
        next();
      },
      getEmpresaIdFromToken: () => 3,
      notifyEstadoPedidoPush: () => effects.push('push'),
      ejecutarRecompensaReferido: () => effects.push('recompensa'),
      ejecutarEstrategiaReferidos: () => effects.push('referidos'),
      ejecutarPostEntregaUpsell: () => effects.push('upsell'),
      awardPointsForDeliveredOrder: () => effects.push('puntos'),
      generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
      notificarPedidoTransferencia: () => effects.push('transferencia'),
      registrarMovimientosActivosDesdePedido,
    }));

    const snapshot = async () => ({
      pedido: (await pool.query('SELECT chofer_id, estado, fecha_entrega, cantidad_entregada FROM pedidos WHERE id = 42')).rows,
      punto: (await pool.query('SELECT id, empresa_id, zona_id FROM puntos_entrega WHERE id = 9')).rows,
      stock: (await pool.query('SELECT * FROM chofer_stock ORDER BY empresa_id, chofer_id, producto_id')).rows,
      stockMov: (await pool.query('SELECT * FROM chofer_stock_mov ORDER BY id')).rows,
      saldosCliente: (await pool.query('SELECT empresa_id, punto_entrega_id, producto_id, saldo FROM cliente_retornables_saldos ORDER BY 1,2,3')).rows,
      saldosLedger: (await pool.query('SELECT empresa_id, sujeto_tipo, sujeto_id, producto_id, saldo FROM retornables_saldos ORDER BY 1,2,3,4')).rows,
      movsCliente: (await pool.query('SELECT * FROM cliente_retornables_movimientos ORDER BY id')).rows,
      movsLedger: (await pool.query('SELECT * FROM retornables_movimientos ORDER BY id')).rows,
      activos: (await pool.query('SELECT id, estado, cliente_id FROM empresa_activos ORDER BY id')).rows,
      pedidoActivos: (await pool.query('SELECT * FROM pedido_activos ORDER BY id')).rows,
      historialActivos: (await pool.query('SELECT * FROM historial_activos ORDER BY id')).rows,
      evidencias: (await pool.query('SELECT * FROM entregas_evidencias ORDER BY pedido_id')).rows,
    });
    const before = await snapshot();
    const desactivador = await pool.connect();
    await desactivador.query('BEGIN');
    await desactivador.query('UPDATE choferes SET activo = FALSE WHERE id = 7 AND empresa_id = 3');

    try {
      await withServer(app, async baseUrl => {
        let settled = false;
        const entrega = postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
          checklist: validChecklist,
          movimientos: [],
        }).finally(() => { settled = true; });
        await withTimeout(choferQueryStarted.promise, 3000, 'La entrega no intentó bloquear al chofer');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(settled, false, 'La entrega debía esperar el lock de desactivación');
        await desactivador.query('COMMIT');
        const response = await withTimeout(entrega, 3000, 'La entrega no terminó tras confirmar la desactivación');
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'Chofer no autorizado' });
      });
    } finally {
      try { await desactivador.query('ROLLBACK'); } catch {}
      desactivador.release();
    }

    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(effects, []);
    const chofer = await pool.query('SELECT activo FROM choferes WHERE id = 7');
    assert.deepEqual(chofer.rows, [{ activo: false }]);
  });
});

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('PostgreSQL real rechaza pedido enlazado a punto cross-tenant sin mutar entrega', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createRetornablesFixture(pool);
    await pool.query(`
      INSERT INTO empresas VALUES (4, '{}'::jsonb);
      INSERT INTO puntos_entrega (id, empresa_id, zona_id) VALUES (19, 4, 77);
      UPDATE pedidos SET punto_entrega_id = 19 WHERE id = 42;
      CREATE TABLE empresa_activos (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL,
        estado text,
        cliente_id integer
      );
      INSERT INTO empresa_activos VALUES (501, 3, 'disponible', NULL);
    `);
    const before = {
      pedido: (await pool.query('SELECT estado, fecha_entrega, cantidad_entregada FROM pedidos WHERE id = 42')).rows,
      stock: (await pool.query('SELECT * FROM chofer_stock ORDER BY producto_id')).rows,
      retornables: (await pool.query('SELECT empresa_id, punto_entrega_id, producto_id, saldo FROM cliente_retornables_saldos ORDER BY empresa_id, punto_entrega_id, producto_id')).rows,
      activos: (await pool.query('SELECT * FROM empresa_activos ORDER BY id')).rows,
      punto: (await pool.query('SELECT empresa_id, zona_id FROM puntos_entrega WHERE id = 19')).rows,
    };
    let activosCalls = 0;
    const app = buildPostgresDeliveryApp(pool, {
      activosService: async () => { activosCalls += 1; },
    });

    await withServer(app, async baseUrl => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
        retornables: [{ producto_id: 55, devueltos: 1 }],
      });
      assert.equal(response.status, 400);
    });

    const after = {
      pedido: (await pool.query('SELECT estado, fecha_entrega, cantidad_entregada FROM pedidos WHERE id = 42')).rows,
      stock: (await pool.query('SELECT * FROM chofer_stock ORDER BY producto_id')).rows,
      retornables: (await pool.query('SELECT empresa_id, punto_entrega_id, producto_id, saldo FROM cliente_retornables_saldos ORDER BY empresa_id, punto_entrega_id, producto_id')).rows,
      activos: (await pool.query('SELECT * FROM empresa_activos ORDER BY id')).rows,
      punto: (await pool.query('SELECT empresa_id, zona_id FROM puntos_entrega WHERE id = 19')).rows,
    };
    assert.deepEqual(after, before);
    assert.equal(activosCalls, 0);
  });
});

test('PostgreSQL real: revocación de cuenta corriente que gana el lock impide el cierre', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createRetornablesFixture(pool);
    await pool.query(`
      UPDATE puntos_entrega SET cuenta_corriente_habilitada = true WHERE id = 9;
      UPDATE pedidos SET metodo_pago = 'inventado' WHERE id = 42;
    `);

    const cierreAlcanzoLockPunto = deferred();
    const wrappedPool = {
      query(sql, params = []) { return pool.query(sql, params); },
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            if (sql.includes('FROM puntos_entrega') && sql.includes('FOR SHARE')) {
              cierreAlcanzoLockPunto.resolve();
            }
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = buildPostgresDeliveryApp(wrappedPool);

    await withServer(app, async baseUrl => {
      const warmup = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
      });
      assert.equal(warmup.status, 409);
      await pool.query("UPDATE pedidos SET metodo_pago = 'cuenta_corriente' WHERE id = 42");

      const revocador = await pool.connect();
      try {
        await revocador.query('BEGIN');
        await revocador.query('UPDATE puntos_entrega SET cuenta_corriente_habilitada = false WHERE id = 9');
        const cierre = postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
          checklist: validChecklist,
          movimientos: [],
        });
        await withTimeout(cierreAlcanzoLockPunto.promise, 3000, 'El cierre no intentó bloquear el punto de entrega');
        await revocador.query('COMMIT');
        const response = await withTimeout(cierre, 3000, 'El cierre no terminó tras confirmar la revocación');
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'Este cliente no está habilitado para cuenta corriente' });
      } finally {
        try { await revocador.query('ROLLBACK'); } catch {}
        revocador.release();
      }
    });

    const pedido = await pool.query('SELECT estado, fecha_entrega, metodo_pago FROM pedidos WHERE id = 42');
    assert.deepEqual(pedido.rows, [{ estado: 'en_ruta', fecha_entrega: null, metodo_pago: 'cuenta_corriente' }]);
  });
});

test('PostgreSQL real: UPDATE final vacío revierte la toma previa y omite postcommit', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createRetornablesFixture(pool);
    await pool.query('UPDATE pedidos SET chofer_id = NULL WHERE id = 42');
    const effects = [];
    const wrappedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            if (sql.includes("SET estado = 'entregado'")) return { rows: [] };
            return client.query(sql, params);
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/repartidor', createRepartidorApiRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool: wrappedPool,
      withAuth(req, _res, next) {
        req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' };
        next();
      },
      getEmpresaIdFromToken: () => 3,
      notifyEstadoPedidoPush: () => effects.push('push'),
      ejecutarRecompensaReferido: () => effects.push('recompensa'),
      ejecutarEstrategiaReferidos: () => effects.push('referidos'),
      ejecutarPostEntregaUpsell: () => effects.push('upsell'),
      awardPointsForDeliveredOrder: () => effects.push('puntos'),
      generateComisionesForDeliveredOrder: () => effects.push('comisiones'),
      notificarPedidoTransferencia: () => effects.push('transferencia'),
      registrarMovimientosActivosDesdePedido: async () => {},
    }));

    await withServer(app, async baseUrl => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
      });
      assert.equal(response.status, 409);
    });

    const pedido = await pool.query('SELECT chofer_id, estado, fecha_entrega FROM pedidos WHERE id = 42');
    const stock = await pool.query('SELECT COUNT(*)::int AS total FROM chofer_stock_mov');
    assert.deepEqual(pedido.rows, [{ chofer_id: null, estado: 'en_ruta', fecha_entrega: null }]);
    assert.equal(stock.rows[0].total, 0);
    assert.deepEqual(effects, []);
  });
});

async function createActivosFixture(pool) {
  await createRetornablesFixture(pool);
  await pool.query(`
    UPDATE productos SET config_activo = '{"es_activo":true}'::jsonb WHERE id = 55;
    UPDATE items_pedido SET cantidad = 1 WHERE pedido_id = 42 AND producto_id = 55;
    INSERT INTO productos (id, empresa_id, nombre, retornable, deleted_at, config_activo)
    VALUES (66, 3, 'Otro activo', false, NULL, '{"es_activo":true}'::jsonb);
    INSERT INTO puntos_entrega (id, empresa_id) VALUES (10, 3);

    CREATE TABLE empresa_activos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      codigo text NOT NULL,
      tipo text NOT NULL,
      estado text DEFAULT 'disponible',
      cliente_id integer REFERENCES puntos_entrega(id),
      producto_id integer REFERENCES productos(id),
      alquiler_mensual numeric(12,2),
      fecha_inicio_alquiler timestamptz,
      fecha_fin_alquiler timestamptz,
      updated_at timestamptz DEFAULT now(),
      UNIQUE (empresa_id, codigo)
    );
    CREATE TABLE historial_activos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      activo_id integer NOT NULL REFERENCES empresa_activos(id),
      cliente_id integer REFERENCES puntos_entrega(id),
      accion text NOT NULL,
      fecha timestamptz DEFAULT now(),
      usuario text,
      observacion text
    );
    CREATE TABLE pedido_activos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL REFERENCES empresas(id),
      pedido_id integer NOT NULL REFERENCES pedidos(id),
      item_pedido_id integer REFERENCES items_pedido(id),
      producto_id integer REFERENCES productos(id),
      activo_id integer NOT NULL REFERENCES empresa_activos(id),
      activo_relacionado_id integer REFERENCES empresa_activos(id),
      tipo_operacion text NOT NULL,
      origen text NOT NULL,
      observacion text,
      created_by text,
      UNIQUE (pedido_id, activo_id)
    );
    INSERT INTO empresa_activos
      (id, empresa_id, codigo, tipo, estado, cliente_id, producto_id)
    VALUES
      (101, 3, 'EQ-101', 'dispenser', 'disponible', NULL, 55),
      (102, 3, 'EQ-102', 'dispenser', 'prestado', 9, 55),
      (103, 3, 'EQ-103', 'otro', 'disponible', NULL, 66),
      (104, 3, 'EQ-104', 'dispenser', 'prestado', 10, 55);
  `);
}

async function resetActivosFixture(pool) {
  await pool.query(`
    UPDATE pedidos SET estado = 'en_ruta', fecha_entrega = NULL, cantidad_entregada = 0 WHERE id = 42;
    DELETE FROM entregas_evidencias;
    DELETE FROM chofer_stock_mov;
    DELETE FROM chofer_stock;
    INSERT INTO chofer_stock VALUES (3, 7, 55, 100);
    DELETE FROM historial_activos;
    DELETE FROM pedido_activos;
    UPDATE empresa_activos SET
      estado = CASE id WHEN 101 THEN 'disponible' WHEN 103 THEN 'disponible' ELSE 'prestado' END,
      cliente_id = CASE id WHEN 102 THEN 9 WHEN 104 THEN 10 ELSE NULL END,
      fecha_inicio_alquiler = NULL,
      fecha_fin_alquiler = NULL;
  `);
}

test('PostgreSQL real: zona explícita cross-tenant no muta pedido, stock, saldos ni activos', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createActivosFixture(pool);
    await pool.query(`
      CREATE TABLE zona_chofer (
        empresa_id integer NOT NULL,
        chofer_id integer NOT NULL,
        zona_id integer NOT NULL,
        PRIMARY KEY (empresa_id, chofer_id, zona_id)
      );
      INSERT INTO empresas VALUES (4, '{}'::jsonb);
      INSERT INTO zona_chofer VALUES (4, 7, 77);
      UPDATE pedidos SET zona_id = NULL WHERE id = 42;
      UPDATE productos SET config_activo = '{}'::jsonb WHERE id = 55;
    `);
    const before = {
      pedido: (await pool.query('SELECT estado, fecha_entrega, zona_id FROM pedidos WHERE id = 42')).rows,
      stock: (await pool.query('SELECT * FROM chofer_stock ORDER BY producto_id')).rows,
      saldos: (await pool.query('SELECT empresa_id, punto_entrega_id, producto_id, saldo FROM cliente_retornables_saldos ORDER BY 1,2,3')).rows,
      activos: (await pool.query('SELECT id, estado, cliente_id FROM empresa_activos ORDER BY id')).rows,
    };
    const app = buildPostgresDeliveryApp(pool, { activosService: registrarMovimientosActivosDesdePedido });

    await withServer(app, async baseUrl => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
        zona_id: 77,
      });
      assert.equal(response.status, 400);
    });

    const after = {
      pedido: (await pool.query('SELECT estado, fecha_entrega, zona_id FROM pedidos WHERE id = 42')).rows,
      stock: (await pool.query('SELECT * FROM chofer_stock ORDER BY producto_id')).rows,
      saldos: (await pool.query('SELECT empresa_id, punto_entrega_id, producto_id, saldo FROM cliente_retornables_saldos ORDER BY 1,2,3')).rows,
      activos: (await pool.query('SELECT id, estado, cliente_id FROM empresa_activos ORDER BY id')).rows,
    };
    assert.deepEqual(after, before);
  });
});

test('PostgreSQL real: locks globales evitan deadlock con payloads inversos solapados', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createActivosFixture(pool);
    await pool.query("INSERT INTO empresa_activos (id, empresa_id, codigo, tipo, estado, producto_id) VALUES (105, 3, 'EQ-105', 'dispenser', 'disponible', 55)");
    const item = await pool.query('SELECT id FROM items_pedido WHERE pedido_id = 42 AND producto_id = 55');
    const itemPedidoId = item.rows[0].id;
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    const firstLocked = deferred();
    const secondLockStarted = deferred();
    const releaseFirst = deferred();
    const wrap = (client, first) => ({
      async query(sql, params) {
        if (sql.includes('ORDER BY id') && sql.includes('FOR UPDATE')) {
          if (first) {
            const result = await client.query(sql, params);
            firstLocked.resolve();
            await releaseFirst.promise;
            return result;
          }
          secondLockStarted.resolve();
        }
        return client.query(sql, params);
      },
    });
    await firstClient.query('BEGIN');
    await secondClient.query('BEGIN');
    const common = { empresaId: 3, clienteId: 9, pedidoId: 42, estricto: true };
    const movimiento = (activoId) => ({ tipoOperacion: 'entrega', activoId, itemPedidoId, productoId: 55 });
    const first = registrarMovimientosActivosDesdePedido({
      ...common,
      dbClient: wrap(firstClient, true),
      movimientos: [movimiento(105), movimiento(101)],
    }).then(async result => { await firstClient.query('COMMIT'); return result; }, async error => { await firstClient.query('ROLLBACK'); throw error; });
    await withTimeout(firstLocked.promise, 3000, 'La primera transacción no tomó los locks');
    const second = registrarMovimientosActivosDesdePedido({
      ...common,
      dbClient: wrap(secondClient, false),
      movimientos: [movimiento(101), movimiento(105)],
    }).then(async result => { await secondClient.query('COMMIT'); return result; }, async error => { await secondClient.query('ROLLBACK'); throw error; });
    await withTimeout(secondLockStarted.promise, 3000, 'La segunda transacción no intentó los locks');
    releaseFirst.resolve();
    const settled = await Promise.allSettled([first, second]);
    firstClient.release();
    secondClient.release();
    assert.equal(settled.some(result => result.status === 'rejected' && result.reason?.code === '40P01'), false);
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
  });
});

test('PostgreSQL real: activos inválidos o no autorizados revierten toda la entrega', postgresOptions, async (t) => {
  await withIsolatedPostgres(async (pool) => {
    await createActivosFixture(pool);
    const item = await pool.query('SELECT id FROM items_pedido WHERE pedido_id = 42 AND producto_id = 55');
    const itemPedidoId = item.rows[0].id;
    const app = buildPostgresDeliveryApp(pool, { activosService: registrarMovimientosActivosDesdePedido });
    const cases = [
      ['activo inexistente', [{ tipoOperacion: 'entrega', activoId: 999, itemPedidoId, productoId: 55 }]],
      ['activo no disponible', [{ tipoOperacion: 'entrega', activoId: 102, itemPedidoId, productoId: 55 }]],
      ['activo de producto ajeno', [{ tipoOperacion: 'entrega', activoId: 103, itemPedidoId, productoId: 55 }]],
      ['retiro de otro cliente', [
        { tipoOperacion: 'entrega', activoId: 101, itemPedidoId, productoId: 55 },
        { tipoOperacion: 'retiro', activoId: 104, itemPedidoId, productoId: 55 },
      ]],
    ];

    await withServer(app, async (baseUrl) => {
      for (const [name, movimientos] of cases) {
        await t.test(name, async () => {
          await resetActivosFixture(pool);
          const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
            checklist: validChecklist,
            movimientos,
          });
          assert.equal(response.status, 400);
          assert.deepEqual(await response.json(), { error: 'Movimientos de activos inválidos' });
          const pedido = await pool.query('SELECT estado, fecha_entrega FROM pedidos WHERE id = 42');
          const counts = await pool.query(`SELECT
            (SELECT count(*)::int FROM pedido_activos) AS pedido_activos,
            (SELECT count(*)::int FROM historial_activos) AS historial`);
          const activos = await pool.query('SELECT id, estado, cliente_id FROM empresa_activos ORDER BY id');
          assert.deepEqual(pedido.rows, [{ estado: 'en_ruta', fecha_entrega: null }]);
          assert.deepEqual(counts.rows, [{ pedido_activos: 0, historial: 0 }]);
          assert.deepEqual(activos.rows, [
            { id: 101, estado: 'disponible', cliente_id: null },
            { id: 102, estado: 'prestado', cliente_id: 9 },
            { id: 103, estado: 'disponible', cliente_id: null },
            { id: 104, estado: 'prestado', cliente_id: 10 },
          ]);
        });
      }
    });
  });
});

test('PostgreSQL real: entrega activa válida asigna el activo y conserva asociación item/producto resuelto', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createActivosFixture(pool);
    await pool.query('UPDATE items_pedido SET producto_id = NULL WHERE pedido_id = 42 AND producto = $1', ['Bidón retornable']);
    const item = await pool.query('SELECT id FROM items_pedido WHERE pedido_id = 42 AND producto = $1', ['Bidón retornable']);
    const itemPedidoId = item.rows[0].id;
    const app = buildPostgresDeliveryApp(pool, { activosService: registrarMovimientosActivosDesdePedido });

    await withServer(app, async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [{ tipoOperacion: 'entrega', activoId: 101, itemPedidoId, productoId: 55 }],
      });
      assert.equal(response.status, 200);
    });

    const pedido = await pool.query('SELECT estado FROM pedidos WHERE id = 42');
    const activo = await pool.query('SELECT estado, cliente_id, producto_id FROM empresa_activos WHERE id = 101');
    const movimiento = await pool.query('SELECT item_pedido_id, producto_id, activo_id, tipo_operacion FROM pedido_activos');
    assert.deepEqual(pedido.rows, [{ estado: 'entregado' }]);
    assert.deepEqual(activo.rows, [{ estado: 'prestado', cliente_id: 9, producto_id: 55 }]);
    assert.deepEqual(movimiento.rows, [{ item_pedido_id: itemPedidoId, producto_id: 55, activo_id: 101, tipo_operacion: 'entrega' }]);
  });
});

test('PostgreSQL real: modo estricto rechaza variantes no canónicas de estados de activos', postgresOptions, async (t) => {
  await withIsolatedPostgres(async (pool) => {
    await createActivosFixture(pool);
    const item = await pool.query('SELECT id FROM items_pedido WHERE pedido_id = 42 AND producto_id = 55');
    const itemPedidoId = item.rows[0].id;

    for (const estado of ['Disponible', ' disponible', 'disponible ', null]) {
      await t.test(`entrega desde ${String(estado)}`, async () => {
        await resetActivosFixture(pool);
        await pool.query('UPDATE empresa_activos SET estado = $1 WHERE id = 101', [estado]);
        await assert.rejects(
          registrarMovimientosActivosDesdePedido({
            dbClient: pool,
            empresaId: 3,
            clienteId: 9,
            pedidoId: 42,
            estricto: true,
            movimientos: [{ tipoOperacion: 'entrega', activoId: 101, itemPedidoId, productoId: 55 }],
          }),
          error => error?.code === 'ACTIVOS_VALIDATION',
        );
      });
    }

    for (const estado of ['Prestado', ' prestado', 'prestado ', null]) {
      await t.test(`retiro desde ${String(estado)}`, async () => {
        await resetActivosFixture(pool);
        await pool.query('UPDATE empresa_activos SET estado = $1 WHERE id = 102', [estado]);
        await assert.rejects(
          registrarMovimientosActivosDesdePedido({
            dbClient: pool,
            empresaId: 3,
            clienteId: 9,
            pedidoId: 42,
            estricto: true,
            movimientos: [{ tipoOperacion: 'retiro', activoId: 102, itemPedidoId, productoId: 55 }],
          }),
          error => error?.code === 'ACTIVOS_VALIDATION',
        );
      });
    }
  });
});

test('PostgreSQL real: mantenimiento de entrega usa reparacion y es compatible con finReparacion', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createActivosFixture(pool);
    const item = await pool.query('SELECT id FROM items_pedido WHERE pedido_id = 42 AND producto_id = 55');
    const itemPedidoId = item.rows[0].id;

    await registrarMovimientosActivosDesdePedido({
      dbClient: pool,
      empresaId: 3,
      clienteId: 9,
      pedidoId: 42,
      estricto: true,
      movimientos: [{ tipoOperacion: 'mantenimiento', activoId: 102, itemPedidoId, productoId: 55 }],
    });

    const trasMantenimiento = await pool.query('SELECT estado, cliente_id FROM empresa_activos WHERE id = 102');
    assert.deepEqual(trasMantenimiento.rows, [{ estado: 'reparacion', cliente_id: null }]);

    const finalizado = await pool.query(
      `UPDATE empresa_activos
          SET estado = 'disponible', updated_at = NOW()
        WHERE empresa_id = $1 AND id = $2 AND estado = 'reparacion'
        RETURNING estado`,
      [3, 102],
    );
    assert.deepEqual(finalizado.rows, [{ estado: 'disponible' }]);
  });
});

test('PostgreSQL real completa entrega y deja ambos saldos y movimientos coherentes', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createRetornablesFixture(pool);
    const app = buildPostgresDeliveryApp(pool);

    await withServer(app, async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
        retornables: [{ producto_id: 55, devueltos: 4 }],
      });
      assert.equal(response.status, 200);
    });

    const pedido = await pool.query('SELECT estado FROM pedidos WHERE id = 42');
    const clienteSaldo = await pool.query('SELECT saldo FROM cliente_retornables_saldos WHERE empresa_id = 3 AND punto_entrega_id = 9 AND producto_id = 55');
    const ledgerSaldo = await pool.query("SELECT saldo FROM retornables_saldos WHERE empresa_id = 3 AND sujeto_tipo = 'cliente' AND sujeto_id = 9 AND producto_id = 55");
    const clienteMovs = await pool.query('SELECT entregados, devueltos, delta, saldo_resultante FROM cliente_retornables_movimientos');
    const ledgerMovs = await pool.query('SELECT cantidad_llenos, cantidad_vacios, delta_saldo, saldo_resultante FROM retornables_movimientos');
    assert.equal(pedido.rows[0].estado, 'entregado');
    assert.equal(Number(clienteSaldo.rows[0].saldo), 1);
    assert.equal(Number(ledgerSaldo.rows[0].saldo), 1);
    assert.ok(Number(clienteSaldo.rows[0].saldo) >= 0);
    assert.deepEqual(clienteMovs.rows.map(numericRow), [
      { entregados: 3, devueltos: 4, delta: -1, saldo_resultante: 1 },
    ]);
    assert.deepEqual(ledgerMovs.rows.map(numericRow), [
      { cantidad_llenos: 3, cantidad_vacios: 4, delta_saldo: -1, saldo_resultante: 1 },
    ]);
  });
});

test('PostgreSQL real preserva saldo -3: entrega 2, recibe 0 y deja ambos ledgers en -1', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createRetornablesFixture(pool);
    await pool.query('UPDATE items_pedido SET cantidad = 2 WHERE pedido_id = 42 AND producto_id = 55');
    await pool.query('UPDATE cliente_retornables_saldos SET saldo = -3');
    await pool.query('UPDATE retornables_saldos SET saldo = -3');
    const app = buildPostgresDeliveryApp(pool);

    await withServer(app, async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
        retornables: [{ producto_id: 55, devueltos: 0 }],
      });
      assert.equal(response.status, 200);
    });

    const clienteSaldo = await pool.query('SELECT saldo FROM cliente_retornables_saldos');
    const ledgerSaldo = await pool.query('SELECT saldo FROM retornables_saldos');
    const clienteMov = await pool.query('SELECT entregados, devueltos, delta, saldo_resultante FROM cliente_retornables_movimientos');
    const ledgerMov = await pool.query('SELECT cantidad_llenos, cantidad_vacios, delta_saldo, saldo_resultante FROM retornables_movimientos');
    assert.equal(Number(clienteSaldo.rows[0].saldo), -1);
    assert.equal(Number(ledgerSaldo.rows[0].saldo), -1);
    assert.deepEqual(clienteMov.rows.map(numericRow), [{ entregados: 2, devueltos: 0, delta: 2, saldo_resultante: -1 }]);
    assert.deepEqual(ledgerMov.rows.map(numericRow), [{ cantidad_llenos: 2, cantidad_vacios: 0, delta_saldo: 2, saldo_resultante: -1 }]);
  });
});

function numericRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

test('PostgreSQL real serializa fijar no-cliente sobre saldo inexistente', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createRetornablesFixture(pool);
    const firstInserted = deferred();
    const secondInsertStarted = deferred();
    const releaseFirst = deferred();
    let connectionNumber = 0;
    const wrappedPool = {
      async connect() {
        const client = await pool.connect();
        connectionNumber += 1;
        const current = connectionNumber;
        return {
          async query(sql, params) {
            if (sql.includes('INSERT INTO retornables_saldos') && sql.includes('DO NOTHING')) {
              if (current === 1) {
                const result = await client.query(sql, params);
                firstInserted.resolve();
                await releaseFirst.promise;
                return result;
              }
              secondInsertStarted.resolve();
            }
            return client.query(sql, params);
          },
          release: (...args) => client.release(...args),
        };
      },
    };
    const app = express();
    app.use('/api/retornables', createRetornablesRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool: wrappedPool,
      withTransaction: work => dbWithTransaction(work, { pool: wrappedPool, maxRetries: 0, retryDelayMs: 0 }),
      withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: 3, id: 9 }; next(); },
      checkLicencia(_req, _res, next) { next(); },
      isSuper: () => false,
      getEmpresaIdFromToken: () => 3,
    }));

    await withServer(app, async (baseUrl) => {
      const body = { sujeto_tipo: 'chofer', sujeto_id: 7, producto_id: 55, modo: 'fijar', cantidad: 5 };
      const first = postJson(`${baseUrl}/api/retornables/ajustes`, body);
      await withTimeout(firstInserted.promise, 3000, 'El primer ajuste no creó la fila');
      const second = postJson(`${baseUrl}/api/retornables/ajustes`, body);
      await withTimeout(secondInsertStarted.promise, 3000, 'El segundo ajuste no alcanzó el upsert');
      releaseFirst.resolve();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map(response => response.status), [200, 200]);
    });

    const saldo = await pool.query("SELECT saldo FROM retornables_saldos WHERE empresa_id = 3 AND sujeto_tipo = 'chofer' AND sujeto_id = 7 AND producto_id = 55");
    assert.equal(Number(saldo.rows[0].saldo), 5);
  });
});

test('PostgreSQL real serializa entrega y ajuste cliente sin deadlock y conserva ambos saldos', postgresOptions, async () => {
  await withIsolatedPostgres(async (pool) => {
    await createRetornablesFixture(pool);

    const entregaBloqueoTomado = deferred();
    const liberarEntrega = deferred();
    const ajusteAlcanzoBloqueo = deferred();
    const wrapPool = (actor) => ({
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params = []) {
            const isClienteCreate = sql.includes('INSERT INTO cliente_retornables_saldos') && sql.includes('DO NOTHING');
            const isClienteLock = sql.includes('FROM cliente_retornables_saldos') && sql.includes('FOR UPDATE');
            const isLedgerLock = sql.includes('FROM retornables_saldos') && sql.includes('FOR UPDATE');
            if (actor === 'ajuste' && (isClienteCreate || isClienteLock)) {
              ajusteAlcanzoBloqueo.resolve('cliente');
              liberarEntrega.resolve();
            }
            const result = await client.query(sql, params);
            if (actor === 'entrega' && isClienteLock) {
              entregaBloqueoTomado.resolve();
              await liberarEntrega.promise;
            }
            if (actor === 'ajuste' && isLedgerLock) {
              ajusteAlcanzoBloqueo.resolve('ledger');
              liberarEntrega.resolve();
            }
            return result;
          },
          release() { client.release(); },
        };
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/api/repartidor', createRepartidorApiRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool: wrapPool('entrega'),
      withAuth: (req, _res, next) => {
        req.user = { chofer_id: 7, empresa_id: 3, username: 'chofer-test', role: 'repartidor' };
        next();
      },
      getEmpresaIdFromToken: () => 3,
      notifyEstadoPedidoPush: async () => {},
      notificarEnRuta: async () => {},
      notificarPedidoTransferencia: async () => {},
      ejecutarEstrategiaVecinos: async () => {},
      awardPointsForDeliveredOrder: async () => {},
      generateComisionesForDeliveredOrder: async () => {},
      registrarMovimientosActivosDesdePedido: async () => {},
    }));
    const ajustePool = wrapPool('ajuste');
    app.use('/api/retornables', createRetornablesRouter({
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      pool: ajustePool,
      withTransaction: work => dbWithTransaction(work, { pool: ajustePool, maxRetries: 0, retryDelayMs: 0 }),
      withAuth(req, _res, next) {
        req.user = { role: 'admin', empresa_id: 3, id: 9, username: 'admin-test' };
        next();
      },
      checkLicencia(_req, _res, next) { next(); },
      isSuper: () => false,
      getEmpresaIdFromToken: () => 3,
    }));

    await withServer(app, async (baseUrl) => {
      const warmup = await postJson(`${baseUrl}/api/retornables/ajustes`, {
        punto_entrega_id: 9,
        producto_id: 55,
        cantidad: -1,
      });
      assert.equal(warmup.status, 400);

      const schemaWarmup = await postJson(`${baseUrl}/api/retornables/ajustes`, {
        punto_entrega_id: 9,
        producto_id: 55,
        modo: 'fijar',
        cantidad: 2,
      });
      assert.equal(schemaWarmup.status, 200);
      await pool.query(`
        DELETE FROM cliente_retornables_movimientos;
        DELETE FROM retornables_movimientos;
        UPDATE cliente_retornables_saldos SET saldo = 2;
        UPDATE retornables_saldos SET saldo = 2;
      `);

      const entrega = postJson(`${baseUrl}/api/repartidor/pedidos/42/entregar`, {
        checklist: validChecklist,
        movimientos: [],
        retornables: [{ producto_id: 55, devueltos: 1 }],
      });
      await withTimeout(entregaBloqueoTomado.promise, 3000, 'La entrega no tomó el lock cliente');

      const ajuste = postJson(`${baseUrl}/api/retornables/ajustes`, {
        punto_entrega_id: 9,
        producto_id: 55,
        modo: 'fijar',
        cantidad: 4,
        observacion: 'Ajuste concurrente',
      });
      const primerBloqueoAjuste = await withTimeout(ajusteAlcanzoBloqueo.promise, 3000, 'El ajuste no alcanzó su primer lock de saldo');
      const [entregaResp, ajusteResp] = await withTimeout(Promise.all([entrega, ajuste]), 6000, 'Entrega y ajuste no completaron');
      assert.equal(entregaResp.status, 200);
      assert.equal(ajusteResp.status, 200);
      assert.equal(primerBloqueoAjuste, 'cliente');
    });

    const saldos = await pool.query(`
      SELECT
        (SELECT saldo FROM cliente_retornables_saldos WHERE empresa_id = 3 AND punto_entrega_id = 9 AND producto_id = 55) AS cliente,
        (SELECT saldo FROM retornables_saldos WHERE empresa_id = 3 AND sujeto_tipo = 'cliente' AND sujeto_id = 9 AND producto_id = 55) AS ledger
    `);
    const saldoCliente = Number(saldos.rows[0].cliente);
    const saldoLedger = Number(saldos.rows[0].ledger);
    assert.equal(saldoCliente, saldoLedger);
    assert.ok([4, 6].includes(saldoCliente), `saldo serializable inesperado: ${saldoCliente}`);
    assert.ok(saldoCliente >= 0);

    const clienteMovs = await pool.query('SELECT pedido_id, delta, saldo_resultante FROM cliente_retornables_movimientos ORDER BY id');
    const ledgerMovs = await pool.query('SELECT pedido_id, delta_saldo AS delta, saldo_resultante FROM retornables_movimientos ORDER BY id');
    assert.equal(clienteMovs.rows.length, 2);
    assert.equal(ledgerMovs.rows.length, 2);
    assert.deepEqual(clienteMovs.rows.map(numericNullableRow), ledgerMovs.rows.map(numericNullableRow));
    const movimientoEntrega = clienteMovs.rows.find((row) => Number(row.pedido_id) === 42);
    assert.ok(Number(movimientoEntrega.saldo_resultante) >= 0);
   });
 });

function numericNullableRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)]));
}
