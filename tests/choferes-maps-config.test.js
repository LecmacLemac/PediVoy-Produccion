import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createWithAuth } from '../src/core/auth.js';
import { createChoferesRouter } from '../src/routes/choferes.js';

test('admin browser maps config requires real role auth and never exposes backend key', async()=>{
  const secret='synthetic-choferes-map-test';
  const users=[
    {id:1,role:'admin',empresa_id:7,chofer_id:null,referente_id:null,activo:true},
    {id:2,role:'super',empresa_id:null,chofer_id:null,referente_id:null,activo:true},
    {id:3,role:'repartidor',empresa_id:7,chofer_id:4,referente_id:null,activo:true,chofer_valid:true},
  ];
  const env={GOOGLE_MAPS_API_KEY:'synthetic-backend-secret'};
  const app=express();
  app.use('/api',createChoferesRouter({query:async()=>{throw new Error('No business DB permitted');},withAuth:createWithAuth({jwtSecret:secret,queryFn:async(_sql,args)=>users.filter(u=>u.id===args[0])}),isSuper:req=>req.user.role==='super',getEmpresaIdFromToken:req=>req.user.empresa_id,mapsBrowserEnv:env}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/api/choferes/maps-config`;
    assert.equal((await fetch(url)).status,401);
    const get=uid=>fetch(url,{headers:{authorization:'Bearer '+jwt.sign({uid,role:users[uid-1].role},secret)}});
    assert.equal((await get(3)).status,403);
    const absent=await get(1);assert.equal(absent.status,503);assert.equal(absent.headers.get('cache-control'),'no-store');assert.doesNotMatch(await absent.text(),/synthetic-backend-secret/);
    env.GOOGLE_MAPS_BROWSER_API_KEY='synthetic-browser-key';
    for(const uid of [1,2]){const r=await get(uid);assert.equal(r.status,200);assert.deepEqual(await r.json(),{apiKey:'synthetic-browser-key',mapId:'DEMO_MAP_ID'});}
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
