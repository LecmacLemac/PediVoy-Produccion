import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createTrackingPublicRouter} from '../src/trackingPublic.js';
import {createPublicLegacyPedidosRouter} from '../src/routes/publicLegacyPedidos.js';
test('tracking exposes accepted date metadata only through existing capability-scoped reads',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{
  const q=async(sql,params)=>{
   if(sql.includes('FROM pedidos p')){
    assert.ok(sql.includes('tracking_token'));assert.ok(params.includes('valid-token'));
    return [{id:42,empresa_id:7,estado:'pendiente',fecha_entrega:null,fecha:'2026-10-15',fecha_entrega_estimada:'2026-10-20',fecha_entrega_programada:'2026-10-20'}];
   }
   return [];
  };
  const app=express();app.use('/api/public',createTrackingPublicRouter({queryFn:q}));app.use('/public',createPublicLegacyPedidosRouter({query:q,withTransaction:fn=>fn(q)}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
   const base=`http://127.0.0.1:${server.address().port}`;
   const current=await fetch(`${base}/api/public/tracking/valid-token`);assert.equal(current.status,200);const body=await current.json();
   assert.equal(body.pedido.fecha_entrega_programada,'2026-10-20');assert.equal(body.pedido.fecha_entrega_estimada,'2026-10-20');assert.equal(body.pedido.fecha_entrega,null);
   const legacy=await fetch(`${base}/public/pedido-estado?id=42&token=valid-token`);assert.equal(legacy.status,200);assert.equal((await legacy.json()).fecha_entrega_programada,'2026-10-20');
  }finally{await new Promise(r=>server.close(r));}
 }finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});
