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

async function withDatabase(work, { prepare, migrate = true } = {}) {
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
    await prepare?.(pool);
    if (migrate) await pool.query(migrationSql);
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

const bareQuickRepliesTableSql = `CREATE TABLE whatsapp_cloud_quick_replies (
  id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  empresa_id INTEGER NOT NULL,
  shortcut TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
)`;

const canonicalConstraints = new Map([
  ['whatsapp_cloud_quick_replies_pkey', 'PRIMARY KEY (id)'],
  ['whatsapp_cloud_quick_replies_empresa_fkey', 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE'],
  ['whatsapp_cloud_quick_replies_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE RESTRICT'],
  ['whatsapp_cloud_quick_replies_updated_by_fkey', 'FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE RESTRICT'],
  ['whatsapp_cloud_quick_replies_shortcut_check', "CHECK (char_length(shortcut) >= 2 AND char_length(shortcut) <= 32 AND shortcut ~ '^[a-z0-9][a-z0-9._-]{1,31}$'::text)"],
  ['whatsapp_cloud_quick_replies_title_check', 'CHECK (char_length(title) >= 1 AND char_length(title) <= 80)'],
  ['whatsapp_cloud_quick_replies_body_check', 'CHECK (char_length(body) >= 1 AND char_length(body) <= 4096)'],
  ['whatsapp_cloud_quick_replies_sort_check', 'CHECK (sort_order >= 0 AND sort_order <= 100000)'],
  ['whatsapp_cloud_quick_replies_is_active_check', 'CHECK (is_active OR NOT is_active)'],
  ['whatsapp_cloud_quick_replies_version_check', 'CHECK (version > 0)'],
]);

async function constraintCatalog(pool) {
  const result = await pool.query(`SELECT conname,pg_catalog.pg_get_constraintdef(oid,true) definition
    FROM pg_catalog.pg_constraint
    WHERE conrelid='whatsapp_cloud_quick_replies'::regclass AND contype IN ('p','f','c','u','x')
    ORDER BY conname`);
  return new Map(result.rows.map(row => [row.conname, row.definition]));
}

async function indexCatalog(pool) {
  return (await pool.query(`SELECT c.oid::text oid,c.xmin::text xmin,c.relname,
      pg_catalog.pg_get_indexdef(c.oid) definition,i.indisvalid,i.indisready,i.indislive
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    WHERE i.indrelid='whatsapp_cloud_quick_replies'::regclass AND NOT i.indisprimary
    ORDER BY c.relname`)).rows;
}

async function tableSnapshot(pool) {
  return {
    relation: (await pool.query(`SELECT oid::text oid,xmin::text xmin
      FROM pg_catalog.pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0],
    constraints: (await pool.query(`SELECT oid::text oid,xmin::text xmin,conname,
        pg_catalog.pg_get_constraintdef(oid,true) definition
      FROM pg_catalog.pg_constraint
      WHERE conrelid='whatsapp_cloud_quick_replies'::regclass AND contype IN ('p','f','c','u','x')
      ORDER BY conname`)).rows,
    indexes: await indexCatalog(pool),
    rows: (await pool.query(`SELECT xmin::text xmin,* FROM whatsapp_cloud_quick_replies ORDER BY id`)).rows,
  };
}

async function assertCanonicalCatalog(pool) {
  assert.deepEqual(await constraintCatalog(pool), canonicalConstraints);
  assert.deepEqual((await pool.query(`SELECT c.relname,pg_catalog.pg_get_indexdef(c.oid) definition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    WHERE i.indrelid='whatsapp_cloud_quick_replies'::regclass AND NOT i.indisprimary
    ORDER BY c.relname`)).rows, [
    { relname: 'idx_whatsapp_cloud_quick_replies_list', definition: 'CREATE INDEX idx_whatsapp_cloud_quick_replies_list ON public.whatsapp_cloud_quick_replies USING btree (empresa_id, is_active, sort_order, title, id)' },
    { relname: 'idx_whatsapp_cloud_quick_replies_tenant_shortcut', definition: 'CREATE UNIQUE INDEX idx_whatsapp_cloud_quick_replies_tenant_shortcut ON public.whatsapp_cloud_quick_replies USING btree (empresa_id, shortcut)' },
  ]);
}

test('migración canonicaliza tabla vacía compatible sin constraints y postflight queda exacto', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    const canonical = (await pool.query(`SELECT oid::text oid,xmin::text xmin FROM pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0];
    const constraints = (await pool.query(`SELECT oid::text oid,conname,pg_catalog.pg_get_constraintdef(oid,true) definition
      FROM pg_catalog.pg_constraint WHERE conrelid='whatsapp_cloud_quick_replies'::regclass ORDER BY conname`)).rows;
    await assertCanonicalCatalog(pool);
    await pool.query(migrationSql);
    assert.deepEqual((await pool.query(`SELECT oid::text oid,xmin::text xmin FROM pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0], canonical);
    assert.deepEqual((await pool.query(`SELECT oid::text oid,conname,pg_catalog.pg_get_constraintdef(oid,true) definition
      FROM pg_catalog.pg_constraint WHERE conrelid='whatsapp_cloud_quick_replies'::regclass ORDER BY conname`)).rows, constraints);
    await assertCanonicalCatalog(pool);
  }, { prepare: pool => pool.query(bareQuickRepliesTableSql), migrate: false });
});

test('migración canonicaliza tabla vacía si falta uno o ambos índices requeridos', async () => {
  for (const indexesToDrop of [
    ['idx_whatsapp_cloud_quick_replies_tenant_shortcut'],
    ['idx_whatsapp_cloud_quick_replies_list'],
    ['idx_whatsapp_cloud_quick_replies_tenant_shortcut', 'idx_whatsapp_cloud_quick_replies_list'],
  ]) {
    await withDatabase(async pool => {
      const relationBefore = (await pool.query(`SELECT oid::text oid,xmin::text xmin
        FROM pg_catalog.pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0];
      for (const indexName of indexesToDrop) await pool.query(`DROP INDEX ${indexName}`);
      await pool.query(migrationSql);
      assert.deepEqual((await pool.query(`SELECT oid::text oid,xmin::text xmin
        FROM pg_catalog.pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0], relationBefore);
      await assertCanonicalCatalog(pool);
    });
  }
});

test('migración rechaza tabla poblada si falta cualquiera de los índices y preserva catálogo y filas', async () => {
  for (const indexName of [
    'idx_whatsapp_cloud_quick_replies_tenant_shortcut',
    'idx_whatsapp_cloud_quick_replies_list',
  ]) {
    await withDatabase(async pool => {
      await seed(pool);
      await pool.query(`INSERT INTO whatsapp_cloud_quick_replies
        (empresa_id,shortcut,title,body,created_by,updated_by) VALUES (1,'segura','Segura','Texto',11,11)`);
      await pool.query(`DROP INDEX ${indexName}`);
      const before = await tableSnapshot(pool);
      await assert.rejects(pool.query(migrationSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_quick_replies_schema_unsafe');
      assert.deepEqual(await tableSnapshot(pool), before);
    });
  }
});

test('migración rechaza tabla poblada sin constraints antes de mutar aunque la fila sea válida', async () => {
  await withDatabase(async pool => {
    const before = (await pool.query(`SELECT oid::text oid,xmin::text xmin FROM pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0];
    await assert.rejects(pool.query(migrationSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_quick_replies_schema_unsafe');
    assert.deepEqual(await constraintCatalog(pool), new Map());
    assert.deepEqual((await pool.query(`SELECT oid::text oid,xmin::text xmin FROM pg_class WHERE oid='whatsapp_cloud_quick_replies'::regclass`)).rows[0], before);
  }, { prepare: async pool => {
    await seed(pool);
    await pool.query(bareQuickRepliesTableSql);
    await pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
      VALUES (1,'valida','Válida','Texto',11,11)`);
  }, migrate: false });
});

test('migración rechaza fila inválida sin CHECK y no deja seguridad parcial', async () => {
  await withDatabase(async pool => {
    await assert.rejects(pool.query(migrationSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_quick_replies_schema_unsafe');
    assert.deepEqual(await constraintCatalog(pool), new Map());
    assert.equal((await pool.query(`SELECT shortcut FROM whatsapp_cloud_quick_replies`)).rows[0].shortcut, 'A');
  }, { prepare: async pool => {
    await seed(pool);
    await pool.query(bareQuickRepliesTableSql);
    await pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
      VALUES (1,'A','Inválida','Texto',11,11)`);
  }, migrate: false });
});

test('migración exige positivamente cada constraint canónica y rechaza extras sin cambios parciales', async () => {
  for (const constraintName of canonicalConstraints.keys()) {
    await withDatabase(async pool => {
      await seed(pool);
      await pool.query(`INSERT INTO whatsapp_cloud_quick_replies (empresa_id,shortcut,title,body,created_by,updated_by)
        VALUES (1,'segura','Segura','Texto',11,11)`);
      await pool.query(`ALTER TABLE whatsapp_cloud_quick_replies DROP CONSTRAINT ${constraintName}`);
      const before = await constraintCatalog(pool);
      await assert.rejects(pool.query(migrationSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_quick_replies_schema_unsafe');
      assert.deepEqual(await constraintCatalog(pool), before);
    });
  }

  for (const alienSql of [
    `ALTER TABLE whatsapp_cloud_quick_replies DROP CONSTRAINT whatsapp_cloud_quick_replies_pkey,
       ADD CONSTRAINT whatsapp_cloud_quick_replies_pkey PRIMARY KEY (empresa_id,id)`,
    `ALTER TABLE whatsapp_cloud_quick_replies DROP CONSTRAINT whatsapp_cloud_quick_replies_created_by_fkey,
       ADD CONSTRAINT whatsapp_cloud_quick_replies_created_by_fkey FOREIGN KEY (created_by) REFERENCES empresas(id)`,
    `ALTER TABLE whatsapp_cloud_quick_replies DROP CONSTRAINT whatsapp_cloud_quick_replies_title_check,
       ADD CONSTRAINT whatsapp_cloud_quick_replies_title_check CHECK (char_length(title) <= 81)`,
    `ALTER TABLE whatsapp_cloud_quick_replies ADD CONSTRAINT whatsapp_cloud_quick_replies_alien_check CHECK (version < 999)`,
  ]) {
    await withDatabase(async pool => {
      await pool.query(alienSql);
      const before = await constraintCatalog(pool);
      await assert.rejects(pool.query(migrationSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_quick_replies_schema_unsafe');
      assert.deepEqual(await constraintCatalog(pool), before);
    });
  }
});

test('migración quick replies es idempotente, conserva OID/xmin y falla cerrada ante índice alien', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    await pool.query(`INSERT INTO whatsapp_cloud_quick_replies
      (empresa_id,shortcut,title,body,created_by,updated_by) VALUES (1,'hola','Hola','Texto',11,11)`);
    const before = await tableSnapshot(pool);
    await pool.query(migrationSql);
    assert.deepEqual(await tableSnapshot(pool), before);

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
