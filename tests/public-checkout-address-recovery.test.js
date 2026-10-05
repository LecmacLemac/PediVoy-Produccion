import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import puppeteer from 'puppeteer';

const root = path.resolve(new URL('..', import.meta.url).pathname);

async function serve(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function checkoutApp(requests, { orderGate = null, pedido = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.get('/public/config', (_req, res) => res.json({
    empresa_id: 1,
    nombre: 'Demo',
    landing_slug: 'demo',
    provincia: 'Santa Fe',
    pais: 'Argentina',
  }));
  app.get('/public/productos', (_req, res) => res.json([{ id: 11, nombre: 'Bidón', precio: 100 }]));
  app.post('/public/contacto', async (req, res) => {
    requests.push({ kind: 'contacto', query: req.query, body: req.body });
    if (String(req.body.telefono).endsWith('3531234567')) {
      return res.json({
        ok: true,
        found: true,
        contacto: {
          id: 41,
          cliente: 'Ana P.',
          direccion: 'Bv. San Martín 123',
          ciudad: 'Villa María',
          provincia: 'Córdoba',
          pais: 'Argentina',
          notas: 'Departamento 4 B',
        },
      });
    }
    if (String(req.body.telefono).endsWith('3537654321')) {
      await new Promise(resolve => setTimeout(resolve, 250));
      return res.json({
        ok: true,
        found: true,
        contacto: {
          id: 42,
          cliente: 'Beto G.',
          direccion: 'Calle Nueva 456',
          ciudad: 'Córdoba',
          provincia: 'Córdoba',
          pais: 'Argentina',
          notas: 'Piso 2',
        },
      });
    }
    return res.json({ ok: true, found: false });
  });
  app.post('/public/pedidos', async (req, res) => {
    requests.push({ kind: 'pedido', body: req.body });
    if (orderGate) await orderGate;
    res.json({ ok: true, pedido });
  });
  app.use('/pedidos', express.static(path.join(root, 'pedidos')));
  return app;
}

async function installGeolocationProbe(page) {
  await page.evaluateOnNewDocument(() => {
    window.__geoCalls = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.__geoCalls += 1;
          success({ coords: { latitude: -32.41, longitude: -63.24 } });
        },
      },
    });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('envío pendiente y éxito bloquean desktop, mobile y un segundo pedido antes de redirigir', async () => {
  const requests = [];
  const gate = deferred();
  await serve(checkoutApp(requests, { orderGate: gate.promise, pedido: { id: 77 } }), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('button[data-action="add-to-cart"]');
      await page.click('button[data-action="add-to-cart"]');
      await page.type('[name="telefono"]', '3531234567');
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      await page.$eval('#form', form => form.requestSubmit());
      await page.waitForFunction(() => document.querySelector('#form button[type="submit"]').textContent.includes('Enviando'));
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.equal(requests.filter(item => item.kind === 'pedido').length, 1);
      assert.deepEqual(await page.evaluate(() => ({
        desktop: document.querySelector('#form button[type="submit"]').disabled,
        mobile: document.querySelector('#mobSubmit').disabled,
      })), { desktop: true, mobile: true });

      await page.$eval('#mobSubmit', button => button.click());
      await page.$eval('#form button[type="submit"]', button => button.click());
      await page.$eval('#form', form => form.requestSubmit());
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(requests.filter(item => item.kind === 'pedido').length, 1);

      gate.resolve();
      await page.waitForFunction(() => document.querySelector('#toastMsg').textContent.includes('éxito'));
      await page.$eval('#mobSubmit', button => button.click());
      await page.$eval('#form button[type="submit"]', button => button.click());
      await page.$eval('#form', form => form.requestSubmit());
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(requests.filter(item => item.kind === 'pedido').length, 1);
    } finally {
      gate.resolve();
      await browser.close();
    }
  });
});

