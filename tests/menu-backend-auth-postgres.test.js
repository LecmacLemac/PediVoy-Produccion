import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createMenuRouter,createPublicMenuRouter } from '../src/routes/menu.js';
import { createWithAuth } from '../src/core/auth.js';
import { withTransaction } from '../src/db.js';
import { withIsolatedPostgres,postgresOptions } from './support/isolated-postgres.js';

test('config save revalidates license inside the same transaction after middleware',postgresOptions,async()=>{
 await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE public.menu_write_barrier(id int PRIMARY KEY);INSERT INTO public.menu_write_barrier VALUES(1);
   CREATE TABLE usuarios(id int PRIMARY KEY,role text,empresa_id int,activo boolean);
   INSERT INTO usuarios VALUES(5,'admin',7,true);
   CREATE TABLE empresas(id int PRIMARY KEY,plan_estado text,plan_vencimiento timestamptz,menu_config jsonb DEFAULT '{}');
   INSERT INTO empresas VALUES(7,'active',NULL,'{}');`);
  process.env.SCHEDULED_MENUS_ENABLED='1';
  const query=async(s,p)=>(await pool.query(s,p)).rows;
  const app=express();app.use(express.json());
  const statements=[];
  app.use('/api/menu',createMenuRouter({query,withTransaction:async fn=>{
   await pool.query("UPDATE empresas SET plan_estado='expired' WHERE id=7");
   return withTransaction(q=>fn(async(s,p)=>{statements.push(s);return q(s,p);}),{pool,maxRetries:0});
  },withAuth:(req,res,next)=>{req.user={uid:5,role:'admin',empresa_id:7};next();},checkLicencia:(req,res,next)=>next()}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
   const result=await fetch(`http://127.0.0.1:${server.address().port}/api/menu/config`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})});
   assert.equal(result.status,402,await result.text());
   assert.match(statements[0],/public.menu_write_barrier/);
   assert.deepEqual((await pool.query('SELECT menu_config FROM empresas WHERE id=7')).rows[0].menu_config,{});
  }finally{delete process.env.SCHEDULED_MENUS_ENABLED;await new Promise(r=>server.close(r));}
 });
});

test('config routes exercise real JWT canonical auth, tenancy, preview and normalized persistence',postgresOptions,async()=>{
 process.env.SCHEDULED_MENUS_ENABLED='1';
 try{await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE public.menu_write_barrier(id int PRIMARY KEY);INSERT INTO public.menu_write_barrier VALUES(1);
   CREATE TABLE usuarios(id int PRIMARY KEY,username text,role text,empresa_id int,chofer_id int,referente_id int,activo boolean);
   CREATE TABLE choferes(id int,empresa_id int,activo boolean);CREATE TABLE referentes(id int,empresa_id int,activo boolean,deleted_at timestamptz);
   INSERT INTO usuarios VALUES(5,'admin','admin',7,NULL,NULL,true),(6,'super','super',NULL,NULL,NULL,true),(9,'user','user',7,NULL,NULL,true);
   CREATE TABLE empresas(id int PRIMARY KEY,plan_estado text DEFAULT 'active',plan_vencimiento timestamptz,menu_config jsonb DEFAULT '{}',config_operativa jsonb DEFAULT '{"preserve":true}',config_entrega jsonb DEFAULT '{"preserve":true}');INSERT INTO empresas(id) VALUES(7),(8);
   CREATE TABLE productos(id int,empresa_id int,disponibilidad_config jsonb,deleted_at timestamptz);INSERT INTO productos VALUES(55,7,'{}',NULL);
   CREATE TABLE public.menu_cupos_diarios(empresa_id int,producto_id int,fecha date,reservado numeric);`);
  const query=async(s,p)=>(await pool.query(s,p)).rows;
  const app=express();app.use(express.json());
  const auth=createWithAuth({queryFn:query,jwtSecret:'fixture-secret-only'});
  app.use('/api/menu',createMenuRouter({query,withTransaction:fn=>withTransaction(fn,{pool,maxRetries:0}),withAuth:auth}));
  app.use('/public',createPublicMenuRouter({query,resolveEmpresaIdFn:async()=>7}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const token=(uid,role)=>jwt.sign({uid,role},'fixture-secret-only');
  const headers=uid=>({'content-type':'application/json',authorization:`Bearer ${token(uid,uid===6?'super':uid===9?'user':'admin')}`});
  try{
   assert.equal((await fetch(`${base}/api/menu/config`)).status,401);
   assert.equal((await fetch(`${base}/api/menu/config`,{headers:headers(9)})).status,403);
   assert.equal((await fetch(`${base}/api/menu/config?empresa_id=8`,{headers:headers(5)})).status,403);
   assert.equal((await fetch(`${base}/api/menu/config?empresa_id=8`,{headers:headers(6)})).status,200);
   const saved=await fetch(`${base}/api/menu/config`,{method:'PUT',headers:headers(5),body:JSON.stringify({enabled:true,timezone:'UTC',advance_enabled:true,max_advance_days:3})});
   assert.equal(saved.status,200);const config=(await saved.json()).config;assert.deepEqual(config.service_weekdays,[0,1,2,3,4,5,6]);
   assert.deepEqual((await pool.query('SELECT config_operativa,config_entrega FROM empresas WHERE id=7')).rows,[{config_operativa:{preserve:true},config_entrega:{preserve:true}}]);
   const preview=await fetch(`${base}/api/menu/preview?producto_id=55`,{headers:headers(5)});assert.equal(preview.status,200);assert.equal((await preview.json()).menu.available,true);
   const calendar=await fetch(`${base}/public/menu`);const body=await calendar.json();assert.equal(body.enabled,true);assert.equal(body.dates.length,4);assert.equal(body.selected_date,body.today);assert.match(calendar.headers.get('cache-control'),/no-store/);
   await pool.query('UPDATE usuarios SET activo=false WHERE id=5');
   assert.equal((await fetch(`${base}/api/menu/config`,{headers:headers(5)})).status,401);
  }finally{await new Promise(r=>server.close(r));}
 });}finally{delete process.env.SCHEDULED_MENUS_ENABLED;}
});
