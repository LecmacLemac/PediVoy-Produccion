import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
const root = new URL('../', import.meta.url);
const meta = {enabled:true,timezone:'America/Argentina/Buenos_Aires',today:'2026-10-15',selected_date:'2026-10-15',advance_enabled:true,max_advance_days:7,dates:['2026-10-15','2026-10-16','2026-10-17']};
async function fixture(t, path, opts={}) {
 const browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setViewport({width:opts.mobile?390:1280,height:900});await page.emulateTimezone('Pacific/Honolulu');
 page.setDefaultTimeout(4000);
 const requests=[]; const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
 page.on('request',async r=>{const u=new URL(r.url());requests.push({url:u.pathname+u.search,body:r.postData(),credentials:r.headers().cookie});
 if(u.pathname.startsWith('/pedidos/')){try { const body=await readFile(new URL('.'+u.pathname,root));return r.respond({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html',body});}catch{ return r.respond({status:404,body:''});}}
 let body={};if(u.pathname.endsWith('/config'))body={empresa_id:1,landing_slug:'demo',nombre:'Synthetic'};
 if(u.pathname.endsWith('/menu')){if(opts.missingMenu)return r.respond({status:404,contentType:'application/json',body:'{}'});body=opts.metadata|| (opts.disabled?{enabled:false}:opts.noAdvance?{...meta,advance_enabled:false}:meta);}
 if(u.pathname.endsWith('/productos')) {if(opts.metadata?.dates && !opts.metadata.dates.includes(u.searchParams.get('fecha_entrega')) && u.searchParams.has('fecha_entrega'))return r.respond({status:400,contentType:'application/json',body:JSON.stringify({error:'La empresa no atiende en esa fecha',code:'MENU_COMPANY_CLOSED'})});if(opts.delayDate===u.searchParams.get('fecha_entrega'))await new Promise(resolve=>setTimeout(resolve,250));if(opts.failDate===u.searchParams.get('fecha_entrega'))return r.abort();body=u.searchParams.get('fecha_entrega')==='2026-10-16'?[{id:opts.sharedId?1:2,nombre:'Mañana',precio:200}]:[{id:1,nombre:'Hoy',precio:100}];if(opts.capacity)body=body.map(p=>({...p,menu:{available:true,remaining:1}}));}
 if(u.pathname.endsWith('/items')){if(opts.repeatDelay)await new Promise(resolve=>setTimeout(resolve,250));body={items:[{producto_id:opts.repeatMissing?9:1,producto:'Histórico',precio_unitario:5,cantidad:1}]};}
 if(u.pathname.endsWith('/me'))body={ok:true,profile:{cliente:'Synthetic',direccion:'Fixture 1',ciudad:'Prueba',telefono:'1123456789'},session:{}};
 if(u.pathname.endsWith('/orders'))body={orders:opts.history?[{id:23,estado:'pendiente',fecha_entrega_programada:'2026-10-17',direccion:'Fixture'}]:[]};
 if(u.pathname.startsWith('/api/public/tracking/'))body={pedido:{id:23,estado:'entregado',fecha_entrega_programada:'2026-10-17',cliente:'Synthetic',direccion:'Fixture',items:[],monto:200}};
 if(u.pathname==='/public/pedidos')body=opts.orderError?{error:'Cupo agotado'}:{ok:true,pedido:{id:23,...(opts.disabled?{}:{fecha_entrega_programada:'2026-10-17'})}};
 return r.respond({status:opts.orderError&&u.pathname==='/public/pedidos'?409:opts.historyFail&&u.pathname.endsWith('/orders')&&requests.some(r=>r.url.startsWith('/public/pedidos?'))?503:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('https://fixture.test'+path);return {page,requests,errors};
}
for(const path of ['/pedidos/index.html?empresa_id=1','/pedidos/app/index.html?empresa_id=1']) {
 test(`real HTML selects URL service date ${path}`,async t=>{const {page,requests,errors}=await fixture(t,path+'&fecha_entrega=2026-10-16',{mobile:true});await page.waitForSelector('[data-menu-date]');await page.waitForFunction(()=>document.querySelector('[data-menu-date]').value==='2026-10-16');assert.ok(requests.some(r=>r.url.includes('fecha_entrega=2026-10-16')&&r.url.includes('/productos')));assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));});
}

for (const app of [false,true]) {
 const path = app ? '/pedidos/app/index.html?empresa_id=1' : '/pedidos/index.html?empresa_id=1';
 const add = app ? '#productos button' : '[data-action="add-to-cart"]';
 const cart = app ? '#cart .cart-item' : '#cart .cart-item';
 test(`cart date change confirms unavailable removal and cancellation ${app}`,async t=>{
  const {page,errors}=await fixture(t,path);await page.waitForSelector(add);await page.click(add);await page.waitForSelector(cart);
  const dialogs=[];page.on('dialog',async d=>{dialogs.push(d.message());if(dialogs.length===1) await d.accept();else await d.dismiss();});
  await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>!document.querySelector('[data-menu-date]').disabled);
  assert.equal(await page.$eval('[data-menu-date]',e=>e.value),'2026-10-15');assert.equal(await page.$$(cart).then(x=>x.length),1);assert.equal(dialogs.length,2);
  assert.doesNotMatch(await page.$eval('[data-menu-status]',e=>e.textContent),/Cargando/);
  page.removeAllListeners('dialog');page.on('dialog',d=>d.accept());await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>document.querySelector('[data-menu-date]').value==='2026-10-16'&&!document.querySelector('[data-menu-date]').disabled);
  assert.equal(await page.$$(cart).then(x=>x.length),0);assert.match(await page.$eval('[data-menu-cart-date]',e=>e.textContent),/16\/10\/2026/);assert.deepEqual(errors,[]);
 });
 test(`network date switch preserves date and cart ${app}`,async t=>{
  const {page}=await fixture(t,path,{failDate:'2026-10-16'});await page.waitForSelector(add);await page.click(add);await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>!document.querySelector('[data-menu-date]').disabled);
  assert.equal(await page.$eval('[data-menu-date]',e=>e.value),'2026-10-15');assert.equal(await page.$$(cart).then(x=>x.length),1);
 });
 test(`invalid URL date offers correction without silent fallback ${app}`,async t=>{
  const {page,requests}=await fixture(t,path+'&fecha_entrega=2026-12-31');await page.waitForSelector('[data-menu-date]',{visible:true});assert.equal(requests.filter(r=>r.url.includes('/productos')).length,0);
  await page.select('[data-menu-date]','2026-10-16');await page.waitForSelector(add);assert.ok(requests.some(r=>r.url.includes('fecha_entrega=2026-10-16')&&r.url.includes('/productos')));
 });
 test(`legacy has no date request or date payload ${app}`,async t=>{
  const {page,requests,errors}=await fixture(t,path,{disabled:true});await page.waitForSelector(add);assert.equal(await page.$eval('[data-menu-date]',e=>e.closest('section').hidden),true);assert.ok(!requests.some(r=>r.url.includes('fecha_entrega=')));assert.deepEqual(errors,[]);
 });
}

async function checkout(page, app) {
 if(app) {await page.click('#btn-send');return;}
 await page.evaluate(()=>{const e=document.querySelector('#form').elements.telefono;e.value='1123456789';e.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.waitForFunction(()=>!phoneLookupPending);
 await page.evaluate(()=>{for(const [name,value] of Object.entries({cliente:'Synthetic',direccion:'Fixture 1',ciudad:'Prueba'})){const e=document.querySelector('#form').elements[name];e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
}
for(const app of [false,true]) for(const disabled of [false,true]) {
 test(`checkout single date payload and server accepted confirmation app=${app} legacy=${disabled}`,async t=>{
  const path=app?'/pedidos/app/index.html?empresa_id=1':'/pedidos/index.html?empresa_id=1';const {page,requests,errors}=await fixture(t,path,{disabled});
  await page.waitForSelector(app?'#productos button':'[data-action="add-to-cart"]');await page.click(app?'#productos button':'[data-action="add-to-cart"]');await checkout(page,app);
  try { await page.waitForFunction(app=>document.querySelector(app?'#order-alert':'#toastMsg').textContent.includes('Pedido enviado'),{},app); } catch(e) { console.log({errors, requests:requests.filter(r=>r.body), state:await page.evaluate(()=>({toast:document.querySelector('#toastMsg')?.textContent,authorized:typeof tenantAuthorized==='undefined'?null:tenantAuthorized,pending:typeof phoneLookupPending==='undefined'?null:phoneLookupPending}))});throw e; }
  const posts=requests.filter(r=>r.url.startsWith('/public/pedidos?'));assert.equal(posts.length,1);const payload=JSON.parse(posts[0].body);
  assert.equal(payload.fecha_entrega,disabled?undefined:'2026-10-15');assert.equal(payload.catalog_channel,disabled?undefined:app?'catalog':'landing');assert.ok(payload.items.every(i=>!('fecha_entrega' in i)));
  const confirmation=await page.$eval(app?'#order-alert':'#toastMsg',e=>e.textContent);if(disabled)assert.doesNotMatch(confirmation,/Entrega:/);else {assert.match(confirmation,/17\/10\/2026/);assert.match(payload.submission_id,/^[a-f\d-]{36}$/);}assert.deepEqual(errors,[]);
 });
}
test('history and capability tracking show committed service date without timezone shift',async t=>{
 const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1',{history:true});await page.waitForFunction(()=>document.querySelector('#orders').textContent.includes('17/10/2026'));
 await page.goto('https://fixture.test/pedidos/seguimiento.html?t=synthetic-capability');await page.waitForSelector('#menuServiceDate',{visible:true});assert.equal(await page.$eval('#menuServiceDate',e=>e.textContent),'Entrega programada: 17/10/2026');assert.equal(await page.$('[data-menu-date]'),null);
});

for(const app of [false,true]) {
 const path=app?'/pedidos/app/index.html?empresa_id=1':'/pedidos/index.html?empresa_id=1';
 test(`old backend without menu endpoint preserves legacy ${app}`,async t=>{const {page,requests}=await fixture(t,path,{missingMenu:true});await page.waitForSelector(app?'#productos button':'[data-action="add-to-cart"]');assert.ok(!requests.some(r=>r.url.includes('fecha_entrega=')));});
 test(`future options absent unless server enables advance ${app}`,async t=>{const {page}=await fixture(t,path,{noAdvance:true});await page.waitForSelector('[data-menu-date]');assert.deepEqual(await page.$$eval('[data-menu-date] option',es=>es.map(e=>e.value)),['2026-10-15']);});
}

for(const app of [false,true]) {
 const path=app?'/pedidos/app/index.html?empresa_id=1':'/pedidos/index.html?empresa_id=1';const add=app?'#productos button':'[data-action="add-to-cart"]';
 test(`late date response cannot overwrite newest date ${app}`,async t=>{const {page,errors}=await fixture(t,path,{delayDate:'2026-10-16'});await page.waitForSelector(add);
 await page.evaluate(()=>{menuController.change('2026-10-16');setTimeout(()=>menuController.change('2026-10-17'),30);});
 await page.waitForFunction(()=>document.querySelector('[data-menu-date]').value==='2026-10-17'&&!document.querySelector('[data-menu-date]').disabled);await new Promise(r=>setTimeout(r,300));assert.equal(await page.$eval('[data-menu-date]',e=>e.value),'2026-10-17');assert.deepEqual(errors,[]);
 });
 test(`409 keeps cart editable, never auto retries and new intent uses new key ${app}`,async t=>{const {page,requests}=await fixture(t,path,{orderError:true});await page.waitForSelector(add);await page.click(add);
 const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept();});await checkout(page,app);
 await page.waitForFunction(app=>app?!appSubmissionPending:!orderSubmissionPending,{},app);
 assert.equal(requests.filter(r=>r.url.startsWith('/public/pedidos?')).length,1);assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),1);
 if(app)assert.ok(dialogs.includes('Cupo agotado'));else assert.match(await page.$eval('#toastMsg',e=>e.textContent),/Cupo agotado/);
 await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>document.querySelector('[data-menu-date]').value==='2026-10-16'&&!document.querySelector('[data-menu-date]').disabled);await page.click(add);await checkout(page,app);
 await page.waitForFunction(app=>app?!appSubmissionPending:!orderSubmissionPending,{},app);
 const posts=requests.filter(r=>r.url.startsWith('/public/pedidos?')).map(r=>JSON.parse(r.body));assert.equal(posts.length,2);assert.notEqual(posts[0].submission_id,posts[1].submission_id);assert.equal(posts[1].fecha_entrega,'2026-10-16');
 });
}
test('delayed landing add stays bound to requested date',async t=>{const {page}=await fixture(t,'/pedidos/index.html?empresa_id=1&fecha_entrega=2026-10-15&add=1',{sharedId:true});await page.waitForSelector('[data-action="add-to-cart"]');await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>document.querySelector('[data-menu-date]').value==='2026-10-16'&&!document.querySelector('[data-menu-date]').disabled);await new Promise(r=>setTimeout(r,850));assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),0);});
test('future App menu describes the selected delivery date, never immediate delivery',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1&fecha_entrega=2026-10-16',{mobile:true});await page.waitForSelector('#productos button');assert.match(await page.$eval('#productos .prod-desc',e=>e.textContent),/Disponible para el 16\/10\/2026/);assert.doesNotMatch(await page.$eval('#productos',e=>e.textContent),/inmediato/i);await page.select('[data-menu-date]','2026-10-15');await page.waitForFunction(()=>menuController.date==='2026-10-15'&&!menuController.busy);assert.match(await page.$eval('#productos .prod-desc',e=>e.textContent),/pedido inmediato/);});

test('App deep link adds from selected date',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1&fecha_entrega=2026-10-16&add=2');await page.waitForSelector('#productos button');assert.match(await page.$eval('#cart',e=>e.textContent),/Mañana/);});

for(const change of ['date','tenant','cart']) test(`late App repeat cannot overwrite changed ${change} context`,async t=>{
 const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1',{repeatDelay:true,sharedId:true});await page.waitForSelector('#productos button');
 page.on('dialog',d=>d.accept());
 await page.evaluate(()=>{window.pendingRepeat=repeatOrder(23);});
 if(change==='date'){await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>menuController.date==='2026-10-16'&&!menuController.busy);}
 else if(change==='tenant')await page.evaluate(()=>history.replaceState(null,'','?empresa_id=2'));
 else await page.click('#productos button');
 await page.evaluate(()=>window.pendingRepeat);
 assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),change==='cart'?1:0);
 if(change==='cart')assert.doesNotMatch(await page.$eval('#order-alert',e=>e.textContent),/Cargamos el pedido/);
});

