import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const migrationStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const migrationEnd = initSql.indexOf('CREATE TABLE IF NOT EXISTS push_subs (', migrationStart);
assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, 'initDb.sql must expose the bounded wpp_outbox migration');
const migrationSql = initSql.slice(migrationStart, migrationEnd);
const canonicalStatuses = ['pending', 'sending', 'sent', 'error', 'skipped'];

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForPostgres(config) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pool = new pg.Pool(config);
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function assertCanonicalContract(pool) {
  const statuses = await pool.query('SELECT DISTINCT status FROM wpp_outbox ORDER BY status');
  assert.ok(statuses.rows.every(row => canonicalStatuses.includes(row.status)));

  const statusColumn = await pool.query(`
    SELECT is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'wpp_outbox'
       AND column_name = 'status'
  `);
  assert.deepEqual(statusColumn.rows, [{ is_nullable: 'NO', column_default: "'pending'::text" }]);

  const constraint = await pool.query(`
    SELECT convalidated, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = 'wpp_outbox'::regclass
       AND conname = 'wpp_outbox_status_check'
  `);
  assert.equal(constraint.rowCount, 1);
  assert.equal(constraint.rows[0].convalidated, true);
  assert.equal(
    constraint.rows[0].definition,
    "CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'error'::text, 'skipped'::text])))",
  );

  const claimColumns = await pool.query(`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'wpp_outbox'
       AND column_name IN ('claim_owner', 'claim_epoch', 'claim_until')
     ORDER BY column_name
  `);
  assert.deepEqual(claimColumns.rows, [
    { column_name: 'claim_epoch', data_type: 'bigint' },
    { column_name: 'claim_owner', data_type: 'text' },
    { column_name: 'claim_until', data_type: 'timestamp with time zone' },
  ]);

  const pendingIndex = await pool.query(`
    SELECT indexdef
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'wpp_outbox'
       AND indexname = 'wpp_outbox_pending_claim_idx'
  `);
  assert.equal(pendingIndex.rowCount, 1);
  assert.match(pendingIndex.rows[0].indexdef, /\(created_at, id\).*WHERE \(status = 'pending'::text\)$/i);
}

const options = {
  skip: dockerAvailable() ? false : 'Requires a disposable Docker PostgreSQL 16 instance',
  timeout: 120_000,
};

test('PostgreSQL 16 legacy outbox migration fails closed and is idempotent', options, async t => {
  const suffix = randomUUID();
  const containerName = `pedivoy-outbox-${suffix}`;
  const password = randomUUID();
  let started = false;
  let pool;
  try {
    try {
      execFileSync('docker', [
        'run', '--detach', '--rm', '--name', containerName,
        '--publish', '127.0.0.1::5432',
        '--env', 'POSTGRES_USER=outbox_test',
        '--env', `POSTGRES_PASSWORD=${password}`,
        '--env', 'POSTGRES_DB=outbox_test',
        'postgres:16',
      ], { stdio: 'ignore' });
    } catch {
      t.skip('Unable to provision a disposable Docker PostgreSQL 16 instance');
      return;
    }
    started = true;
    const portOutput = execFileSync('docker', ['port', containerName, '5432/tcp'], { encoding: 'utf8' }).trim();
    const port = Number(portOutput.slice(portOutput.lastIndexOf(':') + 1));
    pool = await waitForPostgres({
      host: '127.0.0.1', port, user: 'outbox_test', password, database: 'outbox_test', max: 2,
    });

    const version = await pool.query('SHOW server_version');
    assert.match(version.rows[0].server_version, /^16\./);

    await pool.query(`
      CREATE TABLE wpp_outbox (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER,
        telefono TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        status TEXT DEFAULT 'pending',
        error TEXT
      );
      INSERT INTO wpp_outbox (telefono, mensaje, sent_at, status, error) VALUES
        ('1', 'null-unsent', NULL, NULL, NULL),
        ('2', 'unknown-unsent', NULL, 'queued_old', 'legacy detail'),
        ('3', 'null-sent', NOW(), NULL, NULL),
        ('4', 'unknown-sent', NOW(), 'delivered_old', NULL),
        ('5', 'valid-pending', NULL, 'pending', NULL),
        ('6', 'valid-sent', NOW(), 'sent', 'preserve me'),
        ('7', 'valid-sending', NOW(), 'sending', 'sending detail'),
        ('8', 'valid-error', NULL, 'error', 'error detail'),
        ('9', 'valid-skipped', NULL, 'skipped', 'skip detail');
      ALTER TABLE wpp_outbox
        ADD CONSTRAINT wpp_outbox_status_check
        CHECK (status IN ('pending', 'sent')) NOT VALID;
    `);

    await pool.query(migrationSql);
    await assertCanonicalContract(pool);

    const firstRows = (await pool.query(`
      SELECT id, mensaje, sent_at, status, error, claim_owner, claim_epoch, claim_until
        FROM wpp_outbox ORDER BY id
    `)).rows;
    assert.deepEqual(firstRows.map(row => ({ mensaje: row.mensaje, status: row.status, error: row.error })), [
      { mensaje: 'null-unsent', status: 'error', error: 'legacy_status_requires_manual_review' },
      { mensaje: 'unknown-unsent', status: 'error', error: 'legacy detail' },
      { mensaje: 'null-sent', status: 'sent', error: null },
      { mensaje: 'unknown-sent', status: 'sent', error: null },
      { mensaje: 'valid-pending', status: 'pending', error: null },
      { mensaje: 'valid-sent', status: 'sent', error: 'preserve me' },
      { mensaje: 'valid-sending', status: 'sending', error: 'sending detail' },
      { mensaje: 'valid-error', status: 'error', error: 'error detail' },
      { mensaje: 'valid-skipped', status: 'skipped', error: 'skip detail' },
    ]);
    assert.ok(firstRows.slice(0, 4).every(row => row.claim_owner === null && row.claim_epoch === null && row.claim_until === null));
    await assert.rejects(
      pool.query("INSERT INTO wpp_outbox (telefono, mensaje, status) VALUES ('10', 'bad', 'queued_old')"),
      error => error?.code === '23514',
    );
    await assert.rejects(
      pool.query("INSERT INTO wpp_outbox (telefono, mensaje, status) VALUES ('11', 'null', NULL)"),
      error => error?.code === '23502',
    );

    await pool.query(migrationSql);
    await assertCanonicalContract(pool);
    const secondRows = (await pool.query(`
      SELECT id, mensaje, sent_at, status, error, claim_owner, claim_epoch, claim_until
        FROM wpp_outbox ORDER BY id
    `)).rows;
    assert.deepEqual(secondRows, firstRows);

    await pool.query('DROP TABLE wpp_outbox');
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    await assertCanonicalContract(pool);
    const freshDefault = await pool.query(`
      INSERT INTO wpp_outbox (telefono, mensaje) VALUES ('12', 'fresh-default')
      RETURNING status
    `);
    assert.equal(freshDefault.rows[0].status, 'pending');
  } finally {
    if (pool) await pool.end();
    if (started) {
      try { execFileSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' }); } catch {}
    }
  }
});
