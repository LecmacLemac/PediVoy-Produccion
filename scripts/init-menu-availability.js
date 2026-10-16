#!/usr/bin/env node
// Explicit operator command only; safe to import (no DB, dotenv or DDL side effects).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MENU_MIGRATION_LOCK = 684230158;

/** The caller supplies a dedicated, idle client; never pass an open transaction. */
export async function applyMenuAvailabilitySchema(client) {
  const sql = await readFile(new URL('../src/menu/schema.sql', import.meta.url), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1)', [MENU_MIGRATION_LOCK]);
    await client.query('SET LOCAL search_path = pg_catalog, public');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 12) throw Object.assign(new Error('Node 22.12+ (22.x) requerido'), { code: 'NODE_ENGINE' });
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    console.error('Uso explícito: node scripts/init-menu-availability.js --apply (DATABASE_URL provista por operador).');
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL requerida'), { code: 'DATABASE_URL_REQUIRED' });
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await applyMenuAvailabilitySchema(client);
    console.log('Esquema de menús aplicado sin backfill.');
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Never print connection strings, query parameters or database exception details.
    console.error(`Migración de menús rechazada (${error.code || 'MIGRATION_FAILED'}).`);
    process.exitCode = 1;
  });
}
