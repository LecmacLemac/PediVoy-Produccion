import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';
import {
  normalizeProductAvailabilityConfig
} from '../src/menuAvailability.js';
const root = path.resolve(import.meta.dirname, '..');
// Synthetic HTTP fixtures only: never import the application or connect a DB.
async function fixture(t, {
  enabled = true,
  role = 'admin',
  delay = 0,
  productDelay = 0,
  saveDelay = 0,
  previewDelay = 0,
  previewState = null
} = {}) {
  const writes = [];
  const configs = new Map();
  const previews = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture');
    res.setHeader('Content-Type', 'application/json');
    const send = x => res.end(JSON.stringify(x));
    if (req.method !== 'GET') {
      let raw = '';
      for await (const c of req) raw += c;
      writes.push({
        url: req.url,
        body: JSON.parse(raw || '{}')
      });
      if (u.pathname === '/api/menu/config') configs.set(u.searchParams.get('empresa_id'), JSON.parse(
        raw));
      if (saveDelay) await new Promise(r => setTimeout(r, saveDelay));
      return send({
        ok: true
      });
    }
    if (u.pathname === '/api/me') return send({
      user: {
        role,
        empresa_id: 1
      }
    });
    if (u.pathname === '/api/empresas') return send([{
      id: 1,
      nombre: 'Uno'
    }, {
      id: 2,
      nombre: 'Dos'
    }]);
    if (u.pathname === '/api/productos') {
      if (productDelay && u.searchParams.get('empresa_id') === '2') await new Promise(r => setTimeout(
        r, productDelay));
      return send([{
        id: 11,
        nombre: 'Menú',
        precio: 100,
        activo: true,
        mostrar_en_catalogo: true,
        disponibilidad_config: {
          enabled: true,
          weekdays: [0, 2],
          daily_capacity: 0,
          exceptions: [],
          channels: {}
        }
      }]);
    }
    if (u.pathname === '/api/menu/config') {
      const id = u.searchParams.get('empresa_id');
      if (delay && id === '1') await new Promise(r => setTimeout(r, delay));
      return send({
        enabled,
        empresa_id: Number(id),
        config: !enabled ? null : configs.get(id) || {
          enabled: true,
          timezone: id === '2' ? 'America/Montevideo' : 'America/Argentina/Buenos_Aires',
          max_advance_days: 7,
          service_weekdays: [0, 1],
          closed_dates: []
        }
      });
    }
    if (u.pathname === '/api/menu/preview') {
      previews.push(req.url);
      if (previewDelay) await new Promise(r => setTimeout(r, previewDelay));
      return send({
        enabled: true,
        menu: previewState || {
          available: true,
          scheduled: true,
          reason: 'available',
          remaining: 8,
          timezone: 'America/Argentina/Buenos_Aires',
          date: u.searchParams.get('fecha_entrega')
        }
      });
    }
    if (u.pathname.startsWith('/api/')) return send({});
    try {
      const file = path.join(root, u.pathname);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ?
        'text/css' : 'text/html');
      res.end(await fs.readFile(file));
    } catch {
      res.statusCode = 404;
      res.end('');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    args: ['--no-sandbox']
  });
  t.after(async () => {
    await browser.close();
    await new Promise(r => server.close(r));
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1280,
    height: 900
  });
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (r.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) r.continue();
    else r.abort();
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return {
    page,
    writes,
    previews,
    errors,
    base: `http://127.0.0.1:${server.address().port}`
  };
}
async function values(page, entries) {
  await page.evaluate(entries => {
    for (const [id, value] of Object.entries(entries)) {
      const e = document.getElementById(id);
      if (e.type === 'checkbox') e.checked = value;
      else e.value = value;
      e.dispatchEvent(new Event('input', {
        bubbles: true
      }));
      e.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }
  }, entries);
}
test('producto guarda programación completa atómicamente y preview usa únicamente estado guardado',
  async t => {
    const f = await fixture(t);
    await openProduct(f);
    await f.page.waitForSelector('#mp-enabled');
    await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
    await values(f.page, {
      'mp-enabled': true,
      'mp-mode': 'dates',
      'mp-dates': '2026-10-20\n2026-10-21',
      'mp-daily_capacity': '0',
      'mp-open_days_before': '2',
      'mp-open_time': '09:00',
      'mp-close_days_before': '1',
      'mp-close_time': '18:00',
      'mp-allow_advance': true,
      'mp-catalog-override': true,
      'mp-catalog-dates': '2026-10-20',
      'mp-ex-date': '2026-10-20',
      'mp-ex-paused': true,
      'mp-ex-capacity-mode': 'unlimited'
    });
    await f.page.click('#mp-ex-add');
    assert.equal(f.writes.length, 0);
    await f.page.click('#mp-preview');
    await f.page.waitForFunction(() => document.querySelector('#mp-preview-result').textContent.includes(
      'Visible ahora'));
    assert.match(await f.page.$eval('#mp-preview-result', e => e.textContent), /guardad/);
    assert.equal(f.writes.length, 0);
    await f.page.click('#btnSaveProducto');
    await f.page.waitForFunction(() => !document.querySelector('#modal').classList.contains('open'));
    assert.equal(f.writes.length, 1);
    const body = f.writes[0].body;
    assert.equal(body.nombre, 'Menú');
    assert.equal(body.disponibilidad_config.daily_capacity, 0);
    assert.deepEqual(body.disponibilidad_config.dates, ['2026-10-20', '2026-10-21']);
    assert.equal(Object.hasOwn(body.disponibilidad_config.channels.catalog, 'mode'), false);
    assert.deepEqual(normalizeProductAvailabilityConfig(body.disponibilidad_config), body
      .disponibilidad_config);
    assert.deepEqual(body.disponibilidad_config.exceptions, [{
      date: '2026-10-20',
      paused: true,
      capacity: null
    }]);
    assert.deepEqual(f.errors, []);
  });
