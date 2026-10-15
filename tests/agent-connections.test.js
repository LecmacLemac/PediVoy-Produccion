import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withIsolatedPostgres,postgresOptions} from './support/isolated-postgres.js';

export async function fixture(pool) {
 await pool.query(`CREATE TABLE empresas(id integer PRIMARY KEY,plan_estado text,plan_vencimiento timestamptz);
 CREATE TABLE choferes(id integer PRIMARY KEY, empresa_id integer,activo boolean);
 CREATE TABLE referentes(id integer PRIMARY KEY, empresa_id integer,activo boolean,deleted_at timestamptz);
 CREATE TABLE usuarios(id integer PRIMARY KEY,username text,role text,empresa_id integer,chofer_id integer,referente_id integer,activo boolean);
 INSERT INTO empresas VALUES(1,'active',NULL),(2,'active',NULL);
 INSERT INTO choferes VALUES(1,1,true),(2,1,true);
 INSERT INTO referentes VALUES(1,1,true,NULL),(2,1,true,NULL);
 INSERT INTO usuarios VALUES(1,'synthetic','user',1,NULL,NULL,true),(2,'synthetic2','admin',1,NULL,NULL,true),(3,'synthetic3','user',2,NULL,NULL,true),(4,'driver','repartidor',1,1,NULL,true),(5,'ref','referente',1,NULL,1,true),(6,'billing','facturacion',1,NULL,NULL,true),(7,'accountant','contable',1,NULL,NULL,true),(8,'super','super',NULL,NULL,NULL,true);`);
 await pool.query(await readFile(new URL('../src/agents/schema.sql',import.meta.url),'utf8'));
 const {createAgentService}=await import('../src/agents/service.js');
 const query=async(text,values)=>(await pool.query(text,values)).rows;
 const withTransaction=async work=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await work(async(t,v)=>(await c.query(t,v)).rows);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 return {service:createAgentService({query,withTransaction,enabled:true,canonicalOrigin:'https://pedivoy.example'}),query,withTransaction,createAgentService};
}
const actor=uid=>({uid});

test('minimal write acknowledgements preserve domain tomado without persisting payload',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);const {randomUUID}=await import('node:crypto');
 const made=await service.createConnection(actor(4),{name:'Driver',scopes:['deliveries:claim']});
 const opts={scope:'deliveries:claim',tool:'tomar_pedido',write:true,idempotencyKey:randomUUID(),requestHash:'a'.repeat(64)};
 const result=await service.execute(made.token,opts,async()=>({pedido_id:42,tomado:true,token:made.token}));
 assert.deepEqual(result,{pedido_id:42,tomado:true});
 assert.equal(JSON.stringify((await pool.query('SELECT result FROM agent_idempotency')).rows).includes(made.token),false);
}));

test('router bounds an already-parsed global body and rejects forged enable strings',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service,query,withTransaction,createAgentService}=await fixture(pool);
 const {default:express}=await import('express');const {createMiAgenteRouter}=await import('../src/routes/miAgente.js');
 const app=express();app.use(express.json());app.use('/api/mi-agente',createMiAgenteRouter({withAuth:(req,res,next)=>{req.user=actor(1);next();},service,canonicalOrigin:'https://pedivoy.example'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try {
  const res=await fetch(`http://127.0.0.1:${server.address().port}/api/mi-agente/connections`,{method:'POST',headers:{Origin:'https://pedivoy.example','Content-Type':'application/json'},body:JSON.stringify({name:'x'.repeat(9000),scopes:['identity:read']})});
  assert.equal(res.status,413);
 }finally{await new Promise(r=>server.close(r));}
 const disabled=createAgentService({query,withTransaction,enabled:'false',canonicalOrigin:'https://pedivoy.example'});
 await assert.rejects(disabled.createConnection(actor(1),{name:'Disabled',scopes:['identity:read']}),{code:'agents_disabled'});
}));

