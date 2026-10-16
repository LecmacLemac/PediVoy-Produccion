import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createJuegosPublicosRouter } from '../src/routes/juegos.js';
import { rejectUndatedScheduledItems } from '../src/services/menuOrderAvailability.js';

test('automatic WhatsApp replacement refuses scheduled composition before inserting an order',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {
  let writes=0; const replies=[];
  const q=async sql=>{
   if(/INSERT|UPDATE|DELETE/.test(sql) && !/FOR UPDATE/.test(sql)){writes++;return [{id:99}];}
   if(/FROM empresas/.test(sql))return [{menu_config:{enabled:true}}];
   if(/disponibilidad_config/.test(sql))return [{id:55,disponibilidad_config:{enabled:true}}];
   if(/SELECT p.id, p.metodo_pago/.test(sql))return [{id:12,metodo_pago:'efectivo'}];
   if(/SELECT p.id/.test(sql))return [];
   if(/FROM items_pedido/.test(sql))return [{producto_id:55,cantidad:1,producto:'Menu',precio_unitario:10}];
   if(/FROM puntos_entrega/.test(sql))return [{id:10,empresa_id:7,direccion:'Calle 1'}];
   return [];
  };
  const all=readFileSync(new URL('../src/handlers.js',import.meta.url),'utf8');
  const source=all.slice(all.indexOf('async function handleReposicionAutomatica('),all.indexOf('// Router principal',all.indexOf('async function handleReposicionAutomatica(')));
  const context={rejectUndatedScheduledItems,withTransaction:fn=>fn(q),resolveDeliveryPointByPhone:async()=>({status:'unique',point:{id:10,empresa_id:7}}),_positiveTenantId:()=>true,resolveProductIdentityItems:async()=>[{producto_resuelto_id:55,producto_id:55,producto_resuelto:{precio:10},producto:'Menu',cantidad:1}],isConservativeEnqueueError:()=>false,console};
  vm.runInNewContext(source+';globalThis.run=handleReposicionAutomatica;',context);
  await context.run({sendMessage:async(to,text)=>replies.push(text)},'5493515555555@c.us',{empresa_id:7,source:'cliente'},{logProcessingErrors:false});
  assert.equal(writes,0); assert.match(replies[0],/fecha|catálogo/);
 } finally {delete process.env.SCHEDULED_MENUS_ENABLED;}
});

test('game award requires explicit scheduling before any point or order write',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 let writes=0;
 try {
  const q=async sql=>{
   if(/FROM empresas/.test(sql))return [{menu_config:{enabled:true}}];
   if(/FROM juegos_campanias jc/.test(sql))return [{id:7,empresa_id:1,estado:'activa',public_code:'K8X4PZ2Q'}];
   if(/FROM juegos_participaciones/.test(sql))return [{id:2,producto_id:55}];
   if(/FROM productos/.test(sql))return [{id:55,nombre:'Menu',disponibilidad_config:{enabled:true}}];
   if(/^\s*(INSERT INTO (pedidos|puntos_entrega|items_pedido)|UPDATE puntos_entrega)/.test(sql))writes++;
   return [];
  };
  const app=express();app.use(express.json());app.use('/games',createJuegosPublicosRouter({query:q,pool:{connect:async()=>{throw Error('unexpected connection');}},withTransaction:fn=>fn(q)}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
   const res=await fetch(`http://127.0.0.1:${server.address().port}/games/premio-entrega`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({public_code:'K8X4PZ2Q',codigo:'AGUA-123',telefono:'3515551234',nombre:'Cliente',direccion:'Calle 123'})});
   assert.equal(res.status,409);assert.equal((await res.json()).code,'MENU_DATE_REQUIRED');assert.equal(writes,0);
  } finally {await new Promise(r=>server.close(r));}
 } finally {delete process.env.SCHEDULED_MENUS_ENABLED;}
});
