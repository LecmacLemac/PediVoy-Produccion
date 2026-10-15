import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
let browser,server,origin;
// Synthetic rows mirror service.listAudit's public SELECT/envelope (no status field).
const connectionId='00000000-0000-4000-8000-000000000001';
const auditEvents=['ok','error','replayed'].map((outcome,index)=>({id:String(6-index),connection_id:connectionId,empresa_id:7,tool:'tomar_pedido',scope:'deliveries:claim',outcome,created_at:'2026-10-15T12:00:00.000Z'}));
const state={role:'user',enabled:true,status:200,connections:[],creates:[],revokes:0,audits:0,events:auditEvents,holdCreate:false,pendingCreate:null};
test.before(async()=>{
 const app=express();app.use(express.json());
 app.get('/api/me',(req,res)=>res.status(state.status).json(state.status===200?{user:{id:1,rol:state.role,empresa_id:7}}:{error:{code:'DENIED',message:'denied'}}));
 app.get('/api/mi-agente/policy',(req,res)=>res.json({enabled:state.enabled,canonicalOrigin:'https://pedivoy.example',maxConnections:5,maxExpiryDays:30,scopes:[{scope:'identity:read',label:'Identidad',description:'Tu perfil',write:false,roles:[state.role]},...Object.entries({'catalog:read':['user','admin','super','referente'],'orders:read':['user','admin','super'],'deliveries:read':['repartidor'],'referrals:read':['referente'],'billing:read':['user','facturacion','contable','admin','super'],'deliveries:claim':['repartidor'],'orders:reopen':['admin','super']}).filter(([,roles])=>roles.includes(state.role)).map(([scope,roles])=>({scope,roles,label:scope,description:'Permiso sintético',write:['deliveries:claim','orders:reopen'].includes(scope)}))]}));
 app.get('/api/mi-agente/connections',(req,res)=>res.json({connections:state.connections}));
 app.post('/api/mi-agente/connections',(req,res)=>{assert.equal(req.headers.origin,origin);state.creates.push(req.body);const connection={id:1,name:req.body.name,scopes:req.body.scopes,created_at:'2026-10-15',expires_at:'2026-10-22'};state.connections=[connection];const respond=()=>{state.pendingCreate=null;res.json({connection,token:'synthetic-secret'});};if(state.holdCreate)state.pendingCreate=respond;else respond();});
 app.post('/api/mi-agente/connections/:id/revoke',(req,res)=>{state.revokes++;state.connections[0].revoked_at='2026-10-15';res.json({ok:true});});
 app.get('/api/mi-agente/audit',(req,res)=>{state.audits++;const before=req.query.before;if(before)assert.equal(before,'4');res.json({events:state.events.map(event=>({...event,id:before?String(Number(event.id)-3):event.id})),next_cursor:before?null:'4'});});
 app.use('/pedidos',express.static(path.join(root,'pedidos')));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
});
test.after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(r=>server?.close(r));});
async function page(t){const p=await browser.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('status of 4'))errors.push(m.text());});await p.setRequestInterception(true);p.on('request',r=>r.url().startsWith(origin)?r.continue():r.abort());t.after(async()=>{assert.deepEqual(errors,[]);await p.close();});return p;}
const ready=async p=>{await p.goto(`${origin}/pedidos/mi-agente.html`);await p.waitForFunction(()=>document.querySelector('#status')?.dataset.ready==='true');};
test('personal UI creates one-time token, copies explicitly, clears on close, revokes and paginates audit',async t=>{
 state.role='user';state.enabled=true;state.status=200;state.connections=[];
 const p=await page(t);await p.setViewport({width:1440,height:1000});await ready(p);
 assert.equal(await p.$eval('#company-field',e=>getComputedStyle(e).display),'none');
 await p.type('#name','Mi asistente');await p.click('#create');await p.waitForSelector('#token-dialog[open]');
 assert.equal(await p.$eval('#token',e=>e.value),'synthetic-secret');
 assert.deepEqual(await p.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
 await p.evaluate(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copied.push(value);}},configurable:true});});
 assert.equal(await p.$eval('#secret-config',e=>getComputedStyle(e).display),'none');
 await p.click('#copy-token');await p.waitForFunction(()=>window.copied.length===1);
 await p.click('#export-config');assert.ok((await p.$eval('#secret-config',e=>e.value)).includes('synthetic-secret'));
 await p.click('#copy-config');await p.waitForFunction(()=>window.copied.length===2);
 assert.equal(await p.evaluate(()=>window.copied[0]),'synthetic-secret');
 await p.click('#close-token');assert.equal(await p.$eval('#token',e=>e.value),'');
 await p.waitForSelector('[data-revoke]');p.once('dialog',d=>d.accept());await p.click('[data-revoke]');await p.waitForFunction(()=>document.querySelector('#connections').textContent.includes('Revocada'));
 await p.click('#more-audit');await p.waitForFunction(()=>document.querySelectorAll('#audit li').length===6);
 assert.equal(await p.$eval('#more-audit',e=>e.hidden),true);
 await p.screenshot({path:path.join(process.env.TMPDIR,'mi-agente-desktop.png'),fullPage:true});
 await p.setViewport({width:390,height:844});await p.screenshot({path:path.join(process.env.TMPDIR,'mi-agente-mobile.png'),fullPage:true});
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(state.creates.at(-1).empresa_id,undefined);assert.equal(state.revokes,1);
});
for(const lifecycle of ['hidden','hidden then visible','pagehide'])test(`late creation discards token after ${lifecycle} without recreating the connection`,async t=>{
 state.role='user';state.enabled=true;state.status=200;state.connections=[];
 const p=await page(t),other=await browser.newPage();
 const createsBefore=state.creates.length,revokesBefore=state.revokes;
 try{
   await p.bringToFront();await ready(p);
   // Keep only a test-local reference to the synthetic response to check erasure.
   await p.evaluate(()=>{
     const original=window.fetch;
     window.fetch=async(...args)=>{
       const response=await original(...args);
       if(args[0]==='/api/mi-agente/connections'&&args[1]?.method==='POST'){
         const json=response.json.bind(response);
         response.json=async()=>{window.creationResult=await json();return window.creationResult;};
       }
       return response;
     };
     window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.copied.push(value)},configurable:true});
   });
   state.holdCreate=true;
   await p.type('#name','Alta demorada');await p.click('#create');
   await p.waitForFunction(()=>document.querySelector('#create').disabled);
   // The HTTP handler has created the synthetic connection, but holds its response.
   await new Promise((resolve,reject)=>{
     const deadline=Date.now()+5000;
     const poll=()=>state.pendingCreate?resolve():Date.now()>deadline?reject(new Error('Held POST did not arrive')):setTimeout(poll,10);
     poll();
   });
   if(lifecycle==='pagehide'){
     // Isolate pagehide while still visible (e.g. a persisted page lifecycle).
     await p.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
   }else{
     await other.bringToFront();await p.waitForFunction(()=>document.hidden);
     if(lifecycle==='hidden then visible'){
       await p.bringToFront();await p.waitForFunction(()=>!document.hidden);
     }
   }
   state.pendingCreate();
   await p.waitForFunction(()=>!document.querySelector('#create').disabled,{polling:20,timeout:5000});
   assert.equal(await p.evaluate(()=>document.hidden),lifecycle==='hidden');
   assert.deepEqual(await p.evaluate(()=>({dialog:document.querySelector('#token-dialog').open,token:!!document.querySelector('#token').value,config:!!document.querySelector('#secret-config').value})),{dialog:false,token:false,config:false});
   assert.equal(await p.evaluate(()=>window.creationResult.token===''),true);
   assert.match(await p.$eval('#status',e=>e.textContent),/se creó|puede haberse creado/i);
   assert.match(await p.$eval('#status',e=>e.textContent),/token descartado.*revis.*revoc.*antes/i);
   assert.deepEqual(await p.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
   await p.bringToFront();await p.waitForFunction(()=>!document.hidden);
   await p.evaluate(()=>{document.querySelector('#copy-token').click();document.querySelector('#export-config').click();});
   assert.equal(await p.evaluate(()=>window.copied.length),0);
   assert.equal(await p.$eval('#secret-config',e=>e.value===''),true);
   await p.click('#refresh');await p.waitForFunction(()=>!document.querySelector('#refresh').disabled);await p.waitForSelector('[data-revoke]');
   p.once('dialog',d=>d.accept());await p.click('[data-revoke]');
   await p.waitForFunction(()=>document.querySelector('#connections').textContent.includes('Revocada'));
   assert.equal(state.creates.length-createsBefore,1);assert.equal(state.revokes-revokesBefore,1);
 }finally{
   state.holdCreate=false;state.pendingCreate?.();state.pendingCreate=null;
   await other.close();
 }
});

