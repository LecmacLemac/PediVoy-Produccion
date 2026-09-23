import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { claimWppOutboxRows } from '../src/wpp/delivery.js';

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const migrationStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const migrationEnd = initSql.indexOf('CREATE TABLE IF NOT EXISTS push_subs (', migrationStart);
assert.ok(migrationStart >= 0 && migrationEnd > migrationStart, 'initDb.sql must expose the bounded wpp_outbox migration');
const migrationSql = initSql.slice(migrationStart, migrationEnd);
const canonicalStatuses = ['pending', 'sending', 'sent', 'error', 'skipped'];
const futureClaimUntil = '2099-04-05T06:07:08.000Z';
const expiredClaimUntil = '2000-01-02T03:04:05.000Z';

function assertClaim(row, { owner, epoch, until }) {
  assert.equal(row.claim_owner, owner);
  assert.equal(row.claim_epoch, epoch === null ? null : String(epoch));
  assert.equal(row.claim_until?.toISOString() ?? null, until);
}

function pgRows(pool) {
  return async (sql, params) => (await pool.query(sql, params)).rows;
}

async function claimByMessage(pool, { mensaje, owner, epoch = null, leaseMs = 60_000 }) {
  const fenced = epoch !== null;
  return claimWppOutboxRows({
    query: pgRows(pool),
    owner,
    epoch,
    limit: 1,
    leaseMs,
    whereSql: `AND o.mensaje = $${fenced ? 5 : 4}`,
    whereParams: [mensaje],
  });
}

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
       AND column_name IN ('claim_owner', 'claim_epoch', 'claim_until', 'transport_origin')
     ORDER BY column_name
  `);
  assert.deepEqual(claimColumns.rows, [
    { column_name: 'claim_epoch', data_type: 'bigint' },
    { column_name: 'claim_owner', data_type: 'text' },
    { column_name: 'claim_until', data_type: 'timestamp with time zone' },
    { column_name: 'transport_origin', data_type: 'text' },
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

test('PostgreSQL 16 legacy outbox migration preserves valid claims, fails closed, and is idempotent', options, async t => {
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
        error TEXT,
        claim_owner TEXT,
        claim_epoch BIGINT,
        claim_until TIMESTAMPTZ
      );
      CREATE TABLE empresas (id INTEGER PRIMARY KEY);
      INSERT INTO empresas (id) VALUES (1);
      CREATE TABLE wpp_general_control (
        id BOOLEAN PRIMARY KEY,
        owner_id TEXT,
        epoch BIGINT
      );
      INSERT INTO wpp_general_control (id, owner_id, epoch)
      VALUES (TRUE, 'general-current', 41);
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, sent_at, status, error, claim_owner, claim_epoch, claim_until)
      VALUES
        (NULL, '1', 'null-unsent', NULL, NULL, NULL, 'invalid-null-owner', 1, '${futureClaimUntil}'),
        (NULL, '2', 'unknown-unsent', NULL, 'queued_old', 'legacy detail', 'invalid-unknown-owner', 2, '${expiredClaimUntil}'),
        (NULL, '3', 'null-sent', NOW(), NULL, NULL, 'invalid-null-sent-owner', 3, '${futureClaimUntil}'),
        (NULL, '4', 'unknown-sent', NOW(), 'delivered_old', NULL, 'invalid-unknown-sent-owner', 4, '${expiredClaimUntil}'),
        (1, '5', 'pending-future-company', NULL, 'pending', NULL, 'company-legacy', NULL, '${futureClaimUntil}'),
        (NULL, '6', 'pending-future-general', NULL, 'pending', NULL, 'general-current', 41, '${futureClaimUntil}'),
        (1, '7', 'pending-expired', NULL, 'pending', NULL, 'expired-legacy', 7, '${expiredClaimUntil}'),
        (1, '8', 'sending-future', NULL, 'sending', 'sending future detail', 'sending-future-owner', 8, '${futureClaimUntil}'),
        (1, '9', 'sending-expired', NULL, 'sending', 'sending expired detail', 'sending-expired-owner', 9, '${expiredClaimUntil}'),
        (NULL, '10', 'valid-sent', NOW(), 'sent', 'preserve me', 'sent-forensic', 10, '${expiredClaimUntil}'),
        (NULL, '11', 'valid-error', NULL, 'error', 'error detail', 'error-forensic', 11, '${futureClaimUntil}'),
        (NULL, '12', 'valid-skipped', NULL, 'skipped', 'skip detail', 'skipped-forensic', 12, '${expiredClaimUntil}');
      ALTER TABLE wpp_outbox
        ADD CONSTRAINT wpp_outbox_status_check
        CHECK (status IN ('pending', 'sent')) NOT VALID;
      CREATE INDEX wpp_outbox_pending_claim_idx ON wpp_outbox (id);
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
      { mensaje: 'pending-future-company', status: 'pending', error: null },
      { mensaje: 'pending-future-general', status: 'pending', error: null },
      { mensaje: 'pending-expired', status: 'pending', error: null },
      { mensaje: 'sending-future', status: 'sending', error: 'sending future detail' },
      { mensaje: 'sending-expired', status: 'sending', error: 'sending expired detail' },
      { mensaje: 'valid-sent', status: 'sent', error: 'preserve me' },
      { mensaje: 'valid-error', status: 'error', error: 'error detail' },
      { mensaje: 'valid-skipped', status: 'skipped', error: 'skip detail' },
    ]);
    assert.ok(firstRows.slice(0, 4).every(row => row.claim_owner === null && row.claim_epoch === null && row.claim_until === null));
    const canonicalClaims = new Map(firstRows.slice(4).map(row => [row.mensaje, row]));
    assertClaim(canonicalClaims.get('pending-future-company'), {
      owner: 'company-legacy', epoch: null, until: futureClaimUntil,
    });
    assertClaim(canonicalClaims.get('pending-future-general'), {
      owner: 'general-current', epoch: 41, until: futureClaimUntil,
    });
    assertClaim(canonicalClaims.get('pending-expired'), {
      owner: 'expired-legacy', epoch: 7, until: expiredClaimUntil,
    });
    assertClaim(canonicalClaims.get('sending-future'), {
      owner: 'sending-future-owner', epoch: 8, until: futureClaimUntil,
    });
    assertClaim(canonicalClaims.get('sending-expired'), {
      owner: 'sending-expired-owner', epoch: 9, until: expiredClaimUntil,
    });
    assertClaim(canonicalClaims.get('valid-sent'), {
      owner: 'sent-forensic', epoch: 10, until: expiredClaimUntil,
    });
    assertClaim(canonicalClaims.get('valid-error'), {
      owner: 'error-forensic', epoch: 11, until: futureClaimUntil,
    });
    assertClaim(canonicalClaims.get('valid-skipped'), {
      owner: 'skipped-forensic', epoch: 12, until: expiredClaimUntil,
    });
    await assert.rejects(
      pool.query("INSERT INTO wpp_outbox (telefono, mensaje, status) VALUES ('10', 'bad', 'queued_old')"),
      error => error?.code === '23514',
    );
    await assert.rejects(
      pool.query("INSERT INTO wpp_outbox (telefono, mensaje, status) VALUES ('11', 'null', NULL)"),
      error => error?.code === '23502',
    );

    assert.deepEqual(await claimByMessage(pool, {
      mensaje: 'pending-future-company', owner: 'company-reclaimer',
    }), []);
    assert.deepEqual(await claimByMessage(pool, {
      mensaje: 'pending-future-general', owner: 'general-current', epoch: 41n,
    }), []);

    const reclaimStartedAt = Date.now();
    const reclaimed = await claimByMessage(pool, {
      mensaje: 'pending-expired', owner: 'expired-reclaimer', leaseMs: 60_000,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].mensaje, 'pending-expired');
    const reclaimedRow = (await pool.query(`
      SELECT mensaje, status, claim_owner, claim_epoch, claim_until
        FROM wpp_outbox WHERE mensaje = 'pending-expired'
    `)).rows[0];
    assert.equal(reclaimedRow.status, 'pending');
    assert.equal(reclaimedRow.claim_owner, 'expired-reclaimer');
    assert.equal(reclaimedRow.claim_epoch, null);
    assert.ok(reclaimedRow.claim_until.getTime() >= reclaimStartedAt + 55_000);
    assert.ok(reclaimedRow.claim_until.getTime() <= Date.now() + 65_000);

    for (const mensaje of ['sending-future', 'sending-expired']) {
      assert.deepEqual(await claimByMessage(pool, { mensaje, owner: 'sending-reclaimer' }), []);
    }

    const canonicalBeforeSecondMigration = (await pool.query(`
      SELECT id, mensaje, sent_at, status, error, claim_owner, claim_epoch, claim_until
        FROM wpp_outbox
       WHERE status IN ('pending', 'sending', 'sent', 'error', 'skipped')
       ORDER BY id
    `)).rows;

    await pool.query(migrationSql);
    await assertCanonicalContract(pool);
    const secondRows = (await pool.query(`
      SELECT id, mensaje, sent_at, status, error, claim_owner, claim_epoch, claim_until
        FROM wpp_outbox ORDER BY id
    `)).rows;
    assert.deepEqual(secondRows, canonicalBeforeSecondMigration);

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
