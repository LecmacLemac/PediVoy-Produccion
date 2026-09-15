import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { bootstrapSuper } from '../scripts/bootstrap-super.js';

// Use a private, disposable cluster; never touch DATABASE_URL or an installed DB.
let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), '.security-pg-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'security_test', '--no-locale'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'security_test', database: 'postgres' });
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
}

const options = { skip: available ? false : 'Requires PostgreSQL server binaries (pg_config/initdb) and a non-root user' };
const sql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const migration = sql.slice(sql.indexOf('-- Roles DB:'), sql.indexOf('-- 5. CHOFERES'));
const allowed = ['user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin', 'super'];

test('PostgreSQL migration quarantines invalid roles, preserves canonical states and replaces stale CHECK on each run', options, async () => {
  await withDatabase(async pool => {
    await pool.query('CREATE TABLE usuarios (id SERIAL PRIMARY KEY, role TEXT, activo BOOLEAN)');
    const canonical = [];
    for (const role of allowed) {
      for (const active of [true, false]) {
        const { rows } = await pool.query('INSERT INTO usuarios(role, activo) VALUES ($1,$2) RETURNING *', [role, active]);
        canonical.push(rows[0]);
      }
    }
    for (const role of [null, 'guest', 'inventado', 'USER', ' admin ', 'SUPER', '']) {
      await pool.query('INSERT INTO usuarios(role, activo) VALUES ($1,true),($1,false),($1,NULL)', [role]);
    }
    await pool.query('ALTER TABLE usuarios ADD CONSTRAINT usuarios_role_check CHECK (true)');
    await pool.query(migration);
    const { rows } = await pool.query('SELECT * FROM usuarios ORDER BY id');
    assert.deepEqual(rows.slice(0, canonical.length), canonical);
    assert.ok(rows.slice(canonical.length).every(row => row.role === 'user' && row.activo === false));
    for (let run = 0; run < 2; run++) {
      if (run) {
        // A stale same-name constraint must be replaced even on a rerun.
        await pool.query('ALTER TABLE usuarios DROP CONSTRAINT usuarios_role_check');
        await pool.query('ALTER TABLE usuarios ADD CONSTRAINT usuarios_role_check CHECK (true)');
        await pool.query(migration);
      }
      assert.deepEqual((await pool.query('SELECT * FROM usuarios ORDER BY id')).rows, rows);
      const constraint = await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='usuarios_role_check' AND conrelid='usuarios'::regclass");
      assert.equal(constraint.rows.length, 1);
      assert.deepEqual([...constraint.rows[0].definition.matchAll(/'([^']+)'::text/g)].map(match => match[1]), allowed);
      for (const role of [null, 'guest', 'USER', 'inventado']) {
        await assert.rejects(pool.query('INSERT INTO usuarios(role, activo) VALUES ($1,true)', [role]), error => ['23502', '23514'].includes(error.code));
      }
      for (const role of allowed) await pool.query('INSERT INTO usuarios(role, activo) VALUES ($1,false)', [role]);
      await pool.query('DELETE FROM usuarios WHERE id > $1', [rows.at(-1).id]);
    }
  });
});

test('PostgreSQL bootstrap second run succeeds without changing credentials or creating another super', options, async () => {
  await withDatabase(async pool => {
    await pool.query('CREATE TABLE usuarios (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT, empresa_id INTEGER, activo BOOLEAN)');
    const env = { BOOTSTRAP_SUPER_USERNAME: 'super.ops', BOOTSTRAP_SUPER_PASSWORD: 'Correct-Horse-9!' };
    const first = await bootstrapSuper({ pool, env });
    const before = (await pool.query('SELECT * FROM usuarios')).rows;
    const second = await bootstrapSuper({ pool, env: { ...env, BOOTSTRAP_SUPER_PASSWORD: 'Different-Password-8!' }, bcrypt: { hash: () => assert.fail('No rehash on no-op') } });
    assert.deepEqual(second, first);
    assert.deepEqual((await pool.query('SELECT * FROM usuarios')).rows, before);
  });
});

// psql -f executes statements separately. Ending the file at each migration
// boundary models a disconnected/interrupted session before completion.
test('PostgreSQL psql interrupted role migration preserves rows and original constraint', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE usuarios (id SERIAL PRIMARY KEY, role TEXT, activo BOOLEAN, CONSTRAINT usuarios_role_check CHECK (true))");
    await pool.query("INSERT INTO usuarios(role, activo) VALUES ('guest', true)");
    const before = (await pool.query('SELECT * FROM usuarios')).rows;
    const directory = mkdtempSync(join(process.cwd(), '.security-pg-interrupt-'));
    try {
      const boundaries = [...migration.matchAll(/;/g)].map(match => match.index + 1);
      for (const end of boundaries.filter(end => !/COMMIT;\s*(?:--[^\n]*\n?)*\s*$/i.test(migration.slice(0, end)))) {
        const file = join(directory, 'partial.sql');
        writeFileSync(file, migration.slice(0, end));
        execFileSync(join(bin, 'psql'), ['-X', '-h', '127.0.0.1', '-p', String(pool.options.port), '-U', 'security_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', file], { stdio: 'pipe' });
        assert.deepEqual((await pool.query('SELECT * FROM usuarios')).rows, before);
        const constraints = await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='usuarios'::regclass AND conname='usuarios_role_check'");
        assert.deepEqual(constraints.rows, [{ definition: 'CHECK (true)' }]);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
