import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { ensureRetornablesLedgerSchema } from '../src/services/retornablesLedger.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// Evaluate the router without importing payment services or the application DB pool.
const routerContext = { express, ensureRetornablesLedgerSchema, console,
  crearPagoParaPedidoDefault() { throw new Error('Unexpected payment call'); },
  listarPagosPorPedidoDefault() { throw new Error('Unexpected payment call'); },
  refrescarEstadoPagoPedidoDefault() { throw new Error('Unexpected payment call'); },
};
vm.runInNewContext(read('src/routes/repartidorApi.js').replace(/^import[\s\S]*?;$/gm, '').replace('export function', 'function'), routerContext);
const { createRepartidorApiRouter } = routerContext;
const ops = read('pedidos/repartidor-operaciones.js');
const gps = read('pedidos/repartidor-mapa-gps.js');
const core = read('pedidos/repartidor-core.js');
const html = read('pedidos/repartidor.html');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
async function serve(user, rows, run) {
  const calls = [];
  const app = express();
  app.use('/api/repartidor', createRepartidorApiRouter({
    query: async (sql, params) => { calls.push({ sql, params }); return typeof rows === 'function' ? rows(sql, params) : rows; },
    withAuth: (req, res, next) => { req.user = user; next(); },
    getEmpresaIdFromToken: req => req.user.empresa_id,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(path => fetch(`http://127.0.0.1:${server.address().port}/api/repartidor${path}`), calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const driver = { role: 'repartidor', empresa_id: 7, chofer_id: 4 };
test('transferencias propias: alcance autenticado, proyección mínima y sólo SELECT', async () => {
  await serve(driver, [{ pedido_id: 1, cliente: 'Ana', monto: 10, validado: true, estado: 'verificado', archivo_path: 'secreto' }], async (get, calls) => {
    const res = await get('/transferencias?fecha=2026-09-22&estado=verificado&empresa_id=99&chofer_id=88');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rows: [{ pedido_id: 1, cliente: 'Ana', monto: 10, validado: true, estado: 'verificado' }] });
    assert.equal(calls.length, 1);
    assert.deepEqual(Array.from(calls[0].params), [7, 4, '2026-09-22', 'verificado']);
    assert.match(calls[0].sql, /p\.chofer_id = \$2/);
    assert.match(calls[0].sql, /ct\.empresa_id = \$1/);
    assert.match(calls[0].sql, /p\.empresa_id = ct\.empresa_id/);
    assert.match(calls[0].sql, /pe\.empresa_id = p\.empresa_id/);
    assert.doesNotMatch(calls[0].sql, /\b(?:ALTER|INSERT|UPDATE|DELETE|CREATE)\b|archivo_path|comprobante_path|riesgo|cbu/i);
  });
});
test('transferencias requieren rol exacto y vínculos válidos antes de consultar', async () => {
  for (const user of [{ ...driver, role: 'admin' }, { ...driver, role: 'super' }, { ...driver, role: 'REPARTIDOR' }, { ...driver, chofer_id: null }, { ...driver, empresa_id: null }]) {
    await serve(user, [], async (get, calls) => {
      assert.equal((await get('/transferencias')).status, 403);
      assert.equal(calls.length, 0);
    });
  }
});
test('transferencias validan fecha real y estado sin consultar', async () => {
  for (const q of ['fecha=2026-02-30', 'fecha=2026-09-22junk', 'fecha[]=2026-09-22', 'estado=aprobado', 'estado[]=pendiente']) {
    await serve(driver, [], async (get, calls) => {
      assert.equal((await get('/transferencias?' + q)).status, 400, q);
      assert.equal(calls.length, 0);
    });
  }
});
test('stock usa ingresos físicos, fecha del gasto DATE y zona argentina una sola vez', async () => {
  await serve(driver, [{ saldo_inicial: -3, saldo_final: -2, cargado: 1, entregado: 0 }], async (get, calls) => {
    const res = await get('/stock-acumulado?fecha=2026-09-22');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).kpis.saldo_final, -2);
    const sql = calls.find(call => /^WITH/.test(call.sql)).sql;
    assert.equal((sql.match(/csm.tipo = 'INGRESO_GASTOS'/g) || []).length, 2);
    assert.doesNotMatch(sql, /AT TIME ZONE 'UTC'|tipo <> 'venta'/);
    assert.equal((sql.match(/COALESCE\(g.fecha, \(csm.fecha AT TIME ZONE 'America\/Argentina\/Buenos_Aires'\)::date\)/g) || []).length, 2);
    assert.match(sql, /g\.empresa_id = csm\.empresa_id/);
    assert.match(sql, /g\.chofer_id = csm\.chofer_id/);
  });
});
test('entrega resuelve ID aunque cambie el nombre y limita fallback a NULL', () => {
  const sql = slice(read('src/routes/repartidorApi.js'), 'const itemsQ =', 'for (const it of itemsQ.rows)');
  assert.match(sql, /p.id = ip.producto_id/);
  assert.match(sql, /ip.producto_id IS NULL AND LOWER\(TRIM\(p.nombre\)\)/);
});
test('saludo sin username tiene fallback seguro', () => {
  const context = { me: {}, $: () => context.title, title: {} };
  vm.runInNewContext(core.match(/^.*brandTitle.*textContent.*$/m)[0], context);
  assert.equal(context.title.textContent, 'Hola, repartidor');
});
test('transferencias UI usa lectura propia sin control de validación', async () => {
  const nodes = { '#tfDate': { value: '2026-09-22' }, '#tfFilter': { value: '' }, '#tfList': {} };
  let url;
  const context = { $: id => nodes[id], api: async q => { url = q; return { rows: [{ pedido_id: 1, cliente: 'Ana', monto: 5, validado: true }] }; }, esc: String, money: String, console };
  vm.runInNewContext(slice(ops, 'async function loadTransf()', 'async function loadEvidenciasEntrega'), context);
  await context.loadTransf();
  assert.match(url, /^\/api\/repartidor\/transferencias/);
  assert.doesNotMatch(nodes['#tfList'].innerHTML, /checkbox|onchange|toggle/);
  assert.doesNotMatch(ops + read('pedidos/repartidor-pedidos.js'), /\/api\/transferencias|toggle-pago/);
});
test('movimientos nuevos guardan nota manual y legacy se limpia sólo al presentar/editar', () => {
  assert.doesNotMatch(ops, /descripcion: `\$\{pref\}/);
  const context = { window: {}, $: () => null };
  vm.runInNewContext(ops, context);
  assert.equal(context.getMovimientoNota({ tipo: 'carga_llenos', descripcion: 'Carga: 12u Bidón 20L. Nota manual' }), 'Nota manual');
  assert.equal(context.getMovimientoNota({ tipo: 'descarga_vacios', descripcion: 'Descarga: 2.5u Bidón. Nota' }), 'Nota');
  assert.equal(context.getMovimientoNota({ tipo: 'gasto', descripcion: 'Carga: 12u Bidón. Nota' }), 'Carga: 12u Bidón. Nota');
  assert.equal(context.getMovimientoNota({ tipo: 'carga_llenos', descripcion: 'Nota sin prefijo' }), 'Nota sin prefijo');
  assert.match(ops, /\$\('#megDesc'\).value = getMovimientoNota\(row\)/);
  assert.match(ops, /\[detalleMerc, getMovimientoNota\(g\)\]/);
});
test('stock muestra advertencia incluso si otro producto compensa el déficit', async () => {
  const nodes = Object.fromEntries(['stDate','stList','stKpiInicial','stKpiCarga','stKpiEntregado','stKpiSaldo','stWarning'].map(id => ['#' + id, { value: '2026-09-22', style: {}, hidden: true }]));
  const context = { $: id => nodes[id], api: async () => ({ rows: [{ nombre: 'A', saldo_inicial: -3, saldo_final: -2 }, { nombre: 'B', saldo_inicial: 10, saldo_final: 10 }], kpis: { saldo_final: 8 } }), esc: String, console };
  vm.runInNewContext(slice(ops, 'async function loadStockRepartidor()', '// --- RESUMEN ---'), context);
  await context.loadStockRepartidor();
  assert.equal(nodes['#stWarning'].hidden, false);
  assert.match(nodes['#stWarning'].textContent, /déficit|integridad/i);
  assert.match(nodes['#stList'].innerHTML, />-2</);
});
test('menú anuncia nombre y estado al abrir/cerrar/navegar', async () => {
  assert.match(html, /id="menuToggle"[^>]*aria-label="[^"]+"[^>]*aria-controls="menuPanel"[^>]*aria-expanded="false"/);
  let open = false;
  const btn = { setAttribute(k,v) { this[k] = v; } };
  const panel = { classList: { toggle() { return open = !open; }, remove() { open = false; } } };
  const link = { dataset: { sec: 'pedidos' }, setAttribute() {}, removeAttribute() {} };
  const context = { $: id => id === '#menuToggle' ? btn : id === '#menuPanel' ? panel : {}, $$: sel => sel === '.nav-link' ? [link] : [], document: { getElementById() {}, addEventListener() {} }, window: { addEventListener() {} } };
  vm.runInNewContext(read('pedidos/repartidor-shell.js'), context);
  context.initRepartidorShellUI(); btn.onclick(); assert.equal(btn['aria-expanded'], 'true');
  btn.onclick(); assert.equal(btn['aria-expanded'], 'false');
  btn.onclick(); await link.onclick({ preventDefault() {} }); assert.equal(btn['aria-expanded'], 'false');
});
test('mapa hace fallback inicial una vez y respeta selección posterior', () => {
  const nodes = { '#mapFiltroEstado': { value: 'en_ruta', addEventListener(_, fn) { this.change = fn; } }, '#mapSoloHoy': { checked: false, addEventListener() {} }, '#mapRefBtn': {}, '#mapHint': {} };
  let markers = 0;
  const context = { $: id => nodes[id], map: { invalidateSize() {}, fitBounds() {} }, mapMarkers: { clearLayers() { markers = 0; } }, pedidos: [{ estado: 'pendiente', latitud: -31, longitud: -64, cliente: 'Ana' }], getOyString: () => '2026-09-22', getGoogleMapsDirectionsUrl: () => 'url', buildRepartidorMapPopup: () => '', esc: String, L: { divIcon() {}, marker: () => ({ addTo() { markers++; return this; }, bindPopup() {} }) } };
  vm.runInNewContext(slice(gps, 'function initRepartidorMapaGpsUI()', 'function showGpsHelp') + slice(gps, 'function renderMap()', '// --- GPS TRACKING'), context);
  context.initRepartidorMapaGpsUI(); context.renderMap();
  assert.equal(nodes['#mapFiltroEstado'].value, 'pendiente'); assert.equal(markers, 1);
  nodes['#mapFiltroEstado'].value = 'en_ruta'; nodes['#mapFiltroEstado'].change(); context.renderMap();
  assert.equal(nodes['#mapFiltroEstado'].value, 'en_ruta'); assert.equal(markers, 0);
});
test('GPS da feedback inmediato y resultado accesible, sólo al activar', async () => {
  assert.match(html, /id="gpsStatus"[^>]*aria-live="polite"/);
  const status = {};
  let resolvePosition; let requests = 0;
  const context = { document: { getElementById: () => status }, navigator: { geolocation: { getCurrentPosition(resolve) { requests++; resolvePosition = resolve; } } }, window: { isSecureContext: true }, GEO_OPTS_ACTIVATE: {}, gpsSyncState: {}, pedidos: [], persistGpsPreference() {}, updateGpsButtonUI() {}, toast() {}, Date };
  vm.runInNewContext(slice(gps, 'function setGpsFeedback', 'const GPS_PREF_LS_KEY') + slice(gps, 'async function requestGpsActivation()', '// --- MAPA ---'), context);
  assert.equal(requests, 0);
  const pending = context.requestGpsActivation();
  assert.match(status.textContent, /Solicitando/); assert.equal(requests, 1);
  resolvePosition({ coords: {} }); await pending; assert.match(status.textContent, /activado/i);
});
test('una preferencia GPS previa no activa ubicación sin interacción', () => {
  const context = { safeStorage: { local: { get: () => '1' } }, gpsSyncState: { disabled: true }, GPS_PREF_LS_KEY: 'gps' };
  vm.runInNewContext(slice(gps, 'function restoreGpsPreference()', 'function getGeoErrorCode'), context);
  context.restoreGpsPreference();
  assert.equal(context.gpsSyncState.disabled, true);
});

test('todos los enlaces del menú tienen destinos alcanzables por teclado', () => {
  const links = [...html.matchAll(/<a\b[^>]*class="nav-link"[^>]*>/g)].map(m => m[0]);
  assert.equal(links.length, 8);
  for (const link of links) {
    const section = link.match(/data-sec="([^"]+)"/)?.[1];
    const href = link.match(/href="([^"]+)"/)?.[1];
    assert.equal(href, section ? `#sec-${section}` : 'login.html', link);
    if (section) assert.ok(html.includes(`id="sec-${section}"`));
  }
});

test('initDb declara gasto_id y migra instalaciones existentes de forma idempotente', () => {
  const init = read('initDb.sql');
  assert.match(init.match(/CREATE TABLE IF NOT EXISTS chofer_stock_mov \([\s\S]*?\n\);/)[0], /gasto_id\s+INTEGER/i);
  assert.match(init, /ALTER TABLE chofer_stock_mov\s+ADD COLUMN IF NOT EXISTS gasto_id INTEGER\s*;/i);
});

test('stock espera la preparación completa antes del SELECT y reutiliza el esquema', async () => {
  let prepared = false;
  await serve(driver, async sql => {
    if (/ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS gasto_id INTEGER/.test(sql)) {
      await new Promise(resolve => setTimeout(resolve, 20));
      prepared = true;
    }
    if (/^WITH/.test(sql)) assert.equal(prepared, true, 'SELECT antes de garantizar gasto_id');
    return [];
  }, async (get, calls) => {
    assert.equal((await get('/stock-acumulado?fecha=2026-09-22')).status, 200);
    const select = calls.findIndex(c => /^WITH/.test(c.sql));
    const migration = calls.findIndex(c => /ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS gasto_id INTEGER/.test(c.sql));
    assert.ok(migration >= 0 && migration < select);
    const count = calls.length;
    assert.equal((await get('/stock-acumulado?fecha=2026-09-22')).status, 200);
    assert.equal(calls.length, count + 1);
  });
});

for (const ajuste of [3, -8]) {
  test(`stock PostgreSQL suma ajuste firmado ${ajuste} previo y del día sin duplicar devoluciones/ventas`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      await pool.query(`
        CREATE TABLE chofer_stock_mov (empresa_id integer, chofer_id integer, producto_id integer, gasto_id integer, tipo text, cantidad numeric, fecha timestamptz);
        CREATE TABLE gastos_repartidor (id integer, empresa_id integer, chofer_id integer, fecha date);
        CREATE TABLE productos (id integer, empresa_id integer, nombre text);
        CREATE TABLE pedidos (id integer, empresa_id integer, chofer_id integer, estado text, fecha_entrega timestamptz, fecha timestamptz);
        CREATE TABLE items_pedido (pedido_id integer, producto_id integer, producto text, cantidad numeric);
        INSERT INTO productos VALUES (1,7,'Agua');
        INSERT INTO pedidos VALUES (1,7,4,'entregado','2026-09-21 12:00Z',NULL),(2,7,4,'entregado','2026-09-22 12:00Z',NULL),(3,7,4,'pendiente','2026-09-22 12:00Z',NULL);
        INSERT INTO items_pedido VALUES (1,1,'Agua',2),(2,1,'Agua',1),(3,1,'Agua',100);
      `);
      for (const date of ['2026-09-21', '2026-09-22']) {
        for (const [tipo, cantidad] of [['INGRESO_GASTOS', 5], ['ajuste', ajuste], ['DEVOLUCION', 100], ['venta', -100]]) {
          await pool.query('INSERT INTO chofer_stock_mov VALUES (7,4,1,NULL,$1,$2,$3)', [tipo, cantidad, `${date} 12:00Z`]);
        }
        await pool.query("INSERT INTO chofer_stock_mov VALUES (99,4,1,NULL,'ajuste',100,$1),(7,88,1,NULL,'ajuste',100,$1)", [`${date} 12:00Z`]);
      }
      await serve(driver, async (sql, params) => /^WITH/.test(sql) ? (await pool.query(sql, params)).rows : [], async get => {
        const res = await get('/stock-acumulado?fecha=2026-09-22');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.kpis, { saldo_inicial: 3 + ajuste, cargado: 5 + ajuste, entregado: 1, saldo_final: 7 + 2 * ajuste });
        assert.equal(body.rows.length, 1);
      });
    });
  });
}
