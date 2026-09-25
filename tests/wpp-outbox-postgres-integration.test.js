import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { claimWppOutboxRows } from '../src/wpp/delivery.js';
import { empresaWhatsappConfigLockNamespace } from '../src/wpp/companyConfigLock.js';
import { buildCompanyWebOutboxClaimPolicy } from '../src/wpp/companyWebPolicy.js';
import {
  enqueueWppOutbox,
  enqueueWppOutboxCorrelatedReply,
  enqueueWppOutboxInTransaction,
} from '../src/wpp/enqueue.js';

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

    await pool.query('ALTER TABLE empresas ADD COLUMN config_integraciones JSONB');
    await pool.query("UPDATE empresas SET config_integraciones = '{}'::jsonb WHERE id = 1");
    await pool.query(`
      CREATE TABLE juegos_participaciones_atomic_test (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL,
        telefono TEXT NOT NULL
      )
    `);

    const atomicClient = await pool.connect();
    try {
      await atomicClient.query('BEGIN');
      await atomicClient.query(
        'INSERT INTO juegos_participaciones_atomic_test (empresa_id, telefono) VALUES ($1, $2)',
        [1, '3515557777'],
      );
      await enqueueWppOutboxInTransaction({
        empresaId: 1,
        phone: '3515557777',
        message: 'atomic-real-postgres-rollback',
      }, { client: atomicClient, transactionOwner: 'caller' });
      assert.equal((await atomicClient.query(
        "SELECT count(*)::int AS total FROM wpp_outbox WHERE mensaje = 'atomic-real-postgres-rollback'",
      )).rows[0].total, 1);
      await atomicClient.query('ROLLBACK');
    } finally {
      atomicClient.release();
    }
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM juegos_participaciones_atomic_test')).rows[0].total, 0);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS total FROM wpp_outbox WHERE mensaje = 'atomic-real-postgres-rollback'",
    )).rows[0].total, 0);

    const cloudPolicyCases = [
      {
        label: 'boolean-true',
        config: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
        expectedOrigin: 'cloud',
      },
      {
        label: 'normalized-provider',
        config: { whatsapp: { provider: '  ClOuD  ', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
        expectedOrigin: 'cloud',
      },
      {
        label: 'string-true',
        config: { whatsapp: { provider: 'cloud', enabled: 'true', phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
        expectedOrigin: 'company',
      },
      {
        label: 'boolean-false',
        config: { whatsapp: { provider: 'cloud', enabled: false, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
        expectedOrigin: 'company',
      },
      {
        label: 'missing-enabled',
        config: { whatsapp: { provider: 'cloud', phone_number_id: 'phone-1', access_token_encrypted: 'v1:test' } },
        expectedOrigin: 'company',
      },
      {
        label: 'incomplete-cloud',
        config: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-1' } },
        expectedOrigin: 'company',
      },
      { label: 'missing-whatsapp', config: {}, expectedOrigin: 'company' },
      { label: 'empty-whatsapp', config: { whatsapp: {} }, expectedOrigin: 'company' },
      { label: 'null-whatsapp', config: { whatsapp: null }, expectedError: 'config_whatsapp_invalida' },
      { label: 'string-whatsapp', config: { whatsapp: 'cloud' }, expectedError: 'config_whatsapp_invalida' },
      { label: 'array-whatsapp', config: { whatsapp: [] }, expectedError: 'config_whatsapp_invalida' },
      { label: 'null-config', config: null, expectedError: 'config_integraciones_invalida' },
      { label: 'string-config', config: 'cloud', expectedError: 'config_integraciones_invalida' },
      { label: 'array-config', config: [], expectedError: 'config_integraciones_invalida' },
    ];
    for (const policyCase of cloudPolicyCases) {
      await pool.query('UPDATE empresas SET config_integraciones = $1::jsonb WHERE id = 1', [JSON.stringify(policyCase.config)]);
      const enqueue = enqueueWppOutbox({
        empresaId: 1,
        phone: '3515558000',
        message: `cloud-policy-${policyCase.label}`,
      }, pool);
      if (policyCase.expectedError) {
        await assert.rejects(enqueue, new RegExp(policyCase.expectedError));
      } else {
        assert.equal((await enqueue).transportOrigin, policyCase.expectedOrigin, policyCase.label);
      }
    }

    const claimPolicy = buildCompanyWebOutboxClaimPolicy({ empresaParamIndex: 4 });
    await pool.query(
      `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin)
       VALUES (1, '5493515557000', 'claim-normalized-provider', 'company')`,
    );
    await pool.query('UPDATE empresas SET config_integraciones = $1::jsonb WHERE id = 1', [JSON.stringify({
      whatsapp: {
        provider: '  CLOUD  ', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test',
      },
    })]);
    const normalizedClaimWhere = `${claimPolicy.sql} AND o.mensaje = $5`;
    assert.deepEqual(await claimWppOutboxRows({
      query: pgRows(pool),
      owner: 'company-normalized-claim',
      limit: 10,
      whereSql: normalizedClaimWhere,
      whereParams: [1, 'claim-normalized-provider'],
    }), []);
    await pool.query("UPDATE empresas SET config_integraciones = '{\"whatsapp\":{\"provider\":\"web\",\"enabled\":true}}'::jsonb WHERE id = 1");
    const claimedAfterWeb = await claimWppOutboxRows({
      query: pgRows(pool),
      owner: 'company-normalized-claim',
      limit: 10,
      whereSql: normalizedClaimWhere,
      whereParams: [1, 'claim-normalized-provider'],
    });
    assert.deepEqual(claimedAfterWeb.map(row => row.mensaje), ['claim-normalized-provider']);

    await pool.query("UPDATE empresas SET config_integraciones = '{}'::jsonb WHERE id = 1");

    const holdFirstCommitPool = () => {
      let connectionCount = 0;
      let allowCommit;
      let signalCommit;
      const commitReached = new Promise(resolve => { signalCommit = resolve; });
      const commitAllowed = new Promise(resolve => { allowCommit = resolve; });
      return {
        commitReached,
        allowCommit,
        async connect() {
          const raw = await pool.connect();
          connectionCount += 1;
          const holdCommit = connectionCount === 1;
          return {
            async query(input, params) {
              const text = typeof input === 'string' ? input : input.text;
              if (holdCommit && text === 'COMMIT') {
                signalCommit();
                await commitAllowed;
              }
              return raw.query(input, params);
            },
            release(error) { raw.release(error); },
          };
        },
      };
    };

    const enterpriseGate = holdFirstCommitPool();
    const concurrentPayload = { empresaId: 1, phone: '3515559090', message: 'concurrent-dedupe' };
    const firstEnterprise = enqueueWppOutbox(concurrentPayload, enterpriseGate);
    await enterpriseGate.commitReached;
    let secondEnterpriseSettled = false;
    const secondEnterprise = enqueueWppOutbox(concurrentPayload, enterpriseGate).then(result => {
      secondEnterpriseSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondEnterpriseSettled, false, 'second enterprise enqueue must wait while first tx retains locks');
    enterpriseGate.allowCommit();
    const concurrentResults = await Promise.all([firstEnterprise, secondEnterprise]);
    assert.deepEqual(concurrentResults.map(result => result.queued).sort(), [false, true]);
    const concurrentRows = await pool.query(`
      SELECT empresa_id, telefono, mensaje, transport_origin
        FROM wpp_outbox
       WHERE mensaje = 'concurrent-dedupe'
    `);
    assert.deepEqual(concurrentRows.rows, [{
      empresa_id: 1,
      telefono: '5493515559090',
      mensaje: 'concurrent-dedupe',
      transport_origin: 'company',
    }]);

    const correlatedGeneral = await enqueueWppOutboxCorrelatedReply({
      empresaId: 1,
      phone: '3515559093',
      message: 'correlated-general-with-tenant',
      transportOrigin: 'general',
    }, pool);
    assert.equal(correlatedGeneral.transportOrigin, 'general');
    assert.deepEqual((await pool.query(`
      SELECT empresa_id, telefono, mensaje, transport_origin
        FROM wpp_outbox
       WHERE mensaje = 'correlated-general-with-tenant'
    `)).rows, [{
      empresa_id: 1,
      telefono: '5493515559093',
      mensaje: 'correlated-general-with-tenant',
      transport_origin: 'general',
    }]);

    const commitAppliedCalls = [];
    const commitAppliedThenErrorPool = {
      async connect() {
        const raw = await pool.connect();
        return {
          async query(input, params) {
            const text = typeof input === 'string' ? input : input.text;
            commitAppliedCalls.push(text);
            if (text === 'COMMIT') {
              await raw.query(input, params);
              throw new Error('socket lost after PostgreSQL applied commit private-detail');
            }
            return raw.query(input, params);
          },
          release(error) { raw.release(error); },
        };
      },
    };
    await assert.rejects(
      enqueueWppOutbox({ empresaId: 1, phone: '3515559092', message: 'commit-applied-unknown' }, commitAppliedThenErrorPool),
      error => error?.code === 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN'
        && !error.message.includes('private-detail')
        && !Object.hasOwn(error, 'cause'),
    );
    assert.equal(commitAppliedCalls.filter(text => text === 'COMMIT').length, 1);
    assert.equal(commitAppliedCalls.some(text => text === 'ROLLBACK'), false);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS total FROM wpp_outbox WHERE empresa_id = 1 AND mensaje = 'commit-applied-unknown'",
    )).rows[0].total, 1);

    const generalGate = holdFirstCommitPool();
    const generalPayload = { phone: '3515559091', message: 'general-concurrent-dedupe' };
    const firstGeneral = enqueueWppOutbox(generalPayload, generalGate);
    await generalGate.commitReached;
    let secondGeneralSettled = false;
    const secondGeneral = enqueueWppOutbox(generalPayload, generalGate).then(result => {
      secondGeneralSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondGeneralSettled, false, 'second general enqueue must wait for the dedupe lock');
    generalGate.allowCommit();
    const generalResults = await Promise.all([firstGeneral, secondGeneral]);
    assert.deepEqual(generalResults.map(result => result.queued).sort(), [false, true]);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS total FROM wpp_outbox WHERE empresa_id IS NULL AND mensaje = 'general-concurrent-dedupe'",
    )).rows[0].total, 1);

    const assertEnqueueSeesConfigCommittedAfterItStarts = async ({ initialConfig, nextConfig, message, expectedOrigin }) => {
      await pool.query('UPDATE empresas SET config_integraciones = $1::jsonb WHERE id = 1', [JSON.stringify(initialConfig)]);
      const writer = await pool.connect();
      let enqueueSettled = false;
      try {
        await writer.query('BEGIN');
        await writer.query(
          'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
          [empresaWhatsappConfigLockNamespace, 1],
        );
        await writer.query(
          'UPDATE empresas SET config_integraciones = $1::jsonb WHERE id = 1',
          [JSON.stringify(nextConfig)],
        );
        const enqueuePromise = enqueueWppOutbox({
          empresaId: 1,
          phone: '3515559191',
          message,
        }, pool).then(result => {
          enqueueSettled = true;
          return result;
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal(enqueueSettled, false, 'enqueue must begin and block before config commit');
        await writer.query('COMMIT');
        const result = await enqueuePromise;
        assert.equal(result.transportOrigin, expectedOrigin);
        const inserted = await pool.query(
          'SELECT transport_origin FROM wpp_outbox WHERE empresa_id = 1 AND mensaje = $1',
          [message],
        );
        assert.deepEqual(inserted.rows, [{ transport_origin: expectedOrigin }]);
      } catch (error) {
        await writer.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        writer.release();
      }
    };

    const webConfig = { whatsapp: { provider: 'web', enabled: true } };
    const cloudConfig = {
      whatsapp: {
        provider: 'cloud', enabled: true, phone_number_id: 'phone-1', access_token_encrypted: 'v1:test',
      },
    };
    await assertEnqueueSeesConfigCommittedAfterItStarts({
      initialConfig: webConfig,
      nextConfig: cloudConfig,
      message: 'atomic-web-to-cloud',
      expectedOrigin: 'cloud',
    });
    await assertEnqueueSeesConfigCommittedAfterItStarts({
      initialConfig: cloudConfig,
      nextConfig: webConfig,
      message: 'atomic-cloud-to-web',
      expectedOrigin: 'company',
    });

    await pool.query('ALTER TABLE empresas ALTER COLUMN config_integraciones TYPE JSON USING config_integraciones::json');
    for (const policyCase of cloudPolicyCases) {
      await pool.query('UPDATE empresas SET config_integraciones = $1::json WHERE id = 1', [JSON.stringify(policyCase.config)]);
      const enqueue = enqueueWppOutbox({
        empresaId: 1,
        phone: '3515558100',
        message: `json-cloud-policy-${policyCase.label}`,
      }, pool);
      if (policyCase.expectedError) await assert.rejects(enqueue, new RegExp(policyCase.expectedError));
      else assert.equal((await enqueue).transportOrigin, policyCase.expectedOrigin, `JSON ${policyCase.label}`);
    }

    await pool.query(`
      INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin)
      VALUES (1, '5493515557100', 'json-claim-valid', 'company'),
             (1, '5493515557101', 'json-claim-invalid', 'company')
    `);
    await pool.query("UPDATE empresas SET config_integraciones = '{}'::json WHERE id = 1");
    assert.deepEqual((await claimWppOutboxRows({
      query: pgRows(pool), owner: 'json-claim', limit: 10,
      whereSql: `${claimPolicy.sql} AND o.mensaje = $5`, whereParams: [1, 'json-claim-valid'],
    })).map(row => row.mensaje), ['json-claim-valid']);
    await pool.query("UPDATE empresas SET config_integraciones = 'null'::json WHERE id = 1");
    assert.deepEqual(await claimWppOutboxRows({
      query: pgRows(pool), owner: 'json-invalid-claim', limit: 10,
      whereSql: `${claimPolicy.sql} AND o.mensaje = $5`, whereParams: [1, 'json-claim-invalid'],
    }), []);
  } finally {
    if (pool) await pool.end();
    if (started) {
      try { execFileSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' }); } catch {}
    }
  }
});
