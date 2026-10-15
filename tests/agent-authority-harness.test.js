import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

// Synthetic identities, private disposable PostgreSQL; never load app.js or .env.
test('personal authority: all roles, uid isolation, Origin, credential type, revocation and replay', postgresOptions, async () => withIsolatedPostgres(async pool => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/unused_authority_gate';
  const { createAgentService } = await import('../src/agents/service.js');
  const { createMiAgenteRouter } = await import('../src/routes/miAgente.js');
  const { createAgentToolsRouter } = await import('../src/routes/agentTools.js');
  const { createAgentTools } = await import('../src/agents/tools.js');
  await pool.query(`CREATE TABLE empresas(id int PRIMARY KEY,plan_estado text,plan_vencimiento timestamptz);
    CREATE TABLE choferes(id int PRIMARY KEY,empresa_id int,activo boolean);
    CREATE TABLE referentes(id int PRIMARY KEY,empresa_id int,activo boolean,deleted_at timestamptz);
    CREATE TABLE usuarios(id int PRIMARY KEY,username text,role text,empresa_id int,chofer_id int,referente_id int,activo boolean);
    INSERT INTO empresas VALUES(1,'active',NULL),(2,'active',NULL);
    INSERT INTO choferes VALUES(4,1,true);
    INSERT INTO referentes VALUES(5,1,true,NULL);
    INSERT INTO usuarios VALUES(1,'synthetic1','user',1,NULL,NULL,true),(2,'synthetic2','admin',1,NULL,NULL,true),
      (3,'synthetic3','user',2,NULL,NULL,true),(4,'synthetic4','repartidor',1,4,NULL,true),
      (5,'synthetic5','referente',1,NULL,5,true),(6,'synthetic6','facturacion',1,NULL,NULL,true),
      (7,'synthetic7','contable',1,NULL,NULL,true),(8,'synthetic8','super',NULL,NULL,NULL,true);`);
  await pool.query(await readFile(new URL('../src/agents/schema.sql', import.meta.url), 'utf8'));
  const query = async (sql, values) => (await pool.query(sql, values)).rows;
  const withTransaction = async (work, options) => {
    assert.equal(options.maxRetries, 0);
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await work(async (s,v) => (await client.query(s,v)).rows); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const origin = 'https://synthetic.pedivoy.example';
  const service = createAgentService({query,withTransaction,enabled:true,canonicalOrigin:origin});
  const app = express();
  // Only the session boundary is synthetic: uid is injected, all authority is real.
  app.use('/human', createMiAgenteRouter({withAuth:(req,_res,next)=>{req.user={uid:Number(req.get('x-synthetic-uid'))||undefined};next();},service,canonicalOrigin:origin}));
  app.use('/agent', createAgentToolsRouter({service,tools:createAgentTools({})}));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const human = (uid,path,body,headers={}) => fetch(base+'/human'+path,{method:'POST',headers:{'content-type':'application/json',Origin:origin,'x-synthetic-uid':String(uid),...headers},body:JSON.stringify(body)});
  const make = (uid,extra={}) => human(uid,'/connections',{name:'Synthetic authority',scopes:['identity:read'],...extra});
  const call = (token,args={},headers={},suffix='') => fetch(base+'/agent/tools/mi_identidad'+suffix,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:JSON.stringify({arguments:args})});
  try {
    assert.equal((await make(0)).status,401);
    for (const Origin of ['', 'https://evil.example']) {
      assert.equal((await human(1,'/connections',{name:'Synthetic',scopes:['identity:read']},{Origin})).status,403);
    }
    for (const extra of [{owner_uid:2},{uid:2},{empresa_id:2}]) assert.equal((await make(1,extra)).status,400);
    const owned = [];
    for (const uid of [1,2,3,4,5,6,7,8]) {
      const response = await make(uid,uid===8?{empresa_id:1}:{});
      assert.equal(response.status,201,`role uid ${uid}`);
      const made = await response.json(); owned.push({uid,...made});
      const row = (await pool.query('SELECT owner_uid,empresa_id FROM agent_connections WHERE id=$1',[made.connection.id])).rows[0];
      assert.equal(Number(row.owner_uid),uid); assert.equal(Number(row.empresa_id),uid===3?2:1);
    }
    const first = owned[0];
    for (const uid of [2,3]) {
      assert.equal((await human(uid,`/connections/${first.connection.id}/revoke`,{})).status,404);
    }
    for (const headers of [{Origin:''},{Origin:'https://evil.example'}]) assert.equal((await human(1,`/connections/${first.connection.id}/revoke`,{},headers)).status,403);
    for (const body of [{owner_uid:2},{empresa_id:2}]) assert.equal((await human(1,`/connections/${first.connection.id}/revoke`,body)).status,400);
    assert.equal((await call()).status,401);
    assert.equal((await call('eyJhbGciOiJIUzI1NiJ9.synthetic.signature')).status,401);
    assert.equal((await call(null,{}, {cookie:`token=${first.token}`})).status,401);
    assert.equal((await call(null,{}, {},'?token='+encodeURIComponent(first.token))).status,401);
    assert.equal((await call(first.token,{}, {},'?token='+encodeURIComponent(first.token))).status,400);
    assert.equal((await call(first.token,{}, {Origin:origin})).status,403);
    assert.equal((await call(first.token,{owner_uid:2})).status,400);
    assert.equal((await call(first.token,{empresa_id:2})).status,400);
    const accepted = await call(first.token); assert.equal(accepted.status,200);
    // Scope and current-role checks precede both work and cached replay.
    const writer = await service.createConnection({uid:2},{name:'Synthetic writer',scopes:['orders:reopen']});
    const opts = {scope:'orders:reopen',tool:'synthetic_write',write:true,idempotencyKey:'12345678-1234-4234-8234-123456789abc',requestHash:'a'.repeat(64)};
    await pool.query('CREATE TABLE synthetic_effects(id int PRIMARY KEY)');
    let workCalls=0;
    const work = async ctx => {workCalls++;await ctx.query('INSERT INTO synthetic_effects VALUES(1)');return {ok:true,id:1,secret:'must not expand replay'};};
    const firstResult = await service.execute(writer.token,opts,work);
    assert.deepEqual(firstResult,{ok:true,id:1});
    assert.deepEqual(await service.execute(writer.token,opts,work),firstResult);assert.equal(workCalls,1);
    await assert.rejects(service.execute(first.token,opts,work),{status:403});
    await assert.rejects(service.execute(writer.token,{...opts,requestHash:'b'.repeat(64)},work),{status:409});
    await pool.query("UPDATE usuarios SET role='user' WHERE id=2");
    await assert.rejects(service.execute(writer.token,opts,work),{status:403});
    assert.equal(workCalls,1);assert.deepEqual((await pool.query('SELECT id FROM synthetic_effects')).rows,[{id:1}]);
    for (const made of owned) {
      assert.equal((await human(made.uid,`/connections/${made.connection.id}/revoke`,{})).status,200);
      assert.ok((await pool.query('SELECT revoked_at FROM agent_connections WHERE id=$1',[made.connection.id])).rows[0].revoked_at);
      assert.equal((await call(made.token)).status,401);
    }
    await service.revokeConnection({uid:2},writer.connection.id);
    await assert.rejects(service.execute(writer.token,opts,work),{status:401});assert.equal(workCalls,1);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
