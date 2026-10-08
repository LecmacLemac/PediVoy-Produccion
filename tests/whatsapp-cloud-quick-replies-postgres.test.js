import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { createQuickRepliesRepository } from '../src/whatsappCloud/quickRepliesRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available, 'Task 5 PostgreSQL gate requires local PostgreSQL');
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const start = initSql.indexOf('-- BEGIN WHATSAPP CLOUD QUICK REPLIES MIGRATION');
const endMarker = '-- END WHATSAPP CLOUD QUICK REPLIES MIGRATION';
assert.ok(start >= 0 && initSql.indexOf(endMarker, start) > start, 'quick replies migration marker required');
const migrationSql = initSql.slice(start, initSql.indexOf(endMarker, start) + endMarker.length);
const prefix = '.whatsapp-cloud-task5-pg-';
const created = new Set();

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), prefix));
  created.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let pool;
  let started = false;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'task5_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k '' -c allow_system_table_mods=on`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'task5_test', database: 'postgres', max: 8 });
    await pool.query('CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
    await pool.query(`CREATE TABLE usuarios (id INTEGER PRIMARY KEY, role TEXT NOT NULL, empresa_id INTEGER REFERENCES empresas(id), activo BOOLEAN NOT NULL DEFAULT TRUE)`);
    await pool.query(migrationSql);
    await work(pool);
  } finally {
    await pool?.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    created.delete(directory);
  }
}

after(() => {
  assert.deepEqual(readdirSync(process.cwd()).filter(name => name.startsWith(prefix)), []);
  assert.equal(created.size, 0);
});

function repository(pool) {
  return createQuickRepliesRepository({ pool, query: async (sql, params) => (await pool.query(sql, params)).rows });
}

async function seed(pool) {
  await pool.query("INSERT INTO empresas(id) VALUES (1),(2); INSERT INTO usuarios(id,role,empresa_id,activo) VALUES (11,'admin',1,true),(21,'admin',2,true),(31,'super',NULL,true)");
}

test('migración quick replies es idempotente, conserva OID/xmin y falla cerrada ante índice alien', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    await pool.query(`INSERT INTO whatsapp_cloud_quick_replies
      (empresa_id,shortcut,title,body,created_by,updated_by) VALUES (1,'hola','Hola','Texto',11,11)`);
    const before = (await pool.query(`SELECT c.oid::text oid,c.xmin::text xmin FROM pg_class c WHERE c.oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0];
    const rowBefore = (await pool.query(`SELECT xmin::text xmin,* FROM whatsapp_cloud_quick_replies WHERE empresa_id=1 AND shortcut='hola'`)).rows[0];
    await pool.query(migrationSql);
    assert.deepEqual((await pool.query(`SELECT c.oid::text oid,c.xmin::text xmin FROM pg_class c WHERE c.oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0], before);
    assert.deepEqual((await pool.query(`SELECT xmin::text xmin,* FROM whatsapp_cloud_quick_replies WHERE empresa_id=1 AND shortcut='hola'`)).rows[0], rowBefore);

    await pool.query('DROP INDEX idx_whatsapp_cloud_quick_replies_list');
    await pool.query('CREATE INDEX idx_whatsapp_cloud_quick_replies_list ON whatsapp_cloud_quick_replies(title)');
    const alien = (await pool.query(`SELECT oid::text oid,pg_get_indexdef(oid) definition FROM pg_class WHERE oid='idx_whatsapp_cloud_quick_replies_list'::regclass`)).rows[0];
    await assert.rejects(pool.query(migrationSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_quick_replies_schema_unsafe');
    assert.deepEqual((await pool.query(`SELECT oid::text oid,pg_get_indexdef(oid) definition FROM pg_class WHERE oid='idx_whatsapp_cloud_quick_replies_list'::regclass`)).rows[0], alien);
  });
});

test('unicidad shortcut es tenant-scoped, accent/case canónica y soft-disable conserva namespace', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    await pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
      VALUES (1,'ayuda','A','Texto',11,11),(2,'ayuda','B','Texto',21,21)`);
    await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
      VALUES (1,'ayuda','Duplicada','Texto',11,11)`), error => error?.code === '23505');
    for (const shortcut of ['Ayuda','áyuda','a','con espacio']) {
      await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
        VALUES (1,$1,'Inválida','Texto',11,11)`, [shortcut]), error => error?.code === '23514');
    }
    await pool.query("UPDATE whatsapp_cloud_quick_replies SET is_active=false WHERE empresa_id=1 AND shortcut='ayuda'");
    await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
      VALUES (1,'ayuda','Aun reservada','Texto',11,11)`), error => error?.code === '23505');
  });
});