test('empresa guarda menú separado sin sobrescribir datos generales y descarta respuestas tardías',
  async t => {
    const f = await fixture(t, {
      role: 'super',
      delay: 250
    });
    await f.page.goto(f.base + '/pedidos/inicio/empresa.html');
    await f.page.waitForSelector('[data-action="edit"][data-id="1"]');
    await f.page.click('[data-action="edit"][data-id="1"]');
    await f.page.waitForSelector('#mc-timezone');
    await f.page.click('#btnCancelModal');
    await f.page.click('[data-action="edit"][data-id="2"]');
    await f.page.waitForFunction(() => !document.querySelector('#menu-company-fields').disabled);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await f.page.$eval('#mc-timezone', e => e.value), 'America/Montevideo');
    assert.equal(f.writes.length, 0);
    await values(f.page, {
      'mc-enabled': true,
      'mc-advance_enabled': true,
      'mc-max_advance_days': '14',
      'mc-closed_dates': '2026-12-25'
    });
    await f.page.click('#mc-save');
    await f.page.waitForFunction(() => document.querySelector('#menu-company-status').textContent
      .includes('guardado'));
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].url, /empresa_id=2/);
    assert.equal(f.writes[0].body.max_advance_days, 14);
    assert.equal(f.writes[0].body.timezone, 'America/Montevideo');
    assert.equal(Object.hasOwn(f.writes[0].body, 'config_operativa'), false);
    assert.equal(await f.page.$eval('#e_nombre', e => e.value), 'Dos');
    assert.deepEqual(f.errors, []);
  });
for (const viewport of [{
    width: 375,
    height: 667
  }, {
    width: 1280,
    height: 900
  }])
  for (const screen of ['producto', 'empresa']) test(
    `${screen}: diálogo accesible y controles dentro del viewport ${viewport.width}`, async t => {
      const f = await fixture(t);
      await f.page.setViewport(viewport);
      await f.page.goto(f.base + `/pedidos/inicio/${screen}.html`);
      await f.page.waitForSelector('[data-action="edit"]');
      await f.page.click('[data-action="edit"]');
      assert.equal(await f.page.$eval('#modal .modal', e => e.getAttribute('role')), 'dialog');
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const selector of ['#btnCloseModalTop', screen === 'producto' ? '#btnSaveProducto' :
          '#btnSaveEmpresa'
        ]) assert.equal(await f.page.$eval(selector, e => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      }), true);
      await f.page.waitForFunction(screen => !document.querySelector(screen === 'producto' ?
        '#menu-product-fields' : '#menu-company-fields').disabled, {}, screen);
      const menuAction = screen === 'producto' ? '#mp-preview' : '#mc-save';
      await f.page.$eval(menuAction, e => e.scrollIntoView({
        block: 'center'
      }));
      await f.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(
      r))));
      assert.equal(await f.page.$eval(menuAction, e => {
        const r = e.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }), true);
      await f.page.evaluate(() => Promise.allSettled(document.querySelector('#modal').getAnimations({
        subtree: true
      }).map(a => a.finished)));
      assert.equal(await f.page.$eval('#modal', e => getComputedStyle(e).opacity), '1');
      if (process.env.MENU_UI_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MENU_UI_SCREENSHOT_DIR, {
          recursive: true
        });
        await f.page.screenshot({
          path: path.join(process.env.MENU_UI_SCREENSHOT_DIR, `${screen}-${viewport.width}.png`)
        });
      }
      await f.page.keyboard.press('Escape');
      await f.page.waitForFunction(() => !document.querySelector('#modal').classList.contains('open'));
      assert.equal(f.writes.length, 0);
      assert.deepEqual(f.errors, []);
    });