test('checkout no pregunta pago ni promete coordinación; muestra descuento antes de confirmar', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('[name="telefono"]:not([disabled])');

      assert.match(await page.$eval('#cart', el => el.textContent), /Elegí tus productos/);
      assert.equal(await page.$$eval('[name="metodo_pago"]', els => els.length), 0);
      assert.equal(await page.$('#deliveryPromise'), null);
      assert.equal(await page.$eval('#form', form => {
        const discount = form.elements.codigo_referente.closest('label');
        const submit = form.querySelector('button[type="submit"]');
        return Boolean(discount.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), true);
      assert.equal(await page.$eval('#form button[type="submit"]', el => el.disabled), true);
      assert.equal(await page.$eval('#mobSubmit', el => el.disabled), true);
    } finally {
      await browser.close();
    }
  });
});

test('checkout habilita confirmar con carrito y entrega válidos, muestra total y no fija el pago', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('button[data-action="add-to-cart"]');
      await page.click('button[data-action="add-to-cart"]');
      assert.equal(await page.$eval('#form button[type="submit"]', el => el.disabled), true);

      await page.type('[name="telefono"]', '3531234567');
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      assert.equal(await page.$eval('#form button[type="submit"]', el => el.disabled), false);
      assert.equal(await page.$eval('#mobSubmit', el => el.disabled), false);
      assert.match(await page.$eval('#form button[type="submit"]', el => el.textContent), /\$\s*100/);
      assert.match(await page.$eval('#mobSubmit', el => el.textContent), /\$\s*100/);

      await page.$eval('#form', form => form.requestSubmit());
      await new Promise(resolve => setTimeout(resolve, 250));
      const order = requests.find(item => item.kind === 'pedido');
      assert.ok(order);
      assert.equal(Object.hasOwn(order.body, 'metodo_pago'), false);
    } finally {
      await browser.close();
    }
  });
});

test('checkout teléfono primero recupera y acepta la última dirección sin GPS ni coordenadas del navegador', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await installGeolocationProbe(page);
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('button[data-action="add-to-cart"]');

      assert.equal(await page.$eval('#deliveryFields', el => el.hidden), true);
      assert.equal(await page.$eval('textarea[name="notas"]', el => Boolean(el.offsetParent)), true);
      assert.equal(await page.$eval('#form', form => {
        const notes = form.elements.notas.closest('label');
        const submit = form.querySelector('button[type="submit"]');
        return Boolean(notes && submit && (notes.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING));
      }), true);
      await page.type('[name="telefono"]', '3531234567');
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      assert.equal(requests.filter(item => item.kind === 'contacto').length, 1);
      assert.match(await page.$eval('#addressHistoryCard', el => el.textContent), /Ana P\.[\s\S]*Bv\. San Martín 123[\s\S]*Villa María/);
      assert.equal(await page.$('#useSavedAddress'), null);
      assert.equal(await page.$eval('#changeSavedAddress', el => el.textContent.trim()), 'Cambiar dirección');
      assert.equal(await page.$eval('textarea[name="notas"]', el => el.value), 'Departamento 4 B');
      assert.equal(await page.evaluate(() => window.__geoCalls), 0);

      await page.click('button[data-action="add-to-cart"]');
      await page.$eval('textarea[name="notas"]', el => { el.value = 'Departamento 4 B, tocar timbre'; });
      await page.$eval('#form', form => form.requestSubmit());
      await new Promise(resolve => setTimeout(resolve, 250));

      const order = requests.find(item => item.kind === 'pedido');
      assert.ok(order, JSON.stringify(await page.$eval('#form', form => ({
        valid: form.checkValidity(),
        invalid: [...form.elements].filter(element => typeof element.checkValidity === 'function' && !element.checkValidity()).map(element => element.name || element.id),
      }))));
      assert.equal(order.body.punto_entrega_id, 41);
      assert.equal(order.body.direccion, 'Bv. San Martín 123');
      assert.equal(order.body.cliente, 'Ana P.');
      assert.equal(Object.hasOwn(order.body, 'latitud'), false);
      assert.equal(Object.hasOwn(order.body, 'longitud'), false);
      assert.equal(order.body.notas, 'Departamento 4 B, tocar timbre');
      assert.equal(await page.evaluate(() => window.__geoCalls), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), true);
    } finally {
      await browser.close();
    }
  });
});