test('audit renders the backend outcome for success, error and replay without extra secret or PII fields',async t=>{
 state.role='user';state.enabled=true;state.status=200;state.connections=[];
 // Deliberately hostile extra fields test the renderer's allowlist, not the API contract.
 state.events=auditEvents.map(event=>({...event,status:'legacy-status-must-not-render',secret:'secret-must-not-render',arguments:{email:'synthetic-customer@example.invalid'},result:{phone:'synthetic-phone-must-not-render'}}));
 t.after(()=>{state.events=auditEvents;});
 const p=await page(t);await ready(p);
 const rows=await p.$$eval('#audit li',els=>els.map(e=>e.textContent));
 assert.equal(rows.length,3);
 for(const [index,outcome] of ['ok','error','replayed'].entries())assert.ok(rows[index].includes(` · tomar_pedido · ${outcome} · Conexión ${connectionId}`));
 assert.doesNotMatch(await p.content(),/legacy-status-must-not-render|secret-must-not-render|synthetic-customer@example\.invalid|synthetic-phone-must-not-render/);
});
test('connections do not advertise a last-use date absent from the backend contract',async t=>{
 state.role='user';state.enabled=true;state.status=200;
 state.connections=[{id:connectionId,name:'Conexión sintética',scopes:['identity:read'],empresa_id:7,role_at_issue:'user',created_at:'2026-10-15T12:00:00.000Z',expires_at:'2099-10-22T12:00:00.000Z',revoked_at:null}];
 const p=await page(t);await ready(p);
 const text=await p.$eval('#connections',e=>e.textContent);
 assert.match(text,/Vence:/);
 assert.doesNotMatch(text,/Último uso/);
});
test('delivery write permissions are opt-in, super must select explicit company, disabled feature preserves revocation access',async t=>{
 state.connections=[];state.role='repartidor';const p=await page(t);await ready(p);
 assert.equal(await p.$eval('input[value="deliveries:claim"]',e=>e.checked),false);
 state.role='super';await ready(p);assert.notEqual(await p.$eval('#company-field',e=>getComputedStyle(e).display),'none');assert.equal(await p.$eval('#empresa-id',e=>e.required),true);
 state.enabled=false;await ready(p);assert.equal(await p.$eval('#create',e=>e.disabled),true);assert.match(await p.$eval('#status',e=>e.textContent),/no disponible|deshabilitad/i);
 state.enabled=true;
});
for(const [role,expected] of Object.entries({user:['identity:read','catalog:read','orders:read','billing:read'],repartidor:['identity:read','deliveries:read','deliveries:claim'],referente:['identity:read','catalog:read','referrals:read'],facturacion:['identity:read','billing:read'],contable:['identity:read','billing:read'],admin:['identity:read','catalog:read','orders:read','billing:read','orders:reopen'],super:['identity:read','catalog:read','orders:read','billing:read','orders:reopen']}))test(`role ${role} exposes only its policy scopes with writes unchecked`,async t=>{
 state.role=role;state.status=200;state.enabled=true;state.connections=[];const p=await page(t);await ready(p);
 assert.deepEqual(await p.$$eval('#scopes input',els=>els.map(e=>e.value)),expected);
 assert.equal(await p.$$eval('#scopes input',els=>els.filter(e=>e.value.endsWith(':claim')||e.value.endsWith(':reopen')).some(e=>e.checked)),false);
});
test('connection names are literal text and Escape clears all secret fields',async t=>{
 state.role='user';state.connections=[{id:99,name:'<img src=x onerror=alert(1)>',scopes:['identity:read']}];const p=await page(t);await ready(p);
 assert.equal(await p.$('#connections img'),null);assert.ok((await p.$eval('#connections',e=>e.textContent)).includes('<img'));
 await p.type('#name','Escape test');await p.click('#create');await p.waitForSelector('#token-dialog[open]');await p.click('#export-config');await p.keyboard.press('Escape');
 await p.waitForFunction(()=>!document.querySelector('#token-dialog').open);
 assert.equal(await p.$eval('#token',e=>e.value),'');assert.equal(await p.$eval('#secret-config',e=>e.value),'');
});
for(const status of [401,402,403])test(`HTTP ${status} has distinct session/access/license feedback`,async t=>{
 state.status=status;const p=await page(t);await p.goto(`${origin}/pedidos/mi-agente.html`);
 if(status===401){await p.waitForFunction(()=>location.pathname.endsWith('/login.html'));assert.ok(p.url().includes('next=%2Fpedidos%2Fmi-agente.html'));}
 else {await p.waitForSelector('#status[data-ready="true"]');assert.match(await p.$eval('#status',e=>e.textContent),status===402?/licencia/i:/permiso/i);}
 state.status=200;
});
