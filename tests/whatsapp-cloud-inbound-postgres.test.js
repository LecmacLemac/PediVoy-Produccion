import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import {
  claimNextCloudInboundEvent,
  finishCloudInboundEvent,
  renewCloudInboundProcessingLease,
  resetCloudInboundEventForManualRetry,
  startCloudInboundProcessing,
} from '../src/whatsappCloud/inboundRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
const options = { skip: available ? false : 'Requires local PostgreSQL binaries and a non-root user' };
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const start = initSql.indexOf('-- BEGIN WHATSAPP CLOUD INBOX MIGRATION');
const end = initSql.indexOf('-- END WHATSAPP CLOUD INBOX MIGRATION', start);
assert.ok(start >= 0 && end > start);
const migrationSql = initSql.slice(start, end);

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), '.whatsapp-cloud-inbound-pg-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_inbound_test', '--no-locale'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_inbound_test', database: 'postgres', max: 4 });
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
}

const rowsQuery = pool => async (sql, params = []) => (await pool.query(sql, params)).rows;

async function seed(pool, { type = 'text', id = 'wamid.pg-1' } = {}) {
  await pool.query(`INSERT INTO empresas(id, config_integraciones) VALUES (2, $1::jsonb)`, [JSON.stringify({
    whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-2', access_token_encrypted: 'v1:test' },
  })]);
  await pool.query(`
    INSERT INTO whatsapp_cloud_events
      (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, source_timestamp, event_data)
    VALUES (2, 'message', $1, $2, '5493515550002', $3, '1', $4::jsonb)
  `, [`message:${id}`, id, type, JSON.stringify(type === 'text' ? { text: { body: 'ayuda' } } : { image: { id: 'media' } })]);
}

test('migración inbound lifecycle es idempotente y crea estados/índice de claim', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'whatsapp_cloud_events'
         AND column_name IN ('processing_state','claim_owner','claim_until','processing_started_at','processed_at','processing_error_code')
       ORDER BY column_name
    `);
    assert.deepEqual(rows.map(row => row.column_name), [
      'claim_owner', 'claim_until', 'processed_at', 'processing_error_code', 'processing_started_at', 'processing_state',
    ]);
    const index = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_whatsapp_cloud_events_inbound_claim'`)).rows[0];
    assert.match(index.indexdef, /processing_state.+received_at.+id/i);
    const reconcileIndex = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_whatsapp_cloud_events_processing_reconcile'`)).rows[0];
    assert.match(reconcileIndex.indexdef, /claim_until.+id/i);
    assert.match(reconcileIndex.indexdef, /event_kind = 'message'.+processing_state = 'processing_started'/i);
  });
});

test('heartbeat PostgreSQL mantiene lease más allá del plazo y evita reconciliación prematura', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool, { id: 'wamid.long-bot' });
    const query = rowsQuery(pool);
    const row = await claimNextCloudInboundEvent({ query, owner: 'long-owner', leaseMs: 1000 });
    await startCloudInboundProcessing({ query, id: row.id, owner: 'long-owner', leaseMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(await renewCloudInboundProcessingLease({ query, id: row.id, owner: 'long-owner', leaseMs: 1000 }), true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await claimNextCloudInboundEvent({ query, owner: 'reconciler', leaseMs: 1000 }), null);
    const state = (await pool.query('SELECT processing_state, claim_owner, claim_until > NOW() AS lease_live FROM whatsapp_cloud_events WHERE id = $1', [row.id])).rows[0];
    assert.deepEqual(state, { processing_state: 'processing_started', claim_owner: 'long-owner', lease_live: true });
  });
});

test('owner con lease vencido no puede iniciar processing sin reconciliación', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool, { id: 'wamid.expired-before-start' });
    const query = rowsQuery(pool);
    const row = await claimNextCloudInboundEvent({ query, owner: 'expired-owner', leaseMs: 1000 });
    await pool.query("UPDATE whatsapp_cloud_events SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1", [row.id]);

    await assert.rejects(
      startCloudInboundProcessing({ query, id: row.id, owner: 'expired-owner', leaseMs: 1000 }),
      { code: 'CLOUD_INBOUND_CLAIM_LOST' },
    );

    const state = (await pool.query(`
      SELECT processing_state, processing_started_at, claim_owner
        FROM whatsapp_cloud_events
       WHERE id = $1
    `, [row.id])).rows[0];
    assert.deepEqual(state, {
      processing_state: 'pre_process',
      processing_started_at: null,
      claim_owner: 'expired-owner',
    });
  });
});

