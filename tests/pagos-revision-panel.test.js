import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

function syntheticPdf() {
  const stream = 'BT /F1 18 Tf 30 700 Td (SYNTHETIC RECEIPT - TEST ONLY - NO VALUE) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test('review list exposes distinct receipt/order amounts with tenant-safe order join', () => {
  const source = fs.readFileSync('src/routes/transferencias.js', 'utf8');
  const list = source.slice(source.indexOf("router.get('/',"), source.indexOf("router.get('/sin-comprobante'"));
  assert.match(list, /ct\.monto AS monto_comprobante/);
  assert.match(list, /p\.monto AS monto_pedido/);
  assert.match(list, /p\.metodo_pago AS pedido_metodo_pago/);
  assert.match(list, /p\.id = ct\.pedido_id AND p\.empresa_id = ct\.empresa_id/);
});

test('payment review is one receipt panel, uses tenant account options and never requests WhatsApp', async () => {
  assert.equal(fs.readFileSync('pedidos/pagos.html', 'utf8').includes('id="revisionCuenta"'), true, 'Unified review must expose a bank-account selector');
  const app = express(); app.use(express.json());
  const user = { id: 1, uid: 1, role: 'super', empresa_id: null };
  const rows = [
    { id: 1, empresa_id: 7, pedido_id: 501, cliente: 'Cliente sintético', monto: 3000, monto_comprobante: 3000, monto_pedido: 3000, pedido_metodo_pago: 'transferencia', metodo_pago: 'transferencia', estado_revision: 'pendiente', comprobante_path: '/Transferencia/prueba.svg', fecha: new Date().toISOString() },
    { id: 2, empresa_id: 8, pedido_id: 502, cliente: 'Otra empresa sintética', monto: 4000, monto_comprobante: 4000, monto_pedido: 4000, pedido_metodo_pago: 'transferencia', metodo_pago: 'transferencia', estado_revision: 'pendiente', comprobante_path: '/Transferencia/prueba.pdf', fecha: new Date().toISOString() },
    { id: 3, empresa_id: 7, pedido_id: 503, cliente: 'Diferencia sintética', monto: 2000, monto_comprobante: 2000, monto_pedido: 3000, pedido_metodo_pago: 'transferencia', metodo_pago: 'transferencia', estado_revision: 'pendiente', fecha: new Date().toISOString() },
  ];
  const accounts = [{ id: 11, empresa_id: 7, banco: 'Banco de prueba', alias: 'PRUEBA.SIETE', titular: 'Empresa sintética' }, { id: 22, empresa_id: 8, banco: 'Otro banco de prueba', alias: 'PRUEBA.OCHO' }];
  const writes = [], accountReads = []; let mode = 'ok', release;
  app.get('/api/me', (_req, res) => res.json({ user }));
  app.get('/api/empresas', (_req, res) => res.json([{ id: 7, nombre: 'Empresa 7' }, { id: 8, nombre: 'Empresa 8' }]));
  app.get('/api/choferes', (_req, res) => res.json([]));
  app.get('/api/transferencias/cuentas-bancarias', (req, res) => { accountReads.push(req.query.empresa_id || 'all'); res.json(accounts); }); // deliberate mixed response: panel must tenant-filter
  app.get('/api/transferencias', (_req, res) => res.json(rows));
  app.get('/api/transferencias/sin-comprobante', (_req, res) => res.json([]));
  app.get('/api/admin/qr/pagos', (_req, res) => res.json([]));
  app.post('/api/transferencias/:id/verificar', async (req, res) => {
    writes.push({ id: req.params.id, query: req.query, body: req.body });
    if (mode === 'hold') await new Promise(r => { release = r; });
    if (mode === 'conflict') return res.status(409).json({ ok: false, needsReview: true, reason: 'operacion_duplicada' });
    if (mode === 'unknown') return res.status(503).json({ code: 'TRANSACTION_OUTCOME_UNKNOWN', status: 'outcome_unknown' });
    Object.assign(rows.find(row => row.id === Number(req.params.id)), req.body, { validado: 1, verified_reason: req.body.reason, verified_at: new Date().toISOString(), verified_by_username: 'Admin de prueba' }); res.json({ ok: true });
  });
  app.get('/Transferencia/prueba.svg', (_req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="700"><rect width="600" height="700" fill="#fff"/><text x="40" y="80" font-size="26">COMPROBANTE SINTÉTICO</text><text x="40" y="130" font-size="22">SIN VALOR · SOLO PRUEBAS</text><text x="40" y="230" font-size="36">$ 3.000</text></svg>'));
  app.get('/Transferencia/prueba.pdf', (_req, res) => res.type('application/pdf').send(syntheticPdf()));
  app.use('/pedidos', express.static(path.resolve('pedidos')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage(); const errors = [], prompts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async d => { prompts.push(d.message()); await d.dismiss(); });
    await page.setViewport({ width: 1200, height: 900 });
    await page.setRequestInterception(true); page.on('request', r => {
      const url = new URL(r.url());
      return url.hostname === '127.0.0.1' || ['chrome-extension:', 'chrome:', 'data:', 'blob:', 'about:'].includes(url.protocol) ? r.continue() : r.abort();
    });
    const url = `http://127.0.0.1:${server.address().port}/pedidos/pagos.html`;
    const load = async () => { await page.goto(url, { waitUntil: 'networkidle0' }); await page.waitForFunction(() => currentRows.length === 3); };
    await load(); await page.select('#fEmpresa', '8'); await page.select('#fCuenta', '22');
    await page.waitForFunction(() => currentRows.length === 3);
    await page.evaluate(() => verificarPago(1));
    await page.waitForSelector('#revisionCuenta');
    assert.equal(await page.$eval('#modalVisor', n => n.open), true);
    assert.match(await page.$eval('#revisionMontoPedido', n => n.textContent), /3[.,]000/);
    assert.equal(await page.$eval('#visorContainer img', n => n.complete && n.naturalWidth > 0), true);
    assert.deepEqual(await page.$eval('#revisionCuenta', n => Array.from(n.options).filter(o => o.value).map(o => o.value)), ['11']);
    assert.equal(await page.$eval('#fCuenta', n => n.value), '22', 'Review must not rewrite table filters');
    assert.ok(accountReads.includes('7'));
    assert.equal(writes.length, 0, 'Opening never approves');
    assert.equal(await page.$eval('#btnVerificarModal', n => n.disabled), true);
    await page.type('#revisionOperacion', 'TEST-OP-501'); await page.select('#revisionCuenta', '11');
    await page.$eval('#revisionMotivo', n => { n.value = ''; });
    await page.type('#revisionMotivo', 'Confirmado en banco de prueba'); await page.click('#revisionConfirmo');
    await page.screenshot({ path: path.join(process.env.TMPDIR, 'pagos-revision-desktop.png') });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => { document.querySelector('.revision-grid').scrollTop = 0; });
    assert.equal(await page.$$eval('.revision-footer button', buttons => buttons.every(b => b.getBoundingClientRect().bottom <= innerHeight)), true);
    await page.screenshot({ path: path.join(process.env.TMPDIR, 'pagos-revision-mobile.png') });
    await page.setViewport({ width: 1200, height: 900 });
    mode = 'hold';
    await page.click('#btnVerificarModal');
    await page.waitForFunction(() => document.querySelector('#btnVerificarModal').disabled);
    await page.evaluate(() => document.querySelector('#revisionForm').dispatchEvent(new Event('submit', { cancelable: true })));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].query.enviarAviso, '0'); assert.equal(writes[0].body.empresa_id, 7);
    assert.equal(writes[0].body.cuenta_bancaria_id, 11); assert.equal(writes[0].body.nro_operacion, 'TEST-OP-501');
    release(); mode = 'ok'; await page.waitForFunction(() => !document.querySelector('#modalVisor').open);
    assert.deepEqual(prompts, []);
    await page.evaluate(() => verificarPago(3));
    assert.match(await page.$eval('#revisionEstado', n => n.textContent), /no coincid|diferencia/i);
    assert.equal(await page.$eval('#btnVerificarModal', n => n.disabled), true);
    await page.evaluate(() => closeModal());
    mode = 'conflict'; await page.evaluate(() => verificarPago(2));
    assert.ok(await page.$('#visorContainer iframe'));
    const pdfViewer = await page.waitForFrame(frame => frame.url().startsWith('chrome-extension://'), { timeout: 5000 });
    await pdfViewer.waitForSelector('pdf-viewer >>> embed', { timeout: 5000 });
    await pdfViewer.waitForFunction(() => { const v = document.querySelector('pdf-viewer'); return v?.initialLoadComplete_ && v.loadState_ === 'success'; }, { timeout: 5000 });
    await page.type('#revisionOperacion', 'TEST-OP-502'); await page.select('#revisionCuenta', '22'); await page.click('#revisionConfirmo');
    await page.click('#btnVerificarModal');
    await page.waitForFunction(() => document.querySelector('#revisionError').textContent.includes('operación'));
    assert.doesNotMatch(await page.$eval('#revisionError', n => n.textContent), /monto no coincide/i);
    mode = 'unknown'; await page.click('#btnVerificarModal');
    await page.waitForFunction(() => document.querySelector('#revisionError').textContent.includes('conciliación'));
    const count = writes.length;
    assert.equal(await page.$eval('#btnVerificarModal', n => n.disabled), true);
    await page.evaluate(() => closeModal()); await page.evaluate(() => verificarPago(2));
    assert.equal(await page.$eval('#btnVerificarModal', n => n.disabled), true);
    assert.equal(writes.length, count);
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.$eval('#modalVisor', n => n.getBoundingClientRect().width <= innerWidth), true);
    await page.screenshot({ path: path.join(process.env.TMPDIR, 'pagos-revision-resultado-incierto-mobile.png') });
    await page.evaluate(() => closeModal()); await page.evaluate(() => verificarPago(1));
    assert.equal(await page.$eval('#btnVerificarModal', n => n.hidden), true, 'Already validated is view-only');
    assert.equal(await page.$eval('#btnVerificarModal', n => getComputedStyle(n).display), 'none', 'Read-only action must actually be hidden, not only carry hidden attribute');
    await page.setViewport({ width: 1200, height: 900 });
    await page.screenshot({ path: path.join(process.env.TMPDIR, 'pagos-revision-consulta.png') });
    user.role = 'admin'; user.empresa_id = 7; rows[0].validado = 0;
    await load(); await page.evaluate(() => verificarPago(1));
    assert.equal(await page.$eval('#revisionOperacion', n => n.readOnly), true);
    assert.equal(await page.$eval('#revisionCuenta', n => n.disabled), true);
    mode = 'ok'; await page.click('#revisionConfirmo'); await page.click('#btnVerificarModal');
    await page.waitForFunction(() => !document.querySelector('#modalVisor').open);
    assert.equal(Object.hasOwn(writes.at(-1).body, 'empresa_id'), false, 'Admin uses server tenant, not an override');
    await page.waitForFunction(() => currentRows.length === 3);
    await page.evaluate(() => verificarPago(2));
    assert.equal(await page.$eval('#btnVerificarModal', n => n.hidden), true, 'Admin cannot approve a different company');
    assert.equal(writes.every(write => write.query.enviarAviso === '0'), true);
    assert.deepEqual(errors, []); assert.deepEqual(prompts, []);
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
