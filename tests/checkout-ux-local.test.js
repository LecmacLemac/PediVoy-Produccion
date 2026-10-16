import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';

// Explicit representative Pico cascade, not a vendored/full Pico stylesheet.
// Reproduces the inherited light/dark control colors responsible for this regression.
const picoColorFixture=`
:root { --pico-color:#373c44; --pico-form-element-background-color:#fff; --pico-form-element-color:#373c44; --pico-form-element-placeholder-color:#646b79; }
@media (prefers-color-scheme:dark) { :root { --pico-color:#c2c7d0; --pico-form-element-background-color:#1c212c; --pico-form-element-color:#e0e3e7; --pico-form-element-placeholder-color:#8891a4; } }
input,textarea { color:var(--pico-form-element-color); background-color:var(--pico-form-element-background-color); }
input::placeholder,textarea::placeholder { color:var(--pico-form-element-placeholder-color); opacity:1; }
input:disabled,textarea:disabled { opacity:0.5; }
input[aria-invalid=true],textarea[aria-invalid=true] { border-color:#b42318; }
`;
const products = [{id:9001,nombre:'Agua prueba',precio:100},{id:9002,nombre:'Soda prueba',precio:200,etiqueta:'Oferta'}];
async function fixture(t, width=390) {
  const app=express();app.use('/pedidos',express.static(new URL('../pedidos/',import.meta.url).pathname));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=process.env.CHECKOUT_UX_ORIGIN || `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page=await browser.newPage();await page.setViewport({width,height:850});page.setDefaultTimeout(6000);
  const state={rows:products,posts:[],queries:[],holdMenu:null,holdOrder:null,orderResult:{ok:true,pedido:{}}};
  await page.setRequestInterception(true);
  page.on('request',async req=>{
    const url=new URL(req.url());
    if(url.href==='https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css') {
      await req.respond({status:200,contentType:'text/css',body:picoColorFixture});return;
    }
    if(url.pathname.startsWith('/public/')) {
      state.queries.push(url.pathname+url.search);
      let body;
      if(url.pathname==='/public/config') body={empresa_id:9001,landing_slug:'ux-fixture',nombre:'Tienda sintética'};
      else if(url.pathname==='/public/menu') {if(state.holdMenu)await state.holdMenu;body={enabled:true,today:'2026-10-16',selected_date:'2026-10-16',dates:['2026-10-16'],advance_enabled:false};}
      else if(url.pathname==='/public/productos')body=state.rows;
      else if(url.pathname==='/public/contacto') {
        const result=state.contactResult || {ok:true,found:false};
        const fail=state.failContact, status=state.contactStatus || 200, raw=state.contactRaw;
        const hold=state.holdContact;
        state.onContact?.();
        if(hold)await hold;
        if(fail){await req.abort('failed');return;}
        await req.respond({status,contentType:'application/json',body:raw ?? JSON.stringify(result)});return;
      }
      else if(url.pathname==='/public/pedidos'){state.posts.push(JSON.parse(req.postData()));if(state.holdOrder)await state.holdOrder;body=state.orderResult;}
      else body={ok:true,found:false};
      await req.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});return;
    }
    if(url.origin===origin && url.pathname.startsWith('/pedidos/'))await req.continue();else await req.abort();
  });
  await page.goto(origin+'/pedidos/index.html?empresa_id=9001&slug=ux-fixture');await page.waitForSelector('.card');
  await page.waitForFunction(()=>!menuController.busy);
  return {page,state};
}
const action=page=>page.$eval('#mobSubmit',el=>({disabled:el.disabled,text:el.textContent.trim()}));
const search=async(page,text)=>{
  await page.$eval('#prodSearch',(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},text);
  await new Promise(r=>setTimeout(r,350));
};

test('search empty state clears and persists across cart quantities and scheduled-menu reloads',async t=>{
  const {page,state}=await fixture(t);
  await search(page,'Agua');await page.$eval('[data-product-id="9001"] button',el=>el.click());
  await page.waitForSelector('[data-action="mod-cart"][data-delta="1"]');
  await page.click('[data-action="mod-cart"][data-delta="1"]');
  assert.deepEqual(await page.$$eval('.card',cards=>cards.filter(el=>el.getClientRects().length).map(el=>el.dataset.productId)),['9001']);
  await page.click('[data-menu-retry]');await page.waitForFunction(()=>!menuController.busy);
  assert.equal(await page.$eval('#prodSearch',el=>el.value),'Agua');
  assert.deepEqual(await page.$$eval('.card',cards=>cards.filter(el=>el.getClientRects().length).map(el=>el.dataset.productId)),['9001']);
  await search(page,'ninguna coincidencia');
  assert.match(await page.$eval('#loading',el=>el.textContent),/No encontramos productos para tu búsqueda/);
  await page.waitForSelector('#clearProductSearch',{visible:true});
  await page.click('[data-action="mod-cart"][data-delta="-1"]');
  assert.match(await page.$eval('#loading',el=>el.textContent),/No encontramos productos para tu búsqueda/);
  await page.click('[data-menu-retry]');await page.waitForFunction(()=>!menuController.busy);
  assert.equal(await page.$eval('#loading',el=>getComputedStyle(el).display!=='none'),true);
  await page.click('#clearProductSearch');
  assert.equal(await page.$eval('#prodSearch',el=>el.value),'');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'prodSearch');
  assert.equal(await page.$eval('#loading',el=>getComputedStyle(el).display),'none');
  assert.equal(await page.$$eval('.card',cards=>cards.filter(el=>el.getClientRects().length).length),2);
  state.rows=[];await page.click('[data-menu-retry]');
  // Accept removal of the cart item when the scheduled catalog becomes empty.
  page.on('dialog',dialog=>dialog.accept());
  await page.waitForFunction(()=>!menuController.busy);
  assert.equal(await page.$eval('#loading',el=>el.textContent),'No hay productos disponibles.');
  assert.equal(await page.$('#clearProductSearch'),null);
});

test('estimated total agrees on desktop and mobile and viewport permits zoom',async t=>{
  const {page}=await fixture(t,1280);
  assert.equal(await page.$eval('.total-label',el=>el.textContent),'Total estimado');
  assert.equal(await page.$eval('meta[name=viewport]',el=>el.content),'width=device-width, initial-scale=1');
  await page.click('[data-product-id="9001"] button');
  assert.equal(await page.$eval('#total',el=>el.textContent),await page.$eval('#mobTotal',el=>el.textContent));
  for(const width of [1280,390,320]) {
    await page.setViewport({width,height:850});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
    if(width<600) {
      assert.equal(await page.$eval('.mobile-bar',el=>getComputedStyle(el).display!=='none'),true);
      const box=await page.$eval('#mobSubmit',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
      assert.ok(box.left>=0&&box.right<=width&&box.top>=0&&box.bottom<=850);
    }
  }
});

for(const width of [390,320]) test(`mobile cart navigation is immediate and repeatable at ${width}px without submitting`,async t=>{
  const {page,state}=await fixture(t,width);
  assert.equal((await action(page)).disabled,true);
  // Add and tap twice in the same task: no animation or smooth-scroll settling time.
  const snapshots=await page.evaluate(()=>{
    document.querySelector('[data-product-id="9001"] button').click();
    const button=document.querySelector('#mobSubmit');
    const snapshots=[];
    for(let tap=1;tap<=2;tap++) {
      button.click();
      const cart=document.querySelector('#form [name=telefono]').getBoundingClientRect();
      const header=document.querySelector('header').getBoundingClientRect();
      const bar=document.querySelector('.mobile-bar').getBoundingClientRect();
      snapshots.push({tap,top:cart.top,bottom:cart.bottom,header:header.bottom,bar:bar.top,
        height:innerHeight,scroll:scrollY,focus:document.activeElement.id||document.activeElement.name,
        disabled:button.disabled,text:button.textContent.trim(),valid:document.querySelector('#form').checkValidity()});
    }
    return snapshots;
  });
  t.diagnostic(JSON.stringify({width,snapshots}));
  for(const geometry of snapshots) {
    assert.ok(geometry.top>=Math.max(0,geometry.header) && geometry.bottom<=geometry.bar,JSON.stringify(geometry));
    assert.equal(geometry.focus,'telefono');
    assert.equal(geometry.disabled,false);
    assert.equal(geometry.text,'Ver carrito');
    assert.equal(geometry.valid,false);
  }
  assert.equal(await page.$eval('#form button[type=submit]',el=>el.disabled),true);
  assert.equal(state.posts.length,0);
});

test('mobile locked states and valid submit remain protected independently of navigation',async t=>{
  const {page,state}=await fixture(t);
  assert.equal((await action(page)).disabled,true);
  await page.click('[data-product-id="9001"] button');
  assert.deepEqual(await action(page),{disabled:false,text:'Ver carrito'});
  for(const expression of ['phoneLookupPending=true','orderSubmissionPending=true','orderSubmissionSucceeded=true']) {
    await page.evaluate(expression+';updateCheckoutActionState()');assert.equal((await action(page)).disabled,true);
    await page.evaluate('phoneLookupPending=false;orderSubmissionPending=false;orderSubmissionSucceeded=false;updateCheckoutActionState()');
  }
  let releaseMenu;state.holdMenu=new Promise(r=>releaseMenu=r);
  await page.click('[data-menu-retry]');await page.waitForFunction(()=>menuController.busy);
  assert.equal((await action(page)).disabled,true);releaseMenu();await page.waitForFunction(()=>!menuController.busy);
  // Synthetic values only. Contact requests are intercepted before reaching any backend.
  await page.evaluate(()=>{const f=document.querySelector('#form');f.elements.telefono.value='3515559001';f.elements.telefono.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>!phoneLookupPending);
  await page.evaluate(()=>{for(const [name,value]of Object.entries({cliente:'Prueba',direccion:'Fixture 1',ciudad:'Prueba'})){const el=document.querySelector('#form').elements[name];el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}});
  for(const width of [1280,390]) {
    await page.setViewport({width,height:850});
    for(const [delta,total] of [[0,100],[1,200],[-1,100]]) {
      if(delta)await page.$eval(`[data-action="mod-cart"][data-delta="${delta}"]`,el=>el.click());
      for(const selector of ['#form button[type=submit]','#mobSubmit']) {
        assert.equal(await page.$eval(selector,el=>el.textContent.trim()),'Confirmar pedido');
        assert.equal(await page.$eval(selector,el=>el.disabled),false);
      }
      for(const selector of ['#total','#mobTotal']) {
        assert.match(await page.$eval(selector,el=>el.textContent),new RegExp(`^\\$\\s*${total}(?:[,.]00)?$`));
      }
    }
  }
  let releaseOrder;state.holdOrder=new Promise(r=>releaseOrder=r);
  await page.click('#mobSubmit');await page.waitForFunction(()=>orderSubmissionPending);
  await page.evaluate(()=>{document.querySelector('#mobSubmit').click();document.querySelector('#form').requestSubmit();});
  assert.equal(state.posts.length,1);assert.equal((await action(page)).disabled,true);
  releaseOrder();await page.waitForFunction(()=>orderSubmissionSucceeded&&!orderSubmissionPending);
  assert.equal((await action(page)).disabled,true);assert.equal(state.posts.length,1);
  assert.ok(state.queries.every(q=>q.includes('empresa_id=9001')&&(q.startsWith('/public/contacto?')||q.includes('slug=ux-fixture'))));
});

const buttonVisuals=page=>page.$$eval('#form button[type=submit],#mobSubmit',els=>els.map(el=>({
  text:el.textContent.trim(),disabled:el.disabled,busy:el.getAttribute('aria-busy'),
  bg:getComputedStyle(el).backgroundColor,animation:getComputedStyle(el).animationName,
  count:getComputedStyle(el).animationIterationCount,spinner:!!el.querySelector('.checkout-spinner'),
})));
for(const width of [320,390,1280]) for(const outcome of ['success','error']) test(`checkout visual lifecycle ${width}px: one ready transition, held ACK and ${outcome}`,async t=>{
  const {page,state}=await fixture(t,width);
  await page.evaluate(()=>{
    window.readyStarts=0;
    document.addEventListener('animationstart',event=>{if(event.animationName==='checkout-ready')window.readyStarts++;});
  });
  await page.click('[data-product-id="9001"] button');
  await setPhone(page,'3515559001');await page.waitForFunction(()=>!phoneLookupPending);
  await page.evaluate(()=>{for(const [name,value]of Object.entries({cliente:'Prueba',direccion:'Fixture 1',ciudad:'Prueba'})){const el=document.querySelector('#form').elements[name];el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}});
  let visuals=await buttonVisuals(page);
  for(const button of visuals){assert.equal(button.animation,'checkout-ready');assert.equal(button.count,'2');}
  await page.waitForFunction(()=>window.readyStarts===1); // Desktop duplicate is hidden on mobile.
  const animationTimes=await page.$$eval('#form button[type=submit],#mobSubmit',els=>els.map(el=>el.getAnimations()[0]?.startTime ?? null));
  await page.evaluate(()=>{for(let n=0;n<4;n++){updateCheckoutActionState();document.querySelector('[name=ciudad]').dispatchEvent(new Event('input',{bubbles:true}));}});
  assert.deepEqual(await page.$$eval('#form button[type=submit],#mobSubmit',els=>els.map(el=>el.getAnimations()[0]?.startTime ?? null)),animationTimes);
  await page.evaluate(()=>new Promise(r=>setTimeout(r,3000)));
  assert.equal(await page.evaluate(()=>window.readyStarts),1,'one animation on the visible button, not repeated updates');
  assert.equal(await page.$$eval('#form button[type=submit],#mobSubmit',els=>els.every(el=>el.getAnimations().length===0)),true);
  const original=(await buttonVisuals(page)).map(el=>el.bg);
  const bounds=()=>page.$eval(width<960?'#mobSubmit':'#form button[type=submit]',el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right};});
  const readyBounds=await bounds();
  let release;state.holdOrder=new Promise(r=>release=r);t.after(()=>release());
  if(outcome==='error')state.orderResult={ok:false,error:'Rechazo sintético'};
  await page.$eval('#form',el=>el.requestSubmit());await page.waitForFunction(()=>orderSubmissionPending);
  // Updates and even form edits must never reset the pending visual/submit freeze.
  await page.evaluate(()=>{const name=document.querySelector('[name=cliente]');name.value='Editado pendiente';name.dispatchEvent(new Event('input',{bubbles:true}));updateCheckoutActionState();document.querySelector('#form').requestSubmit();document.querySelector('#mobSubmit').click();});
  await page.waitForFunction(()=>document.querySelector('#mobSubmit').textContent.includes('Enviando'));
  visuals=await buttonVisuals(page);
  for(const button of visuals){assert.equal(button.text,'Enviando…');assert.equal(button.bg,'rgb(30, 41, 59)');assert.equal(button.disabled,true);assert.equal(button.busy,'true');assert.equal(button.spinner,true);}
  assert.equal((await bounds()).height,readyBounds.height,'pending height must not jump');
  await page.evaluate(()=>new Promise(r=>setTimeout(r,250)));
  assert.equal(await page.evaluate(()=>orderSubmissionSucceeded),false);
  assert.equal(state.posts.length,1);
  release();await page.waitForFunction(()=>!orderSubmissionPending);
  visuals=await buttonVisuals(page);
  if(outcome==='success') {
    for(const button of visuals){assert.equal(button.text,'✓ Pedido confirmado');assert.equal(button.bg,'rgb(21, 128, 61)');assert.equal(button.disabled,true);assert.equal(button.busy,'false');assert.equal(button.spinner,false);}
  } else {
    assert.deepEqual(visuals.map(el=>el.bg),original);
    for(const button of visuals){assert.equal(button.text,'Confirmar pedido');assert.equal(button.disabled,false);assert.equal(button.busy,'false');assert.equal(button.spinner,false);}
    assert.equal(await page.$eval('[name=cliente]',el=>el.value),'Editado pendiente');
    assert.equal(await page.$eval('#toastMsg',el=>el.textContent),'Rechazo sintético');
    assert.equal(await page.evaluate(()=>carrito.length),1);
  }
  assert.equal((await bounds()).height,readyBounds.height,'result height must not jump');
  const resultBounds=await bounds();assert.ok(resultBounds.left>=0&&resultBounds.right<=width,JSON.stringify(resultBounds));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(state.posts.length,1);
});

test('reduced motion removes phone/ready pulses and spinner animation without losing status',async t=>{
  const {page,state}=await fixture(t);
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.click('[data-product-id="9001"] button');await page.click('#mobSubmit');
  assert.equal(await page.$eval('[name=telefono]',el=>getComputedStyle(el).animationName),'none');
  state.contactResult={found:true,contacto:{id:9001,cliente:'Sintético',direccion:'Fixture 1',ciudad:'Prueba'}};
  await setPhone(page,'3515559001');await page.waitForFunction(()=>!phoneLookupPending);
  for(const button of await buttonVisuals(page))assert.equal(button.animation,'none');
  let release;state.holdOrder=new Promise(r=>release=r);t.after(()=>release());
  await page.click('#mobSubmit');await page.waitForFunction(()=>orderSubmissionPending);
  assert.equal(await page.$$eval('.checkout-spinner',els=>els.length===2&&els.every(el=>getComputedStyle(el).animationName==='none')),true);
  for(const button of await buttonVisuals(page)){assert.equal(button.text,'Enviando…');assert.equal(button.busy,'true');}
  release();await page.waitForFunction(()=>!orderSubmissionPending);
});

const setPhone=async(page,value)=>page.$eval('#form [name=telefono]',(el,value)=>{
  el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));
  const badge=document.querySelector('#phoneFormatStatus');
  return {value:el.value,valid:el.classList.contains('phone-client-recognized'),
    visible:!!badge&&!badge.hidden&&!!badge.getClientRects().length,
    text:badge?.textContent.trim(),describedby:el.getAttribute('aria-describedby')};
},value);

test('phone lookup feedback is synchronous, accessible and keeps normalization',async t=>{
  const {page,state}=await fixture(t);
  const empty=await setPhone(page,'');
  assert.equal(empty.visible,false);
  for(const value of ['3515559001','03515559001','54 351 5559001','+54 9 351 5559002','351-555-9003']) {
    t.diagnostic(`format case ${value}`);
    let release;state.holdContact=new Promise(r=>release=r);
    t.after(()=>release());
    const result=await setPhone(page,value);
    assert.equal(result.visible,false,`unexpected success for ${value}`);
    assert.equal(result.text,'','hidden aria-describedby target must not announce a recognized client');
    assert.equal(result.valid,false);
    assert.equal(result.value.replace(/\D/g,'').length,10);
    assert.doesNotMatch(result.text,/Número válido/);
    assert.doesNotMatch(result.text,/verificad|existe|WhatsApp|propietari/i);
    assert.ok(result.describedby.split(' ').includes('phoneLookupStatus'));
    assert.ok(result.describedby.split(' ').includes('phoneFormatStatus'));
    assert.equal(await page.$eval('#phoneLookupStatus',el=>el.textContent),'Buscando tus datos…');
    const green=await page.$eval('#form [name=telefono]',el=>getComputedStyle(el).borderTopColor);
    assert.notEqual(green,'rgb(21, 128, 61)');
    release();state.holdContact=null;await page.waitForFunction(()=>!phoneLookupPending);
    assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),true);
    assert.match(await page.$eval('#phoneLookupStatus',el=>el.textContent),/Cliente nuevo · Completá tus datos de entrega/);
    for(const invalid of ['','351555900','5412345678','12345678901234']) {
      assert.equal(await page.evaluate(value=>normalizeArgentineNationalPhone(value),invalid),'');
      const result=await setPhone(page,invalid);
      assert.equal(result.visible,false,invalid);assert.equal(result.valid,false,invalid);
      assert.notEqual(await page.$eval('#form [name=telefono]',el=>getComputedStyle(el).borderTopColor),'rgb(21, 128, 61)');
    }
  }
  // Valid -> another valid is reevaluated in the input event, without awaiting fetch.
  await setPhone(page,'3515559001');
  assert.equal((await setPhone(page,'+54 9 351 5559002')).visible,false);
  await page.waitForFunction(()=>!phoneLookupPending);
  state.failContact=true;
  assert.equal((await setPhone(page,'3515559003')).visible,false);
  await page.waitForFunction(()=>!phoneLookupPending);
  assert.match(await page.$eval('#phoneLookupStatus',el=>el.textContent),/No pudimos consultar tus datos. Podés completarlos manualmente/);
  assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),true);
  state.failContact=false;
  let release;state.holdContact=new Promise(r=>release=r);t.after(()=>release());
  state.contactResult={found:true,contacto:{id:9001,cliente:'Sintético',direccion:'Fixture 1',ciudad:'Prueba'}};
  const request=new Promise(resolve=>state.onContact=resolve);
  await setPhone(page,'3515559004');await request;
  await page.waitForFunction(()=>phoneLookupPending);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/public/contacto');
  assert.equal((await setPhone(page,'5412345678')).visible,false);
  release();state.holdContact=null;await response;
  await page.evaluate(()=>new Promise(r=>setTimeout(r,50)));
  assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),true);
  assert.equal(await page.$eval('#addressHistoryCard',el=>el.hidden),true);
  assert.match(await page.$eval('#phoneLookupStatus',el=>el.textContent),/Ingresá 10 dígitos/);
  assert.equal(state.posts.length,0);
});

test('incomplete phone has a quiet warm cue, navigation pulses twice and editing stops it',async t=>{
  const {page,state}=await fixture(t);
  const phone='#form [name=telefono]';
  assert.equal(await page.$eval(phone,el=>el.classList.contains('phone-needs-attention')),true);
  assert.equal(await page.$eval(phone,el=>getComputedStyle(el).animationName),'none');
  await page.click('[data-product-id="9001"] button');await page.click('#mobSubmit');
  assert.equal(await page.$eval(phone,el=>getComputedStyle(el).animationIterationCount),'2');
  assert.ok(parseFloat(await page.$eval(phone,el=>getComputedStyle(el).animationDuration))>=1);
  await setPhone(page,'351');
  assert.equal(await page.$eval(phone,el=>getComputedStyle(el).animationName),'none');
  assert.equal(await page.$eval(phone,el=>el.classList.contains('phone-needs-attention')),true);
  let release;state.holdContact=new Promise(r=>release=r);t.after(()=>release());
  await setPhone(page,'3515559001');
  assert.equal(await page.$eval(phone,el=>el.classList.contains('phone-needs-attention')),false);
  assert.equal(await page.$eval('#phoneLookupStatus',el=>el.textContent),'Buscando tus datos…');
  release();await page.waitForFunction(()=>!phoneLookupPending);
  // A complete phone with other missing data still navigates to the cart, never submits.
  await page.click('#mobSubmit');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'cart');
  assert.equal(state.posts.length,0);
});

const recognizedContact={ok:true,found:true,contacto:{id:9001,cliente:'Sintético',direccion:'Fixture 1',ciudad:'Prueba'}};
test('recognized contact alone gets success, address changes retain recognition and phone edits clear it immediately',async t=>{
  const {page,state}=await fixture(t);
  state.contactResult=recognizedContact;
  await setPhone(page,'3515559001');await page.waitForFunction(()=>!phoneLookupPending);
  assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),false);
  assert.match(await page.$eval('#phoneFormatStatus',el=>el.textContent),/✓\s*Cliente reconocido/);
  assert.equal(await page.$eval('#phoneFormatStatus [aria-hidden=true]',el=>el.textContent),'✓');
  assert.equal(await page.$eval('#form [name=telefono]',el=>getComputedStyle(el).borderTopColor),'rgb(21, 128, 61)');
  assert.equal(await page.$eval('#addressHistoryCard',el=>el.hidden),false);
  assert.equal(await page.$eval('#savedAddress',el=>el.textContent),'Fixture 1');
  await page.click('#changeSavedAddress');
  assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),false);
  assert.equal(await page.$eval('#deliveryFields',el=>el.hidden),false);
  assert.equal(await page.$eval('#form',el=>el.elements.punto_entrega_id.value),'');
  assert.equal(await page.$eval('#phoneLookupStatus',el=>el.textContent),'Ingresá la nueva dirección.');
  let release;state.holdContact=new Promise(r=>release=r);t.after(()=>release());
  await page.click('[data-product-id="9001"] button');
  const result=await setPhone(page,'3515559002');
  assert.equal(result.visible,false);assert.equal(result.valid,false);
  assert.equal(await page.$eval('#phoneLookupStatus',el=>el.textContent),'Buscando tus datos…');
  assert.equal(await page.$eval('#addressHistoryCard',el=>el.hidden),true);
  assert.equal((await action(page)).disabled,true);
  assert.equal(await page.$eval('#form button[type=submit]',el=>el.disabled),true);
  await page.$eval('#form',form=>form.requestSubmit());
  assert.equal(state.posts.length,0);
  release();state.holdContact=null;await page.waitForFunction(()=>!phoneLookupPending);
  const invalid=await setPhone(page,'');assert.equal(invalid.visible,false);assert.equal(invalid.valid,false);
});

test('lookup errors and malformed contracts are never success or new and allow manual delivery',async t=>{
  const {page,state}=await fixture(t);
  const cases=[
    ...[403,429,500].map(contactStatus=>({contactStatus,contactResult:recognizedContact})),
    {failContact:true},{contactRaw:'{invalid json'}, {contactRaw:'null'},
    ...[[],{}, {ok:false,found:false},{found:'false'}, {found:true},
      {found:true,contacto:{id:9001}}, {found:true,contacto:{direccion:'Fixture 1'}},
      {found:true,contacto:{id:9001,direccion:'   '}},
      {found:true,contacto:{id:{},direccion:'Fixture 1'}},
      {found:true,contacto:{id:9001,direccion:42}}].map(contactResult=>({contactResult})),
  ];
  for(const [index,options]of cases.entries()) {
    Object.assign(state,{contactStatus:200,contactRaw:undefined,failContact:false,contactResult:{}},options);
    await setPhone(page,String(3515559100+index));await page.waitForFunction(()=>!phoneLookupPending);
    assert.equal(await page.$eval('#phoneLookupStatus',el=>el.textContent),'No pudimos consultar tus datos. Podés completarlos manualmente',JSON.stringify(options));
    assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),true);
    assert.equal(await page.$eval('#form [name=telefono]',el=>el.classList.contains('phone-client-recognized')),false);
    assert.equal(await page.$eval('#deliveryFields',el=>el.hidden),false);
    assert.equal(await page.$eval('#addressHistoryCard',el=>el.hidden),true);
  }
  assert.equal(state.posts.length,0);
});

for(const stale of ['recognized','new','error']) test(`late ${stale} response cannot replace the current phone lookup`,async t=>{
  const {page,state}=await fixture(t);
  let release;state.holdContact=new Promise(r=>release=r);t.after(()=>release());
  state.contactResult=stale==='recognized'?recognizedContact:{ok:true,found:false};
  state.contactStatus=stale==='error'?500:200;
  const request=new Promise(resolve=>state.onContact=resolve);
  await setPhone(page,'3515559001');await request;
  state.onContact=null;state.holdContact=null;state.contactStatus=200;state.contactResult=recognizedContact;
  await setPhone(page,'3515559002');await page.waitForFunction(()=>!phoneLookupPending);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/public/contacto');
  release();await response;await page.evaluate(()=>new Promise(r=>setTimeout(r,50)));
  assert.equal(await page.$eval('#phoneFormatStatus',el=>el.hidden),false);
  assert.match(await page.$eval('#phoneFormatStatus',el=>el.textContent),/Cliente reconocido/);
  assert.equal(await page.$eval('#addressHistoryCard',el=>el.hidden),false);
  assert.equal(await page.$eval('#phoneLookupStatus',el=>el.textContent),'Encontramos tu última dirección. Revisala antes de confirmar el pedido.');
  assert.equal(state.posts.length,0);
});

test('checkout controls retain legible light surfaces in light and dark Pico color cascades',async t=>{
  const {page,state}=await fixture(t);
  await setPhone(page,'3515559001');await page.waitForFunction(()=>!phoneLookupPending);
  for(const scheme of ['dark','light']) {
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:scheme}]);
    assert.equal(await page.evaluate(()=>matchMedia('(prefers-color-scheme:dark)').matches),scheme==='dark');
    // Prove the representative fixture media rule actually applies (no CDN network).
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--pico-form-element-color').trim()),scheme==='dark'?'#e0e3e7':'#373c44');
    const controls=await page.$$eval('#form input:not([type=hidden]),#form textarea',els=>els.map(el=>{
      const s=getComputedStyle(el),p=getComputedStyle(el,'::placeholder');
      return {name:el.name,color:s.color,fill:s.webkitTextFillColor,bg:s.backgroundColor,placeholder:p.color,opacity:p.opacity};
    }));
    for(const control of controls) {
      assert.equal(control.color,'rgb(30, 41, 59)',`${scheme} ${control.name}`);
      assert.equal(control.fill,'rgb(30, 41, 59)');
      assert.equal(control.bg,'rgb(248, 250, 252)');
      assert.equal(control.placeholder,'rgb(100, 116, 139)');assert.equal(control.opacity,'1');
    }
    await page.bringToFront();
    await page.waitForSelector('#form [name=cliente]',{visible:true});
    // Acquire focus within the existing timeout, separately from the CSS transition.
    // A one-shot focus can be lost while the localhost document settles.
    await page.waitForFunction(()=>{
      const el=document.querySelector('#form [name=cliente]');
      if(document.activeElement!==el)el.focus();
      return document.activeElement===el;
    });
    assert.equal(await page.$eval('#form [name=cliente]',el=>document.activeElement===el),true,`${scheme} focus acquired`);
    await page.waitForFunction(()=>{const el=document.querySelector('#form [name=cliente]'),s=getComputedStyle(el);return document.activeElement===el&&s.backgroundColor==='rgb(255, 255, 255)'&&s.borderTopColor==='rgb(37, 99, 235)';});
    assert.equal(await page.$eval('#form [name=cliente]',el=>getComputedStyle(el).borderTopColor),'rgb(37, 99, 235)');
    assert.notEqual(await page.$eval('#form [name=cliente]',el=>getComputedStyle(el).boxShadow),'none');
    await page.$eval('#form [name=cliente]',el=>el.blur());
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#form [name=cliente]')).backgroundColor==='rgb(248, 250, 252)');
  }
  await page.$eval('#form [name=cliente]',el=>{el.readOnly=true;});
  const readonly=await page.$eval('#form [name=cliente]',el=>{
    const s=getComputedStyle(el);
    return {readOnly:el.readOnly,disabled:el.disabled,opacity:s.opacity,color:s.color,fill:s.webkitTextFillColor,bg:s.backgroundColor};
  });
  assert.deepEqual(readonly,{readOnly:true,disabled:false,opacity:'1',color:'rgb(30, 41, 59)',fill:'rgb(30, 41, 59)',bg:'rgb(248, 250, 252)'});
  await page.$eval('#form [name=cliente]',el=>{el.readOnly=false;el.disabled=true;});
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#form [name=cliente]')).opacity==='0.5');
  const locks=await page.$eval('#form [name=cliente]',el=>({readOnly:el.readOnly,disabled:el.disabled,opacity:getComputedStyle(el).opacity}));
  assert.deepEqual(locks,{readOnly:false,disabled:true,opacity:'0.5'});
  assert.equal(state.posts.length,0);
});
