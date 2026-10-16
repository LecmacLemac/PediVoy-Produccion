import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import {createPublicClientAppRouter} from '../src/routes/publicClientApp.js';
import {withIsolatedPostgres,postgresOptions} from './support/isolated-postgres.js';

test('actual client history exposes the committed date with tenant/profile isolation and default-off compatibility',postgresOptions,async()=>{
 await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE puntos_entrega(id int,empresa_id int,cliente text,telefono text,telefono_normalizado text,direccion text,ciudad text,provincia text,pais text,notas text,email text);
   INSERT INTO puntos_entrega(id,empresa_id,cliente) VALUES(10,7,'Fixture'),(11,7,'Other profile'),(12,8,'Other tenant');
   CREATE TABLE pedidos(id int,punto_entrega_id int,empresa_id int,fecha timestamptz,estado text,metodo_pago text,monto numeric,tracking_token text,fecha_entrega_programada date,fecha_entrega_estimada date);
   INSERT INTO pedidos VALUES(1,10,7,now(),'pendiente','efectivo',10,'fixture-token','2026-10-16','2026-10-16'),(2,11,7,now(),'pendiente','efectivo',10,'other',NULL,NULL),(3,12,8,now(),'pendiente','efectivo',10,'other',NULL,NULL);`);
  const query=async(s,p)=>(await pool.query(s,p)).rows;
  const app=express();
  const token=jwt.sign({type:'client',empresa_id:7,profile_id:10},process.env.JWT_SECRET || 'dev');
  app.use((req,res,next)=>{req.cookies={client_token:token};next();});
  app.use('/api/public/app',createPublicClientAppRouter({query,resolveEmpresaIdFn:async()=>7}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
   process.env.SCHEDULED_MENUS_ENABLED='1';
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/public/app/orders`);
   assert.equal(response.status,200);
   const body=await response.json();assert.deepEqual(body.orders.map(o=>o.id),[1]);
   assert.equal(body.orders[0].fecha_entrega_programada,'2026-10-16');
   delete process.env.SCHEDULED_MENUS_ENABLED;
   await pool.query('ALTER TABLE pedidos DROP COLUMN fecha_entrega_programada, DROP COLUMN fecha_entrega_estimada');
   const legacy=await fetch(`http://127.0.0.1:${server.address().port}/api/public/app/orders`);
   assert.equal(legacy.status,200);assert.deepEqual((await legacy.json()).orders.map(o=>o.id),[1]);
  }finally {delete process.env.SCHEDULED_MENUS_ENABLED;await new Promise(r=>server.close(r));}
 });
});
