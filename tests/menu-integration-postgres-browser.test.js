import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import puppeteer from 'puppeteer';
import {withIsolatedPostgres,postgresOptions} from './support/isolated-postgres.js';

// Only the private cluster below may be queried. Fence default dotenv/DB/workers.
process.env.DOTENV_CONFIG_PATH='/dev/null';
process.env.DATABASE_URL='postgres://invalid:invalid@127.0.0.1:1/unused';
process.env.ENABLE_WPP='0';
if(process.env.TMPDIR){fs.mkdirSync(process.env.TMPDIR,{recursive:true});process.chdir(process.env.TMPDIR);}
const {createWithAuth}=await import('../src/core/auth.js');
const {withTransaction}=await import('../src/db.js');
const {createMenuRouter,createPublicMenuRouter}=await import('../src/routes/menu.js');
const {createPublicLegacyCatalogRouter}=await import('../src/routes/publicLegacyCatalog.js');
const {registerPublicLegacyCreatePedidoRoute}=await import('../src/routes/publicLegacyCreatePedido.js');
const {createTrackingPublicRouter}=await import('../src/trackingPublic.js');
const {toNum,inRange,round,buildOrderSummary}=await import('../src/public/pedidosLegacyHelpers.js');

const artifacts=path.join(process.env.TMPDIR||process.cwd(),'menu-scheduled-integration');
const root=new URL('../',import.meta.url);
const csrfSecret='synthetic-menu-integration-key';

