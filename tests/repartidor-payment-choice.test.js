import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import vm from 'node:vm';

import { createRepartidorApiRouter } from '../src/routes/repartidorApi.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function appHarness({ order = {}, calls = [] } = {}) {
  const query = async (sql) => {
    calls.push({ scope: 'query', sql });
    if (/SELECT\s+p\.id, p\.estado/.test(sql)) return [{
      id: 42, estado: 'en_ruta', metodo_pago: null, metodo_pago_origen: null,
      metodo_pago_seleccionado_at: null, ...order,
    }];
    return [];
  };
  const txQuery = async (sql, params = []) => {
    calls.push({ scope: 'tx', sql, params });
    if (/FROM pedidos p/.test(sql) && /FOR UPDATE/.test(sql)) return [{
      id: 42, chofer_id: 7, estado: 'en_ruta', metodo_pago: 'transferencia',
      metodo_pago_origen: 'cliente_whatsapp', zona_id: 4, punto_entrega_id: 11,
      ...order,
    }];
    if (/FROM choferes/.test(sql)) return [{ id: 7, usuario_id: 70 }];
    if (/UPDATE pedidos/.test(sql)) return [{ id: 42 }];
    if (/INSERT INTO pedido_metodo_pago_eventos/.test(sql)) return [{ id: 9 }];
    return [];
  };
  const app = express();
  app.use(express.json());
  app.use('/api/repartidor', createRepartidorApiRouter({
    query,
    pool: {},
    withTransaction: work => work(txQuery),
    withAuth(req, _res, next) {
      req.user = { uid: 70, role: 'repartidor', empresa_id: 3, chofer_id: 7, username: 'driver' };
      next();
    },
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  return app;
}

test('GET repartidor pedidos expone método, origen y fecha sin convertir NULL a efectivo', async () => {
  const calls = [];
  const app = appHarness({ calls });
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/repartidor/pedidos`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{
      id: 42, estado: 'en_ruta', metodo_pago: null, metodo_pago_origen: null,
      metodo_pago_seleccionado_at: null,
    }]);
  });
  const select = calls.find(call => /SELECT\s+p\.id, p\.estado/.test(call.sql));
  assert.match(select.sql, /p\.metodo_pago_origen/);
  assert.match(select.sql, /p\.metodo_pago_seleccionado_at/);
  assert.match(select.sql, /p\.chofer_id = \$1/);
  assert.match(select.sql, /p\.empresa_id = \$2/);
});

test('override manual de selección cliente exige confirmación y audita actor repartidor revalidado', async () => {
  const calls = [];
  const app = appHarness({ calls });
  await withServer(app, async base => {
    const denied = await fetch(`${base}/api/repartidor/pedidos/42`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metodo_pago: 'efectivo' }),
    });
    assert.equal(denied.status, 409);
    assert.match((await denied.json()).error, /confirm/i);

    const accepted = await fetch(`${base}/api/repartidor/pedidos/42`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metodo_pago: 'efectivo', confirmar_cambio_cliente: true }),
    });
    assert.equal(accepted.status, 200);
  });
  const actorLock = calls.find(call => call.scope === 'tx' && /FROM choferes/.test(call.sql));
  assert.match(actorLock.sql, /JOIN usuarios/);
  assert.match(actorLock.sql, /u\.activo IS TRUE/);
  assert.match(actorLock.sql, /u\.role = 'repartidor'/);
  const update = calls.find(call => call.scope === 'tx' && /UPDATE pedidos/.test(call.sql));
  assert.match(update.sql, /metodo_pago_origen/);
  assert.match(update.sql, /metodo_pago_outbound_message_id = NULL/);
  assert.ok(calls.some(call => call.scope === 'tx' && /INSERT INTO pedido_metodo_pago_eventos/.test(call.sql)));
});

const html = fs.readFileSync(new URL('../pedidos/repartidor.html', import.meta.url), 'utf8');
const pedidosSource = fs.readFileSync(new URL('../pedidos/repartidor-pedidos.js', import.meta.url), 'utf8');
const entregaSource = fs.readFileSync(new URL('../pedidos/repartidor-entrega.js', import.meta.url), 'utf8');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('UI distingue pendiente, elección cliente/manual y transferencia verificada', () => {
  assert.doesNotMatch(pedidosSource, /p\.metodo_pago \|\| 'efectivo'/);
  assert.match(pedidosSource, /Forma de pago pendiente/);
  assert.match(pedidosSource, /Efectivo — elegido por el cliente/);
  assert.match(pedidosSource, /Transferencia — elegida por el cliente/);
  assert.match(pedidosSource, /elegida por el repartidor/);
  assert.match(pedidosSource, /Transferencia verificada/);
  assert.match(html, /\.payment-choice-status/);
  assert.match(html, /\.pay-opt:focus-visible/);
});

test('UI renderiza fecha legible de selección y no inventa fecha cuando es NULL', () => {
  const cardsContainer = { innerHTML: '' };
  const emptyMsg = { hidden: false };
  const selectedAt = '2026-10-10T15:34:00.000Z';
  const context = vm.createContext({
    getFilteredPedidos: () => [{
      id: 42,
      estado: 'en_ruta',
      metodo_pago: 'transferencia',
      metodo_pago_origen: 'cliente_whatsapp',
      metodo_pago_seleccionado_at: selectedAt,
      cliente: 'Ana <Cliente>',
      direccion: 'Calle 1',
      monto: 1500,
      items: [],
    }],
    renderCargaPendiente() {},
    verificadas: new Set(),
    pagosCanales: { efectivo: true, transferencia: true },
    getOyString: () => '2026-10-10',
    getPedidoFechaOperativa: () => '2026-10-10',
    formatFechaPlanificada: () => '',
    renderRetornablesPendientes: () => '',
    formatFechaAR: () => '',
    money: value => `$${value}`,
    esc: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    $: selector => selector === '#cardsContainer' ? cardsContainer : emptyMsg,
    Number,
    String,
    Array,
    Date,
  });
  vm.runInContext(pedidosSource.slice(pedidosSource.indexOf('function formatPaymentChoiceSelectedAt(')), context);
  context.renderCards();
  assert.match(cardsContainer.innerHTML, /Elegida el /);
  assert.match(cardsContainer.innerHTML, /elegida por el cliente <span class="payment-choice-date">/);
  assert.doesNotMatch(cardsContainer.innerHTML, new RegExp(selectedAt));
  assert.match(cardsContainer.innerHTML, /Ana &lt;Cliente&gt;/);

  context.getFilteredPedidos = () => [{
    id: 43, estado: 'en_ruta', metodo_pago: null, metodo_pago_origen: null,
    metodo_pago_seleccionado_at: null, cliente: 'Beto', direccion: 'Calle 2', monto: 900, items: [],
  }];
  context.renderCards();
  assert.match(cardsContainer.innerHTML, /Forma de pago pendiente/);
  assert.doesNotMatch(cardsContainer.innerHTML, /Elegida el /);
});

test('UI exige confirmación explícita antes de cambiar selección cliente y envía flag server-side', async () => {
  const apiCalls = [];
  let confirmations = 0;
  const context = vm.createContext({
    pedidos: [{ id: 42, metodo_pago: 'transferencia', metodo_pago_origen: 'cliente_whatsapp', cuenta_corriente_habilitada: false }],
    pagosCanales: { efectivo: true, transferencia: true },
    toast() {},
    setActionBusy: () => () => {},
    withLock: async (_key, work) => work(),
    resolverZonaParaPedido: async () => null,
    api: async (url, options) => { apiCalls.push({ url, options }); return { ok: true }; },
    loadPedidos: async () => {},
    notifyError: error => { throw error; },
    confirm: () => { confirmations += 1; return true; },
    Number,
    String,
  });
  vm.runInContext(slice(entregaSource, 'async function setPay(', 'function toast('), context);
  await context.setPay(42, 'efectivo');
  assert.equal(confirmations, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls[0].options.body)), {
    metodo_pago: 'efectivo', confirmar_cambio_cliente: true,
  });
});

test('entrega no vuelve a cobrar una transferencia realmente verificada', async () => {
  assert.match(entregaSource, /verificadas\.has\(Number\(id\)\)/);
  assert.match(entregaSource, /esTransferencia\s*&&\s*!transferenciaVerificada\s*&&\s*qrHabilitado/);
});
