import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createPublicLandingRouter} from '../src/routes/publicLanding.js';
import {createPublicLegacyCatalogRouter} from '../src/routes/publicLegacyCatalog.js';
import {createPublicLegacyMarketplaceRouter} from '../src/routes/publicLegacyMarketplace.js';
test('every public catalog source filters saved channel rules and quota without changing array/order contract',async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{
  const all=[0,1,2,3,4,5,6];
  const configs=[{id:1,disponibilidad_config:{enabled:true,weekdays:all,channels:{landing:{weekdays:[]}}}},{id:2,disponibilidad_config:{enabled:true,weekdays:[],channels:{landing:{weekdays:all}}}},{id:3,disponibilidad_config:{enabled:true,weekdays:all,daily_capacity:1}},{id:4,disponibilidad_config:{}}];
  const products=[{id:1,nombre:'Catalog'},{id:2,nombre:'Landing'},{id:3,nombre:'Agotado'},{id:4,nombre:'Legacy'}];
  const sql=[];
  const q=async(statement,params=[])=>{
   sql.push(statement);
   if(statement.includes('menu_config'))return [{menu_config:{enabled:true,timezone:'UTC'}}];
   if(statement.includes('public.menu_cupos_diarios'))return [{producto_id:3,reservado:1}];
   if(statement.includes('FROM productos') && statement.includes('disponibilidad_config'))return configs.map(p=>({...p,mostrar_en_catalogo:true,mostrar_en_landing:true}));
   if(statement.includes('FROM productos'))return products;
   if(statement.includes('FROM empresas') && /landing_slug, landing_domain/.test(statement))return [{id:7,nombre:'Empresa'}];
   if(statement.includes('FROM empresas'))return [{id:Number(params[0])}];
   throw Error(`unexpected query: ${statement}`);
  };
  const app=express();const withTransaction=fn=>fn(q);
  app.use('/api/public',createPublicLandingRouter({query:q,withTransaction}));
  app.use('/public',createPublicLegacyCatalogRouter({query:q,withTransaction}));
  app.use('/public',createPublicLegacyMarketplaceRouter({query:q}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
   const base=`http://127.0.0.1:${server.address().port}`;
   for(const prefix of ['/api/public','/public'])for(const channel of ['catalog','landing']){
    const result=await fetch(`${base}${prefix}/productos?empresa_id=7&scope=${channel}`);assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-store/);
    const body=await result.json();assert.ok(Array.isArray(body));assert.deepEqual(body.map(p=>p.id),channel==='catalog'?[1,4]:[2,4]);assert.ok(body.every(p=>p.menu.available));
   }
   const marketplace=await fetch(`${base}/public/marketplace`);assert.equal(marketplace.status,200);assert.match(marketplace.headers.get('cache-control'),/no-store/);assert.deepEqual((await marketplace.json())[0].productos.map(p=>p.id),[1,4]);
   delete process.env.SCHEDULED_MENUS_ENABLED;sql.length=0;
   const disabled=await fetch(`${base}/public/productos?empresa_id=7&scope=catalog`);assert.deepEqual((await disabled.json()).map(p=>p.id),[1,2,3,4]);
   assert.ok(sql.every(s=>!s.includes('menu_config')&&!s.includes('disponibilidad_config')&&!s.includes('menu_cupos_diarios')));
  }finally{await new Promise(r=>server.close(r));}
 }finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});
