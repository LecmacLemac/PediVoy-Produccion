import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {registerLandingRoutes} from '../src/routes/landingRoutes.js';

test('landings canónicas incorporan selector compartido sin modificar HTML guardado y conservan legacy default-off',async()=>{
 const folder=await fs.mkdtemp(path.join(process.env.TMPDIR||os.tmpdir(),'scheduled-landing-'));
 const original='<!doctype html><html><head><title>Empresa sintética</title></head><body><h1>Mi carta</h1><script>window.inlineLegacy=true;</script></body></html>';
 await fs.mkdir(path.join(folder,'pages'));await fs.writeFile(path.join(folder,'pages','empresa_7.html'),original);
 const old=process.env.SCHEDULED_MENUS_ENABLED;
 const app=express();registerLandingRoutes(app,{projectDir:folder,query:async(sql,params)=>{
  if(/SELECT.*landing_slug/i.test(sql))return [{id:7,empresa_id:7,landing_slug:'synthetic'}];
  if(/FROM empresas/i.test(sql))return [{id:7,empresa_id:7,landing_slug:'synthetic'}];
  throw new Error('Unexpected synthetic SQL');
 }});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  delete process.env.SCHEDULED_MENUS_ENABLED;
  assert.equal(await(await fetch(base+'/landing/synthetic')).text(),original);
  process.env.SCHEDULED_MENUS_ENABLED='1';
  for(const url of ['/landing/synthetic','/l/synthetic','/?empresa_id=7']){
   const response=await fetch(base+url),html=await response.text();
   assert.equal(response.status,200);
   assert.equal(response.headers.get('cache-control'),'no-store');
   assert.match(html,/src="\/pedidos\/landing-menu-programado\.js"/);
   assert.match(html,/data-menu-empresa="7"/);
   assert.ok(html.indexOf('landing-menu-programado.js')<html.indexOf('window.inlineLegacy'),'El adaptador se instala antes de los consumidores inline');
   assert.equal(html.split('landing-menu-programado.js').length-1,1);
  }
  assert.equal(await fs.readFile(path.join(folder,'pages','empresa_7.html'),'utf8'),original);
 }finally{
  if(old===undefined)delete process.env.SCHEDULED_MENUS_ENABLED;else process.env.SCHEDULED_MENUS_ENABLED=old;
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(folder,{recursive:true,force:true});
 }
});