test('real transaction adapter never retries and reports ambiguous commit without inventing failure',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {query,createAgentService}=await fixture(pool);
 const {withTransaction:realTransaction}=await import('../src/db.js');
 const {randomUUID}=await import('node:crypto');
 let loseCommit=false;
 const adapterPool={connect:async()=>{
  const client=await pool.connect();
  return {query:async(sql,params)=>{const result=await client.query(sql,params);if(sql==='COMMIT'&&loseCommit){loseCommit=false;throw Error('Synthetic lost acknowledgement');}return result;},release:()=>client.release()};
 }};
 const service=createAgentService({query,enabled:true,canonicalOrigin:'https://pedivoy.example',withTransaction:(fn,options)=>realTransaction(fn,{...options,pool:adapterPool})});
 const made=await service.createConnection(actor(2),{name:'Commit safety',scopes:['orders:reopen']});
 const opts={scope:'orders:reopen',tool:'synthetic_write',write:true,idempotencyKey:randomUUID(),requestHash:'a'.repeat(64)};
 let calls=0;
 await assert.rejects(service.execute(made.token,opts,async()=>{calls++;throw Object.assign(Error('SQL private'),{code:'40001'});}),{status:500});
 assert.equal(calls,1);
 loseCommit=true;
 await assert.rejects(service.execute(made.token,opts,async()=>{calls++;return {ok:true,id:5};}),{status:503,code:'outcome_unknown'});
 assert.equal(calls,2);
 assert.deepEqual(await service.execute(made.token,opts,async()=>{calls++;return {ok:false};}),{ok:true,id:5});
 assert.equal(calls,2);
}));

async function waitForLock(pool,fragment) {
 const deadline=Date.now()+4000;
 while(Date.now()<deadline) {
  const rows=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS waiting",['%'+fragment+'%'])).rows;
  if(rows[0].waiting) return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Expected PostgreSQL row-lock wait');
}

test('concurrent role/baja/driver/license/revoke commits are revalidated before work or replay',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);const {randomUUID,createHash}=await import('node:crypto');
 const cases=[
  {uid:2,scope:'orders:reopen',sql:"UPDATE usuarios SET role='user' WHERE id=2",restore:"UPDATE usuarios SET role='admin' WHERE id=2",wait:'FROM usuarios WHERE id=$1 FOR SHARE',status:403,replay:true},
  {uid:2,scope:'orders:reopen',sql:'UPDATE usuarios SET activo=false WHERE id=2',restore:'UPDATE usuarios SET activo=true WHERE id=2',wait:'FROM usuarios WHERE id=$1 FOR SHARE',status:401},
  {uid:4,scope:'deliveries:claim',sql:'UPDATE choferes SET activo=false WHERE id=1',restore:'UPDATE choferes SET activo=true WHERE id=1',wait:'FROM choferes WHERE id=$1 FOR SHARE',status:401},
  {uid:8,scope:'orders:reopen',sql:"UPDATE empresas SET plan_estado='expired' WHERE id=2",restore:"UPDATE empresas SET plan_estado='active' WHERE id=2",wait:'FROM empresas WHERE id=$1 FOR SHARE',status:402},
  {uid:2,scope:'orders:reopen',sql:'UPDATE agent_connections SET revoked_at=now() WHERE id=$1',wait:'FROM agent_connections WHERE id=$1 FOR UPDATE',status:401},
 ];
 for(const item of cases) {
  const made=await service.createConnection(actor(item.uid),{name:'Concurrent safety',scopes:[item.scope],...(item.uid===8?{empresa_id:2}:{})});
  const opts={scope:item.scope,tool:'synthetic_write',write:true,idempotencyKey:randomUUID(),requestHash:createHash('sha256').update('{}').digest('hex')};
  await service.execute(made.token,opts,async()=>({ok:true,id:1}));
  const holder=await pool.connect();let pending;let called=false;
  try {
   await holder.query('BEGIN');await holder.query(item.sql,item.sql.includes('$1')?[made.connection.id]:[]);
   pending=Promise.all([opts,{...opts,idempotencyKey:randomUUID()}].map(options=>service.execute(made.token,options,async()=>{called=true;return {ok:true};}).then(result=>({result}),error=>({error}))));
   await waitForLock(pool,item.wait);
   await holder.query('COMMIT');
   const results=await pending;for(const result of results) assert.equal(result.error?.status,item.status);assert.equal(called,false);
  }finally{await holder.query('ROLLBACK');holder.release();if(pending) await pending;}
  if(item.restore) await pool.query(item.restore);
 }
}));

test('in-flight domain work holds owner/link/license locks while concurrent legacy updates wait',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const made=await service.createConnection(actor(4),{name:'Held locks',scopes:['deliveries:read']});
 let release;const gate=new Promise(resolve=>{release=resolve;});let started;const entered=new Promise(resolve=>{started=resolve;});
 const work=service.execute(made.token,{scope:'deliveries:read',tool:'mis_repartos'},async()=>{started();await gate;return {ok:true};});
 await entered;
 const legacy=pool.query('UPDATE choferes SET activo=false WHERE id=1');
 try {await waitForLock(pool,'UPDATE choferes SET activo=false');}finally{release();}
 assert.deepEqual(await work,{ok:true});await legacy;
 await assert.rejects(service.authenticate(made.token),{status:401});
}));

