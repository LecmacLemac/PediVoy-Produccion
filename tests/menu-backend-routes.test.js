import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerPublicLegacyCreatePedidoRoute } from '../src/routes/publicLegacyCreatePedido.js';
import { toNum,inRange,round,buildOrderSummary } from '../src/public/pedidosLegacyHelpers.js';
import { createMenuRouter, createPublicMenuRouter } from '../src/routes/menu.js';
async function serve(app,work) { const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r)); try {await work(`http://127.0.0.1:${server.address().port}`);} finally {await new Promise(r=>server.close(r));} }
test('configuration is canonical admin-only, and default-off needs no new columns',async()=>{
 delete process.env.SCHEDULED_MENUS_ENABLED;
 const sql=[];
 const query=async(s)=>{sql.push(s);if(s.includes('FROM usuarios'))return [{id:5,role:'admin',empresa_id:7,activo:true}]; throw Error('unexpected schema access');};
 const app=express(); app.use(express.json());
 app.use('/api/menu',createMenuRouter({query,withTransaction:fn=>fn(query),withAuth:(req,res,next)=>{req.user={uid:5,role:req.headers['x-role']||'admin',empresa_id:7};next();}}));
 await serve(app,async base=>{
  const denied=await fetch(`${base}/api/menu/config`,{headers:{'x-role':'user'}}); assert.equal(denied.status,403);
  const response=await fetch(`${base}/api/menu/config`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{enabled:false,empresa_id:7,config:null});
  const cross=await fetch(`${base}/api/menu/config?empresa_id=8`);assert.equal(cross.status,403);
 });
 assert.ok(sql.every(s=>!s.includes('menu_config')));
});
test('disabled public scheduled request fails before any legacy SQL or side effect',async()=>{
 delete process.env.SCHEDULED_MENUS_ENABLED;
 let queries=0;
 const app=express();app.use(express.json());
 registerPublicLegacyCreatePedidoRoute(app,{query:async()=>{queries++;throw Error('unexpected SQL');},resolveEmpresaIdFn:async()=>7,normalizePhone:v=>String(v).replace(/\D/g,''),toNum,inRange,round,buildOrderSummary});
 await serve(app,async base=>{
  const response=await fetch(`${base}/public/pedidos?empresa_id=7`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({empresa_id:7,cliente:'Fixture',telefono:'3515559999',direccion:'Fixture 1',fecha_entrega:'2026-10-16',items:[{producto_id:55,producto:'Menu',cantidad:1,precio_unitario:10}]})});
  assert.equal(response.status,409,await response.text());assert.equal(queries,0);
 });
});

test('public menu off keeps canonical tenant resolver and no-store',async()=>{
 delete process.env.SCHEDULED_MENUS_ENABLED;
 const app=express();let tenantCalls=0;
 app.use('/public',createPublicMenuRouter({query:async()=>[],resolveEmpresaIdFn:async()=>{tenantCalls++;return 7;}}));
 await serve(app,async base=>{const response=await fetch(`${base}/public/menu`);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.deepEqual(await response.json(),{enabled:false});});
 assert.equal(tenantCalls,1);
});