test('HTML real Web y App → APIs canónicas → PostgreSQL UTF8 y seguimiento por capability',postgresOptions,async t=>{
 const oldFlag=process.env.SCHEDULED_MENUS_ENABLED;process.env.SCHEDULED_MENUS_ENABLED='1';
 t.after(()=>{if(oldFlag===undefined)delete process.env.SCHEDULED_MENUS_ENABLED;else process.env.SCHEDULED_MENUS_ENABLED=oldFlag;});
 await withIsolatedPostgres(async cluster=>{
  await cluster.query("CREATE DATABASE menu_browser_utf8 ENCODING 'UTF8' TEMPLATE template0");
  const pool=new pg.Pool({...cluster.options,database:'menu_browser_utf8'});
  try{
   await pool.query(fs.readFileSync(new URL('initDb.sql',root),'utf8'));
   await pool.query(`INSERT INTO empresas(id,nombre,landing_slug,plan_estado,plan_vencimiento,config_entrega,config_operativa)
    VALUES(9001,'Empresa sintética E2E','synthetic-menu-e2e','active','2099-01-01','{"dias_habiles":[0,1,2,3,4,5,6]}','{"pais":"Argentina","provincia":"Córdoba"}'),
    (9002,'Empresa aislada','synthetic-private-e2e','active','2099-01-01','{}','{}');
    INSERT INTO usuarios(id,username,password,role,empresa_id,activo) VALUES(9001,'synthetic-menu-admin','unused-synthetic-hash','admin',9001,true);`);
   const query=async(sql,params=[])=>(await pool.query(sql,params)).rows;
   const transaction=fn=>withTransaction(fn,{pool,maxRetries:0});
   const auth=createWithAuth({queryFn:query,jwtSecret:csrfSecret});
   const app=express();app.use(express.json());app.use(cookieParser());
   const notices=[];
   app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));
   app.use('/api/menu',createMenuRouter({query,withTransaction:transaction,withAuth:auth,checkLicencia:(_req,_res,next)=>next()}));
   app.use('/public',createPublicMenuRouter({query}));app.use('/api/public',createPublicMenuRouter({query}));
   app.use('/public',createPublicLegacyCatalogRouter({query,withTransaction:transaction}));
   app.use('/api/public',createPublicLegacyCatalogRouter({query,withTransaction:transaction}));
   app.use('/api/public',createTrackingPublicRouter({queryFn:query,mapsBrowserEnv:{}}));
   // This is a synthetic App customer-session fixture, not a customer-auth test.
   app.get(['/public/app/me','/api/public/app/me'],(_req,res)=>res.json({ok:true,profile:{cliente:'Cliente App sintético',telefono:'3515559001',direccion:'Fixture 1',ciudad:'Prueba'},session:{}}));
   app.get(['/public/app/orders','/api/public/app/orders'],(_req,res)=>res.json({orders:[]}));
   registerPublicLegacyCreatePedidoRoute(app,{query,pool,normalizePhone:value=>String(value||'').replace(/\D+/g,''),geocodeIfNeeded:async()=>null,pointInAnyZone:async()=>null,enqueueOrderConfirmationWppMessage:async message=>notices.push(message),enqueueWppMessage:async message=>notices.push(message),sendSmsViaIfttt:async()=>null,toNum,inRange,round,buildOrderSummary,getAliasEmpresa:async()=>null,ejecutarEstrategiaVecinosFn:async()=>null});
   app.use('/pedidos',express.static(new URL('pedidos/',root).pathname));
   const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
   const origin=`http://127.0.0.1:${server.address().port}`;
   const token=jwt.sign({uid:9001,role:'super',empresa_id:null},csrfSecret);
   const api=async(url,{method='GET',body}={})=>{const response=await fetch(origin+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
   let browser;
   try{
    const config=await api('/api/menu/config?empresa_id=9001',{method:'PUT',body:{enabled:true,timezone:'UTC',advance_enabled:true,max_advance_days:7,service_weekdays:[0,1,2,3,4,5,6]}});
    assert.equal(config.status,200,JSON.stringify(config.data));
    assert.equal((await api('/api/menu/config?empresa_id=9002',{method:'PUT',body:{enabled:true}})).status,403,'JWT claims never override canonical tenant');
    const readBack=await api('/api/menu/config');assert.equal(readBack.data.config.advance_enabled,true);assert.equal(readBack.data.empresa_id,9001);
    const today=new Date().toISOString().slice(0,10),next=new Date(today+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);const tomorrow=next.toISOString().slice(0,10);
    await pool.query(`INSERT INTO productos(id,empresa_id,nombre,precio,mostrar_en_catalogo,mostrar_en_landing,disponibilidad_config) VALUES
      (900155,9001,'Carta de hoy',100,true,true,$1::jsonb),
      (900156,9001,'Carta anticipada',200,true,true,$2::jsonb),
      (900255,9002,'Privado de otra empresa',5,true,true,'{}')`,[
       JSON.stringify({enabled:true,mode:'dates',dates:[today],open_days_before:7,daily_capacity:3}),
       JSON.stringify({enabled:true,mode:'dates',dates:[tomorrow],open_days_before:7,daily_capacity:3})]);
    const calendar=await api('/public/menu?empresa_id=9001');assert.ok(calendar.data.dates.includes(tomorrow));
    assert.deepEqual((await api('/public/productos?empresa_id=9001&scope=landing')).data.map(p=>p.id),[900155]);
    browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
    fs.mkdirSync(artifacts,{recursive:true});
    const results=[];
    for(const isApp of [false,true]){
     const page=await browser.newPage();page.setDefaultTimeout(6000);await page.emulateTimezone('Pacific/Honolulu');await page.setViewport({width:isApp?390:1280,height:900});
     await page.setRequestInterception(true);page.on('request',request=>request.url().startsWith(origin)||/^(about:|data:|blob:)/.test(request.url())?request.continue():request.abort());
     const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
     const url=origin+(isApp?'/pedidos/app/index.html':'/pedidos/index.html')+'?empresa_id=9001&fecha_entrega='+tomorrow+'&catalog_channel='+(isApp?'catalog':'landing');
     await page.goto(url);const add=isApp?'#productos button':'[data-action="add-to-cart"]';await page.waitForSelector(add);
     assert.equal(await page.$eval('[data-menu-date]',e=>e.value),tomorrow);
     assert.match(await page.$eval(isApp?'#productos':'#prodsList',e=>e.textContent),/Carta anticipada/);
     assert.doesNotMatch(await page.$eval(isApp?'#productos':'#prodsList',e=>e.textContent),/Carta de hoy|Privado de otra empresa/);
     await page.click(add);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
     await page.waitForFunction(()=>[...document.querySelectorAll('#prodsList .card')].every(card=>Number(getComputedStyle(card).opacity)>=0.99));
     await page.screenshot({path:path.join(artifacts,isApp?'app-mobile.png':'web-desktop.png'),fullPage:true});
     const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/public/pedidos'&&response.request().method()==='POST');
     if(isApp)await page.click('#btn-send');else{
      await page.evaluate(()=>{const e=document.querySelector('#form').elements.telefono;e.value='3515559002';e.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.waitForFunction(()=>!phoneLookupPending);
      await page.evaluate(()=>{for(const [name,value]of Object.entries({cliente:'Cliente Web sintético',direccion:'Fixture 2',ciudad:'Prueba'})){const e=document.querySelector('#form').elements[name];e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
     }
     const response=await responsePromise,result=await response.json();
     assert.equal(response.status(),200,JSON.stringify(result));assert.equal(result.pedido.fecha_entrega_programada,tomorrow);
     await page.waitForFunction(app=>document.querySelector(app?'#order-alert':'#toastMsg').textContent.includes('Pedido enviado'),{},isApp);
     assert.deepEqual(errors,[]);
     results.push({result,payload:JSON.parse(response.request().postData())});await page.close();
    }
    const rows=(await pool.query("SELECT id,empresa_id,to_char(fecha_entrega_programada,'YYYY-MM-DD') AS programada,to_char(fecha_entrega_estimada,'YYYY-MM-DD') AS estimada FROM pedidos WHERE empresa_id=9001 ORDER BY id")).rows;
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.programada===tomorrow&&row.estimada===tomorrow));
    assert.equal((await pool.query('SELECT reservado FROM menu_cupos_diarios WHERE empresa_id=9001 AND producto_id=900156')).rows[0].reservado,'2');
    for(const {result,payload}of results){
     const replay=await api('/public/pedidos?empresa_id=9001',{method:'POST',body:payload});assert.equal(replay.status,200);assert.equal(replay.data.created,false);
     assert.equal(replay.data.pedido.id,result.pedido.id);
     const order=(await pool.query('SELECT tracking_token FROM pedidos WHERE id=$1',[result.pedido.id])).rows[0];
     const tracking=await api('/api/public/tracking/'+order.tracking_token);assert.equal(tracking.status,200,JSON.stringify(tracking.data));assert.equal(tracking.data.pedido.fecha_entrega_programada,tomorrow);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos WHERE empresa_id=9001')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM menu_reservas_items WHERE empresa_id=9001 AND activa')).rows[0].n,2);
    await pool.query(`UPDATE productos SET promo_config=$1::jsonb WHERE id=900156`,[JSON.stringify({once_per_client_gift:{enabled:true,discount_amount:25}})]);
    const promotion={empresa_id:9001,cliente:'Cliente promoción sintético',telefono:'3515559003',direccion:'Fixture 3',ciudad:'Prueba',items:[{producto_id:900156,producto:'Carta anticipada',cantidad:1,precio_unitario:200}],fecha_entrega:tomorrow,catalog_channel:'landing',submission_id:'menu-e2e-discount-once'};
    const discounted=await api('/public/pedidos?empresa_id=9001',{method:'POST',body:promotion});
    assert.equal(discounted.status,200,JSON.stringify(discounted.data));assert.equal(Number(discounted.data.pedido.monto),175);
    const adjustment=(await pool.query('SELECT producto_id,cantidad,precio_unitario FROM items_pedido WHERE pedido_id=$1 AND precio_unitario<0',[discounted.data.pedido.id])).rows;
    assert.equal(adjustment.length,1);assert.equal(adjustment[0].producto_id,null);assert.equal(Number(adjustment[0].precio_unitario),-25);
    assert.equal((await pool.query('SELECT reservado FROM menu_cupos_diarios WHERE empresa_id=9001 AND producto_id=900156')).rows[0].reservado,'3','Sólo las unidades físicas consumen cupo, no el descuento');
    const notified=notices.length;
    const exhausted=await api('/public/pedidos?empresa_id=9001',{method:'POST',body:{...promotion,telefono:'3515559004',submission_id:'menu-e2e-exhausted'}});
    assert.equal(exhausted.status,409);assert.equal(notices.length,notified);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos WHERE empresa_id=9001')).rows[0].n,3);
    await pool.query(`INSERT INTO productos(id,empresa_id,nombre,precio,mostrar_en_catalogo,mostrar_en_landing,disponibilidad_config) VALUES(900157,9001,'Producto por peso',100,true,true,$1::jsonb)`,[JSON.stringify({enabled:true,mode:'dates',dates:[tomorrow],open_days_before:7,daily_capacity:.3})]);
    const fractional={...promotion,cliente:'Cliente por peso sintético',telefono:'3515559005',submission_id:'menu-e2e-fractional',items:[{producto_id:900157,producto:'Producto por peso',cantidad:.1,precio_unitario:100},{producto_id:900157,producto:'Producto por peso',cantidad:.2,precio_unitario:100}]};
    const weight=await api('/public/pedidos?empresa_id=9001',{method:'POST',body:fractional});assert.equal(weight.status,200,JSON.stringify(weight.data));
    assert.equal(Number((await pool.query('SELECT reservado FROM menu_cupos_diarios WHERE empresa_id=9001 AND producto_id=900157')).rows[0].reservado),.3);
    const mergedReplay=await api('/public/pedidos?empresa_id=9001',{method:'POST',body:{...fractional,items:[{...fractional.items[0],cantidad:.3}]}});assert.equal(mergedReplay.status,200,JSON.stringify(mergedReplay.data));assert.equal(mergedReplay.data.created,false);assert.equal(mergedReplay.data.pedido.id,weight.data.pedido.id);
    console.log('Integración real: Web + App, pedidos anticipados, replay, descuento, cupo decimal y seguimiento; PostgreSQL UTF8 desechable. Capturas:',artifacts);
   }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }finally{await pool.end();}
 });
});