test('sensitive identity changes permanently revoke even after A-B-A restoration',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 for(const [uid,away,back] of [
  [1,'UPDATE usuarios SET empresa_id=2 WHERE id=1','UPDATE usuarios SET empresa_id=1 WHERE id=1'],
  [1,'UPDATE usuarios SET activo=false WHERE id=1','UPDATE usuarios SET activo=true WHERE id=1'],
  [4,'UPDATE usuarios SET chofer_id=2 WHERE id=4','UPDATE usuarios SET chofer_id=1 WHERE id=4'],
  [4,'UPDATE choferes SET activo=false WHERE id=1','UPDATE choferes SET activo=true WHERE id=1'],
  [4,'UPDATE choferes SET empresa_id=2 WHERE id=1','UPDATE choferes SET empresa_id=1 WHERE id=1'],
  [5,'UPDATE usuarios SET referente_id=2 WHERE id=5','UPDATE usuarios SET referente_id=1 WHERE id=5'],
  [5,'UPDATE referentes SET deleted_at=now() WHERE id=1','UPDATE referentes SET deleted_at=NULL WHERE id=1'],
  [5,'UPDATE referentes SET activo=false WHERE id=1','UPDATE referentes SET activo=true WHERE id=1'],
 ]) {
  const made=await service.createConnection(actor(uid),{name:'Permanent revoke',scopes:['identity:read']});
  await pool.query(away);await pool.query(back);
  await assert.rejects(service.authenticate(made.token),{status:401});
  assert.ok((await pool.query('SELECT revoked_at FROM agent_connections WHERE id=$1',[made.connection.id])).rows[0].revoked_at);
 }
}));

test('owner quotas prevent token rotation bypass for calls and creation',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const a=await service.createConnection(actor(1),{name:'A',scopes:['identity:read']});
 const b=await service.createConnection(actor(1),{name:'B',scopes:['identity:read']});
 const opts={scope:'identity:read',tool:'mi_identidad'};
 for(let i=0;i<60;i++) await service.execute(i%2?a.token:b.token,opts,async()=>({ok:true}));
 let called=false;
 await assert.rejects(service.execute(a.token,opts,async()=>{called=true;}),{status:429});assert.equal(called,false);
 await assert.rejects(service.authenticate(b.token),{status:429});
 await service.revokeConnection(actor(1),a.connection.id);await service.revokeConnection(actor(1),b.connection.id);
 for(let i=2;i<30;i++){const c=await service.createConnection(actor(1),{name:'Rotated',scopes:['identity:read']});await service.revokeConnection(actor(1),c.connection.id);}
 await assert.rejects(service.createConnection(actor(1),{name:'Over quota',scopes:['identity:read']}),{status:429});
}));

test('denied scopes consume quota and leave a metadata-only failed audit event',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const made=await service.createConnection(actor(1),{name:'Reader',scopes:['identity:read']});
 let calls=0;
 await assert.rejects(service.execute(made.token,{scope:'orders:read',tool:'mis_pedidos'},async()=>++calls),{status:403});
 assert.equal(calls,0);
 const events=(await service.listAudit(actor(1),{})).events;
 assert.equal(events[0].tool,'mis_pedidos');assert.equal(events[0].outcome,'error');
 assert.equal((await pool.query('SELECT quota_count FROM agent_connections WHERE id=$1',[made.connection.id])).rows[0].quota_count,1);
}));

test('all seven canonical roles grant only their own scopes and super binds explicit company',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);const {allowedScopesForRole}=await import('../src/agents/policy.js');
 for(const [uid,role] of [[1,'user'],[2,'admin'],[4,'repartidor'],[5,'referente'],[6,'facturacion'],[7,'contable'],[8,'super']]) {
  const scopes=allowedScopesForRole(role);
  const made=await service.createConnection({uid,role:'super',empresa_id:999},{name:role,scopes,...(role==='super'?{empresa_id:2}:{})});
  const ctx=await service.authenticate(made.token);assert.equal(ctx.actor.role,role);assert.equal(ctx.empresaId,role==='super'?2:1);assert.deepEqual(ctx.scopes,scopes);
  assert.deepEqual((await service.listAudit(actor(3),{})).events,[]);
 }
 await assert.rejects(service.createConnection(actor(1),{name:'Override',scopes:['identity:read'],empresa_id:2}),{status:400});
 await assert.rejects(service.createConnection(actor(8),{name:'Missing tenant',scopes:['identity:read']}),{status:400});
 await assert.rejects(service.createConnection(actor(8),{name:'Unknown tenant',scopes:['identity:read'],empresa_id:999}),{status:403});
 await assert.rejects(service.createConnection(actor(1),{name:'Promote',scopes:['orders:reopen']}),{status:403});
}));