test('super: cambio de empresa retira productos anteriores mientras carga el nuevo tenant', async t => {
  const f = await fixture(t, {
    role: 'super',
    productDelay: 400
  });
  await f.page.goto(f.base + '/pedidos/inicio/producto.html');
  await f.page.waitForSelector('#empSel option[value="1"]');
  await f.page.select('#empSel', '1');
  await f.page.waitForSelector('[data-action="edit"]');
  await f.page.select('#empSel', '2');
  assert.equal(await f.page.$('[data-action="edit"]'), null);
  assert.equal(f.writes.length, 0);
});
test('guardar producto no cierra una edición nueva cuando llega la respuesta anterior', async t => {
  const f = await fixture(t, {
    saveDelay: 350
  });
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  await f.page.click('#btnSaveProducto');
  await f.page.waitForFunction(() => document.querySelector('#btnSaveProducto').disabled);
  await f.page.click('#btnCancelModal');
  await f.page.click('[data-action="edit"]');
  await new Promise(r => setTimeout(r, 450));
  assert.equal(await f.page.$eval('#modal', e => e.classList.contains('open')), true);
  assert.equal(f.writes.length, 1);
});
test('Empresa: respuesta de guardado anterior no verifica ni reemplaza otra empresa abierta', async t => {
 const f=await fixture(t,{role:'super',saveDelay:300});await f.page.goto(f.base+'/pedidos/inicio/empresa.html');await f.page.waitForSelector('[data-action="edit"][data-id="1"]');await f.page.click('[data-action="edit"][data-id="1"]');await f.page.waitForFunction(()=>!document.querySelector('#menu-company-fields').disabled);await values(f.page,{'mc-max_advance_days':'19'});await f.page.click('#mc-save');await f.page.waitForFunction(()=>document.querySelector('#menu-company-fields').disabled);await f.page.click('#btnCancelModal');await f.page.click('[data-action="edit"][data-id="2"]');await f.page.waitForFunction(()=>!document.querySelector('#menu-company-fields').disabled);await new Promise(r=>setTimeout(r,400));assert.equal(await f.page.$eval('#mc-timezone',e=>e.value),'America/Montevideo');assert.equal(await f.page.$eval('#mc-max_advance_days',e=>e.value),'7');assert.doesNotMatch(await f.page.$eval('#menu-company-status',e=>e.textContent),/guardado y verificado/);assert.equal(f.writes.length,1);assert.match(f.writes[0].url,/empresa_id=1/);assert.equal(f.writes[0].body.max_advance_days,19);assert.deepEqual(f.errors,[]);
});

test('Enter dentro del menú Empresa no guarda el formulario general', async t => {
  const f = await fixture(t);
  await f.page.goto(f.base + '/pedidos/inicio/empresa.html');
  await f.page.waitForSelector('[data-action="edit"]');
  await f.page.click('[data-action="edit"]');
  await f.page.waitForFunction(() => !document.querySelector('#menu-company-fields').disabled);
  await f.page.focus('#mc-timezone');
  await f.page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.writes.length, 0);
});
async function openProduct(f) {
  await f.page.goto(f.base + '/pedidos/inicio/producto.html');
  await f.page.waitForSelector('[data-action="edit"]');
  await f.page.click('[data-action="edit"]');
}
test('feature apagada informa activación pendiente y conserva controles manuales sin escribir', async t => {
  const f = await fixture(t, {
    enabled: false
  });
  await openProduct(f);
  await f.page.waitForSelector('#menu-product-status');
  await f.page.waitForFunction(() => document.querySelector('#menu-product-status').textContent
    .includes('activación'));
  assert.equal(await f.page.$eval('#menu-product-fields', e => e.disabled), true);
  assert.equal(await f.page.$eval('#p_catalogo', e => e.disabled), false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.errors, []);
});


