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

    await ensureComprobantesTransferenciaSchema(query, { lockTimeoutMs: 500 });
    assert.equal(await checkComprobantesTransferenciaSchemaReady(query), true);
    const before = (await pool.query(`
      SELECT conname, oid::text, xmin::text, convalidated,
             pg_catalog.pg_get_constraintdef(oid, true) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.comprobantes_transferencia'::pg_catalog.regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [constraints])).rows;
    assert.equal(before.length, constraints.length);
    assert.ok(before.every(row => row.convalidated === true));
    assert.match(before.find(row => row.conname === 'ck_ct_archivo_size_cap').definition, /archivo_size <= 10485760/);

    await ensureComprobantesTransferenciaSchema(query, { lockTimeoutMs: 500 });
    const after = (await pool.query(`
      SELECT conname, oid::text, xmin::text, convalidated,
             pg_catalog.pg_get_constraintdef(oid, true) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.comprobantes_transferencia'::pg_catalog.regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [constraints])).rows;
    assert.deepEqual(after, before);
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
        ensureComprobantesTransferenciaSchema(
          (sql, params = []) => queryRows(pool, sql, params),
          { lockTimeoutMs: 100 },
        ),
        error => error?.code === '55P03',
      );
      assert.ok(Date.now() - started < 2000, 'el timeout evita hang');
      await blocker.query('ROLLBACK');
      await ensureComprobantesTransferenciaSchema(
        (sql, params = []) => queryRows(pool, sql, params),
        { lockTimeoutMs: 500 },
      );
      assert.equal(await checkComprobantesTransferenciaSchemaReady(
        (sql, params = []) => queryRows(pool, sql, params),
      ), true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
  });
});
