import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import vm from 'node:vm';
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

test('PostgreSQL migration quarantines invalid roles and incoherent tenants, preserves valid canonical states and replaces stale CHECK on each run', options, async () => {
  await withDatabase(async pool => {
    await pool.query('CREATE TABLE usuarios (id SERIAL PRIMARY KEY, role TEXT, empresa_id INTEGER, activo BOOLEAN)');
    const canonical = [];
    for (const role of allowed) {
      for (const active of [true, false]) {
        const { rows } = await pool.query('INSERT INTO usuarios(role, empresa_id, activo) VALUES ($1,$2,$3) RETURNING *', [role, role === 'super' ? null : 7, active]);
        canonical.push(rows[0]);
      }
    }
    // Multiple global supers are legitimate and must remain active.
    canonical.push((await pool.query("INSERT INTO usuarios(role, empresa_id, activo) VALUES ('super',NULL,true) RETURNING *")).rows[0]);
    const incoherent = [];
    for (const role of allowed) {
      for (const empresaId of role === 'super' ? [7, 0, -1] : [null, 0, -1]) {
        for (const active of [true, false, null]) {
          const { rows } = await pool.query('INSERT INTO usuarios(role, empresa_id, activo) VALUES ($1,$2,$3) RETURNING *', [role, empresaId, active]);
          incoherent.push({ ...rows[0], activo: false });
        }
      }
    }
    for (const role of [null, 'guest', 'inventado', 'USER', ' admin ', 'SUPER', '']) {
      await pool.query('INSERT INTO usuarios(role, activo) VALUES ($1,true),($1,false),($1,NULL)', [role]);
    }
    await pool.query('ALTER TABLE usuarios ADD CONSTRAINT usuarios_role_check CHECK (true)');
    await pool.query(migration);
    const { rows } = await pool.query('SELECT * FROM usuarios ORDER BY id');
    assert.deepEqual(rows.slice(0, canonical.length), canonical);
    assert.deepEqual(rows.slice(canonical.length, canonical.length + incoherent.length), incoherent);
    assert.ok(rows.slice(canonical.length + incoherent.length).every(row => row.role === 'user' && row.activo === false));
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
    await pool.query("CREATE TABLE usuarios (id SERIAL PRIMARY KEY, role TEXT, empresa_id INTEGER, activo BOOLEAN, CONSTRAINT usuarios_role_check CHECK (true))");
    await pool.query("INSERT INTO usuarios(role, empresa_id, activo) VALUES ('guest', NULL, true), ('super', 7, true), ('admin', NULL, true), ('user', 0, true)");
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

const identitySchema = sql.slice(0, sql.indexOf('CREATE TABLE IF NOT EXISTS referente_productos'));
test('PostgreSQL full schema order quarantines identity links atomically and reruns without changing valid identities', options, async () => {
  await withDatabase(async pool => {
    // Run the actual schema through referentes, including the early role block.
    await pool.query(identitySchema);
    await pool.query("INSERT INTO empresas(id,nombre) VALUES (7,'Seven'),(8,'Eight')");
    await pool.query("INSERT INTO choferes(id,empresa_id,nombre,activo) VALUES (1,7,'Valid',true),(2,7,'Inactive',false),(3,8,'Foreign',true),(4,7,'Null',NULL)");
    await pool.query("INSERT INTO referentes(id,empresa_id,nombre,codigo,activo,deleted_at) VALUES (1,7,'Valid','a',true,NULL),(2,7,'Inactive','b',false,NULL),(3,8,'Foreign','c',true,NULL),(4,7,'Deleted','d',true,NOW())");
    const expected = [];
    async function add(role, chofer, referente, active, valid) {
      const { rows } = await pool.query('INSERT INTO usuarios(username,password,role,empresa_id,chofer_id,referente_id,activo) VALUES ($1,\'unused\',$2,$3,$4,$5,$6) RETURNING *', [String(expected.length), role, role === 'super' ? null : 7, chofer, referente, active]);
      expected.push({ ...rows[0], activo: valid ? active : false });
    }
    for (const active of [true, false]) {
      for (const role of allowed) {
        await add(role, role === 'repartidor' ? 1 : null, role === 'referente' ? 1 : null, active, true);
        if (!['repartidor', 'referente'].includes(role)) {
          await add(role, 1, null, active, false);
          await add(role, null, 1, active, false);
        }
      }
      for (const role of ['repartidor', 'referente']) {
        for (const id of [null, 0, -1, 2, 3, 4, 999]) await add(role, role === 'repartidor' ? id : null, role === 'referente' ? id : null, active, false);
        await add(role, 1, 1, active, false);
      }
    }
    await add('super', null, null, true, true);
    const before = (await pool.query('SELECT * FROM usuarios ORDER BY id')).rows;
    const blockStart = identitySchema.indexOf('-- Identity-link quarantine:');
    assert.ok(blockStart > identitySchema.indexOf('CREATE TABLE IF NOT EXISTS referentes'), 'Quarantine must follow linked tables');
    const block = identitySchema.slice(blockStart, identitySchema.indexOf('COMMIT;', blockStart) + 7);
    const directory = mkdtempSync(join(process.cwd(), '.security-pg-interrupt-'));
    try {
      for (const match of block.matchAll(/;/g)) {
        const partial = block.slice(0, match.index + 1);
        if (partial.endsWith('COMMIT;')) continue;
        const file = join(directory, 'partial.sql');
        writeFileSync(file, partial);
        execFileSync(join(bin, 'psql'), ['-X', '-h', '127.0.0.1', '-p', String(pool.options.port), '-U', 'security_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', file], { stdio: 'pipe' });
        assert.deepEqual((await pool.query('SELECT * FROM usuarios ORDER BY id')).rows, before);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
    for (let run = 0; run < 2; run++) {
      await pool.query(identitySchema);
      assert.deepEqual((await pool.query('SELECT * FROM usuarios ORDER BY id')).rows, expected);
    }
  });
});


test('PostgreSQL WhatsApp full normalized identities reject suffix collisions and duplicates', options, async () => {
  await withDatabase(async pool => {
    await pool.query(`
      CREATE TABLE usuarios (id SERIAL PRIMARY KEY, username TEXT, telefono TEXT, role TEXT,
        empresa_id INTEGER, chofer_id INTEGER, referente_id INTEGER, activo BOOLEAN);
      CREATE TABLE choferes (id INTEGER PRIMARY KEY, telefono TEXT, empresa_id INTEGER, nombre TEXT, activo BOOLEAN);
      CREATE TABLE referentes (id INTEGER PRIMARY KEY, empresa_id INTEGER, activo BOOLEAN, deleted_at TIMESTAMP);
      CREATE TABLE puntos_entrega (id INTEGER, telefono TEXT, empresa_id INTEGER, cliente TEXT);
      CREATE TABLE empresas (id INTEGER);
      INSERT INTO empresas VALUES (7);
      INSERT INTO puntos_entrega VALUES (1, '3871234567', 7, 'Cliente');
    `);
    const source = readFileSync(new URL('../src/handlers.js', import.meta.url), 'utf8')
      .replace(/^import .*;\r?$/gm, '')
      .replace('export default { start };', 'globalThis.resolve = _resolverContextoDesdeTelefono;');
    const calls = [];
    const sandbox = { console, process: { env: {} }, query: async (sql, params) => {
      calls.push(sql);
      return (await pool.query(sql, params)).rows;
    } };
    vm.runInNewContext(source, sandbox);
    const resolve = (sender = '5493871234567') => sandbox.resolve(`${sender}@c.us`);
    const reset = () => pool.query('TRUNCATE usuarios, choferes');
    const addUser = (username, telefono = null, activo = true) => pool.query(
      "INSERT INTO usuarios(username, telefono, role, activo) VALUES ($1,$2,'super',$3)", [username, telefono, activo]);
    for (const stored of ['343871234567', '3871234567']) {
      await reset();
      await addUser(stored);
      assert.equal((await resolve()).role, 'cliente', `user ${stored} must not match`);
      await pool.query('TRUNCATE usuarios');
      await pool.query("INSERT INTO choferes VALUES (4,$1,7,'Chofer',true)", [stored]);
      assert.equal((await resolve()).role, 'cliente', `chofer ${stored} must not match`);
    }
    await reset();
    await addUser('+54 (938) 712-34567');
    await addUser('+34 387 123 4567');
    assert.equal((await resolve()).role, 'super');
    assert.equal((await resolve('343871234567')).role, 'super');
    for (const activo of [true, false]) {
      await reset();
      await addUser('5493871234567');
      await addUser('+54 (938) 712-34567', null, activo);
      calls.length = 0;
      assert.equal(await resolve(), null);
      assert.equal(calls.length, 1, 'Ambiguous users cannot fall back');
      await reset();
      await pool.query("INSERT INTO choferes VALUES (4,'5493871234567',7,'A',true),(5,'+54 (938) 712-34567',8,'B',$1)", [activo]);
      calls.length = 0;
      assert.equal(await resolve(), null);
      assert.equal(calls.length, 2, 'Ambiguous drivers cannot read linked users or customers');
    }
    await reset();
    await addUser('operator', '+54 (938) 712-34567');
    assert.equal((await resolve()).role, 'super');
    await addUser('5493871234567');
    assert.equal(await resolve(), null, 'Cross-field duplicate must fail closed');
    await reset();
    await addUser('+54 (938) 712-34567', '5493871234567');
    assert.equal((await resolve()).role, 'super', 'Two fields on one user are one candidate');
    await reset();
    await pool.query("INSERT INTO choferes VALUES (5,'+34 387 123 4567',8,'B',true),(4,'+54 (938) 712-34567',7,'A',true)");
    for (const [sender, id, tenant] of [['5493871234567', 4, 7], ['343871234567', 5, 8]]) {
      const ctx = await resolve(sender);
      assert.equal(ctx.role, 'repartidor');
      assert.equal(ctx.chofer_id, id);
      assert.equal(ctx.empresa_id, tenant);
    }
    await pool.query("INSERT INTO usuarios(username, role, empresa_id, chofer_id, activo) VALUES ('+54 (938) 712-34567','repartidor',7,4,true)");
    assert.equal((await resolve()).role, 'repartidor');
    await pool.query('UPDATE choferes SET activo = false WHERE id = 4');
    assert.equal(await resolve(), null, 'Exact identity still requires a coherent active link');
  });
});
