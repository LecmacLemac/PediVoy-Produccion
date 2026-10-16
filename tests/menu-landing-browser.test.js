import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import {injectLandingMenuAdapter} from '../src/services/landingMenuAdapter.js';

async function harness(t,{enabled=true,advance=true,failed=false,slugOnly=false}={}){
 const app=express(),calls=[];
 let html=injectLandingMenuAdapter('<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Carta sintética</title></head><body><header>Empresa sintética</header><main><div id="products"></div><a id="buy" href="/pedidos/?empresa_id=7&add=99">Pedir</a><a id="other" href="/pedidos/?empresa_id=8&add=1">Otra empresa</a></main><script>fetch("/public/productos?empresa_id=7&scope=landing").then(r=>{if(!r.ok)throw Error("catalog");return r.json();}).then(rows=>{document.getElementById("products").textContent=rows.map(p=>p.nombre).join(",");}).catch(()=>document.getElementById("products").textContent="No se pudo cargar");</script></body></html>',7);
 if(slugOnly)html=html.replaceAll('empresa_id=7','slug=synthetic');
 app.get('/landing/synthetic',(_req,res)=>res.type('html').send(html));
 app.get('/pedidos/',(_req,res)=>res.type('html').send('<html><body>Checkout sintético sin red externa</body></html>'));
 app.get('/public/menu',(req,res)=>failed?res.status(503).json({error:'Synthetic unavailable'}):res.json({enabled,timezone:'America/Argentina/Buenos_Aires',today:'2026-10-15',selected_date:req.query.fecha_entrega||'2026-10-15',advance_enabled:advance,max_advance_days:7,dates:['2026-10-15','2026-10-16']}));
 app.get('/public/productos',(req,res)=>{calls.push({...req.query});res.json([{id:99,nombre:'Menú '+(req.query.fecha_entrega||'legacy')}]);});
 app.use('/pedidos',express.static(new URL('../pedidos/',import.meta.url).pathname));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage(),origin=`http://127.0.0.1:${server.address().port}`;
 await page.setRequestInterception(true);page.on('request',request=>request.url().startsWith(origin)?request.continue():request.abort());
 return {page,origin,calls};
}

test('landing usa fecha del servidor antes del script inline y mantiene fecha al pedir sin cruzar empresa',async t=>{
 const {page,origin,calls}=await harness(t);
 await page.goto(origin+'/landing/synthetic');
 await page.waitForFunction(()=>document.getElementById('products').textContent==='Menú 2026-10-15',{timeout:3000});
 assert.equal(calls[0].fecha_entrega,'2026-10-15');
 await page.waitForSelector('#landingMenuDate');
 await Promise.all([page.waitForNavigation(),page.select('#landingMenuDate','2026-10-16')]);
 await page.waitForFunction(()=>document.getElementById('products').textContent==='Menú 2026-10-16');
 const link=new URL(await page.$eval('#buy',a=>a.href));
 assert.equal(link.searchParams.get('fecha_entrega'),'2026-10-16');assert.equal(link.searchParams.get('empresa_id'),'7');assert.equal(link.searchParams.get('add'),'99');
 assert.equal(new URL(await page.$eval('#other',a=>a.href)).searchParams.get('fecha_entrega'),null);
 await page.setViewport({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(calls.at(-1).fecha_entrega,'2026-10-16');
});

test('empresa sin menú mantiene productos legacy sin parámetros ni controles nuevos',async t=>{
 const {page,origin,calls}=await harness(t,{enabled:false});await page.goto(origin+'/landing/synthetic');
 await page.waitForFunction(()=>document.getElementById('products').textContent==='Menú legacy');
 assert.equal(calls[0].fecha_entrega,undefined);assert.equal(await page.$('#landingMenuDate'),null);
 assert.equal(new URL(await page.$eval('#buy',a=>a.href)).searchParams.get('fecha_entrega'),null);
});

test('slug canónico en mayúsculas conserva fecha y canal en productos y enlace de compra',async t=>{
 const {page,origin,calls}=await harness(t,{slugOnly:true});await page.goto(origin+'/landing/SYNTHETIC?fecha_entrega=2026-10-16');
 await page.waitForSelector('#landingMenuDate');await page.waitForFunction(()=>document.getElementById('products').textContent.length>0);
 assert.equal(calls[0].fecha_entrega,'2026-10-16');assert.equal(calls[0].scope,'landing');
 const buy=new URL(await page.$eval('#buy',a=>a.href));assert.equal(buy.searchParams.get('fecha_entrega'),'2026-10-16');assert.equal(buy.searchParams.get('catalog_channel'),'landing');assert.equal(buy.searchParams.get('slug'),'synthetic');
});

test('clic central y menú contextual no abren compra con fecha sin verificar',async t=>{
 const {page,origin}=await harness(t,{failed:true,slugOnly:true});await page.goto(origin+'/landing/synthetic?fecha_entrega=2026-10-16');await page.waitForSelector('#landingMenuError');
 const before=(await page.browser().pages()).length;await page.click('#buy',{button:'middle'});await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await page.browser().pages()).length,before);
 assert.equal(await page.$eval('#buy',a=>a.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),false);
});

test('metadatos fallidos no publican menú no validado y muestran reintento explícito',async t=>{
 const {page,origin,calls}=await harness(t,{failed:true});await page.goto(origin+'/landing/synthetic?fecha_entrega=2099-01-01');
 await page.waitForSelector('#landingMenuError',{timeout:3000});
 assert.equal(calls.length,0);assert.equal(await page.$eval('#landingMenuError',e=>e.getAttribute('role')),'alert');
 assert.ok(await page.$('#landingMenuRetry'));
 assert.ok(await page.$('#landingMenuToday'));
 await page.click('#buy');assert.match(page.url(),/\/landing\/synthetic/,'No se debe comprar con una fecha no verificada');
 await Promise.all([page.waitForNavigation(),page.click('#landingMenuToday')]);
 assert.equal(new URL(page.url()).searchParams.get('fecha_entrega'),null);
});
