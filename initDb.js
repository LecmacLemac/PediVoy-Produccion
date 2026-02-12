// initDb.js — ejecuta initDb.sql en PostgreSQL (ESM) de forma idempotente
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
    // 1) ¿Ya existe la tabla empresas?
    const check = await client.query(`SELECT to_regclass('public.empresas') AS reg`);

    if (check.rows[0]?.reg) {
      console.log('✅ DB ya inicializada (tabla empresas existe). No corro initDb.sql');
      return;
    }

    // 2) Primera vez: ejecuto todo el SQL de creación + seeding
    await client.query(sql);
    console.log('✅ DB inicializada OK (initDb.sql ejecutado)');
  } catch (e) {
    console.error('❌ Error inicializando DB:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
