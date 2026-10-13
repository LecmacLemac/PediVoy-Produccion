// Opt-in real Google SDK smoke. Only synthetic order/token/location fixtures.
// Uses local public capability validation and .env browser key, not Render config.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { createTrackingPublicRouter } from '../../src/trackingPublic.js';

const root=path.resolve(new URL('../..',import.meta.url).pathname);
const env=dotenv.parse(fs.readFileSync(path.join(root,'.env')));
const key=env.GOOGLE_MAPS_BROWSER_API_KEY?.trim();
assert.ok(key,'GOOGLE_MAPS_BROWSER_API_KEY requerida; sin fallback');
const fixtureToken='synthetic-follow-token';let stale=false;
const queryFn=async(sql,args)=>{
 if(sql.includes('FROM pedidos p'))return args[0]===fixtureToken?[{id:901,empresa_id:7,estado:'en_ruta',fecha:new Date().toISOString(),cliente:'Cliente de prueba',direccion:'Dirección sintética',dest_lat:-31.421,dest_lng:-64.189,chofer_nombre:'Repartidor de prueba',chofer_tel:'3515551234',empresa_nombre:'Empresa de prueba',metodo_pago:'efectivo',monto:1000}]:[];
 if(sql.includes('FROM pedido_track_points'))return [{latitud:-31.416,longitud:-64.184,timestamp:new Date(Date.now()-(stale?600000:0)).toISOString()}];
 if(sql.includes('FROM items_pedido'))return [{producto:'Producto sintético',cantidad:1,precio_unitario:1000}];
 if(sql.includes('FROM pedido_pagos'))return [];
 throw new Error('Unexpected fixture query');
};
const app=express();app.use('/api/public',createTrackingPublicRouter({queryFn,mapsBrowserEnv:{GOOGLE_MAPS_BROWSER_API_KEY:key,GOOGLE_MAPS_MAP_ID:env.GOOGLE_MAPS_MAP_ID}}));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const local=`http://127.0.0.1:${server.address().port}`;
let browser;let page;const errors=[];
try{
 browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-setuid-sandbox']});
 page=await browser.newPage();await page.setViewport({width:390,height:844});
 page.on('pageerror',e=>errors.push(String(e.message).split(key).join('[OCULTO]')));
 page.on('console',msg=>{const code=msg.text().match(/Google Maps JavaScript API error:\s*(\w+)/);if(code)errors.push(code[1]);});
 await page.goto('https://www.pedivoy.com/',{waitUntil:'domcontentloaded',timeout:30000});
 const origin=await page.evaluate(()=>location.origin);assert.equal(origin,'https://www.pedivoy.com');
 await page.evaluate(token=>history.replaceState(null,'','/pedidos/seguimiento.html?t='+encodeURIComponent(token)),fixtureToken);
 await page.setRequestInterception(true);
 page.on('request',async request=>{
  const url=new URL(request.url());
  if(url.origin!==origin||!url.pathname.startsWith('/api/public/tracking/'))return request.continue();
  if(request.method()!=='GET')return request.abort();
  const response=await fetch(local+url.pathname+url.search);
  const body=await response.text();
  return request.respond({status:response.status,contentType:'application/json',body});
 });
 let html=fs.readFileSync(path.join(root,'pedidos/seguimiento.html'),'utf8');
 html=html.replace('<script src="/pedidos/seguimiento-google-map.js"></script>',()=>'<script>'+fs.readFileSync(path.join(root,'pedidos/seguimiento-google-map.js'),'utf8')+'</script>');
 await page.setContent(html,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>typeof driverMarker!=='undefined'&&!!driverMarker,{timeout:30000});
 await page.evaluate(()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Google tiles timeout')),20000);google.maps.event.addListenerOnce(map,'tilesloaded',()=>{clearTimeout(timer);resolve();});map.setZoom(15);}));
 assert.equal(await page.evaluate(()=>seguimientoGoogleAuthFailed),false);
 assert.equal(await page.$eval('#lblCliente',el=>el.textContent),'Hola Cliente de prueba');
 assert.equal(await page.evaluate(()=>!!driverMarker && !!destMarker && !!trajectoryLine),true);
 await page.click('#toggleDetails');await page.waitForFunction(()=>document.getElementById('hudCard').classList.contains('compact'));
 await new Promise(resolve=>setTimeout(resolve,400));
 // Google attribution remains above the floating card.
 assert.equal(await page.evaluate(()=>document.getElementById('map').getBoundingClientRect().bottom<=document.getElementById('hudCard').getBoundingClientRect().top),true);
 const screenshot=path.join(process.env.TMPDIR,'seguimiento-google-piloto.png');await page.screenshot({path:screenshot});
 await page.evaluate(()=>{map.setCenter({lat:-31.43,lng:-64.2});map.setZoom(13);});
 await page.evaluate(()=>updateTracking());assert.equal(await page.evaluate(()=>map.getZoom()),13);
 assert.equal(await page.evaluate(()=>Math.abs(map.getCenter().lat()+31.43)<.00001),true);
 stale=true;await page.evaluate(()=>updateTracking());assert.equal(await page.evaluate(()=>driverMarker),null);assert.equal(await page.evaluate(()=>trajectoryLine),null);
 await page.setViewport({width:1100,height:800});await page.evaluate(()=>resizeSeguimientoMap());
 assert.equal(await page.$eval('#googleMapError',el=>el.hidden),true);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({sdk:'Google Maps real',origin,credentialSource:'local browser key',orderData:'synthetic, local router capability; not Render verification',tilesLoaded:true,driverAndDestination:true,staleLocationHidden:true,cameraPreserved:true,contacts:true,mobileAndDesktop:true,attributionNotCovered:true,errors,screenshot},null,2));
}catch(error){console.error(String(error.message).split(key).join('[OCULTO]'));console.log('Browser errors:',errors);if(page)console.log(await page.evaluate(()=>document.getElementById('googleMapError')?.textContent));process.exitCode=1;}
finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
