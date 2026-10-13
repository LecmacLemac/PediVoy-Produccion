import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import puppeteer from 'puppeteer';

test('public tracking Google UI keeps customer state, privacy freshness, contact and camera across updates',async()=>{
 const html=fs.readFileSync('pedidos/seguimiento.html','utf8');
 assert.doesNotMatch(html,/leaflet/);
 const app=express();let mode='live';let configStatus=200;let configCalls=0;
 const pedido={id:1,estado:'en_ruta',cliente:'Cliente sintético',direccion:'Dirección de prueba',dest_lat:-31.42,dest_lng:-64.19,chofer_nombre:'Chofer sintético',chofer_tel:'3515551234',empresa_nombre:'Empresa de prueba',items:[{producto:'Producto de prueba',cantidad:1,precio_unitario:1000}],monto:1000,metodo_pago:'efectivo'};
 app.get('/api/public/tracking/:token',(req,res)=>{
  if(req.params.token==='invalid-token')return res.status(404).json({error:'Pedido no encontrado'});
  if(req.query.map_config==='1'){configCalls++;return res.status(configStatus).json(configStatus===200?{apiKey:'synthetic-browser-key',mapId:'DEMO_MAP_ID'}:{error:'Google Maps no está configurado'});}
  res.json({pedido,driverLocation:{latitud:-31.416,longitud:-64.184,timestamp:new Date(Date.now()-(mode==='stale'?600000:0)).toISOString(),location_status:mode==='stale'?'desactualizada':'en_vivo',location_age_seconds:mode==='stale'?600:0}});
 });
 app.use('/pedidos',express.static('pedidos'));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-setuid-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:390,height:844});
  await page.evaluateOnNewDocument(()=>{
   class MapDouble{constructor(_el,o){this.center=o.center;this.zoom=o.zoom;}setCenter(p){this.center=p;}getCenter(){return this.center;}setZoom(z){this.zoom=z;}getZoom(){return this.zoom;}}
   class Marker{constructor(o){Object.assign(this,o);}}
   class Polyline{constructor(o){Object.assign(this,o);}setMap(m){this.map=m;}setPath(p){this.path=p;}}
   window.google={maps:{Map:MapDouble,marker:{AdvancedMarkerElement:Marker},Polyline,event:{trigger(){}}}};
  });
  const base=`http://127.0.0.1:${server.address().port}/pedidos/seguimiento.html`;
  await page.goto(base+'?t=synthetic-token',{waitUntil:'networkidle2'});
  await page.waitForFunction(()=>typeof driverMarker!=='undefined'&&!!driverMarker);
  assert.equal(await page.$eval('#lblCliente',el=>el.textContent),'Hola Cliente sintético');
  assert.equal(await page.evaluate(()=>!!destMarker && !!trajectoryLine),true);
  assert.equal(await page.$eval('#btnWpp',el=>el.style.display),'grid');
  await page.evaluate(()=>{map.setCenter({lat:-31.5,lng:-64.3});map.setZoom(13);});
  await page.evaluate(()=>updateTracking());
  assert.equal(await page.evaluate(()=>map.getZoom()),13);assert.equal(await page.evaluate(()=>map.getCenter().lat),-31.5);
  mode='stale';await page.evaluate(()=>updateTracking());
  assert.equal(await page.evaluate(()=>driverMarker),null);assert.equal(await page.evaluate(()=>trajectoryLine),null);
  assert.match(await page.$eval('#mapNote',el=>el.textContent),/recientes|actualiz|señal|ubicación/i);
  await page.click('#toggleDetails');await page.waitForFunction(()=>document.getElementById('hudCard').classList.contains('compact'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  configStatus=503;await page.goto(base+'?t=synthetic-token',{waitUntil:'networkidle2'});
  assert.equal(await page.$eval('#lblCliente',el=>el.textContent),'Hola Cliente sintético');
  assert.equal(await page.evaluate(()=>typeof map), 'undefined');
  assert.match(await page.$eval('#googleMapError',el=>el.textContent),/no está configurado/);
  const before=configCalls;await page.goto(base+'?t=invalid-token',{waitUntil:'networkidle2'});assert.equal(configCalls,before);
  await page.goto(base,{waitUntil:'networkidle2'});assert.equal(configCalls,before);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