test('current owner changes invalidate tenant, active status, role grants and driver/referent links',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const user=await service.createConnection(actor(1),{name:'User',scopes:['identity:read','orders:read']});
 const driver=await service.createConnection(actor(4),{name:'Driver',scopes:['deliveries:read']});
 const ref=await service.createConnection(actor(5),{name:'Ref',scopes:['referrals:read']});
 await pool.query("UPDATE usuarios SET role='admin' WHERE id=1");
 await assert.rejects(service.authenticate(user.token,{scope:'orders:reopen'}),{status:403});
 await pool.query("UPDATE usuarios SET role='facturacion' WHERE id=1");
 await assert.rejects(service.authenticate(user.token,{scope:'orders:read'}),{status:403});
 assert.deepEqual((await service.authenticate(user.token)).scopes,['identity:read']);
 await pool.query('UPDATE usuarios SET empresa_id=2 WHERE id=1');
 await assert.rejects(service.authenticate(user.token),{status:401});
 await pool.query('UPDATE usuarios SET empresa_id=1,activo=false WHERE id=1');
 await assert.rejects(service.authenticate(user.token),{status:401});
 await pool.query('UPDATE usuarios SET chofer_id=2 WHERE id=4');
 await assert.rejects(service.authenticate(driver.token),{status:401});
 await pool.query('UPDATE usuarios SET chofer_id=1 WHERE id=4; UPDATE choferes SET activo=false WHERE id=1');
 await assert.rejects(service.authenticate(driver.token),{status:401});
 await pool.query('UPDATE usuarios SET referente_id=2 WHERE id=5');
 await assert.rejects(service.authenticate(ref.token),{status:401});
 await pool.query('UPDATE usuarios SET referente_id=1 WHERE id=5; UPDATE referentes SET deleted_at=now() WHERE id=1');
 await assert.rejects(service.authenticate(ref.token),{status:401});
 await pool.query('DELETE FROM usuarios WHERE id=5');
 await assert.rejects(service.authenticate(ref.token),{status:401});
}));

test('connection cap is serialized, expiry bounded and license never blocks revocation',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service,query,withTransaction,createAgentService}=await fixture(pool);
 const results=await Promise.allSettled(Array.from({length:11},(_,i)=>service.createConnection(actor(1),{name:`Concurrent ${i}`,scopes:['identity:read']})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10);assert.equal(results.filter(r=>r.reason?.code==='connection_limit').length,1);
 const made=results.find(r=>r.status==='fulfilled').value;
 assert.equal(new Date(made.connection.expires_at)-new Date(made.connection.created_at),7*86400000);
 for(const days of [0,31,1.5,'7']) await assert.rejects(service.createConnection(actor(2),{name:'Invalid expiry',scopes:['identity:read'],expires_in_days:days}),{status:400});
 await pool.query("UPDATE empresas SET plan_estado='expired' WHERE id=1");
 await assert.rejects(service.authenticate(made.token),{status:402});
 await assert.rejects(service.createConnection(actor(2),{name:'Expired',scopes:['identity:read']}),{status:402});
 assert.equal((await service.listConnections(actor(1))).length,10);
 assert.ok((await service.listAudit(actor(1),{})).events.length);
 const disabled=createAgentService({query,withTransaction,enabled:false,canonicalOrigin:'https://pedivoy.example'});
 await assert.rejects(disabled.authenticate(made.token),{code:'agents_disabled'});
 await disabled.revokeConnection(actor(1),made.connection.id);
 const badOrigin=createAgentService({query,withTransaction,enabled:true,canonicalOrigin:'http://pedivoy.example'});
 await assert.rejects(badOrigin.createConnection(actor(2),{name:'No HTTPS',scopes:['identity:read']}),{code:'canonical_origin_required'});
 await assert.rejects(service.createConnection(actor(8),{name:'Expired selected company',scopes:['identity:read'],empresa_id:1}),{status:402});
 const superMade=await service.createConnection(actor(8),{name:'Super',scopes:['identity:read'],empresa_id:2,expires_in_days:30});
 assert.equal((await service.authenticate(superMade.token)).empresaId,2);
 await pool.query('UPDATE agent_connections SET expires_at=now()-interval \'1 second\' WHERE id=$1',[superMade.connection.id]);
 await assert.rejects(service.authenticate(superMade.token),{status:401});
}));

