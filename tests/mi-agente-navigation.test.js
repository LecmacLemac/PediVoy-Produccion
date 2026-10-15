import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const root = new URL('../pedidos/', import.meta.url);
function htmlFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? htmlFiles(file) : entry.name.endsWith('.html') ? [file] : [];
  });
}

test('Mi agente tiene un único acceso opcional desde Configuración Inicial, fuera de los menús', async t => {
  const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  let role = 'admin';
  const writes = [];
  const origin = 'https://synthetic-setup.pedivoy.example';
  const html = fs.readFileSync(new URL('inicio/inicial.html', root), 'utf8');
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') writes.push(url.pathname);
    if (url.origin !== origin) return request.respond({status:200,body:''});
    if (url.pathname === '/pedidos/inicio/inicial.html') return request.respond({status:200,contentType:'text/html',body:html});
    if (url.pathname === '/api/me') return request.respond({status:200,contentType:'application/json',body:JSON.stringify({user:{uid:999,role,empresa_id:999}})});
    if (url.pathname === '/api/setup/progress') return request.respond({status:200,contentType:'application/json',body:JSON.stringify(Object.fromEntries(Array.from({length:10},(_,i)=>[i+1,true])))});
    return request.respond({status:200,contentType:'text/html',body:'<title>Destino sintético Mi agente</title>'});
  });
  for (const currentRole of ['admin','super']) {
    role = currentRole;
    for (const width of [390,1280]) {
      await page.setViewport({width,height:900});
      await page.goto(origin+'/pedidos/inicio/inicial.html');
      const steps = role === 'super' ? 10 : 9;
      await page.waitForFunction(expected => document.getElementById('progressText').textContent === expected, {}, `100% Completado (${steps} de ${steps})`);
      const state = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href="/pedidos/mi-agente.html"]')];
        const card = document.getElementById('personalAgentSetup');
        const link = card?.querySelector('a');
        const rect = link?.getBoundingClientRect();
        return {links:links.length,menuLinks:links.filter(a=>a.closest('nav,header,[role="menu"]')).length,
          title:card?.querySelector('h3')?.textContent,optional:card?.textContent.includes('Opcional'),
          checkButtons:card?.querySelectorAll('[data-action="toggle-step"]').length,
          label:link?.textContent.trim(),visible:!!rect&&rect.width>0&&rect.height>0,
          horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.equal(state.links,1,'Debe existir un único acceso en la página');
      assert.equal(state.menuLinks,0,'No debe aparecer en menús');
      assert.equal(state.title,'Mi agente IA');
      assert.equal(state.optional,true);
      assert.equal(state.checkButtons,0);
      assert.equal(state.label,'Configurar mi agente →');
      assert.equal(state.visible,true);
      assert.equal(state.horizontalOverflow,false);
      await page.$eval('#personalAgentSetup a', a => a.focus());
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>location.pathname==='/pedidos/mi-agente.html');
    }
  }
  assert.deepEqual(writes,[],'Abrir la configuración no debe generar escrituras');
  for (const file of htmlFiles(root.pathname)) {
    if (file === new URL('inicio/inicial.html',root).pathname) continue;
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/<a\b[^>]*href\s*=\s*["'][^"']*mi-agente\.html[^"']*["']/i,`Acceso fuera de Configuración Inicial: ${file}`);
  }
});
