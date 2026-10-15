import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = new URL('../', import.meta.url);
// SYNTHETIC SDK: exercises the real HTML without Google/network/credentials.
const sdk = `(() => {
 const state = window.syntheticMaps = {maps:[], markers:[], lines:[], imports:[], popups:[]};
 class Map { constructor(el, options) { this.el=el; this.options=options; this.center=options.center; this.zoom=options.zoom; this.fits=0; state.maps.push(this); el.textContent='Mapa Google sintético (no servicio real)'; } fitBounds(bounds) {this.lastBounds=bounds.points;this.fits++; this.center=bounds.points[0];this.zoom=Math.min(18,this.options.maxZoom||19);queueMicrotask(()=>this.idleListeners?.splice(0).forEach(fn=>fn()));} setOptions(opts){Object.assign(this.options,opts);} setCenter(p){this.center=p;} getCenter(){return this.center;} setZoom(z){this.zoom=z;} getZoom(){return this.zoom;} }
 class Bounds {constructor(){this.points=[];} extend(p){this.points.push(p);return this;} getCenter(){return this.points[0];}}
 class Marker {constructor(opts){Object.assign(this,opts);this.listeners={};state.markers.push(this);this.content.style.display='inline-grid';this.content.style.margin='12px';this.map?.el.append(this.content);} set map(value){this._map=value;if(!value)this.content?.remove();} get map(){return this._map;} addListener(e,fn){this.listeners[e]=fn;this.content.onclick=fn;return {remove(){}};} }
 class Polyline {constructor(opts){Object.assign(this,opts);state.lines.push(this);} setMap(map){this.map=map;} }
 class InfoWindow {constructor(options={}){this.options=options;} setOptions(options){Object.assign(this.options,options);} setContent(content){this.content=content;} open(opts){if(!this.options.disableAutoPan)opts.map.setCenter(opts.anchor.position);this.opts=opts;state.popups.push(this.content.textContent);const old=document.querySelector('.synthetic-popup');old?.remove();this.node=document.createElement('div');this.node.className='synthetic-popup';this.node.append(this.content);document.querySelector('#map').append(this.node);} close(){this.node?.remove();}}
 window.google={maps:{event:{addListenerOnce:(map,event,fn)=>{(map.idleListeners ||= []).push(fn);return {remove(){map.idleListeners=map.idleListeners.filter(item=>item!==fn);}};}},Map,LatLngBounds:Bounds,Polyline,InfoWindow,marker:{AdvancedMarkerElement:Marker},importLibrary:async name=>{state.imports.push(name);return name==='marker'?{AdvancedMarkerElement:Marker}:{Map};}}};
 const callback=new URL(document.currentScript.src).searchParams.get('callback');window[callback]?.();
})();`;
const detail = (company='1') => [
 {cliente_id:1,cliente:`Cliente ${company} <img src=x onerror="window.injected=true">`,cliente_lat:-24.79,cliente_lng:-65.41,telefono:'549123',direccion:'Calle <b>uno</b>',convirtio:false,estado:'sent',canal:'whatsapp',estrategia:'base',created_at:'2026-10-01T12:00:00Z'},
 {cliente_id:1,cliente:`Cliente ${company}`,cliente_lat:-24.79,cliente_lng:-65.41,telefono:'549123',convirtio:true,estado:'sent',canal:'whatsapp',created_at:'2026-10-01T12:00:00Z'},
 {cliente_id:2,cliente:`Rojo ${company}`,cliente_lat:-24.8,cliente_lng:-65.42,convirtio:false,estado:'error',canal:'sms',created_at:'2026-10-02T12:00:00Z'},
];
const drivers = [{chofer_id:1,chofer_nombre:'Cercano <script>bad</script>',pedido_id:9,latitud:-24.791,longitud:-65.411},{chofer_id:1,latitud:-24.792,longitud:-65.412},{chofer_id:2,chofer_nombre:'Lejano',latitud:-25,longitud:-66}];
async function harness(t, options={}) {
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setViewport({width:options.mobile?390:1280,height:900});
 const errors=[];page.on('pageerror',()=>errors.push('pageerror'));const calls=[];let sdkRelease;
 await page.evaluateOnNewDocument(shortTimeout=>{const native=window.setInterval;window.setInterval=(fn,ms)=>{if(ms===15000)window.syntheticRefresh=fn;return native(fn,ms);};if(shortTimeout){const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===20000?150:ms,...args);}},options.shortTimeout);
 await page.evaluateOnNewDocument(ignoreAbort=>{if(ignoreAbort){const nativeFetch=window.fetch;window.fetch=(url,opts={})=>nativeFetch(url,{...opts,signal:undefined});}},options.ignoreAbort);
 await page.setRequestInterception(true);
 page.on('request',async request=>{try {
  const url=new URL(request.url());calls.push(url.pathname);
  if(url.hostname==='maps.googleapis.com') { if(options.sdkDelay)await new Promise(resolve=>sdkRelease=resolve); if(options.sdkFail)return request.abort(); return request.respond({status:200,contentType:'application/javascript',body:sdk}); }
  if(url.pathname.startsWith('/api/')) {
   let body={};const company=url.searchParams.get('empresa_id')||'1';
   if(options.apiDelay)await options.apiDelay(url);
   if(url.pathname==='/api/me')body={user:{role:'super'}};
   else if(url.pathname==='/api/empresas')body=[{id:1,nombre:'Uno'},{id:2,nombre:'Dos'},{id:3,nombre:'Tres'}];
   else if(url.pathname.endsWith('/maps-config'))return request.respond({status:options.configStatus||200,contentType:'application/json',body:JSON.stringify(options.missingConfig?{ok:true}:{ok:true,apiKey:'SYNTHETIC-NOT-A-KEY',mapId:'SYNTHETIC_MAP_ID'})});
   else if(url.pathname.endsWith('/telemetria'))body={ok:true,totales:{total:Number(company)*10,exitosos:2},items:[{estrategia:'base',canal:'sms',total:10,exitosos:2}]};
   else if(url.pathname.endsWith('/detalle'))body={ok:true,items:options.details||detail(company)};
   else if(url.pathname==='/api/track/live')body={items:options.drivers||drivers};
   return request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});
  }
  if(url.hostname!=='synthetic.test')return request.abort();
  const path=new URL('.'+url.pathname,root);let body;try {body=await fs.readFile(path);}catch{return request.respond({status:404,body:''});}
  return request.respond({status:200,contentType:url.pathname.endsWith('.html')?'text/html':url.pathname.endsWith('.js')?'application/javascript':url.pathname.endsWith('.css')?'text/css':'image/png',body});
 }catch { if(!request.isInterceptResolutionHandled())await request.abort(); }});
 await page.goto('http://synthetic.test/pedidos/inicio/marketing-telemetria.html',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#kpiTotal').textContent==='10');
 return {page,calls,errors,releaseSDK:()=>sdkRelease?.()};
}