test('read quotas are database-shared and audit pagination never crosses owners',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service,query,withTransaction,createAgentService}=await fixture(pool);
 const other=createAgentService({query,withTransaction,enabled:true,canonicalOrigin:'https://pedivoy.example'});
 const made=await service.createConnection(actor(1),{name:'Reader',scopes:['identity:read']});
 let calls=0;
 for(let i=0;i<60;i++) assert.equal(await (i%2?service:other).execute(made.token,{scope:'identity:read',tool:'mi_identidad',write:false},async()=>++calls),i+1);
 await assert.rejects(other.execute(made.token,{scope:'identity:read',tool:'mi_identidad',write:false},async()=>++calls),{status:429});
 assert.equal(calls,60);
 const first=await service.listAudit(actor(1),{limit:10});assert.equal(first.events.length,10);assert.ok(first.next_cursor);
 const second=await service.listAudit(actor(1),{limit:10,before:first.next_cursor});assert.equal(second.events.length,10);assert.ok(BigInt(second.events[0].id)<BigInt(first.events.at(-1).id));
 assert.deepEqual(await service.listAudit(actor(3),{limit:10}),{events:[],next_cursor:null});
 await assert.rejects(service.listAudit(actor(1),{before:'9999999999999999999'}),{status:400});
 await pool.query("UPDATE agent_connections SET quota_start=now()-interval '2 minutes' WHERE id=$1",[made.connection.id]);
 await pool.query("UPDATE agent_owner_quotas SET calls_start=now()-interval '2 minutes' WHERE owner_uid=1");
 await service.execute(made.token,{scope:'identity:read',tool:'mi_identidad'},async()=>++calls);assert.equal(calls,61);
}));

test('manual schema runner requires explicit apply and fresh initialization includes identical DDL',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {applyAgentIntegrations}=await import('../scripts/init-agent-integrations.js');
 const before=(await pool.query("SELECT to_regclass('agent_connections') AS name")).rows[0];assert.equal(before.name,null);
 await assert.rejects(applyAgentIntegrations({pool}),{code:'apply_required'});
 await applyAgentIntegrations({pool,apply:true});
 await applyAgentIntegrations({pool,apply:true});
 assert.equal((await pool.query("SELECT to_regclass('agent_connections') AS name")).rows[0].name,'agent_connections');
 const ddl=await readFile(new URL('../src/agents/schema.sql',import.meta.url),'utf8');
 const init=await readFile(new URL('../initDb.sql',import.meta.url),'utf8');
 assert.ok(init.replaceAll('\r\n','\n').includes(ddl.trim()));
}));

