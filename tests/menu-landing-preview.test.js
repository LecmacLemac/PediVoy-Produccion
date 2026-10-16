import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';

const template='<html><head></head><body><main id="catalog"></main><script>fetch("/public/productos?slug=synthetic&scope=landing").then(r=>r.json()).then(rows=>document.getElementById("catalog").textContent=rows.map(r=>r.nombre).join(","));</script></body></html>';
async function fixture(t){
 const app=express(),requests=[];
 app.get('/host',(_req,res)=>res.send('<html><body><iframe id="previewFrame" sandbox="allow-scripts"></iframe><script>window.currentEmpresaId=7;</script><script src="/pedidos/landing-preview.js"></script></body></html>'));
 app.get('/public/config',(_req,res)=>res.json({empresa_id:7,landing_slug:'synthetic',nombre:'Empresa sintética'}));
 app.get('/public/menu',(req,res)=>res.json({enabled:true,today:'2026-10-15',selected_date:req.query.fecha_entrega||'2026-10-15',timezone:'America/Argentina/Buenos_Aires',advance_enabled:true,max_advance_days:7,dates:['2026-10-15','2026-10-16']}));
 app.get('/public/productos',(req,res)=>{requests.push({...req.query});res.json([{id:1,nombre:'Menú '+req.query.fecha_entrega,precio:1}]);});
 app.use('/pedidos',express.static(new URL('../pedidos/',import.meta.url).pathname));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage(),base=`http://127.0.0.1:${server.address().port}`;await page.setRequestInterception(true);page.on('request',request=>request.url().startsWith(base)||request.url().startsWith('about:')?request.continue():request.abort());await page.goto(base+'/host');
 return {page,requests};
}

test('preview offline permite elegir fecha real desde el host sin abrir red dentro del iframe',async t=>{
 const {page,requests}=await fixture(t);
 await page.evaluate(html=>showLandingPreview(html,{id:7,landing_slug:'synthetic'}),template);
 await page.waitForSelector('#landingPreviewDate');
 assert.equal(requests.at(-1).fecha_entrega,'2026-10-15');
 await page.select('#landingPreviewDate','2026-10-16');
 await page.waitForFunction(()=>document.getElementById('landingPreviewDate')?.value==='2026-10-16'&&!document.getElementById('landingPreviewDate').disabled);
 const frame=page.frames().find(frame=>frame.parentFrame());
 await frame.waitForFunction(()=>document.getElementById('catalog')?.textContent==='Menú 2026-10-16');
 assert.equal(requests.at(-1).scope,'landing');assert.equal(requests.at(-1).fecha_entrega,'2026-10-16');
 assert.equal(await frame.evaluate(()=>document.getElementById('landingPreviewMenuNotice').dataset.date),'2026-10-16');
 assert.equal(await frame.evaluate(async()=>{try{await fetch('/api/empresas',{method:'PUT'});return false;}catch{return true;}}),true);
 assert.equal(await page.$eval('#previewFrame',frame=>frame.getAttribute('sandbox')),'allow-scripts');
});
