// Opt-in real Google SDK smoke. All application traffic and business rows are synthetic.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import puppeteer from 'puppeteer';
import {createWithAuth} from '../../src/core/auth.js';
import {createSetupRouter} from '../../src/routes/setup.js';
const root=path.resolve(new URL('../..',import.meta.url).pathname);
const env=dotenv.parse(fs.readFileSync(path.join(root,'.env')));
const apiKey=String(env.GOOGLE_MAPS_BROWSER_API_KEY||'').trim();
assert.ok(apiKey,'Falta la clave de navegador; no se admite fallback backend');
const output=path.join(process.env.TMPDIR,'marketing-google-live');fs.mkdirSync(output,{recursive:true});
const origin='https://www.pedivoy.com';
const identity={id:99001,role:'super',empresa_id:null,activo:true,chofer_id:null,referente_id:null};
const secret='synthetic-marketing-google-smoke-signing';
const noBusiness=async()=>{throw new Error('No business database in this smoke');};
const app=express();
app.use('/api/setup',createSetupRouter({query:noBusiness,withTransaction:noBusiness,getEmpresaIdFromToken:req=>req.user.empresa_id,
 withAuth:createWithAuth({jwtSecret:secret,queryFn:async(_sql,params)=>params[0]===identity.id?[identity]:[]}),
 mapsBrowserEnv:{GOOGLE_MAPS_BROWSER_API_KEY:apiKey,GOOGLE_MAPS_MAP_ID:env.GOOGLE_MAPS_MAP_ID}}));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const auth='Bearer '+jwt.sign({uid:identity.id,role:'super'},secret);