test('App repeat resolves IDs and current prices for the cart date',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1');await page.waitForSelector('#productos button');await page.evaluate(()=>repeatOrder(23));await page.click('#productos button');assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),1);assert.match(await page.$eval('#total',e=>e.textContent),/200/);});
test('App repeat refuses unavailable historical items without clearing cart',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1',{repeatMissing:true});await page.waitForSelector('#productos button');await page.click('#productos button');const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept();});await page.evaluate(()=>repeatOrder(23));assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),1);assert.match(await page.$eval('#cart',e=>e.textContent),/Hoy/);assert.match(dialogs[0],/no disponibles/);});
test('App preserves landing channel when entering from a date-bound landing link',async t=>{const {page,requests}=await fixture(t,'/pedidos/app/index.html?empresa_id=1&fecha_entrega=2026-10-16&catalog_channel=landing');await page.waitForSelector('#productos button');await page.click('#productos button');await checkout(page,true);await page.waitForFunction(()=>document.querySelector('#order-alert').textContent.includes('Pedido enviado'));assert.equal(JSON.parse(requests.find(r=>r.url.startsWith('/public/pedidos?')).body).catalog_channel,'landing');assert.ok(requests.some(r=>r.url.includes('/productos')&&r.url.includes('scope=landing')));});

test('checkout honors validated catalog channel in date-bound URL',async t=>{const {page,requests}=await fixture(t,'/pedidos/index.html?empresa_id=1&fecha_entrega=2026-10-16&catalog_channel=catalog');await page.waitForSelector('[data-action="add-to-cart"]');await page.click('[data-action="add-to-cart"]');await checkout(page,false);await page.waitForFunction(()=>orderSubmissionSucceeded);const post=requests.find(r=>r.url.startsWith('/public/pedidos?'));assert.equal(JSON.parse(post.body).catalog_channel,'catalog');assert.ok(requests.some(r=>r.url.includes('/productos')&&r.url.includes('scope=catalog')));});

test('date revalidation checks aggregate product quantities, not each duplicate row',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1',{capacity:true});await page.waitForSelector('#productos button');await page.click('#productos button');const result=await page.evaluate(()=>{cart.push({...cart[0],id:'duplicate'});try{menuController.payload();return '';}catch(e){return e.message;}});assert.match(result,/sin disponibilidad o cupo/);});

for(const app of [false,true])test(`menu controls match screen tokens and stay usable at 375px ${app}`,async t=>{
 const {page,errors}=await fixture(t,app?'/pedidos/app/index.html?empresa_id=1&fecha_entrega=2026-10-16':'/pedidos/index.html?empresa_id=1&fecha_entrega=2026-10-16');await page.setViewport({width:375,height:812});await page.waitForSelector(app?'#productos button':'[data-action="add-to-cart"]');await page.waitForFunction(()=>!menuController.busy);
 for(const selector of ['[data-menu-date]','[data-menu-retry]']){const style=await page.$eval(selector,e=>({radius:parseFloat(getComputedStyle(e).borderRadius),height:e.getBoundingClientRect().height}));assert.ok(style.radius>=10);assert.ok(style.height>=44);}
 await page.focus('[data-menu-date]');await page.keyboard.press('Tab');assert.equal(await page.$eval('[data-menu-retry]',e=>e===document.activeElement),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 if(process.env.MENU_UI_SCREENSHOT_DIR){await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});await page.evaluate(()=>Promise.allSettled(document.getAnimations().map(a=>a.finished)));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await mkdir(process.env.MENU_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.MENU_UI_SCREENSHOT_DIR}/${app?'app':'web'}-menu-375.png`,fullPage:true});}
});

for(const app of [false,true])test(`menu date is visible before products ${app}`,async t=>{const {page}=await fixture(t,app?'/pedidos/app/index.html?empresa_id=1':'/pedidos/index.html?empresa_id=1');await page.waitForSelector(app?'#productos button':'[data-action="add-to-cart"]');const positions=await page.evaluate(app=>({date:document.querySelector('[data-menu-date]').getBoundingClientRect().top,product:document.querySelector(app?'#productos':'#prodsList').getBoundingClientRect().top}),app);assert.ok(positions.date<positions.product);});

test('a changed tenant cannot submit a catalog committed for another tenant',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1');await page.waitForSelector('#productos button');await page.click('#productos button');const result=await page.evaluate(()=>{history.replaceState(null,'','?empresa_id=2');try{menuController.payload();return '';}catch(e){return e.message;}});assert.match(result,/empresa/);});

for(const app of [false,true])test(`initial network error has explicit recoverable menu retry ${app}`,async t=>{const config={failDate:'2026-10-15'};const {page}=await fixture(t,app?'/pedidos/app/index.html?empresa_id=1':'/pedidos/index.html?empresa_id=1',config);await page.waitForSelector('[data-menu-retry]',{visible:true});config.failDate=null;await page.click('[data-menu-retry]');await page.waitForSelector(app?'#productos button':'[data-action="add-to-cart"]');assert.equal(await page.$eval('[data-menu-date]',e=>e.value),'2026-10-15');});

for(const app of [false,true])test(`retry after invalid URL cannot silently order today ${app}`,async t=>{
 const {page,requests}=await fixture(t,app?'/pedidos/app/index.html?empresa_id=1&fecha_entrega=2026-12-31&add=1':'/pedidos/index.html?empresa_id=1&fecha_entrega=2026-12-31&add=1');await page.waitForSelector('[data-menu-retry]',{visible:true});await page.click('[data-menu-retry]');await page.waitForFunction(()=>!menuController.busy);assert.equal(requests.filter(r=>r.url.includes('/productos')).length,0);assert.equal(await page.evaluate(()=>menuController.date),'');assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),0);
});

for(const app of [false,true])test(`retry initial future date network failure keeps URL date ${app}`,async t=>{
 const opts={failDate:'2026-10-16'};const {page,requests}=await fixture(t,app?'/pedidos/app/index.html?empresa_id=1&fecha_entrega=2026-10-16':'/pedidos/index.html?empresa_id=1&fecha_entrega=2026-10-16',opts);await page.waitForSelector('[data-menu-retry]',{visible:true});opts.failDate=null;await page.click('[data-menu-retry]');await page.waitForFunction(()=>menuController.date&&!menuController.busy);assert.equal(await page.evaluate(()=>menuController.date),'2026-10-16');assert.ok(!requests.some(r=>r.url.includes('/productos')&&r.url.includes('fecha_entrega=2026-10-15')));
});

test('metadata dates must be real ISO strings, never object-shaped options',async t=>{const {page,requests}=await fixture(t,'/pedidos/index.html?empresa_id=1',{metadata:{...meta,dates:[meta.today,{date:'2026-10-16'}]}});await page.waitForFunction(()=>!menuController.busy);assert.equal(requests.filter(r=>r.url.includes('/productos')).length,0);await page.waitForSelector('[data-menu-retry]',{visible:true});});

for (const app of [false,true]) for (const dates of [[],['2026-10-16']]) test(`closed today is a normal recoverable state app=${app} dates=${dates.length}`,async t=>{
 const {page,requests}=await fixture(t,app?'/pedidos/app/index.html?empresa_id=1':'/pedidos/index.html?empresa_id=1',{metadata:{...meta,dates}});
 await page.waitForFunction(()=>menuController && !menuController.busy && document.querySelector('[data-menu-status]').textContent.length>0);
 assert.equal(requests.filter(r=>r.url.includes('/productos')).length,0);
 assert.match(await page.$eval('[data-menu-status]',e=>e.textContent),/cerrado hoy/i);
 const error=await page.evaluate(()=>{try{menuController.payload();return '';}catch(e){return e.message;}});assert.match(error,/cerrado/i);
 if(dates.length){await page.select('[data-menu-date]','2026-10-16');await page.waitForFunction(()=>menuController.date==='2026-10-16'&&!menuController.busy);assert.equal(await page.evaluate(()=>menuController.payload().fecha_entrega),'2026-10-16');}
});

test('accepted App order remains confirmed when history refresh fails',async t=>{const {page}=await fixture(t,'/pedidos/app/index.html?empresa_id=1',{historyFail:true});page.on('dialog',d=>d.accept());await page.waitForSelector('#productos button');await page.click('#productos button');await checkout(page,true);await page.waitForFunction(()=>document.querySelector('#order-alert').textContent.includes('17/10/2026'));assert.equal(await page.$$('#cart .cart-item').then(x=>x.length),0);});