test('human router enforces exact Origin, JSON, owner, no-store and sanitized errors',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const {default:express}=await import('express');
 const {createMiAgenteRouter}=await import('../src/routes/miAgente.js');
 const app=express();
 app.use('/api/mi-agente',createMiAgenteRouter({withAuth:(req,res,next)=>{req.user=actor(1);next();},service,canonicalOrigin:'https://pedivoy.example'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/mi-agente`;
 const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://pedivoy.example',...headers},body:JSON.stringify(body)});
 try {
  const policy=await fetch(base+'/policy');assert.equal(policy.status,200);assert.equal(policy.headers.get('cache-control'),'no-store');
  assert.equal((await post('/connections',{name:'External',scopes:['identity:read']},{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/connections',{name:'External',scopes:['identity:read']},{Origin:''})).status,403);
  assert.equal((await post('/connections',{name:'External',scopes:['identity:read'],owner_uid:2})).status,400);
  assert.equal((await post('/connections',{name:'External',scopes:['identity:read']},{'Content-Type':'text/plain'})).status,415);
  const made=await post('/connections',{name:'External',scopes:['identity:read']});assert.equal(made.status,201);
  const data=await made.json();assert.ok(data.token);
  const listing=await (await fetch(base+'/connections')).json();assert.equal(listing.connections.length,1);assert.equal(JSON.stringify(listing).includes(data.token),false);
  assert.equal((await post(`/connections/${data.connection.id}/revoke`,{})).status,200);
  assert.equal((await fetch(base+'/audit?limit=1')).status,200);
  assert.equal((await fetch(base+'/audit?uid=2')).status,400);
  const malformed=await fetch(base+'/connections',{method:'POST',headers:{Origin:'https://pedivoy.example','Content-Type':'application/json'},body:'{'});
  assert.equal(malformed.status,400);assert.equal((await malformed.text()).includes('SyntaxError'),false);
 }finally{await new Promise(r=>server.close(r));}
}));

test('uses no automatic transaction retries and redacts even database error messages',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {createAgentService,query,withTransaction}=await fixture(pool);
 let txOptions;
 const service=createAgentService({query,withTransaction:(fn,options)=>{txOptions=options;return withTransaction(fn);},enabled:true,canonicalOrigin:'https://pedivoy.example'});
 await service.createConnection(actor(1),{name:'External',scopes:['identity:read']});
 assert.equal(txOptions?.maxRetries,0);
 const broken=createAgentService({query:async()=>{throw Object.assign(Error('secret SQL'),{code:'42P01'});},withTransaction});
 await assert.rejects(broken.listConnections(actor(1)),e=>e.status===503 && e.code==='schema_required' && !e.message.includes('SQL'));
}));

test('execute atomically records minimal write results, rejects mismatched keys and rolls back',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const {randomUUID,createHash}=await import('node:crypto');
 await pool.query('CREATE TABLE synthetic_effects(id integer PRIMARY KEY)');
 const made=await service.createConnection(actor(2),{name:'Writer',scopes:['orders:reopen']});
 const options={scope:'orders:reopen',tool:'reabrir_pedido_cancelado',write:true,idempotencyKey:randomUUID(),requestHash:createHash('sha256').update('{}').digest('hex')};
 let calls=0;
 const work=async ctx=>{calls++;await ctx.query('INSERT INTO synthetic_effects VALUES(1)');return {ok:true,id:1,estado:'pendiente',token:made.token,email:'private@example.test',arguments:{secret:'private'}};};
 assert.equal(typeof service.execute,'function');
 const first=await service.execute(made.token,options,work);
 assert.deepEqual(first,{ok:true,id:1,estado:'pendiente'});
 assert.deepEqual(await service.execute(made.token,options,work),first);
 assert.equal(calls,1);
 await assert.rejects(service.execute(made.token,{...options,requestHash:'a'.repeat(64)},work),{status:409});
 await assert.rejects(service.execute(made.token,{...options,idempotencyKey:randomUUID()},async ctx=>{await ctx.query('INSERT INTO synthetic_effects VALUES(2)');throw Error('PII-secret');}),{status:500});
 assert.deepEqual((await pool.query('SELECT id FROM synthetic_effects')).rows,[{id:1}]);
 assert.equal((await pool.query('SELECT * FROM agent_idempotency')).rows.length,1);
 const audit=(await service.listAudit(actor(2),{})).events;
 assert.deepEqual(audit.filter(e=>e.tool==='reabrir_pedido_cancelado').map(e=>e.outcome),['error','error','replayed','ok']);
 assert.equal(JSON.stringify(audit).includes('PII-secret'),false);
 await assert.rejects(service.execute(made.token,{...options,write:false},work),{status:400});
}));
test('connections store only digest, isolate ownership, authenticate current identity',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const {service}=await fixture(pool);
 const made=await service.createConnection(actor(1),{name:'External',scopes:['identity:read','orders:read']});
 assert.match(made.token,/^pva_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
 assert.equal(JSON.stringify(made.connection).includes(made.token),false);
 const stored=(await pool.query('SELECT * FROM agent_connections')).rows[0];
 assert.equal(stored.token_hash.length,64); assert.equal(JSON.stringify(stored).includes(made.token),false);
 assert.equal((await service.authenticate(made.token,{scope:'orders:read'})).empresaId,1);
 assert.deepEqual(await service.listConnections(actor(2)),[]);
 await assert.rejects(service.revokeConnection(actor(2),made.connection.id),{status:404});
 await assert.rejects(service.authenticate(made.token.slice(0,-1)+'!'),{status:401});
 await service.revokeConnection(actor(1),made.connection.id);
 await service.revokeConnection(actor(1),made.connection.id);
 await assert.rejects(service.authenticate(made.token),{status:401});
}));