const local=`http://127.0.0.1:${server.address().port}`;
const detail=company=>[
 {cliente_id:101,cliente:`Cliente sintético ${company}`,cliente_lat:-24.79,cliente_lng:-65.41,telefono:'0000000000',direccion:'Dirección sintética',convirtio:true,estado:'sent',canal:'whatsapp',estrategia:'base',created_at:new Date().toISOString()},
 {cliente_id:102,cliente:`Sin conversión ${company}`,cliente_lat:-24.8,cliente_lng:-65.42,convirtio:false,estado:'error',canal:'sms',estrategia:'base',created_at:new Date().toISOString()},
];
let browser,page;const errors=[],writes=[];let configRequests=0;
try{
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
 page=await browser.newPage();await page.setViewport({width:1280,height:1000});
 page.on('pageerror',()=>errors.push('pageerror'));
 page.on('console',message=>{const code=message.text().match(/Google Maps JavaScript API error:\s*(\w+)/);if(code)errors.push(code[1]);});
 await page.evaluateOnNewDocument(()=>{
  Object.defineProperty(window,'marketingGoogleMapsReady',{configurable:true,set(callback){
   Object.defineProperty(window,'marketingGoogleMapsReady',{configurable:true,writable:true,value:()=>{
    const original=google.maps.importLibrary.bind(google.maps);
    google.maps.importLibrary=async name=>{
     const lib=await original(name);
     if(name!=='maps')return lib;
     return {...lib,Map:class extends lib.Map{constructor(...args){super(...args);window.liveMarketingMap=this;google.maps.event.addListener(this,'tilesloaded',()=>window.liveMarketingTiles=true);}}};
    };
    callback();
   }});
  }});
 });
 await page.setRequestInterception(true);
 page.on('request',async request=>{
  try{
   const url=new URL(request.url());
   if(url.origin!==origin){
    if(/(^|\.)(googleapis\.com|gstatic\.com|google\.com|googleusercontent\.com)$/.test(url.hostname))return request.continue();
    return request.abort();
   }
   if(request.method()!=='GET'){writes.push(url.pathname);return request.respond({status:405,body:''});}
   if(url.pathname.startsWith('/api/')){
    const company=url.searchParams.get('empresa_id')||'1';let body,status=200;
    if(url.pathname==='/api/setup/marketing/maps-config'){
     configRequests++;const response=await fetch(local+url.pathname,{headers:{Authorization:auth}});status=response.status;body=await response.json();
    }else if(url.pathname==='/api/me')body={user:identity};
    else if(url.pathname==='/api/empresas')body=[{id:1,nombre:'Empresa sintética Uno'},{id:2,nombre:'Empresa sintética Dos'}];
    else if(url.pathname==='/api/setup/marketing/telemetria')body={ok:true,totales:{total:Number(company)*10,exitosos:2,fallidos:1,costo_total:12},items:[{estrategia:'base',canal:'whatsapp',total:3,exitosos:2,fallidos:1}]};
    else if(url.pathname==='/api/setup/marketing/detalle')body={ok:true,items:detail(company)};
    else if(url.pathname==='/api/track/live')body={items:[{chofer_id:31,chofer_nombre:'Repartidor sintético',pedido_id:901,latitud:-24.791,longitud:-65.411,estado:'en_ruta'}]};
    else {status=404;body={error:'Unknown synthetic endpoint'};}
    return request.respond({status,contentType:'application/json',body:JSON.stringify(body)});
   }
   const file=path.resolve(root,'.'+url.pathname);
   if(!file.startsWith(root+path.sep))return request.respond({status:404,body:''});
   let body;try{body=fs.readFileSync(file);}catch{return request.respond({status:404,body:''});}
   const type=file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'image/png';
   return request.respond({status:200,contentType:type,body});
  }catch{errors.push('fixture_request_failed');if(!request.isInterceptResolutionHandled())await request.abort();}
 });
 await page.goto(origin+'/pedidos/inicio/marketing-telemetria.html',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.liveMarketingMap&&window.liveMarketingTiles&&document.querySelectorAll('.marketing-map-pin').length===3,{timeout:45000});
 assert.equal(await page.$eval('#mapError',e=>e.hidden),true);
 await page.click('#tbodyDetalle tr[data-idx="0"]');
 await page.waitForFunction(()=>document.querySelector('.gm-style-iw')?.textContent.includes('Chofer más cercano'),{timeout:10000});
 assert.match(await page.$eval('.marketing-map-popup',e=>e.textContent),/distancia en línea recta/);
 await page.evaluate(()=>new Promise(resolve=>{google.maps.event.addListenerOnce(liveMarketingMap,'idle',resolve);liveMarketingMap.setCenter({lat:-24.8,lng:-65.42});liveMarketingMap.setZoom(13);}));
 const previous=await page.evaluate(()=>({center:liveMarketingMap.getCenter().toJSON(),zoom:liveMarketingMap.getZoom()}));
 await page.click('#btnRefresh');await page.waitForNetworkIdle({idleTime:700,timeout:20000});
 const after=await page.evaluate(()=>({center:liveMarketingMap.getCenter().toJSON(),zoom:liveMarketingMap.getZoom()}));
 assert.ok(Math.abs(previous.center.lat-after.center.lat)<0.000001&&Math.abs(previous.center.lng-after.center.lng)<0.000001);
 assert.equal(after.zoom,previous.zoom);
 await page.evaluate(()=>document.getElementById('map').scrollIntoView({block:'center'}));
 await page.screenshot({path:path.join(output,'marketing-desktop.png')});
 await page.setViewport({width:390,height:844});
 await page.select('#fCanal','sms');assert.equal(await page.$$eval('#tbodyDetalle tr[data-idx]',rows=>rows.length),1);
 await page.click('#btnLimpiarFiltros');assert.equal(await page.$$eval('#tbodyDetalle tr[data-idx]',rows=>rows.length),2);
 await page.select('#empresa','2');await page.waitForFunction(()=>document.getElementById('kpiTotal').textContent==='20');
 await page.waitForFunction(()=>document.querySelectorAll('.marketing-map-pin').length===3);
 await page.click('#tbodyDetalle tr[data-idx="0"]');
 await page.waitForFunction(()=>document.querySelector('.marketing-map-popup')?.textContent.includes('Cliente sintético 2'));
 await page.waitForFunction(()=>{const popup=document.querySelector('.gm-style-iw-c')?.getBoundingClientRect(),map=document.getElementById('map').getBoundingClientRect();return popup&&popup.top>=map.top&&popup.bottom<=map.bottom;},{timeout:3000});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.evaluate(()=>document.getElementById('map').scrollIntoView({block:'center'}));
 await page.screenshot({path:path.join(output,'marketing-mobile.png')});
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.equal(configRequests,1);
 console.log(JSON.stringify({sdk:'Google Maps real',origin,configurationSource:'Clave browser de .env local servida por router real con autenticación super sintética',businessData:'Sólo fixtures; ninguna solicitud a la aplicación productiva',tilesLoaded:true,clientsAndDriver:true,nearestDriverPopup:true,refreshPreservesCamera:true,companySwitch:true,filters:true,mobile:true,configRequests,writes,errors,screenshots:[path.join(output,'marketing-desktop.png'),path.join(output,'marketing-mobile.png')]}));
}catch(error){
 console.error(JSON.stringify({failed:true,errorType:error.name,providerCodes:errors,message:'Smoke incompleto; diagnósticos privados suprimidos'}));process.exitCode=1;
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