test('normaliza formatos argentinos sin truncar el teléfono equivocado', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('[name="telefono"]:not([disabled])');
      for (const raw of ['3531234567', '03531234567', '+54 9 353 123-4567', '5493531234567', '543531234567']) {
        const before = requests.filter(item => item.kind === 'contacto').length;
        await page.$eval('[name="telefono"]', (input, value) => {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, raw);
        await page.waitForFunction(
          () => document.querySelector('#phoneLookupStatus').textContent !== 'Buscando tu última dirección…',
        );
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(requests.filter(item => item.kind === 'contacto').length, before + 1, raw);
        const latest = requests.filter(item => item.kind === 'contacto').at(-1);
        assert.ok(latest, raw);
        assert.equal(latest.body.telefono, '5493531234567', raw);
      }
    } finally {
      await browser.close();
    }
  });
});

test('cambiar dirección limpia punto y coordenadas; GPS sólo se activa con acción explícita', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await installGeolocationProbe(page);
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('[name="telefono"]:not([disabled])');
      await page.type('[name="telefono"]', '3531234567');
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      assert.equal(await page.$eval('#form', form => form.elements.punto_entrega_id.value), '41');
      assert.equal(await page.$eval('#form', form => form.elements.notas.value), 'Departamento 4 B');
      assert.equal(await page.evaluate(() => window.__geoCalls), 0);

      await page.$eval('[name="telefono"]', input => {
        input.value = '353123456';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.deepEqual(await page.$eval('#form', form => ({
        point: form.elements.punto_entrega_id.value,
        notes: form.elements.notas.value,
        address: form.elements.direccion.value,
        recoveredVisible: !document.querySelector('#addressHistoryCard').hidden,
      })), {
        point: '',
        notes: '',
        address: '',
        recoveredVisible: false,
      });

      await page.$eval('[name="telefono"]', input => {
        input.value = '3531234567';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      await page.$eval('#changeSavedAddress', button => button.click());
      const state = await page.$eval('#form', form => ({
        point: form.elements.punto_entrega_id.value,
        lat: form.elements.latitud.value,
        lng: form.elements.longitud.value,
        address: form.elements.direccion.value,
        city: form.elements.ciudad.value,
        customer: form.elements.cliente.value,
        province: form.elements.provincia.value,
        country: form.elements.pais.value,
        notes: form.elements.notas.value,
        addressReadOnly: form.elements.direccion.readOnly,
      }));
      assert.deepEqual(state, {
        point: '',
        lat: '',
        lng: '',
        address: '',
        city: '',
        customer: '',
        province: 'Santa Fe',
        country: 'Argentina',
        notes: '',
        addressReadOnly: false,
      });
      assert.equal(await page.evaluate(() => window.__geoCalls), 0);

      await page.$eval('#useGpsLocation', button => button.click());
      await page.waitForFunction(() => window.__geoCalls === 1);
      assert.deepEqual(await page.$eval('#form', form => ({ lat: form.elements.latitud.value, lng: form.elements.longitud.value })), {
        lat: '-32.41',
        lng: '-63.24',
      });
    } finally {
      await browser.close();
    }
  });
});

async function installDelayedGeolocationProbe(page) {
  await page.evaluateOnNewDocument(() => {
    window.__geoCalls = 0;
    window.__resolveGeo = null;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.__geoCalls += 1;
          window.__resolveGeo = () => success({ coords: { latitude: -32.41, longitude: -63.24 } });
        },
      },
    });
  });
}

