import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withIsolatedPostgres,postgresOptions} from './support/isolated-postgres.js';
import {applyAgentIntegrations} from '../scripts/init-agent-integrations.js';

const schema=await readFile(new URL('../src/agents/schema.sql',import.meta.url),'utf8');
const canonical=await readFile(new URL('../initDb.sql',import.meta.url),'utf8');
const begin='-- BEGIN PERSONAL AGENT INTEGRATIONS';
const end='-- END PERSONAL AGENT INTEGRATIONS';
const relations=['agent_connections','agent_owner_quotas','agent_audit','agent_idempotency'];

test('canonical agent block exactly matches standalone SQL inside the existing final transaction',()=>{
 const normalized=canonical.replaceAll('\r\n','\n');
 const start=normalized.indexOf(begin);
 const stop=normalized.indexOf(end,start);
 assert.ok(start>=0 && stop>start);
 assert.equal(normalized.slice(start+begin.length,stop).trim(),schema.trim());
 assert.match(normalized.slice(stop+end.length),/^\s*COMMIT;\s*$/);
 const before=normalized.slice(0,start);
 assert.ok(before.lastIndexOf('BEGIN;')>before.lastIndexOf('COMMIT;'));
 assert.match(before.slice(before.lastIndexOf('BEGIN;')),/SET LOCAL search_path = public;/);
});

test('standalone SQL and manual runner migrate twice without touching shadow relations or leaking search_path',postgresOptions,async()=>withIsolatedPostgres(async pool=>{
 const client=await pool.connect();
 try {
  await client.query(`CREATE SCHEMA shadow;
   CREATE TABLE public.usuarios(id integer PRIMARY KEY,empresa_id integer,chofer_id integer,referente_id integer,activo boolean);
   INSERT INTO public.usuarios VALUES(1,1,NULL,NULL,true);
   CREATE FUNCTION shadow.clock_timestamp() RETURNS timestamptz LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow builtin called'; END $$;
   SET search_path = shadow, pg_catalog, public;`);
  for(const relation of relations) await client.query(`CREATE TABLE shadow.${relation}(marker integer); INSERT INTO shadow.${relation} VALUES(73)`);
  const original=(await client.query('SHOW search_path')).rows;
  for(let pass=0;pass<2;pass++) {
   await client.query(schema);
   assert.deepEqual((await client.query('SHOW search_path')).rows,original);
  }
  const boundPool={connect:async()=>({query:(...args)=>client.query(...args),release:()=>{}})};
  for(let pass=0;pass<2;pass++) {
   await applyAgentIntegrations({pool:boundPool,apply:true});
   assert.deepEqual((await client.query('SHOW search_path')).rows,original);
  }
  for(const relation of relations) {
   assert.deepEqual((await client.query(`SELECT * FROM shadow.${relation}`)).rows,[{marker:73}]);
   assert.notEqual((await client.query('SELECT pg_catalog.to_regclass($1) AS oid',[`public.${relation}`])).rows[0].oid,null);
  }
  await client.query(`INSERT INTO public.agent_connections(id,owner_uid,empresa_id,role_at_issue,name,scopes,token_hash,created_at,expires_at)
   VALUES('00000000-0000-4000-8000-000000000001',1,1,'user','Synthetic',ARRAY['identity:read'],repeat('a',64),now(),now()+interval '1 day');
   UPDATE public.usuarios SET empresa_id=2 WHERE id=1;
   UPDATE public.usuarios SET empresa_id=1 WHERE id=1;`);
  assert.equal((await client.query('SELECT revoked_at IS NOT NULL AS revoked FROM public.agent_connections')).rows[0].revoked,true);
 } finally {client.release();}
}));
