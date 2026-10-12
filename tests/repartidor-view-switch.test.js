import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import puppeteer from 'puppeteer';

// Real application HTML/scripts; synthetic map and order fixtures, no business API.
test('direct view buttons preserve list scroll, shared filters, map viewport and accessible navigation', async () => {
  const app = express();
  app.get('/pedidos/repartidor.html', (_req,res) => res.type('html').send(fs.readFileSync('pedidos/repartidor.html','utf8').replace('bootRepartidorPanel();','/* isolated UI test: no production boot */')));
  app.use('/pedidos',express.static('pedidos'));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  let browser;
  try {
    browser = await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-setuid-sandbox']});
    const page = await browser.newPage();
    await page.setViewport({width:390,height:844});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/pedidos/repartidor.html`,{waitUntil:'networkidle2'});
    assert.equal(await page.$eval('#sec-pedidos [data-view-target="mapa"]',el=>el.textContent.includes('Mapa')),true);
    assert.equal(await page.$eval('#filtersToggle',el=>el.getAttribute('aria-label')), 'Mostrar u ocultar filtros de pedidos');
    await page.evaluate(()=>{
      window.testMapCalls=[];
      renderMap=async (options={})=>{window.testMapCalls.push(options); map={synthetic:true};};
      resizeRepartidorMap=()=>{};
      operationalStatusFilter='en_ruta'; historicalMode=true;
      document.getElementById('fSearch').value='Prueba';
      document.getElementById('cardsContainer').style.height='2000px';
    });
    await page.click('#filtersToggle');
    const collapsed=await page.$eval('#filtersToggle',el=>el.getAttribute('aria-expanded'));
    await page.evaluate(()=>window.scrollTo(0,450));
    const savedScroll=await page.evaluate(()=>window.scrollY);
    // Keyboard/programmatic activation avoids Playwright/Puppeteer auto-scroll changing the saved point.
    await page.focus('#sec-pedidos [data-view-target="mapa"]');
    await page.evaluate(()=>window.scrollTo(0,450));
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>!document.getElementById('sec-mapa').hidden && document.activeElement.dataset.viewTarget === 'pedidos');
    assert.equal(await page.$eval('.nav-link[data-sec="mapa"]',el=>el.getAttribute('aria-current')),'page');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.viewTarget),'pedidos');
    await page.click('#sec-mapa [data-view-target="pedidos"]');
    await page.waitForFunction(()=>!document.getElementById('sec-pedidos').hidden && Math.abs(window.scrollY-450)<2);
    assert.equal(await page.evaluate(()=>window.scrollY),savedScroll);
    assert.equal(await page.$eval('#fSearch',el=>el.value),'Prueba');
    assert.equal(await page.$eval('#filtersToggle',el=>el.getAttribute('aria-expanded')),collapsed);
    assert.equal(await page.evaluate(()=>historicalMode && operationalStatusFilter==='en_ruta'),true);
    await page.$eval('#sec-pedidos [data-view-target="mapa"]',el=>el.click());
    await page.waitForFunction(()=>window.testMapCalls.length>=2);
    assert.equal(await page.evaluate(()=>window.testMapCalls.at(-1).preserveViewport),true);
    await page.click('#mapSecondaryFilters summary');
    assert.equal(await page.$eval('#mapSecondaryFilters',el=>el.open),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:process.env.TMPDIR+'/repartidor-switch-mobile.png'});
    await page.setViewport({width:1100,height:800});
    await page.click('#sec-mapa [data-view-target="pedidos"]');
    await page.waitForFunction(()=>!document.getElementById('sec-pedidos').hidden && document.activeElement.dataset.viewTarget === 'mapa');
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForFunction(()=>window.scrollY === 0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:process.env.TMPDIR+'/repartidor-switch-desktop.png'});
    assert.deepEqual(errors,[]);
  } finally {
    if(browser)await browser.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
