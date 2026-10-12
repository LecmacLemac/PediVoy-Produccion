// Opt-in isolated UI smoke on an allowed website origin. Does not write to production.
// Uses real Google SDK + actual HTML/renderer; identity/business records are synthetic.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';
import { createWithAuth } from '../../src/core/auth.js';
import { createChoferesRouter } from '../../src/routes/choferes.js';

const root=path.resolve(new URL('../..',import.meta.url).pathname);
const env=dotenv.parse(fs.readFileSync(path.join(root,'.env')));
const key=env.GOOGLE_MAPS_BROWSER_API_KEY?.trim();
assert.ok(key,'Se requiere GOOGLE_MAPS_BROWSER_API_KEY en .env; no se sustituye por otra clave');
const secret='synthetic-choferes-smoke-only';
const user={id:1,role:'admin',empresa_id:7,chofer_id:null,referente_id:null,activo:true};
const app=express();
app.use('/api',createChoferesRouter({query:async()=>{throw new Error('No production DB in smoke');},withAuth:createWithAuth({jwtSecret:secret,queryFn:async(_sql,args)=>args[0]===1?[user]:[]}),isSuper:req=>req.user.role==='super',getEmpresaIdFromToken:req=>req.user.empresa_id,mapsBrowserEnv:{GOOGLE_MAPS_BROWSER_API_KEY:key,GOOGLE_MAPS_MAP_ID:env.GOOGLE_MAPS_MAP_ID}}));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const local=`http://127.0.0.1:${server.address().port}`;
const item={pedido_id:5001,chofer_id:10,chofer_nombre:'Chofer de prueba',cliente:'Cliente de prueba',estado:'en_ruta',latitud:-31.416,longitud:-64.184,dest_lat:-31.42,dest_lng:-64.189,timestamp:new Date().toISOString(),telefono:'3515551234'};
let browser;
let page;
const errors=[];
try{
 browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-setuid-sandbox']});
 page=await browser.newPage();await page.setViewport({width:1200,height:900});
 page.on('pageerror',error=>errors.push(String(error.message).split(key).join('[OCULTO]')));
 page.on('console',msg=>{const code=msg.text().match(/Google Maps JavaScript API error:\s*(\w+)/);if(code)errors.push(code[1]);});
 await page.goto('https://www.pedivoy.com/',{waitUntil:'domcontentloaded',timeout:30000});
 const origin=await page.evaluate(()=>location.origin);assert.equal(origin,'https://www.pedivoy.com');
 // Business/API responses below are explicit synthetic fixtures, never production data.
 await page.setRequestInterception(true);
 page.on('request',async request=>{
  const url=new URL(request.url());
  if(url.origin!==origin || !url.pathname.startsWith('/api/'))return request.continue();
  let body={ok:true,items:[]};let status=200;
  if(url.pathname==='/api/choferes/maps-config'){
   const response=await fetch(local+url.pathname,{headers:{authorization:'Bearer '+jwt.sign({uid:1,role:'admin'},secret)}});
   status=response.status;body=await response.json();
  } else if(url.pathname==='/api/me')body={user};
  else if(url.pathname==='/api/choferes')body=[{id:10,nombre:'Chofer de prueba',telefono:'3515551234',tipo:'propio'}];
  else if(url.pathname==='/api/track/live')body={ok:true,items:[item]};
  else if(url.pathname==='/api/track/drivers/live')body={ok:true,items:[{...item}]};
  else if(request.method()!=='GET') { errors.push('Unexpected write request'); status=405; }
  return request.respond({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 let html=fs.readFileSync(path.join(root,'pedidos/inicio/choferes.html'),'utf8');
 html=html.replace('<script src="/pedidos/inicio/choferes-google-map.js"></script>',()=>'<script>'+fs.readFileSync(path.join(root,'pedidos/inicio/choferes-google-map.js'),'utf8')+'</script>');
 html=html.replace('    // --- Init ---','    window.choferesSmokeLoaded = true;\n    // --- Init ---');
 await page.setContent(html,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.choferesSmokeLoaded);
 await page.click('#tabTracking');
 await page.waitForFunction(()=>typeof trackingMap!=='undefined' && trackingMap && trackingMarkerByPedido.size===1,{timeout:30000});
 await page.evaluate(()=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Map tiles did not load')),20000);
  google.maps.event.addListenerOnce(trackingMap,'tilesloaded',()=>{clearTimeout(timer);window.smokeTiles=true;resolve();});
  trackingMap.setZoom(14);
 }));
 assert.equal(await page.evaluate(()=>trackingGoogleAuthFailed),false);
 await page.evaluate(()=>focusIncident(5001));
 await page.waitForFunction(()=>document.querySelector('.gm-style-iw')?.textContent.includes('Pedido #5001'));
 assert.equal(await page.evaluate(()=>trackingMarkersLayer.length),2);
 await page.evaluate(()=>{trackingMap.setCenter({lat:-31.43,lng:-64.2});trackingMap.setZoom(13);});
 item.latitud=-31.417;
 await page.evaluate(()=>loadTracking(true));
 assert.equal(await page.evaluate(()=>Math.abs(trackingMap.getCenter().lat()+31.43)<.00001),true);
 assert.equal(await page.evaluate(()=>trackingMap.getZoom()),13);
 assert.equal(await page.evaluate(()=>trackingTrailLayer.length>0),true);
 const screenshot=path.join(process.env.TMPDIR,'choferes-google-tracking.png');
 await page.screenshot({path:screenshot});
 await page.setViewport({width:390,height:844});await page.evaluate(()=>resizeTrackingMap());
 assert.equal(await page.$eval('#trackingMapError',el=>el.hidden),true);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({sdk:'Google Maps real',origin,configurationSource:'local .env key with local authenticated admin route',businessData:'synthetic fixtures only; not production verification',tilesLoaded:true,truckAndDestination:true,popup:true,trail:true,autoRefreshPreservesCamera:true,mobile:true,errors,screenshot},null,2));
}catch(error){
 console.error(String(error.message).split(key).join('[OCULTO]'));console.log('Browser errors:',errors);
 if(page)console.log(await page.evaluate(()=>document.getElementById('trackingMapError')?.textContent));
 process.exitCode=1;
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