test('GPS demorado no escribe coordenadas después de cambiar teléfono y dirección', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await installDelayedGeolocationProbe(page);
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('[name="telefono"]:not([disabled])');
      await page.type('[name="telefono"]', '3530000000');
      await page.waitForSelector('#deliveryFields:not([hidden])');
      await page.click('#useGpsLocation');
      await page.waitForFunction(() => window.__geoCalls === 1 && typeof window.__resolveGeo === 'function');

      await page.$eval('[name="telefono"]', input => {
        input.value = '3531234567';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      await page.click('#changeSavedAddress');
      await page.type('[name="direccion"]', 'Nueva dirección 789');
      await page.evaluate(() => window.__resolveGeo());
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.deepEqual(await page.$eval('#form', form => ({
        lat: form.elements.latitud.value,
        lng: form.elements.longitud.value,
        address: form.elements.direccion.value,
      })), {
        lat: '',
        lng: '',
        address: 'Nueva dirección 789',
      });
    } finally {
      await browser.close();
    }
  });
});

test('GPS demorado no revive coordenadas si teléfono y dirección vuelven a sus valores originales', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await installDelayedGeolocationProbe(page);
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('[name="telefono"]:not([disabled])');
      await page.type('[name="telefono"]', '3530000000');
      await page.waitForSelector('#deliveryFields:not([hidden])');
      await page.type('[name="direccion"]', 'Dirección original 123');
      await page.click('#useGpsLocation');
      await page.waitForFunction(() => window.__geoCalls === 1 && typeof window.__resolveGeo === 'function');

      await page.$eval('[name="telefono"]', input => {
        input.value = '3531234567';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector('#addressHistoryCard:not([hidden])');
      await page.$eval('[name="telefono"]', input => {
        input.value = '3530000000';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector('#deliveryFields:not([hidden])');
      await page.type('[name="direccion"]', 'Dirección original 123');
      await page.evaluate(() => window.__resolveGeo());
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.deepEqual(await page.$eval('#form', form => ({
        lat: form.elements.latitud.value,
        lng: form.elements.longitud.value,
        phone: form.elements.telefono.value,
        address: form.elements.direccion.value,
      })), {
        lat: '',
        lng: '',
        phone: '3530000000',
        address: 'Dirección original 123',
      });
    } finally {
      await browser.close();
    }
  });
});

test('cambiar a otro teléfono válido limpia la dirección anterior antes de resolver el nuevo lookup', async () => {
  const requests = [];
  await serve(checkoutApp(requests), async base => {
    const browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/pedidos/?empresa_id=1`);
      await page.waitForSelector('[name="telefono"]:not([disabled])');
      await page.click('button[data-action="add-to-cart"]');
      await page.type('[name="telefono"]', '3531234567');
      await page.waitForSelector('#addressHistoryCard:not([hidden])');

      await page.$eval('[name="telefono"]', input => {
        input.value = '3537654321';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.deepEqual(await page.$eval('#form', form => ({
        point: form.elements.punto_entrega_id.value,
        customer: form.elements.cliente.value,
        address: form.elements.direccion.value,
        city: form.elements.ciudad.value,
        notes: form.elements.notas.value,
        addressReadOnly: form.elements.direccion.readOnly,
      })), {
        point: '',
        customer: '',
        address: '',
        city: '',
        notes: '',
        addressReadOnly: false,
      });

      await page.$eval('#form', form => form.requestSubmit());
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(requests.filter(item => item.kind === 'pedido').length, 0);

      await page.waitForFunction(() => document.querySelector('#form').elements.punto_entrega_id.value === '42');
      assert.deepEqual(await page.$eval('#form', form => ({
        point: form.elements.punto_entrega_id.value,
        address: form.elements.direccion.value,
        notes: form.elements.notas.value,
      })), {
        point: '42',
        address: 'Calle Nueva 456',
        notes: 'Piso 2',
      });
    } finally {
      await browser.close();
    }
  });
});