test('cliente único sin chofer centra el mapa y abre popup; click en pin muestra datos seguros',async t=>{
 const {page,errors}=await harness(t,{details:[detail()[0]],drivers:[]});await page.waitForFunction(()=>window.syntheticMaps?.markers.length===1);
 assert.equal(await page.$eval('#mapError',e=>e.hidden),true);
 await page.click('.marketing-map-pin');assert.match(await page.$eval('.synthetic-popup',e=>e.textContent),/<img/);
 await page.click('#tbodyDetalle tr[data-idx="0"]');
 assert.deepEqual(await page.evaluate(()=>({center:syntheticMaps.maps[0].getCenter(),zoom:syntheticMaps.maps[0].getZoom(),lines:syntheticMaps.lines.filter(l=>l.map).length})),{center:{lat:-24.79,lng:-65.41},zoom:16,lines:0});assert.deepEqual(errors,[]);
});

test('coordenadas inválidas no crean pins y ceros individuales válidos se conservan',async t=>{
 const invalid=[[null,-65],['',-65],['  ',-65],[91,-65],[-24,181],[0,0],['Infinity',1],[true,1],[{},1]];
 const details=[...invalid.map(([lat,lng],i)=>({...detail()[0],cliente_id:i+10,cliente_lat:lat,cliente_lng:lng})),{...detail()[0],cliente_id:99,cliente_lat:0,cliente_lng:-65},{...detail()[0],cliente_id:100,cliente_lat:-24,cliente_lng:0}];
 const {page}=await harness(t,{details,drivers:[]});await page.waitForFunction(()=>window.syntheticMaps?.markers.length>0);
 assert.deepEqual(await page.evaluate(()=>syntheticMaps.markers.filter(m=>m.map).map(m=>m.position)),[{lat:0,lng:-65},{lat:-24,lng:0}]);
});

