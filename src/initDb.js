// initDb.js — ejecuta initDb.sql en PostgreSQL (ESM)
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const sqlPath = path.join(__dirname, 'initDb.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('✅ DB inicializada OK');
  } catch (e) {
    console.error('❌ Error inicializando DB:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
