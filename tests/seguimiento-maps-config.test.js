import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTrackingPublicRouter } from '../src/trackingPublic.js';

test('tracking map config requires valid non-expired capability, keeps tenant joins and exposes browser key only',async()=>{
 const env={GOOGLE_MAPS_API_KEY:'synthetic-server-key'};
 const calls=[];
 const queryFn=async(sql,params)=>{
  calls.push(sql);
  if(!sql.includes('FROM pedidos p'))throw new Error('Map config should not query location or items');
  assert.match(sql,/pe\.empresa_id = p\.empresa_id/);assert.match(sql,/c\.empresa_id = p\.empresa_id/);
  if(params[0]==='missing-token')return [];
  return [{id:1,empresa_id:7,estado:params[0]==='expired-token'?'entregado':'en_ruta',fecha_entrega:'2020-01-01',fecha:'2020-01-01'}];
 };
 const app=express();app.use('/api/public',createTrackingPublicRouter({queryFn,mapsBrowserEnv:env}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}/api/public/tracking/`;
  const get=token=>fetch(base+token+'?map_config=1');
  assert.equal((await get('bad')).status,400);assert.equal(calls.length,0);
  assert.equal((await get('missing-token')).status,404);
  assert.equal((await get('expired-token')).status,404);
  const absent=await get('active-token');assert.equal(absent.status,503);assert.doesNotMatch(await absent.text(),/synthetic-server-key/);
  env.GOOGLE_MAPS_BROWSER_API_KEY='synthetic-browser-key';
  const valid=await get('active-token');assert.equal(valid.status,200);assert.equal(valid.headers.get('cache-control'),'no-store');
  assert.deepEqual(await valid.json(),{apiKey:'synthetic-browser-key',mapId:'DEMO_MAP_ID'});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