for (const [name,options,message] of [
 ['config ausente',{missingConfig:true},/no está configurado/],['config 403',{configStatus:403},/super admin/],['SDK red fallida',{sdkFail:true},/No se pudo cargar/],['SDK timeout',{sdkDelay:true,shortTimeout:true},/No se pudo cargar/],
])test(`${name}: tabla, KPIs y filtros siguen usables sin filtrar secretos`,async t=>{
 const {page,calls,errors,releaseSDK}=await harness(t,options);await page.waitForFunction(()=>!document.querySelector('#mapError').hidden,{timeout:2500});
 if(options.sdkDelay) releaseSDK();
 const error=await page.$eval('#mapError',e=>e.textContent);assert.match(error,message);assert.ok(!error.includes('SYNTHETIC-NOT-A-KEY'));
 await page.select('#fEstado','error');assert.equal(await page.$$eval('#tbodyDetalle tr[data-idx]',els=>els.length),1);
 await page.click('#btnRefresh');await page.waitForNetworkIdle({idleTime:100});assert.equal(await page.$eval('#kpiTotal',e=>e.textContent),'10');assert.equal(calls.filter(p=>p.endsWith('/maps-config')).length,1);assert.deepEqual(errors,[]);
});

test('gm_authFailure posterior limpia pins, popup y línea sin afectar detalle',async t=>{
 const {page,errors}=await harness(t);await page.waitForFunction(()=>window.syntheticMaps?.markers.length===4);await page.click('#tbodyDetalle tr[data-idx="0"]');
 await page.evaluate(()=>window.gm_authFailure());assert.match(await page.$eval('#mapError',e=>e.textContent),/no autorizó/);
 await page.evaluate(()=>window.syntheticRefresh());await page.waitForNetworkIdle({idleTime:100});
 assert.deepEqual(await page.evaluate(()=>({pins:syntheticMaps.markers.filter(m=>m.map).length,lines:syntheticMaps.lines.filter(m=>m.map).length,rows:document.querySelectorAll('#tbodyDetalle tr[data-idx]').length})),{pins:0,lines:0,rows:3});assert.deepEqual(errors,[]);
});

test('HTML móvil real conserva filtros combinados y acciones visibles',async t=>{
 const {page,errors}=await harness(t,{mobile:true});await page.waitForFunction(()=>window.syntheticMaps?.markers.length===4);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.select('#fCanal','sms');await page.select('#fEstado','error');await page.select('#fConv','no');
 await page.type('#fCliente','Rojo');await page.type('#fEstrategia','no-existe');assert.equal(await page.$$eval('#tbodyDetalle tr[data-idx]',els=>els.length),0);
 await page.click('#btnLimpiarFiltros');assert.equal(await page.$$eval('#tbodyDetalle tr[data-idx]',els=>els.length),3);
 await page.type('#fTelefono','549123');await page.$eval('#fDesde',e=>{e.value='2026-10-01';e.dispatchEvent(new Event('change'));});await page.$eval('#fHasta',e=>{e.value='2026-10-01';e.dispatchEvent(new Event('change'));});assert.equal(await page.$$eval('#tbodyDetalle tr[data-idx]',els=>els.length),2);
 await page.click('#tbodyDetalle tr[data-idx="0"]');assert.match(await page.$eval('.synthetic-popup',e=>e.textContent),/línea recta/);assert.deepEqual(errors,[]);
 if(process.env.MARKETING_MAP_SCREENSHOTS) {await page.evaluate(()=>{scrollTo(0,0);return new Promise(resolve=>requestAnimationFrame(resolve));});await page.screenshot({path:process.env.MARKETING_MAP_SCREENSHOTS+'/marketing-mobile.png',fullPage:true});}
});

