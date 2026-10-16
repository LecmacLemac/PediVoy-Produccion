import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {evaluateProductAvailability} from '../src/menuAvailability.js';
import {validateMenuOrder} from '../src/services/menuOrderAvailability.js';
const company={enabled:true,timezone:'UTC'},productConfig={enabled:true,weekdays:[0,1,2,3,4,5,6],daily_capacity:.3};
const now=new Date('2026-10-15T12:00:00Z');

test('0.3 de cupo menos 0.1 comprometido conserva 0.2 disponible, sin epsilon arbitrario',()=>{
 const menu=evaluateProductAvailability({company,productConfig,deliveryDate:'2026-10-15',now,usedQuantity:.1});assert.equal(menu.remaining,.2);
});

test('backend acepta el último 0.2 y agrega 0.1+0.2 como exactamente 0.3',async t=>{
 const old=process.env.SCHEDULED_MENUS_ENABLED;process.env.SCHEDULED_MENUS_ENABLED='1';t.after(()=>old===undefined?delete process.env.SCHEDULED_MENUS_ENABLED:process.env.SCHEDULED_MENUS_ENABLED=old);
 let used=.1;const q=async sql=>sql.includes('FROM empresas')?[{menu_config:company}]:sql.includes('FROM productos')?[{id:55,disponibilidad_config:productConfig}]:sql.includes('FROM public.menu_cupos_diarios')?[{producto_id:55,reservado:String(used)}]:[];
 assert.ok(await validateMenuOrder(q,{empresaId:7,items:[{producto_id:55,cantidad:.2}],deliveryDate:'2026-10-15',now}));
 used=0;
 assert.ok(await validateMenuOrder(q,{empresaId:7,items:[{producto_id:55,cantidad:.1},{producto_id:55,cantidad:.2}],deliveryDate:'2026-10-15',now}));
});

test('carrito público no elimina cantidades decimales válidas al compararlas con cupo',async t=>{
 const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});t.after(()=>browser.close());const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.respond({status:200,contentType:'text/html',body:'<html><body><main id="root"></main><section id="cart"></section></body></html>'}));
 await page.goto('http://fixture.invalid/');await page.addScriptTag({path:new URL('../pedidos/menu-programado.js',import.meta.url).pathname});
 const result=await page.evaluate(async()=>{
  let asked=0;window.confirm=()=>{asked++;return true;};const items=[{producto_id:55,cantidad:.1,precio:1},{producto_id:55,cantidad:.2,precio:1}];
  const controller=PediVoyMenu.create({root:document.getElementById('root'),cartRoot:document.getElementById('cart'),tenant:()=> '7',channel:'catalog',cart:()=>items,url:path=>path,onCommit:()=>{},request:async path=>path.includes('/menu')?{enabled:true,timezone:'UTC',today:'2026-10-15',selected_date:'2026-10-15',advance_enabled:false,dates:['2026-10-15']}:[{id:55,precio:1,menu:{available:true,remaining:.3}}]});
  await controller.init();return {asked,count:items.length,payload:controller.payload()};
 });assert.equal(result.asked,0);assert.equal(result.count,2);assert.equal(result.payload.fecha_entrega,'2026-10-15');
});
