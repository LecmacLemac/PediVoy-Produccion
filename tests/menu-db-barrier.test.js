import test from 'node:test';
import assert from 'node:assert/strict';
import {withTransaction} from '../src/db.js';
import {withIsolatedPostgres,postgresOptions} from './support/isolated-postgres.js';

const barrier='SELECT id FROM public.menu_write_barrier WHERE id=1 FOR UPDATE';
function flag(t,value){const previous=process.env.SCHEDULED_MENUS_ENABLED;if(value===undefined)delete process.env.SCHEDULED_MENUS_ENABLED;else process.env.SCHEDULED_MENUS_ENABLED=value;t.after(()=>previous===undefined?delete process.env.SCHEDULED_MENUS_ENABLED:process.env.SCHEDULED_MENUS_ENABLED=previous);}
function fixturePool(query){const calls=[];return {calls,connect:async()=>({query:async(sql,params)=>{calls.push(sql);return await query?.(sql,params)||{rows:[]};},release:()=>calls.push('RELEASE')})};}

test('withTransaction adquiere barrera antes de invocar cualquier writer existente, incluso si usa client.query',async t=>{
 flag(t,'1');const pool=fixturePool();
 await withTransaction(async(q,client)=>{assert.deepEqual(pool.calls,['BEGIN',barrier]);await client.query('SELECT row BEFORE UPDATE FOR SHARE');await q('UPDATE row');},{pool,maxRetries:0});
 assert.deepEqual(pool.calls,['BEGIN',barrier,'SELECT row BEFORE UPDATE FOR SHARE','UPDATE row','COMMIT','RELEASE']);
});

test('schema ausente falla antes de ejecutar lógica de negocio, sin COMMIT ni efecto externo',async t=>{
 flag(t,'1');let called=0;const pool=fixturePool(async sql=>{if(sql===barrier)throw Object.assign(new Error('missing relation'),{code:'42P01'});});
 await assert.rejects(()=>withTransaction(async()=>called++,{pool,maxRetries:0}),error=>error.code==='42P01');
 assert.equal(called,0);assert.deepEqual(pool.calls,['BEGIN',barrier,'ROLLBACK','RELEASE']);
});

test('default-off conserva transacciones legacy sin consultar ninguna tabla de menús',async t=>{
 flag(t,undefined);const pool=fixturePool();await withTransaction(q=>q('legacy'),{pool});assert.deepEqual(pool.calls,['BEGIN','legacy','COMMIT','RELEASE']);
});

test('todos los callbacks canónicos esperan barrera antes de tomar row locks: dos conexiones reales sin inversión',postgresOptions,async t=>{
 flag(t,'1');await withIsolatedPostgres(async pool=>{
  await pool.query('CREATE TABLE menu_write_barrier(id int PRIMARY KEY);INSERT INTO menu_write_barrier VALUES(1);CREATE TABLE company(id int PRIMARY KEY,value int);INSERT INTO company VALUES(1,0)');
  let unlock;const held=new Promise(resolve=>unlock=resolve);let firstStarted;const started=new Promise(resolve=>firstStarted=resolve);let secondEntered=false;
  const first=withTransaction(async q=>{await q('SELECT * FROM company WHERE id=1 FOR SHARE');firstStarted();await held;return 1;},{pool,maxRetries:0});
  await started;
  const second=withTransaction(async q=>{secondEntered=true;await q('UPDATE company SET value=value+1 WHERE id=1');return 2;},{pool,maxRetries:0});
  try{
   await new Promise(resolve=>setTimeout(resolve,30));assert.equal(secondEntered,false);
  }finally{unlock();}
  assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.equal((await pool.query('SELECT value FROM company')).rows[0].value,1);
 });
});