test('seleccionar fila antes del SDK conserva foco cliente y chofer cuando termina la carga',async t=>{
 const {page,releaseSDK}=await harness(t,{sdkDelay:true});await page.waitForFunction(()=>document.querySelector('script[src*="maps.googleapis.com"]'));
 await page.click('#tbodyDetalle tr[data-idx="0"]');releaseSDK();await page.waitForFunction(()=>window.syntheticMaps?.markers.length===4);
 const result=await page.evaluate(()=>({bounds:syntheticMaps.maps[0].lastBounds,popup:document.querySelector('.synthetic-popup')?.textContent}));
 assert.deepEqual(result.bounds,[{lat:-24.79,lng:-65.41},{lat:-24.791,lng:-65.411}]);assert.match(result.popup,/Chofer más cercano/);
});

test('cambiar empresa durante SDK pendiente descarta datos anteriores y aplica sólo contexto actual',async t=>{
 const {page,releaseSDK,errors}=await harness(t,{sdkDelay:true});
 await page.waitForFunction(()=>document.querySelector('script[src*="maps.googleapis.com"]'));
 await page.type('#fCliente','Cliente');
 const cleared=await page.evaluate(()=>{document.querySelector('#empresa').value='2';document.querySelector('#empresa').dispatchEvent(new Event('change'));return {rows:document.querySelector('#tbodyDetalle').textContent,kpi:document.querySelector('#kpiTotal').textContent};});
 assert.ok(!cleared.rows.includes('Cliente 1'));assert.notEqual(cleared.kpi,'10');
 await page.waitForFunction(()=>document.querySelector('#kpiTotal').textContent==='20');
 releaseSDK();await page.waitForFunction(()=>window.syntheticMaps?.markers.length>0);
 const result=await page.evaluate(()=>({titles:syntheticMaps.markers.filter(m=>m.map).map(m=>m.title),filter:document.querySelector('#fCliente').value,rows:document.querySelector('#tbodyDetalle').textContent}));
 assert.ok(result.titles.some(t=>t.includes('Cliente 2')));assert.ok(result.titles.every(t=>!t.includes('Cliente 1')));assert.equal(result.filter,'Cliente');assert.match(result.rows,/Cliente 2/);assert.deepEqual(errors,[]);
});

test('requests tardíos de empresa anterior nunca pisan tablas, KPIs, selección ni mapa nuevo',async t=>{
 const releases=[];const {page,errors}=await harness(t,{ignoreAbort:true,apiDelay:async url=>{if(url.searchParams.get('empresa_id')==='2')await new Promise(resolve=>releases.push(resolve));}});
 await page.waitForFunction(()=>window.syntheticMaps?.markers.length===4);
 await page.click('#tbodyDetalle tr[data-idx="0"]');
 await page.evaluate(()=>{document.querySelector('#empresa').value='2';document.querySelector('#empresa').dispatchEvent(new Event('change'));});
 const cleared=await page.evaluate(()=>({markers:syntheticMaps.markers.filter(m=>m.map).length,lines:syntheticMaps.lines.filter(l=>l.map).length,popup:!!document.querySelector('.synthetic-popup'),rows:document.querySelector('#tbodyDetalle').textContent}));
 assert.equal(cleared.markers,0);assert.equal(cleared.lines,0);assert.equal(cleared.popup,false);assert.ok(!cleared.rows.includes('Cliente 1'));
 await page.select('#empresa','3');await page.waitForFunction(()=>document.querySelector('#kpiTotal').textContent==='30',{timeout:2500});
 assert.equal(releases.length,3,'Tres respuestas sintéticas antiguas permanecen pendientes aunque se abortó su signal');
 releases.forEach(resolve=>resolve());
 await page.waitForNetworkIdle({idleTime:100});
 const result=await page.evaluate(()=>({kpi:document.querySelector('#kpiTotal').textContent,rows:document.querySelector('#tbodyDetalle').textContent,titles:syntheticMaps.markers.filter(m=>m.map).map(m=>m.title),lines:syntheticMaps.lines.filter(l=>l.map).length,outlined:[...document.querySelectorAll('#tbodyDetalle tr')].some(tr=>tr.style.outline.includes('2px'))}));
 assert.equal(result.kpi,'30');assert.match(result.rows,/Cliente 3/);assert.ok(!result.rows.includes('Cliente 2'));assert.ok(result.titles.every(t=>!t.includes('Cliente 2')));assert.equal(result.lines,0);assert.equal(result.outlined,false);assert.deepEqual(errors,[]);
});