test('CRUD/CAS concurrente tiene un ganador, aisla tenants y revalida actor', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const repo = repository(pool);
    const createdReply = await repo.create({ empresaId: 1, usuarioId: 11, actorRole: 'admin', shortcut: 'saludo', title: 'Saludo', body: 'Hola', sortOrder: 2, isActive: true });
    assert.equal(createdReply.outcome, 'created');
    assert.deepEqual((await repo.list({ empresaId: 1 })).map(item => item.shortcut), ['saludo']);
    assert.deepEqual(await repo.list({ empresaId: 2 }), []);

    const id = createdReply.quickReply.id;
    const attempts = await Promise.all([
      repo.update({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, title: 'Uno', expectedVersion: 1 }),
      repo.update({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, title: 'Dos', expectedVersion: 1 }),
    ]);
    assert.deepEqual(attempts.map(item => item.outcome).sort(), ['stale', 'updated']);
    const current = (await repo.list({ empresaId: 1 }))[0];
    assert.equal(current.version, 2);
    const disabled = await repo.disable({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, expectedVersion: 2 });
    assert.equal(disabled.quickReply.isActive, false);
    assert.deepEqual(await repo.list({ empresaId: 1 }), []);
    assert.equal((await repo.list({ empresaId: 1, includeInactive: true })).length, 1);

    await pool.query('UPDATE usuarios SET activo=false WHERE id=11');
    await assert.rejects(repo.update({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, isActive: true, expectedVersion: 3 }), error => error?.code === 'QUICK_REPLY_ACTOR_FORBIDDEN');
    await pool.query("UPDATE usuarios SET activo=true,empresa_id=2 WHERE id=11");
    await assert.rejects(repo.update({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, isActive: true, expectedVersion: 3 }), error => error?.code === 'QUICK_REPLY_ACTOR_FORBIDDEN');
    const superResult = await repo.update({ empresaId: 1, usuarioId: 31, actorRole: 'super', id, isActive: true, expectedVersion: 3 });
    assert.equal(superResult.outcome, 'updated');
  });
});

test('actor row es el primer lock: mutación y cambio de actor respetan el ganador', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const repo = repository(pool);
    const createdReply = await repo.create({ empresaId: 1, usuarioId: 11, actorRole: 'admin', shortcut: 'race', title: 'Race', body: 'Texto', sortOrder: 0, isActive: true });
    const id = createdReply.quickReply.id;
    const targetBlocker = await pool.connect();
    try {
      await targetBlocker.query('BEGIN');
      await targetBlocker.query('SELECT 1 FROM whatsapp_cloud_quick_replies WHERE id=$1::uuid FOR UPDATE', [id]);
      const mutation = repo.update({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, title: 'Ganadora', expectedVersion: 1 });
      await new Promise(resolve => setTimeout(resolve, 80));
      let actorChangeSettled = false;
      const actorChange = pool.query('UPDATE usuarios SET activo=false WHERE id=11').finally(() => { actorChangeSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(actorChangeSettled, false);
      await targetBlocker.query('COMMIT');
      assert.equal((await mutation).outcome, 'updated');
      await actorChange;
    } finally {
      await targetBlocker.query('ROLLBACK').catch(() => {});
      targetBlocker.release();
    }

    await pool.query('UPDATE usuarios SET activo=true,empresa_id=1 WHERE id=11');
    const actorWriter = await pool.connect();
    try {
      await actorWriter.query('BEGIN');
      await actorWriter.query('UPDATE usuarios SET empresa_id=2 WHERE id=11');
      const mutation = repo.update({ empresaId: 1, usuarioId: 11, actorRole: 'admin', id, title: 'Perdedora', expectedVersion: 2 });
      await new Promise(resolve => setTimeout(resolve, 80));
      await actorWriter.query('COMMIT');
      await assert.rejects(mutation, error => error?.code === 'QUICK_REPLY_ACTOR_FORBIDDEN');
      assert.deepEqual((await pool.query('SELECT title,version FROM whatsapp_cloud_quick_replies WHERE id=$1', [id])).rows[0], { title: 'Ganadora', version: 2 });
    } finally {
      await actorWriter.query('ROLLBACK').catch(() => {});
      actorWriter.release();
    }
  });
});
