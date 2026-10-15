#!/usr/bin/env node
// Explicit manual migration only. Never loads .env or starts the application.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

export async function applyAgentIntegrations({pool,apply=false}={}) {
 if(apply!==true) throw Object.assign(new Error('Se requiere --apply explícito'),{code:'apply_required'});
 if(!pool) throw new Error('Pool requerido');
 const sql=await readFile(new URL('../src/agents/schema.sql',import.meta.url),'utf8');
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SET LOCAL search_path = public');
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pedivoy:agent-integrations:v1'))");
  await client.query(sql);
  await client.query('COMMIT');
 } catch {
  await client.query('ROLLBACK').catch(()=>{});
  throw Object.assign(new Error('No se pudo inicializar el esquema de agentes'),{code:'migration_failed'});
 } finally {client.release();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 if(process.argv.length!==3 || process.argv[2]!=='--apply') {
  console.error('Uso manual: DATABASE_URL=<destino explícito> node scripts/init-agent-integrations.js --apply (no carga .env)');
  process.exitCode=1;
 } else if(!process.env.DATABASE_URL) {
  console.error('DATABASE_URL explícita requerida; no se carga .env');process.exitCode=1;
 } else {
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try {await applyAgentIntegrations({pool,apply:true});console.log('Esquema de integraciones de agentes inicializado');}
  catch {console.error('Migración de agentes fallida; revisar destino y permisos');process.exitCode=1;}
  finally {await pool.end();}
 }
}