test('fila enfoca cliente y chofer cercano con popup seguro y línea recta; refresh preserva cámara, selección y filtros',async t=>{
 const {page,errors}=await harness(t);
 await page.waitForFunction(()=>window.syntheticMaps?.markers.length===4);
 await page.click('#tbodyDetalle tr[data-idx="0"]');
 await page.waitForFunction(()=>window.syntheticMaps.lines.some(l=>l.map),{timeout:1500});
 assert.ok(await page.evaluate(()=>syntheticMaps.maps[0].getZoom()<=16),'El foco limita zoom a 16 sin limitar zoom manual posterior');
 const before=await page.evaluate(()=>({line:syntheticMaps.lines.find(l=>l.map).path,popup:document.querySelector('.synthetic-popup').textContent,outline:document.querySelector('#tbodyDetalle tr').style.outline,colors:syntheticMaps.markers.filter(m=>m.map).map(m=>m.content.style.backgroundColor)}));
 assert.deepEqual(before.line,[{lat:-24.79,lng:-65.41},{lat:-24.791,lng:-65.411}]);assert.match(before.popup,/Chofer más cercano/);assert.match(before.popup,/0\.15 km/);assert.match(before.popup,/<img/);assert.match(before.popup,/<script>/);assert.ok(before.outline.includes('2px'));assert.ok(before.colors.includes('rgb(34, 197, 94)'));assert.ok(before.colors.includes('rgb(239, 68, 68)'));
 assert.equal(await page.evaluate(()=>!!window.injected||!!document.querySelector('.synthetic-popup img, .synthetic-popup script')),false);
 if(process.env.MARKETING_MAP_SCREENSHOTS) {await page.evaluate(()=>{scrollTo(0,0);return new Promise(resolve=>requestAnimationFrame(resolve));});await page.screenshot({path:process.env.MARKETING_MAP_SCREENSHOTS+'/marketing-desktop.png',fullPage:true});}
 await page.type('#fCliente','Cliente');
 await page.evaluate(()=>{syntheticMaps.maps[0].setCenter({lat:-20,lng:-60});syntheticMaps.maps[0].setZoom(10);window.syntheticRefresh();});
 await page.waitForFunction(()=>syntheticMaps.markers.length>=8);
 const after=await page.evaluate(()=>({center:syntheticMaps.maps[0].getCenter(),zoom:syntheticMaps.maps[0].getZoom(),active:syntheticMaps.markers.filter(m=>m.map).length,lines:syntheticMaps.lines.filter(l=>l.map).length,rows:document.querySelectorAll('#tbodyDetalle tr[data-idx]').length,outline:document.querySelector('#tbodyDetalle tr').style.outline,filter:document.querySelector('#fCliente').value}));
 assert.deepEqual(after.center,{lat:-20,lng:-60});assert.equal(after.zoom,10);assert.equal(after.active,4);assert.equal(after.lines,1);assert.equal(after.rows,2);assert.ok(after.outline.includes('2px'));assert.equal(after.filter,'Cliente');assert.deepEqual(errors,[]);
});

test('HTML real carga una sola SDK Google con libraries maps+marker y conserva KPIs',async t=>{
 const {page,calls,errors}=await harness(t);
 await page.waitForFunction(()=>window.syntheticMaps?.markers.length>0,{timeout:2500});
 const result=await page.evaluate(()=>({imports:syntheticMaps.imports,options:syntheticMaps.maps[0].options,count:syntheticMaps.markers.filter(m=>m.map).length}));
 assert.deepEqual(result.imports.sort(),['maps','marker']);assert.equal(result.options.mapId,'SYNTHETIC_MAP_ID');assert.equal(result.options.maxZoom,19);assert.equal(result.count,4);
 assert.equal(calls.filter(p=>p==='/maps/api/js').length,1);assert.equal(calls.filter(p=>p.endsWith('/maps-config')).length,1);assert.deepEqual(errors,[]);
 assert.ok(!calls.some(p=>/leaflet|tile\.openstreetmap/.test(p)));
});