test('guardar cambios manuales con feature apagada omite disponibilidad_config', async t => {
  const f = await fixture(t, {
    enabled: false
  });
  await openProduct(f);
  await f.page.waitForFunction(() => document.querySelector('#menu-product-status').textContent
    .includes('activación'));
  await values(f.page, {
    p_nombre: 'Cambio manual'
  });
  await f.page.click('#btnSaveProducto');
  await f.page.waitForFunction(() => !document.querySelector('#modal').classList.contains('open'));
  assert.equal(f.writes.length, 1);
  assert.equal(Object.hasOwn(f.writes[0].body, 'disponibilidad_config'), false);
  assert.equal(f.writes[0].body.nombre, 'Cambio manual');
});

test('semanal conserva domingo=0, cupo vacío ilimitado y excepción heredada sin capacity', async t => {
  const f = await fixture(t);
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  assert.equal(await f.page.$eval('#mp-weekdays input[value="0"]', e => e.checked), true);
  await values(f.page, {
    'mp-daily_capacity': '',
    'mp-allow_advance': false,
    'mp-ex-date': '2026-10-22',
    'mp-ex-paused': false
  });
  await f.page.click('#mp-ex-add');
  await f.page.click('#btnSaveProducto');
  await f.page.waitForFunction(() => !document.querySelector('#modal').classList.contains('open'));
  const c = f.writes[0].body.disponibilidad_config;
  assert.deepEqual(c.weekdays, [0, 2]);
  assert.equal(c.daily_capacity, null);
  assert.equal(c.allow_advance, false);
  assert.deepEqual(c.exceptions, [{
    date: '2026-10-22',
    paused: false
  }]);
  assert.deepEqual(c.channels, {});
  assert.deepEqual(normalizeProductAvailabilityConfig(c), c);
});

test('pausar por hoy prepara una única excepción y requiere Guardar Producto', async t => {
  const f = await fixture(t);
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  await f.page.click('#mp-pause-today');
  await f.page.click('#mp-pause-today');
  assert.equal(f.writes.length, 0);
  const date = await f.page.$eval('#mp-ex-date', e => e.value);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await f.page.$$eval('#mp-ex-list li', es => es.length), 1);
  await f.page.click('#btnSaveProducto');
  await f.page.waitForFunction(() => !document.querySelector('#modal').classList.contains('open'));
  assert.deepEqual(f.writes[0].body.disponibilidad_config.exceptions, [{
    date,
    paused: true
  }]);
});

test('valida fechas reales y ventana de apertura antes de enviar el producto', async t => {
  const f = await fixture(t);
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  await values(f.page, {
    'mp-mode': 'dates',
    'mp-dates': '2026-02-30'
  });
  await f.page.click('#btnSaveProducto');
  assert.match(await f.page.$eval('#toast', e => e.textContent), /fechas reales/);
  assert.equal(f.writes.length, 0);
  await values(f.page, {
    'mp-dates': '2026-10-20',
    'mp-open_time': '23:00',
    'mp-close_time': '22:00'
  });
  await f.page.click('#btnSaveProducto');
  assert.match(await f.page.$eval('#toast', e => e.textContent), /apertura debe ser anterior/);
  assert.equal(f.writes.length, 0);
});

test('admin Empresa guarda sólo su tenant y valida horizonte y zona IANA', async t => {
  const f = await fixture(t);
  await f.page.goto(f.base + '/pedidos/inicio/empresa.html');
  await f.page.waitForSelector('[data-action="edit"][data-id="1"]');
  assert.equal(await f.page.$('[data-action="edit"][data-id="2"]'), null);
  await f.page.click('[data-action="edit"][data-id="1"]');
  await f.page.waitForFunction(() => !document.querySelector('#menu-company-fields').disabled);
  await values(f.page, {
    'mc-max_advance_days': '31'
  });
  await f.page.click('#mc-save');
  assert.equal(f.writes.length, 0);
  await values(f.page, {
    'mc-max_advance_days': '3',
    'mc-timezone': 'Mars/Test'
  });
  await f.page.click('#mc-save');
  assert.match(await f.page.$eval('#menu-company-status', e => e.textContent), /IANA válida/);
  assert.equal(f.writes.length, 0);
  await values(f.page, {
    'mc-timezone': 'UTC'
  });
  await f.page.click('#mc-save');
  await f.page.waitForFunction(() => document.querySelector('#menu-company-status').textContent
    .includes('verificado'));
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].url, /empresa_id=1/);
});

