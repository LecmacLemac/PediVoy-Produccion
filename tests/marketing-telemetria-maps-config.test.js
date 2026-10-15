import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createWithAuth } from '../src/core/auth.js';
import { createSetupRouter } from '../src/routes/setup.js';

test('Google Maps de telemetría usa autenticación real y rol super vigente, sin SQL de negocio ni fallback de clave backend', async () => {
  const secret='synthetic-marketing-maps-signing-secret';
  const roles=['super','admin','user','repartidor','referente','contable','facturacion'];
  const users=roles.map((role,index)=>({id:index+1,role,empresa_id:role==='super'?null:7,activo:true,chofer_id:role==='repartidor'?41:null,referente_id:role==='referente'?51:null,chofer_valid:role==='repartidor',referente_valid:role==='referente'}));
  users.push({id:8,role:'super',empresa_id:null,activo:false,chofer_id:null,referente_id:null});
  const mapsBrowserEnv={GOOGLE_MAPS_API_KEY:'synthetic-backend-secret'};
  let businessCalls=0;
  const noBusiness=async()=>{businessCalls++;throw new Error('Unexpected business SQL');};
  const app=express();
  app.use('/api/setup',createSetupRouter({
    query:noBusiness,withTransaction:async()=>{throw new Error('Unexpected transaction');},
    getEmpresaIdFromToken:req=>req.user?.empresa_id,
    withAuth:createWithAuth({jwtSecret:secret,queryFn:async(_sql,params)=>users.filter(user=>user.id===params[0])}),
    mapsBrowserEnv,
  }));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/setup/marketing/maps-config`;
  const get=(uid,claims={})=>fetch(url,{headers:uid?{Authorization:'Bearer '+jwt.sign({uid,role:users[uid-1].role,...claims},secret)}:{}});
  try{
    assert.equal((await get()).status,401);
    for(let uid=2;uid<=7;uid++){
      const response=await get(uid,{role:'super'});
      assert.equal(response.status,403,`No elevar rol de ${roles[uid-1]} con claims antiguos`);
      assert.doesNotMatch(await response.text(),/synthetic-backend-secret/);
    }
    assert.equal((await get(8)).status,401);
    const missing=await get(1);
    assert.equal(missing.status,503);
    assert.equal(missing.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(await missing.text(),/synthetic-backend-secret/);
    mapsBrowserEnv.GOOGLE_MAPS_BROWSER_API_KEY=' synthetic-browser-key ';
    const ready=await get(1);
    assert.equal(ready.status,200);
    assert.equal(ready.headers.get('cache-control'),'no-store');
    assert.deepEqual(await ready.json(),{ok:true,apiKey:'synthetic-browser-key',mapId:'DEMO_MAP_ID'});
    mapsBrowserEnv.GOOGLE_MAPS_MAP_ID=' synthetic-map-id ';
    assert.deepEqual(await (await get(1)).json(),{ok:true,apiKey:'synthetic-browser-key',mapId:'synthetic-map-id'});
    mapsBrowserEnv.GOOGLE_MAPS_BROWSER_API_KEY='   ';
    assert.equal((await get(1)).status,503);
    assert.equal(businessCalls,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
