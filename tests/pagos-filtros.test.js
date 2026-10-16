import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import path from 'node:path';

// Real HTML, isolated HTTP APIs and explicitly synthetic business records.
async function fixture(run) {
  const app = express(), reads = [], writes = [], failures = new Set();
  const settings = {counts:[200,1,1],status:503,qrFallback:false,duplicateTail:false};
  const held = [];
  app.use(express.json());
  app.get('/api/me', (_, res) => res.json({user:{id:1,role:'super'}}));
  app.get('/api/empresas', (_, res) => res.json([{id:7,nombre:'Sintética 7'},{id:8,nombre:'Sintética 8'}]));
  app.get('/api/choferes', (_, res) => res.json([{id:3,nombre:'Chofer sintético'}]));
  app.get('/api/transferencias/cuentas-bancarias', async (req,res) => {
    if(req.query.empresa_id === '7') await new Promise(r => setTimeout(r,180));
    res.json([{id:Number(req.query.empresa_id || 8)*10,empresa_id:Number(req.query.empresa_id || 8),banco:'Banco sintético',alias:'TEST'}]);
  });
  const paths=['/api/transferencias','/api/admin/qr/pagos','/api/transferencias/sin-comprobante'];
  paths.forEach((endpoint,index) => app.get(endpoint,async (req,res) => {
    reads.push({endpoint,query:{...req.query}});
    if(req.query.q === 'lenta') await new Promise(r => { held.push(r); });
    if(failures.has(endpoint)) return res.status(settings.status).json({error:'synthetic unavailable'});
    const base={monto:100,metodo_pago:'transferencia',empresa_id:8,cliente:'Página sintética',fecha:'2026-10-14T12:00:00.123456-03:00',cursor_fecha:'2026-10-14T15:00:00.123456Z'};
    if(index===1 && settings.qrFallback){delete base.cursor_fecha;base.settlement_at='2026-10-14T15:00:00.987654Z';}
    if(settings.nullDates) {
      base.fecha=null;delete base.settlement_at;delete base.updated_at;base.created_at=null;
      if(settings.nullCursor) base.cursor_fecha='-infinity';else delete base.cursor_fecha;
      if(req.query.before_id && req.query.before_fecha!=='-infinity') return res.status(400).json({error:'before_fecha inválido'});
    }
    const count=settings.counts[index];
    const first=Array.from({length:count},(_,i)=>({...base,id:500-i,pedido_id:500-i,created_at:base.fecha}));
    // Search really filters the complete source, including clients beyond page one.
    const tail=['Cliente fuera de primera página','lenta','nueva'].map((cliente,i)=>({...base,id:1+i,pedido_id:1+i,cliente,created_at:base.fecha}));
    const all=first.concat(tail);
    if(req.query.q) return res.json(all.filter(row=>row.cliente.toLowerCase().includes(req.query.q.toLowerCase())).slice(0,200));
    if(req.query.before_id) return res.json((settings.duplicateTail?[first.at(-1)]:[]).concat(tail.slice(0,1)));
    res.json(first);
  }));
  app.use('/api', (req,res)=>{writes.push(req.method);res.status(404).json({});});
  app.use('/pedidos', express.static(path.resolve('pedidos')));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  let browser;
  try {
    browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page=await browser.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith('http://127.0.0.1:')?r.continue():r.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/pedidos/pagos.html`,{waitUntil:'networkidle0'});
    await run({page,reads,writes,failures,paths,settings,release:()=>held.splice(0).forEach(r=>r())});
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[],'Filters never write payments or send WhatsApp');
  } finally {if(browser)await browser.close();held.splice(0).forEach(r=>r());server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('paginación por fuente conserva cursor exacto, no repite agotadas y reintenta errores HTTP',async()=>fixture(async({page,reads,failures,paths})=>{
  assert.equal(await page.evaluate(()=>currentRows.length),202);
  failures.add(paths[0]);
  await page.evaluate(()=>Promise.all([cargarMas(),cargarMas()]));
  await page.waitForFunction(()=>document.querySelector('#resultadosEstado').textContent.includes('503'));
  assert.equal(reads.length,4,'Only transfer source is still active; duplicate click ignored');
  assert.equal(reads.at(-1).query.before_id,'301');
  assert.equal(reads.at(-1).query.before_fecha,'2026-10-14T15:00:00.123456Z');
  assert.equal(await page.evaluate(()=>currentRows.length),202);
  failures.clear();await page.evaluate(()=>cargarMas());
  await page.waitForFunction(()=>currentRows.length===203);
  assert.deepEqual(reads.at(-1).query,reads.at(-2).query,'Retry does not advance failed cursor');
  assert.equal(await page.$eval('#btnVerMas',n=>getComputedStyle(n).display),'none');
}));

for(const [index,tipo] of ['transferencia','qr','sin_comprobante'].entries()) {
  test(`200 fechas nulas: ${tipo} pagina sin retry loop con sentinel y fallback legacy`,async()=>fixture(async({page,reads,settings})=>{
    settings.counts[index]=200;settings.nullDates=true;
    await page.select('#fTipo',tipo);
    for(const nullCursor of [false,true]) {
      settings.nullCursor=nullCursor;
      await page.evaluate(()=>loadPagos());
      assert.equal(await page.evaluate(()=>currentRows.length),200);
      const before=reads.length;
      await page.evaluate(()=>{
        const realParse=Date.parse;
        Date.parse=value=>{if(value==='-infinity')throw new Error('Do not parse sentinel as Date');return realParse(value);};
      });
      await page.evaluate(()=>cargarMas());
      assert.equal(reads.length,before+1);
      assert.equal(reads.at(-1).query.before_fecha,'-infinity');
      assert.equal(reads.at(-1).query.before_id,'301');
      assert.equal(await page.evaluate(()=>currentRows.length),201);
      assert.doesNotMatch(await page.$eval('#resultadosEstado',n=>n.textContent),/400/);
      assert.equal(await page.$eval('#btnVerMas',n=>getComputedStyle(n).display),'none');
      await page.evaluate(()=>cargarMas());
      assert.equal(reads.length,before+1,'Fuente agotada no reintenta ni cicla');
    }
  }));
}

test('filtros combinados respetan Tipo/Estado/Cuenta y explican combinaciones vacías',async()=>fixture(async({page,reads,paths})=>{
  const apply=()=>page.evaluate(()=>loadPagos());
  for(const [tipo,estado,expected] of [['transferencia','pendiente',[0]],['qr','verificado',[1]],['sin_comprobante','pendiente',[2]],['','en_revision',[0]],['','orphan',[0]],['','verificado',[0,1]],['qr','en_revision',[]],['sin_comprobante','verificado',[]]]) {
    await page.select('#fTipo',tipo);await page.select('#fEstado',estado);
    const start=reads.length;await apply();
    assert.deepEqual(reads.slice(start).map(r=>r.endpoint),expected.map(i=>paths[i]));
    if(!expected.length) assert.match(await page.$eval('#resultadosEstado',n=>n.textContent),/combinación/i);
  }
  await page.select('#fTipo','qr');await page.select('#fEstado','');
  const before=reads.length;await page.select('#fCuenta','80');
  await page.waitForFunction(()=>!listBusy);assert.equal(reads.length,before,'Account must not override QR type');
  await page.select('#fTipo','transferencia');await page.select('#fChofer','3');await apply();
  assert.equal(reads.at(-1).query.cuenta_bancaria_id,'80');assert.equal(reads.at(-1).query.chofer_id,'3');
}));

test('rango inválido no consulta; presets usan Argentina y limpiar restaura todo sin overflow móvil',async()=>fixture(async({page,reads})=>{
  await page.$eval('#fDesde',n=>n.value='2026-10-15');await page.$eval('#fHasta',n=>n.value='2026-10-01');
  const before=reads.length;await page.evaluate(()=>loadPagos());
  assert.equal(reads.length,before);assert.equal(await page.$eval('#fHasta',n=>n.getAttribute('aria-invalid')),'true');
  await page.evaluate(()=>{const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-01T01:30:00Z']));}static now(){return new RealDate('2026-11-01T01:30:00Z').getTime();}};});
  await page.evaluate(()=>aplicarHoy());
  assert.equal(await page.$eval('#fDesde',n=>n.value),'2026-10-31');assert.equal(await page.$eval('#fHasta',n=>n.value),'2026-10-31');
  await page.click('#presetSemana');await page.waitForFunction(()=>!listBusy);
  assert.equal(await page.$eval('#fDesde',n=>n.value),'2026-10-25');
  await page.click('#presetMes');await page.waitForFunction(()=>!listBusy);
  assert.equal(await page.$eval('#fDesde',n=>n.value),'2026-10-01');
  await page.type('#fBuscar','algo');await page.select('#fTipo','qr');await page.evaluate(()=>limpiarFiltros());await page.waitForFunction(()=>!listBusy);
  assert.deepEqual(await page.$$eval('.filters-card input,.filters-card select',ns=>ns.map(n=>n.value)),Array(8).fill(''));
  await page.setViewport({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const heights=await page.$$eval('.filters-card .btn',buttons=>buttons.filter(button=>getComputedStyle(button).display!=='none').map(button=>button.getBoundingClientRect().height));
  assert.ok(heights.every(height=>height>=44&&height<=60),'Acciones móviles con altura táctil compacta, sin flex-basis vertical de 120px');
  assert.equal(await page.$eval('#toast',node=>getComputedStyle(node).visibility),'hidden','El aviso inactivo no debe quedar visible en capturas ni accesibilidad');
  assert.ok(await page.$('label[for="fBuscar"]'));
  assert.match(await page.$eval('.kpi-grid',n=>n.textContent),/de registros cargados/);
}));

test('respuestas viejas y cuentas tardías no pisan el filtro nuevo',async()=>fixture(async({page,reads,release})=>{
  await page.evaluate(()=>{ const realFetch=window.fetch; window.fetch=(url,opts)=>realFetch(url,{...opts,signal:undefined}); }); // Deliberately ignore abort: generation must still protect the UI.
  await page.$eval('#fBuscar',n=>n.value='lenta');await page.evaluate(()=>{loadPagos();});
  await page.waitForFunction(()=>listBusy);await new Promise(r=>setTimeout(r,50));
  await page.$eval('#fBuscar',n=>n.value='nueva');await page.evaluate(()=>loadPagos());release();
  await page.waitForFunction(()=>currentRows.length===3&&currentRows.every(r=>r.cliente==='nueva'));
  await new Promise(r=>setTimeout(r,80));
  assert.equal(await page.evaluate(()=>currentRows.every(r=>r.cliente==='nueva')),true,'Late old responses cannot overwrite newer results');
  await page.select('#fEmpresa','7');
  assert.equal(await page.evaluate(()=>currentRows.length),0,'Company change immediately hides the previous company list');
  await page.select('#fEmpresa','8');
  await new Promise(r=>setTimeout(r,300));
  assert.deepEqual(await page.$eval('#fCuenta',n=>Array.from(n.options).filter(o=>/^\d+$/.test(o.value)).map(o=>o.value)),['80']);
  assert.equal(reads.at(-1).query.empresa_id,'8');
  assert.ok(await page.evaluate(()=>currentRows.every(r=>r.cliente==='nueva')));
}));

test('CSV exporta sólo cargados, nombra rango aplicado y neutraliza fórmulas',async()=>fixture(async({page,reads})=>{
  await page.$eval('#fDesde',n=>n.value='2026-10-01');await page.$eval('#fHasta',n=>n.value='2026-10-15');await page.evaluate(()=>loadPagos());
  const count=reads.length;
  const result=await page.evaluate(async()=>{
    let blob,filename;URL.createObjectURL=b=>{blob=b;return 'blob:synthetic';};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){filename=this.download;};
    currentRows[0].cliente='=HYPERLINK("bad")';
    document.querySelector('#fDesde').value='2025-01-01';exportarCSV();
    return {text:await blob.text(),filename,count:currentRows.length,cell:csvCell(' \t+SUM(1,2)')};
  });
  assert.equal(reads.length,count);assert.match(result.filename,/cargados-2026-10-01_2026-10-15/);
  assert.equal(result.text.split('\n').length,result.count+1);assert.match(result.text,/"'=HYPERLINK/);assert.match(result.cell,/^"'/);
}));

test('QR pagina con timestamp exacto de liquidación, deduplica y mantiene errores 403 visibles',async()=>fixture(async({page,reads,failures,paths,settings})=>{
  settings.counts[1]=200;settings.qrFallback=true;settings.duplicateTail=true;
  await page.select('#fTipo','qr');await page.evaluate(()=>loadPagos());
  failures.add(paths[1]);settings.status=403;await page.evaluate(()=>cargarMas());
  assert.match(await page.$eval('#resultadosEstado',n=>n.textContent),/403/);
  assert.equal(reads.at(-1).query.before_fecha,'2026-10-14T15:00:00.987654Z');
  assert.equal(reads.at(-1).query.before_id,'301');
  failures.clear();await page.evaluate(()=>cargarMas());
  assert.equal(await page.evaluate(()=>currentRows.length),201,'Repeated row_id is not rendered twice');
  assert.equal(await page.$eval('#btnVerMas',n=>getComputedStyle(n).display),'none');
}));

test('buscador global accesible envía q y rango a las tres fuentes con Enter',async()=>fixture(async({page,reads})=>{
  assert.ok(await page.$('#fBuscar'),'Falta buscador global accesible');
  assert.equal(await page.$eval('#fBuscar',n=>n.maxLength),120);
  const beforeTyping=reads.length;
  await page.type('#fBuscar','Cliente fuera de primera página');
  assert.equal(reads.length,beforeTyping,'Typing does not issue a request per character');
  await page.$eval('#fDesde',n=>n.value='2026-10-01');await page.$eval('#fHasta',n=>n.value='2026-10-15');
  const start=reads.length;await page.focus('#fBuscar');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>currentRows.length===3);
  assert.equal(reads.length-start,3);
  for(const {query} of reads.slice(start)){assert.equal(query.q,'Cliente fuera de primera página');assert.equal(query.desde,'2026-10-01');assert.equal(query.hasta,'2026-10-15');assert.equal(query.before_id,undefined);}
  assert.match(await page.$eval('#resultadosEstado',n=>n.textContent),/3 registros cargados/);
}));
