import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import express from 'express';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { registerLandingRoutes } from '../src/routes/landingRoutes.js';

test('browser: product XSS, safe images, selected-company preview and opaque sandbox', async () => {
  const app = express();
  const payload = '<img src=x onerror="window.pwned=true">';
  app.get('/api/public/productos', (_req, res) => res.json([{ id: "1');window.pwned=true;//", nombre: payload, descripcion: payload, etiqueta: payload, imagen: 'javascript:alert(1)', precio: 100 }]));
  app.get('/public/config', (req, res) => res.json({ empresa_id: req.query.slug === 'selected' ? 7 : 8, nombre: 'Selected tenant', landing_slug: 'selected' }));
  app.get('/public/productos', (_req, res) => res.json([{ id: 42, nombre: 'Selected product', precio: 100 }]));
  registerLandingRoutes(app, { projectDir: path.resolve('.'), query: async (_sql, params) => [{ id: params[0] === 'selected' ? 7 : 8, landing_slug: params[0] === 7 ? 'selected' : 'fuegin' }] });
  app.use(express.static('.'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/pages/empresa_8.html');
    await page.waitForSelector('.product-card');
    const rendered = await page.evaluate(() => ({
      attacked: !!window.pwned,
      name: document.querySelector('.product-info h3').textContent,
      href: document.querySelector('.product-card').href,
      src: document.querySelector('.product-image').src,
      inline: document.querySelectorAll('[onclick], [onerror]').length,
      logo: document.querySelector('img[src="logo.png"]'),
      images: document.querySelectorAll('#productGrid img').length,
    }));
    assert.equal(rendered.attacked, false);
    assert.equal(rendered.name, payload);
    assert.equal(new URL(rendered.href).searchParams.get('add'), "1');window.pwned=true;//");
    assert.match(rendered.src, /^data:image\/svg\+xml,%3Csvg/);
    assert.equal(rendered.inline, 0);
    assert.equal(rendered.logo, null);
    assert.equal(rendered.images, 1);
    await page.goto(base + '/landing/selected?slug=other');
    await page.waitForFunction(() => document.body.textContent.includes('Selected product'));
    assert.equal(await page.evaluate(() => APP.slug), 'selected');
    assert.equal(await page.evaluate(() => APP.empresaId), 7);
    await page.evaluate(() => {
      document.body.innerHTML = '<iframe id="previewFrame" sandbox="allow-scripts"></iframe>';
      window.currentEmpresaId = 7;
      document.cookie = 'previewTest=secret';
    });
    await page.addScriptTag({ url: base + '/pedidos/landing-preview.js' });
    const template = await fs.readFile('pages/landing/landing_multiempresa_pro_v2.html', 'utf8');
    await page.evaluate(html => showLandingPreview(html, { id: 7, landing_slug: 'selected' }), template);
    let frame = page.frames().find(f => f.parentFrame());
    await frame.waitForFunction(() => document.body.textContent.includes('Selected product'));
    assert.equal(await frame.evaluate(() => APP.slug), 'selected');
    assert.equal(await frame.evaluate(() => APP.empresaId), 7);
    const isolation = await frame.evaluate(async () => {
      const result = {};
      for (const [key, read] of [['parent', () => parent.document], ['cookie', () => document.cookie], ['storage', () => localStorage.getItem('token')]]) {
        try { read(); result[key] = false; } catch { result[key] = true; }
      }
      try { await fetch('/api/empresas', { credentials: 'include' }); result.api = false; } catch { result.api = true; }
      return result;
    });
    assert.deepEqual(isolation, { parent: true, cookie: true, storage: true, api: true });
    for (const name of (await fs.readdir('pages/landing')).filter(name => name.startsWith('landing_') && name.endsWith('.html'))) {
      const html = await fs.readFile('pages/landing/' + name, 'utf8');
      await page.evaluate(html => showLandingPreview(html, { id: 7, landing_slug: 'selected' }), html);
      frame = page.frames().find(f => f.parentFrame());
      await frame.waitForFunction(() => document.body.textContent.includes('Selected product'), { timeout: 5000 }).catch(async error => { throw new Error(name + ': ' + await frame.evaluate(() => document.body.innerText), { cause: error }); });
      assert.equal(await frame.evaluate(() => APP.slug), 'selected', name);
      assert.equal(await frame.evaluate(() => Number(APP.empresaId)), 7, name);
    }
    await assert.rejects(page.evaluate(() => showLandingPreview('', { id: 7, landing_slug: 'other' })), /no corresponde/);
    await assert.rejects(page.evaluate(() => showLandingPreview('', { id: 7, landing_slug: '</script>' })), /slug válido/);
    const editor = await fs.readFile('pedidos/iaweb.html', 'utf8');
    assert.match(editor, /sandbox="allow-scripts"/);
    assert.doesNotMatch(editor, /allow-same-origin|srcdoc = (?:generatedHtml|data\.html)/);
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
});
