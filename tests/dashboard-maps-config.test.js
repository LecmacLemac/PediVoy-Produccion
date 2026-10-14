import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import {createWithAuth} from '../src/core/auth.js';
import {createPedidosRouter} from '../src/routes/pedidos.js';

test('dashboard map config uses real auth for admin/super and only exposes browser key',async()=>{
 const secret='synthetic-dashboard-test';
 const users=[{id:1,role:'admin',empresa_id:7,chofer_id:null,referente_id:null,activo:true},{id:2,role:'super',empresa_id:null,chofer_id:null,referente_id:null,activo:true},{id:3,role:'user',empresa_id:7,chofer_id:null,referente_id:null,activo:true}];
 const env={GOOGLE_MAPS_API_KEY:'synthetic-backend-secret'};
 const app=express();app.use('/api/pedidos',createPedidosRouter({withAuthFn:createWithAuth({jwtSecret:secret,queryFn:async(_sql,args)=>users.filter(u=>u.id===args[0])}),mapsBrowserEnv:env}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const url=`http://127.0.0.1:${server.address().port}/api/pedidos/maps-config`;
  const get=uid=>fetch(url,uid?{headers:{authorization:'Bearer '+jwt.sign({uid,role:users[uid-1].role},secret)}}:{});
  assert.equal((await get()).status,401);assert.equal((await get(3)).status,403);
  const absent=await get(1);assert.equal(absent.status,503);assert.equal(absent.headers.get('cache-control'),'no-store');assert.doesNotMatch(await absent.text(),/synthetic-backend-secret/);
  env.GOOGLE_MAPS_BROWSER_API_KEY='synthetic-browser-key';
  for(const uid of [1,2]){const res=await get(uid);assert.equal(res.status,200);assert.deepEqual(await res.json(),{apiKey:'synthetic-browser-key',mapId:'DEMO_MAP_ID'});}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
