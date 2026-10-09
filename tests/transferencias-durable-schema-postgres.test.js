import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  checkComprobantesTransferenciaSchemaReady,
  ensureComprobantesTransferenciaSchema,
} from '../src/transferenciasServices.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const constraints = [
  'ck_ct_archivo_metadata_consistente',
  'ck_ct_archivo_size_real',
  'ck_ct_archivo_size_cap',
  'ck_ct_archivo_mimetype',
  'ck_ct_archivo_sha256',
];

async function queryRows(pool, sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

test('PostgreSQL real: durable schema repara drift homónimo y segunda ejecución no toca OIDs/MVCC', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const query = (sql, params = []) => queryRows(pool, sql, params);
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), false);
    const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
    await pool.query(initSql);
    await pool.query(`
      ALTER TABLE comprobantes_transferencia
        DROP CONSTRAINT ck_ct_archivo_metadata_consistente,
        DROP CONSTRAINT ck_ct_archivo_size_cap;
      ALTER TABLE comprobantes_transferencia
        ADD CONSTRAINT ck_ct_archivo_metadata_consistente CHECK (TRUE),
        ADD CONSTRAINT ck_ct_archivo_size_cap CHECK (
          archivo_binario IS NULL OR (archivo_size > 0 AND archivo_size <= 1)
        );
    `);
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), false);

    await pool.query('DROP INDEX public.uq_ct_source_message_new, public.uq_ct_file_hash_new');
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), false);
    await ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 500 });
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), true);
    const beforeConstraints = (await pool.query(`
      SELECT conname, oid::text, xmin::text, convalidated,
             pg_catalog.pg_get_constraintdef(oid, true) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.comprobantes_transferencia'::pg_catalog.regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [constraints])).rows;
    assert.equal(beforeConstraints.length, constraints.length);
    assert.ok(beforeConstraints.every(row => row.convalidated === true));
    assert.match(beforeConstraints.find(row => row.conname === 'ck_ct_archivo_size_cap').definition, /archivo_size <= 10485760/);
    const beforeIndexes = (await pool.query(`
      SELECT class_row.relname, class_row.oid::text, class_row.xmin::text,
             index_row.indisunique, index_row.indisvalid, index_row.indisready, index_row.indislive
        FROM pg_catalog.pg_class class_row
        JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
        JOIN pg_catalog.pg_index index_row ON index_row.indexrelid = class_row.oid
       WHERE namespace_row.nspname = 'public'
         AND class_row.relname = ANY($1::text[])
       ORDER BY class_row.relname
    `, [['uq_ct_source_message_new', 'uq_ct_file_hash_new']])).rows;
    assert.equal(beforeIndexes.length, 2);
    assert.ok(beforeIndexes.every(row => row.indisunique && row.indisvalid && row.indisready && row.indislive));

    await ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 500 });
    const afterConstraints = (await pool.query(`
      SELECT conname, oid::text, xmin::text, convalidated,
             pg_catalog.pg_get_constraintdef(oid, true) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.comprobantes_transferencia'::pg_catalog.regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [constraints])).rows;
    const afterIndexes = (await pool.query(`
      SELECT class_row.relname, class_row.oid::text, class_row.xmin::text,
             index_row.indisunique, index_row.indisvalid, index_row.indisready, index_row.indislive
        FROM pg_catalog.pg_class class_row
        JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
        JOIN pg_catalog.pg_index index_row ON index_row.indexrelid = class_row.oid
       WHERE namespace_row.nspname = 'public'
         AND class_row.relname = ANY($1::text[])
       ORDER BY class_row.relname
    `, [['uq_ct_source_message_new', 'uq_ct_file_hash_new']])).rows;
    assert.deepEqual(afterConstraints, beforeConstraints);
    assert.deepEqual(afterIndexes, beforeIndexes);
  });
});

for (const drift of [
  {
    name: 'homónimo no único sobre id',
    sql: 'CREATE INDEX uq_ct_source_message_new ON public.comprobantes_transferencia (id)',
  },
  {
    name: 'columna incorrecta',
    sql: 'CREATE UNIQUE INDEX uq_ct_source_message_new ON public.comprobantes_transferencia ((COALESCE(empresa_id, 0)), dedupe_file_hash) WHERE source_message_id IS NOT NULL',
  },
  {
    name: 'predicado incorrecto',
    sql: 'CREATE UNIQUE INDEX uq_ct_source_message_new ON public.comprobantes_transferencia ((COALESCE(empresa_id, 0)), source_message_id) WHERE dedupe_file_hash IS NOT NULL',
  },
]) {
  test(`PostgreSQL real: repara índice ${drift.name}`, postgresOptions, async () => {
    await withIsolatedPostgres(async pool => {
      const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
      await pool.query(initSql);
      await pool.query('DROP INDEX public.uq_ct_source_message_new');
      await pool.query(drift.sql);
      const query = (sql, params = []) => queryRows(pool, sql, params);
      assert.equal(await checkComprobantesTransferenciaSchemaReady(query), false);
      await ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 500 });
      assert.equal(await checkComprobantesTransferenciaSchemaReady(query), true);
    });
  });
}

test('PostgreSQL real: repara índice con lifecycle inválido', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
    await pool.query(initSql);
    await pool.query(`
      UPDATE pg_catalog.pg_index
         SET indisvalid = FALSE, indisready = FALSE
       WHERE indexrelid = 'public.uq_ct_source_message_new'::pg_catalog.regclass
    `);
    const query = (sql, params = []) => queryRows(pool, sql, params);
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), false);
    await ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 500 });
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), true);
  });
});

test('PostgreSQL real: objeto no-index homónimo falla cerrado y queda intacto', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
    await pool.query(initSql);
    await pool.query('DROP INDEX public.uq_ct_source_message_new');
    await pool.query('CREATE TABLE public.uq_ct_source_message_new (id integer)');
    await assert.rejects(
      ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 500 }),
      error => error?.code === '55000' && !/empresa|source_message_id/i.test(error.message.replace('canonical durable receipt index repair failed', '')),
    );
    assert.equal((await pool.query(
      "SELECT relkind FROM pg_catalog.pg_class WHERE oid='public.uq_ct_source_message_new'::pg_catalog.regclass",
    )).rows[0].relkind, 'r');
  });
});

test('PostgreSQL real: lock retenido causa timeout con rollback y retry posterior exitoso', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
    await pool.query(initSql);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE comprobantes_transferencia IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await assert.rejects(
        ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 100 }),
        error => error?.code === '55P03',
      );
      assert.ok(Date.now() - started < 2000, 'el timeout evita hang');
      await blocker.query('ROLLBACK');
      await ensureComprobantesTransferenciaSchema({ pool }, { lockTimeoutMs: 500 });
      assert.equal(await checkComprobantesTransferenciaSchemaReady(
        (sql, params = []) => queryRows(pool, sql, params),
      ), true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
  });
});
