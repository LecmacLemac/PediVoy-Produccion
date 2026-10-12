import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs';
import { createAuthGuestSignupRouter } from '../src/routes/authGuestSignup.js';
import { createWithAuth } from '../src/core/auth.js';
import { requireCanonicalBackofficeRole } from '../src/routes/canonicalBackofficeRole.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const root=path.resolve(new URL('..',import.meta.url).pathname);
if(process.env.TMPDIR){fs.mkdirSync(process.env.TMPDIR,{recursive:true});process.chdir(process.env.TMPDIR);}

test('company signup creates tenant admin in DB and JWT, ignores caller privileges and preserves tenant ownership',postgresOptions,async()=>{
 await withIsolatedPostgres(async pool=>{
  await pool.query(`CREATE TABLE empresas(id serial PRIMARY KEY,nombre text,telefono text,email text,rubro text,landing_slug text,plan_estado text,plan_tipo text,plan_vencimiento timestamptz,setup_steps jsonb);
   CREATE TABLE usuarios(id serial PRIMARY KEY,username text UNIQUE,password text,role text,empresa_id integer REFERENCES empresas(id),telefono text,activo boolean DEFAULT true,chofer_id integer,referente_id integer);
   CREATE TABLE choferes(id integer,activo boolean,empresa_id integer);
   CREATE TABLE referentes(id integer,activo boolean,deleted_at timestamptz,empresa_id integer);
   INSERT INTO empresas(id,nombre) VALUES(99,'Otra empresa sintética');`);
  const query=async(sql,params)=>(await pool.query(sql,params)).rows;
  const secret=process.env.JWT_SECRET||'dev';
  const withAuth=createWithAuth({jwtSecret:secret,queryFn:query});
  const app=express();app.use(express.json());
  app.use('/api/auth',createAuthGuestSignupRouter({query,withAuth,pool}));
  app.get('/test/admin',withAuth,requireCanonicalBackofficeRole,(req,res)=>res.json({role:req.user.role,empresa_id:req.user.empresa_id}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
   const base=`http://127.0.0.1:${server.address().port}`;
   const response=await fetch(base+'/api/auth/signup-full?includeToken=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'syntheticowner',password:'SyntheticOnly123!',empresa_nombre:'Nueva empresa sintética',role:'super',empresa_id:99})});
   assert.equal(response.status,200);
   const result=await response.json();
   assert.equal(result.user.role,'admin');assert.notEqual(result.user.empresa_id,99);
   const saved=(await query('SELECT role,empresa_id,activo,chofer_id,referente_id FROM usuarios WHERE id=$1',[result.user.id]))[0];
   assert.equal(saved.role,'admin');assert.equal(saved.empresa_id,result.user.empresa_id);assert.equal(saved.activo,true);
   assert.equal(saved.chofer_id,null);assert.equal(saved.referente_id,null);
   const claims=jwt.verify(result.token,secret);assert.equal(claims.role,'admin');assert.equal(claims.empresa_id,saved.empresa_id);
   const allowed=await fetch(base+'/test/admin',{headers:{authorization:'Bearer '+result.token}});
   assert.equal(allowed.status,200);assert.deepEqual(await allowed.json(),{role:'admin',empresa_id:saved.empresa_id});
   assert.equal((await query('SELECT nombre FROM empresas WHERE id=$1',[99]))[0].nombre,'Otra empresa sintética');
   assert.match(fs.readFileSync(path.join(root,'pedidos/signup.html'),'utf8'),/\/api\/auth\/signup-full/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 });
});
