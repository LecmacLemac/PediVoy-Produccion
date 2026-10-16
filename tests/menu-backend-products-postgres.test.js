import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createProductosRouter } from '../src/routes/productos.js';
import { withTransaction } from '../src/db.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

test('product availability saves in canonical transaction and omission preserves it',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try {await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE public.menu_write_barrier(id int PRIMARY KEY);INSERT INTO public.menu_write_barrier VALUES(1);
   CREATE TABLE productos(id int PRIMARY KEY,empresa_id int,nombre text,precio numeric,deleted_at timestamptz,updated_by int,updated_at timestamptz,disponibilidad_config jsonb DEFAULT '{}');
   INSERT INTO productos(id,empresa_id,nombre,precio) VALUES(55,7,'Menu',10);`);
  const app=express();app.use(express.json());
  const statements=[];
  app.use('/api/productos',createProductosRouter({query:async(s,p)=>(await pool.query(s,p)).rows,withTransaction:fn=>withTransaction(q=>fn(async(s,p)=>{statements.push(s);return q(s,p);}),{pool,maxRetries:0}),withAuth:(req,res,next)=>{req.user={uid:5,role:'admin',empresa_id:7};next();},isSuper:()=>false,getEmpresaIdFromToken:()=>7}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
   const put=body=>fetch(`http://127.0.0.1:${server.address().port}/api/productos/55`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   const first=await put({disponibilidad_config:{enabled:true,weekdays:[0,1,2,3,4,5,6],daily_capacity:12}});
   assert.equal(first.status,200,await first.text());
   assert.match(statements[0],/public.menu_write_barrier/);
   const saved=(await pool.query('SELECT disponibilidad_config FROM productos')).rows[0].disponibilidad_config;
   assert.equal(saved.enabled,true);assert.equal(saved.daily_capacity,12);
   const legacy=await put({precio:11}); assert.equal(legacy.status,200);
   assert.deepEqual((await pool.query('SELECT disponibilidad_config FROM productos')).rows[0].disponibilidad_config,saved);
  } finally {await new Promise(r=>server.close(r));}
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});