test('owner con lease vencido no puede finalizar processing sin reconciliación', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool, { id: 'wamid.expired-before-finish' });
    const query = rowsQuery(pool);
    const row = await claimNextCloudInboundEvent({ query, owner: 'expired-owner', leaseMs: 1000 });
    await startCloudInboundProcessing({ query, id: row.id, owner: 'expired-owner', leaseMs: 1000 });
    await pool.query("UPDATE whatsapp_cloud_events SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1", [row.id]);

    await assert.rejects(
      finishCloudInboundEvent({ query, id: row.id, owner: 'expired-owner', state: 'processed' }),
      { code: 'CLOUD_INBOUND_CLAIM_LOST' },
    );

    const state = (await pool.query(`
      SELECT processing_state, processing_error_code, processed_at, claim_owner
        FROM whatsapp_cloud_events
       WHERE id = $1
    `, [row.id])).rows[0];
    assert.deepEqual(state, {
      processing_state: 'processing_started',
      processing_error_code: null,
      processed_at: null,
      claim_owner: 'expired-owner',
    });
  });
});

test('owner vencido no puede renovar ni finalizar después de perder el fence', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool, { id: 'wamid.lost-owner' });
    const query = rowsQuery(pool);
    const row = await claimNextCloudInboundEvent({ query, owner: 'old-owner', leaseMs: 1000 });
    await startCloudInboundProcessing({ query, id: row.id, owner: 'old-owner', leaseMs: 1000 });
    await pool.query("UPDATE whatsapp_cloud_events SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1", [row.id]);
    assert.equal(await renewCloudInboundProcessingLease({ query, id: row.id, owner: 'old-owner', leaseMs: 1000 }), false);
    await claimNextCloudInboundEvent({ query, owner: 'reconciler', leaseMs: 1000 });
    await assert.rejects(
      finishCloudInboundEvent({ query, id: row.id, owner: 'old-owner', state: 'processed' }),
      { code: 'CLOUD_INBOUND_CLAIM_LOST' },
    );
    assert.equal((await pool.query('SELECT processing_state FROM whatsapp_cloud_events WHERE id = $1', [row.id])).rows[0].processing_state, 'outcome_unknown');
  });
});

test('dos workers concurrentes reclaman una vez y processing_started vencido converge a outcome_unknown tras restart', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool);
    const query = rowsQuery(pool);
    const claims = await Promise.all([
      claimNextCloudInboundEvent({ query, owner: 'worker-a', leaseMs: 1000 }),
      claimNextCloudInboundEvent({ query, owner: 'worker-b', leaseMs: 1000 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const row = claims.find(Boolean);
    const owner = claims[0] ? 'worker-a' : 'worker-b';
    await startCloudInboundProcessing({ query, id: row.id, owner, leaseMs: 1000 });
    await pool.query(`UPDATE whatsapp_cloud_events SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [row.id]);
    assert.equal(await claimNextCloudInboundEvent({ query, owner: 'worker-c', leaseMs: 1000 }), null);
    const reconciled = await pool.query(`
      SELECT processing_state, processing_error_code, claim_owner, claim_until, processed_at
        FROM whatsapp_cloud_events WHERE id = $1
    `, [row.id]);
    assert.equal(reconciled.rows[0].processing_state, 'outcome_unknown');
    assert.equal(reconciled.rows[0].processing_error_code, 'processing_lease_expired');
    assert.equal(reconciled.rows[0].claim_owner, null);
    assert.equal(reconciled.rows[0].claim_until, null);
    assert.ok(reconciled.rows[0].processed_at instanceof Date);
    assert.equal(await claimNextCloudInboundEvent({ query, owner: 'worker-d', leaseMs: 1000 }), null);
  });
});

test('pre_process vencido se recupera con fencing y retry manual no abre outcome_unknown', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool);
    const query = rowsQuery(pool);
    const first = await claimNextCloudInboundEvent({ query, owner: 'old', leaseMs: 1000 });
    await pool.query(`UPDATE whatsapp_cloud_events SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id]);
    const reclaimed = await claimNextCloudInboundEvent({ query, owner: 'new', leaseMs: 1000 });
    assert.equal(reclaimed.id, first.id);
    await assert.rejects(startCloudInboundProcessing({ query, id: first.id, owner: 'old' }), { code: 'CLOUD_INBOUND_CLAIM_LOST' });
    await startCloudInboundProcessing({ query, id: first.id, owner: 'new', leaseMs: 1000 });
    await finishCloudInboundEvent({ query, id: first.id, owner: 'new', state: 'outcome_unknown', errorCode: 'bot_processing_unknown' });
    await assert.rejects(resetCloudInboundEventForManualRetry({ query, id: first.id }), { code: 'CLOUD_INBOUND_RETRY_NOT_ALLOWED' });
  });
});
