import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { basename, join } from 'node:path';
import pg from 'pg';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL focal gate requires local PostgreSQL 18 initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const tempPrefix = '.init-db-canonical-pg-';
const createdDirectories = new Set();

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), tempPrefix));
  createdDirectories.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), [
      '-D', directory, '-A', 'trust', '-U', 'init_db_test', '--no-locale', '--encoding=UTF8',
    ], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), [
      '-D', directory, '-l', join(directory, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start',
    ], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'init_db_test', database: 'postgres', max: 2 });
    const version = await pool.query('SHOW server_version');
    assert.match(version.rows[0].server_version, /^18\./);
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), [
      '-D', directory, '-m', 'immediate', '-w', 'stop',
    ], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
}

async function snapshotNamespace(pool, schema) {
  await pool.query('BEGIN');
  try {
    await pool.query('SET LOCAL search_path = public, pg_catalog');
    const result = await pool.query(`
    WITH namespace AS (
      SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1
    ), inventory AS (
      SELECT 'namespace'::TEXT AS kind, namespace_row.oid AS oid, namespace_row.nspname AS name,
             pg_catalog.concat_ws('|', namespace_row.nspowner::TEXT,
               namespace_row.nspacl::TEXT) AS definition
        FROM pg_catalog.pg_namespace AS namespace_row
       WHERE namespace_row.oid IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'class', class_row.oid, class_row.relname,
             pg_catalog.concat_ws('|', class_row.relkind::TEXT, class_row.relpersistence::TEXT,
               class_row.relowner::TEXT, class_row.relam::TEXT,
               CASE WHEN class_row.relkind IN ('v', 'm')
                    THEN pg_catalog.pg_get_viewdef(class_row.oid, true) END,
               CASE WHEN class_row.relkind = 'i'
                    THEN pg_catalog.pg_get_indexdef(class_row.oid) END)
        FROM pg_catalog.pg_class AS class_row
       WHERE class_row.relnamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'attribute', (class_row.oid::BIGINT * 1000 + attribute_row.attnum)::OID,
             class_row.relname || '.' || attribute_row.attname,
             pg_catalog.concat_ws('|', attribute_row.atttypid::TEXT, attribute_row.atttypmod::TEXT,
               attribute_row.attnotnull::TEXT, attribute_row.attidentity::TEXT,
               attribute_row.attgenerated::TEXT, attribute_row.attcollation::TEXT,
               pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid))
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_attribute AS attribute_row ON attribute_row.attrelid = class_row.oid
        LEFT JOIN pg_catalog.pg_attrdef AS default_row
          ON default_row.adrelid = attribute_row.attrelid AND default_row.adnum = attribute_row.attnum
       WHERE class_row.relnamespace IN (SELECT oid FROM namespace)
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
      UNION ALL
      SELECT 'constraint', constraint_row.oid, constraint_row.conname,
             pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.connamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'function', procedure_row.oid, procedure_row.proname,
             pg_catalog.pg_get_functiondef(procedure_row.oid)
        FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.pronamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'trigger', trigger_row.oid, class_row.relname || '.' || trigger_row.tgname,
             pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
        FROM pg_catalog.pg_trigger AS trigger_row
        JOIN pg_catalog.pg_class AS class_row ON class_row.oid = trigger_row.tgrelid
       WHERE class_row.relnamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'type', type_row.oid, type_row.typname,
             pg_catalog.concat_ws('|', type_row.typtype::TEXT, type_row.typcategory::TEXT,
               type_row.typrelid::TEXT, type_row.typelem::TEXT, type_row.typbasetype::TEXT,
               type_row.typnotnull::TEXT,
               (SELECT pg_catalog.string_agg(enum_row.enumlabel, ',' ORDER BY enum_row.enumsortorder)
                  FROM pg_catalog.pg_enum AS enum_row WHERE enum_row.enumtypid = type_row.oid))
        FROM pg_catalog.pg_type AS type_row
       WHERE type_row.typnamespace IN (SELECT oid FROM namespace)
    )
    SELECT kind, oid::TEXT, name, definition
      FROM inventory
     ORDER BY kind, name, oid
    `, [schema]);
    await pool.query('COMMIT');
    return result.rows;
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function canonicalOutboxForeignKey(pool) {
  return pool.query(`
    SELECT constraint_row.oid::TEXT,
           source_namespace.nspname AS source_schema,
           source_table.relname AS source_table,
           ARRAY(
             SELECT attribute_row.attname
               FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute_row
                 ON attribute_row.attrelid = constraint_row.conrelid
                AND attribute_row.attnum = key.attnum
              ORDER BY key.position
           )::TEXT[] AS source_columns,
           target_namespace.nspname AS target_schema,
           target_table.relname AS target_table,
           ARRAY(
             SELECT attribute_row.attname
               FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute_row
                 ON attribute_row.attrelid = constraint_row.confrelid
                AND attribute_row.attnum = key.attnum
              ORDER BY key.position
           )::TEXT[] AS target_columns,
           constraint_row.confupdtype,
           constraint_row.confdeltype,
           constraint_row.confmatchtype,
           constraint_row.condeferrable,
           constraint_row.condeferred,
           constraint_row.convalidated,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace AS source_namespace ON source_namespace.oid = source_table.relnamespace
      JOIN pg_catalog.pg_class AS target_table ON target_table.oid = constraint_row.confrelid
      JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_table.relnamespace
     WHERE constraint_row.conrelid = 'public.wpp_outbox'::pg_catalog.regclass
       AND constraint_row.conname = 'wpp_outbox_empresa_id_fkey'
       AND constraint_row.contype = 'f'
  `);
}

test('initDb completo fija public antes de todo DDL, preserva íntegro shadow y limpia la sesión al terminar',
  { timeout: 180_000 }, async () => {
    assert.match(initSql, /^SET search_path = public, pg_catalog;/);
    assert.match(initSql, /RESET search_path;\s*$/);

    await withDatabase(async pool => {
      const client = await pool.connect();
      try {
        await client.query('CREATE SCHEMA shadow');
        await client.query(`
          SET search_path = shadow, public;
          CREATE TABLE shadow.empresas(id INTEGER PRIMARY KEY, marker TEXT DEFAULT 'shadow');
          CREATE FUNCTION shadow.now() RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE
            AS 'SELECT TIMESTAMPTZ ''2000-01-01T00:00:00Z''';
          CREATE VIEW shadow.empresas_view AS SELECT id, marker FROM shadow.empresas;
        `);
        const shadowBefore = await snapshotNamespace(client, 'shadow');

        await client.query(initSql);
        assert.deepEqual(await snapshotNamespace(client, 'shadow'), shadowBefore);
        assert.equal((await client.query('SHOW search_path')).rows[0].search_path, '"$user", public');

        const publicObjects = await client.query(`
          SELECT COUNT(*)::INTEGER AS count
            FROM pg_catalog.pg_class AS class_row
            JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
           WHERE namespace_row.nspname = 'public'
        `);
        assert.ok(publicObjects.rows[0].count > 100, 'full install must create the canonical public schema');
        for (const relation of ['public.empresas', 'public.wpp_outbox', 'public.whatsapp_cloud_events']) {
          assert.notEqual((await client.query('SELECT pg_catalog.to_regclass($1) AS oid', [relation])).rows[0].oid, null);
        }

        await client.query('SET search_path = shadow, public');
        await client.query(initSql);
        assert.deepEqual(await snapshotNamespace(client, 'shadow'), shadowBefore);
        assert.equal((await client.query('SHOW search_path')).rows[0].search_path, '"$user", public');

        const failingSql = initSql.replace(/RESET search_path;\s*$/, `
          BEGIN;
          CREATE TABLE init_db_rollback_probe(id INTEGER);
          SELECT 1 / 0;
          COMMIT;
          RESET search_path;
        `);
        await client.query('SET search_path = shadow, public');
        await assert.rejects(client.query(failingSql), error => error?.code === '22012');
        await client.query('ROLLBACK');
        assert.equal((await client.query("SELECT pg_catalog.to_regclass('public.init_db_rollback_probe') AS oid")).rows[0].oid, null);
        assert.equal((await client.query("SELECT pg_catalog.to_regclass('shadow.init_db_rollback_probe') AS oid")).rows[0].oid, null);
        assert.deepEqual(await snapshotNamespace(client, 'shadow'), shadowBefore);
        assert.equal((await client.query('SHOW search_path')).rows[0].search_path, 'public, pg_catalog');
        await client.query('RESET search_path');
      } finally {
        client.release();
      }
    });
  });

test('initDb repara exactamente la FK canónica engañosa y preserva constraints ajenos',
  { timeout: 180_000 }, async () => {
    await withDatabase(async pool => {
      await pool.query(initSql);
      await pool.query(`
        CREATE TABLE public.outbox_reply_parent(id TEXT PRIMARY KEY);
        ALTER TABLE public.wpp_outbox
          ADD CONSTRAINT wpp_outbox_reply_correlation_fkey
          FOREIGN KEY (reply_correlation_id) REFERENCES public.outbox_reply_parent(id)
          ON DELETE SET NULL;
        ALTER TABLE public.wpp_outbox DROP CONSTRAINT wpp_outbox_empresa_id_fkey;
        ALTER TABLE public.wpp_outbox
          ADD CONSTRAINT wpp_outbox_empresa_id_fkey
          FOREIGN KEY (empresa_id) REFERENCES public.empresas(id)
          MATCH SIMPLE ON UPDATE CASCADE ON DELETE CASCADE
          DEFERRABLE INITIALLY DEFERRED NOT VALID;
      `);
      const unrelatedBefore = (await pool.query(`
        SELECT oid::TEXT, pg_catalog.pg_get_constraintdef(oid, true) AS definition
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.wpp_outbox'::pg_catalog.regclass
           AND conname = 'wpp_outbox_reply_correlation_fkey'
      `)).rows;

      const deceptive = await canonicalOutboxForeignKey(pool);
      assert.equal(deceptive.rows[0].confupdtype, 'c');
      assert.equal(deceptive.rows[0].condeferrable, true);
      assert.equal(deceptive.rows[0].condeferred, true);
      assert.equal(deceptive.rows[0].convalidated, false);

      await pool.query(initSql);

      const canonical = await canonicalOutboxForeignKey(pool);
      assert.equal(canonical.rowCount, 1);
      assert.deepEqual(canonical.rows[0], {
        oid: canonical.rows[0].oid,
        source_schema: 'public',
        source_table: 'wpp_outbox',
        source_columns: ['empresa_id'],
        target_schema: 'public',
        target_table: 'empresas',
        target_columns: ['id'],
        confupdtype: 'a',
        confdeltype: 'c',
        confmatchtype: 's',
        condeferrable: false,
        condeferred: false,
        convalidated: true,
        definition: 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE',
      });
      assert.deepEqual((await pool.query(`
        SELECT oid::TEXT, pg_catalog.pg_get_constraintdef(oid, true) AS definition
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.wpp_outbox'::pg_catalog.regclass
           AND conname = 'wpp_outbox_reply_correlation_fkey'
      `)).rows, unrelatedBefore);
    });
  });

after(() => {
  assert.deepEqual([...createdDirectories].map(basename), [], 'all temporary PostgreSQL clusters must be removed');
  const residual = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(residual, [], 'no residual temporary PostgreSQL cluster directories');
});