test('Empresa feature apagada queda bloqueada sin bloquear otros campos', async t => {
  const f = await fixture(t, {
    enabled: false
  });
  await f.page.goto(f.base + '/pedidos/inicio/empresa.html');
  await f.page.waitForSelector('[data-action="edit"]');
  await f.page.click('[data-action="edit"]');
  await f.page.waitForFunction(() => document.querySelector('#menu-company-status').textContent
    .includes('activación'));
  assert.equal(await f.page.$eval('#menu-company-fields', e => e.disabled), true);
  assert.equal(await f.page.$eval('#e_nombre', e => e.disabled), false);
  assert.equal(f.writes.length, 0);
});

for (const [reason, label] of [
    ['MENU_PAUSED', 'Pausado'],
    ['MENU_NOT_OPEN', 'Programado']
  ]) test(`preview estado guardado ${label}`, async t => {
  const f = await fixture(t, {
    previewState: {
      available: false,
      scheduled: true,
      reason,
      remaining: 2
    }
  });
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  await f.page.click('#mp-preview');
  await f.page.waitForFunction(label => document.querySelector('#mp-preview-result').textContent
    .startsWith(label), {}, label);
  assert.equal(f.writes.length, 0);
});

test('preview tardía de una edición cancelada no contamina un editor nuevo', async t => {
  const f = await fixture(t, {
    previewDelay: 250
  });
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  await f.page.click('#mp-preview');
  await f.page.click('#btnCancelModal');
  await f.page.click('#btnNuevoProducto');
  await new Promise(r => setTimeout(r, 350));
  assert.match(await f.page.$eval('#mp-preview-result', e => e.textContent), /Sin consultar/);
  assert.equal(await f.page.$eval('#mp-preview', e => e.disabled), true);
  assert.equal(f.writes.length, 0);
});


test('editar una excepción recupera pausa y cupo para modificarla sin duplicar fechas', async t => {
  const f = await fixture(t);
  await openProduct(f);
  await f.page.waitForFunction(() => !document.querySelector('#menu-product-fields').disabled);
  await values(f.page, {
    'mp-ex-date': '2026-10-22',
    'mp-ex-paused': true,
    'mp-ex-capacity-mode': 'custom',
    'mp-ex-capacity': '0'
  });
  await f.page.click('#mp-ex-add');
  await values(f.page, {
    'mp-ex-date': '2026-10-23',
    'mp-ex-paused': false,
    'mp-ex-capacity-mode': 'inherit'
  });
  await f.page.click('#mp-ex-list [data-edit]');
  assert.equal(await f.page.$eval('#mp-ex-date', e => e.value), '2026-10-22');
  assert.equal(await f.page.$eval('#mp-ex-paused', e => e.checked), true);
  assert.equal(await f.page.$eval('#mp-ex-capacity-mode', e => e.value), 'custom');
  assert.equal(await f.page.$eval('#mp-ex-capacity', e => e.value), '0');
  await values(f.page, {
    'mp-ex-paused': false,
    'mp-ex-capacity': '5'
  });
  await f.page.click('#mp-ex-add');
  assert.equal(await f.page.$$eval('#mp-ex-list li', es => es.length), 1);
  assert.equal(f.writes.length, 0);
});

test('preview pendiente no reemplaza el aviso después de cambiar la fecha seleccionada', async t => {
 const f=await fixture(t,{previewDelay:250});await openProduct(f);await f.page.waitForFunction(()=>!document.querySelector('#menu-product-fields').disabled);await f.page.click('#mp-preview');await values(f.page,{'mp-preview-date':'2026-10-22'});await new Promise(r=>setTimeout(r,350));assert.doesNotMatch(await f.page.$eval('#mp-preview-result',e=>e.textContent),/Visible ahora/);assert.equal(f.writes.length,0);
});

test('Empresa rechaza alias de zona no IANA antes de persistir', async t => {
  const f = await fixture(t);
  await f.page.goto(f.base + '/pedidos/inicio/empresa.html');
  await f.page.waitForSelector('[data-action="edit"]');
  await f.page.click('[data-action="edit"]');
  await f.page.waitForFunction(() => !document.querySelector('#menu-company-fields').disabled);
  await values(f.page, {
    'mc-timezone': 'EST'
  });
  await f.page.click('#mc-save');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.writes.length, 0);
  assert.match(await f.page.$eval('#menu-company-status', e => e.textContent), /IANA válida/);
});
