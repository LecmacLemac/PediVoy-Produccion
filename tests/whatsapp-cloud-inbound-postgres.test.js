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
  scheduleCloudInboundRetry,
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

async function inboundClaimIndexShape(pool) {
  return (await pool.query(`
    SELECT index_row.indnkeyatts,
           index_row.indnatts,
           index_row.indexprs IS NOT NULL AS has_expressions,
           (array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
             FILTER (WHERE key_column.ordinality <= index_row.indnkeyatts))::TEXT[] AS key_columns,
           pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_index AS index_row
      CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute AS attribute_row
        ON attribute_row.attrelid = index_row.indrelid
       AND attribute_row.attnum = key_column.attnum
     WHERE index_row.indexrelid = 'idx_whatsapp_cloud_events_inbound_claim'::regclass
     GROUP BY index_row.indnkeyatts, index_row.indnatts, index_row.indexprs,
              index_row.indpred, index_row.indrelid
  `)).rows[0];
}

async function seed(pool, { type = 'text', id = 'wamid.pg-1' } = {}) {
  await pool.query(`INSERT INTO empresas(id, config_integraciones) VALUES (2, $1::jsonb)`, [JSON.stringify({
    whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-2', access_token_encrypted: 'v1:test' },
  })]);
  await pool.query(`
    INSERT INTO whatsapp_cloud_events
      (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, source_timestamp, event_data, phone_number_id)
    VALUES (2, 'message', $1, $2, '5493515550002', $3, '1', $4::jsonb, 'phone-2')
  `, [`message:${id}`, id, type, JSON.stringify(type === 'text' ? { text: { body: 'ayuda' } } : { image: { id: 'media' } })]);
}

test('migración inbound lifecycle es idempotente y crea estados/índice de claim', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'whatsapp_cloud_events'
         AND column_name IN ('processing_state','claim_owner','claim_until','processing_started_at','processed_at','processing_error_code','phone_number_id','attempt_count','retry_count','next_attempt_at')
       ORDER BY column_name
    `);
    assert.deepEqual(rows.map(row => row.column_name), [
      'attempt_count', 'claim_owner', 'claim_until', 'next_attempt_at', 'phone_number_id', 'processed_at', 'processing_error_code', 'processing_started_at', 'processing_state', 'retry_count',
    ]);
    const index = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_whatsapp_cloud_events_inbound_claim'`)).rows[0];
    assert.match(index.indexdef, /processing_state.+next_attempt_at.+received_at.+id/i);
    const reconcileIndex = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_whatsapp_cloud_events_processing_reconcile'`)).rows[0];
    assert.match(reconcileIndex.indexdef, /claim_until.+id/i);
    assert.match(reconcileIndex.indexdef, /event_kind = 'message'.+processing_state = 'processing_started'/i);
  });
});

test('migración reemplaza índice inbound claim legacy sin next_attempt_at y segunda ejecución es estable', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('DROP INDEX idx_whatsapp_cloud_events_inbound_claim');
    await pool.query(`
      CREATE INDEX idx_whatsapp_cloud_events_inbound_claim
        ON whatsapp_cloud_events (processing_state, received_at, id)
       WHERE event_kind = 'message' AND processing_state IN ('pending', 'pre_process')
    `);

    await pool.query(migrationSql);
    const first = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_whatsapp_cloud_events_inbound_claim'`)).rows[0].indexdef;
    assert.match(first, /processing_state.+next_attempt_at.+received_at.+id/i);
    await pool.query(migrationSql);
    const second = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_whatsapp_cloud_events_inbound_claim'`)).rows[0].indexdef;
    assert.equal(second, first);
  });
});

test('migración reemplaza índice engañoso con next_attempt_at sólo en WHERE', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('DROP INDEX idx_whatsapp_cloud_events_inbound_claim');
    await pool.query(`
      CREATE INDEX idx_whatsapp_cloud_events_inbound_claim
        ON whatsapp_cloud_events (processing_state, received_at, id)
       WHERE event_kind = 'message'
         AND processing_state IN ('pending', 'pre_process')
         AND next_attempt_at IS NULL
    `);

    await pool.query(migrationSql);
    const shape = await inboundClaimIndexShape(pool);
    assert.equal(shape.indnkeyatts, 4);
    assert.deepEqual(shape.key_columns, ['processing_state', 'next_attempt_at', 'received_at', 'id']);
    assert.doesNotMatch(shape.predicate, /next_attempt_at/i);
  });
});

test('migración reemplaza índice inbound claim con columnas en orden incorrecto y queda estable', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('DROP INDEX idx_whatsapp_cloud_events_inbound_claim');
    await pool.query(`
      CREATE INDEX idx_whatsapp_cloud_events_inbound_claim
        ON whatsapp_cloud_events (processing_state, received_at, next_attempt_at, id)
       WHERE event_kind = 'message' AND processing_state IN ('pending', 'pre_process')
    `);

    await pool.query(migrationSql);
    const first = await inboundClaimIndexShape(pool);
    assert.equal(first.indnkeyatts, 4);
    assert.deepEqual(first.key_columns, ['processing_state', 'next_attempt_at', 'received_at', 'id']);
    assert.match(first.predicate, /event_kind = 'message'.+processing_state = ANY/i);
    await pool.query(migrationSql);
    assert.deepEqual(await inboundClaimIndexShape(pool), first);
  });
});

test('migración reemplaza índice inbound claim con INCLUDE y conserva definición exacta estable', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('DROP INDEX idx_whatsapp_cloud_events_inbound_claim');
    await pool.query(`
      CREATE INDEX idx_whatsapp_cloud_events_inbound_claim
        ON whatsapp_cloud_events (processing_state, next_attempt_at, received_at, id)
        INCLUDE (claim_until)
       WHERE event_kind = 'message' AND processing_state IN ('pending', 'pre_process')
    `);

    await pool.query(migrationSql);
    const first = await inboundClaimIndexShape(pool);
    assert.equal(first.indnkeyatts, 4);
    assert.equal(first.indnatts, 4);
    assert.equal(first.has_expressions, false);
    assert.deepEqual(first.key_columns, ['processing_state', 'next_attempt_at', 'received_at', 'id']);
    await pool.query(migrationSql);
    assert.deepEqual(await inboundClaimIndexShape(pool), first);
  });
});

test('retry pre-efecto persiste contador/backoff y claim respeta next_attempt_at con fencing', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool, { id: 'wamid.retry-media', type: 'image' });
    const query = rowsQuery(pool);
    const first = await claimNextCloudInboundEvent({ query, owner: 'worker-a', leaseMs: 1000 });
    assert.equal(first.attempt_count, 1);
    assert.equal(first.retry_count, 0);

    await scheduleCloudInboundRetry({
      query, id: first.id, owner: 'worker-a', delayMs: 5000, errorCode: 'cloud_media_retryable',
    });
    const scheduled = (await pool.query(`
      SELECT processing_state, attempt_count, retry_count, next_attempt_at > NOW() AS waits,
             claim_owner, claim_until
        FROM whatsapp_cloud_events WHERE id = $1
    `, [first.id])).rows[0];
    assert.deepEqual(scheduled, {
      processing_state: 'pending', attempt_count: 1, retry_count: 1, waits: true,
      claim_owner: null, claim_until: null,
    });
    assert.equal(await claimNextCloudInboundEvent({ query, owner: 'worker-b', leaseMs: 1000 }), null);

    await assert.rejects(scheduleCloudInboundRetry({
      query, id: first.id, owner: 'worker-a', delayMs: 1, errorCode: 'cloud_media_retryable',
    }), { code: 'CLOUD_INBOUND_CLAIM_LOST' });

    await pool.query(`UPDATE whatsapp_cloud_events SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id]);
    const claims = await Promise.all([
      claimNextCloudInboundEvent({ query, owner: 'worker-b', leaseMs: 1000 }),
      claimNextCloudInboundEvent({ query, owner: 'worker-c', leaseMs: 1000 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const reclaimed = claims.find(Boolean);
    const reclaimedOwner = claims[0] ? 'worker-b' : 'worker-c';
    assert.equal(reclaimed.id, first.id);
    assert.equal(reclaimed.attempt_count, 2);
    assert.equal(reclaimed.retry_count, 1);

    await pool.query('UPDATE whatsapp_cloud_events SET retry_count = 3 WHERE id = $1', [first.id]);
    await finishCloudInboundEvent({
      query, id: first.id, owner: reclaimedOwner, state: 'skipped', errorCode: 'cloud_media_retry_exhausted',
    });
    const exhausted = (await pool.query(`
      SELECT processing_state, processing_error_code, processed_at IS NOT NULL AS terminal
        FROM whatsapp_cloud_events WHERE id = $1
    `, [first.id])).rows[0];
    assert.deepEqual(exhausted, {
      processing_state: 'skipped', processing_error_code: 'cloud_media_retry_exhausted', terminal: true,
    });
    assert.equal(await claimNextCloudInboundEvent({ query, owner: 'worker-d', leaseMs: 1000 }), null);
  });
});

test('heartbeat PostgreSQL mantiene lease más allá del plazo y evita reconciliación prematura', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await seed(pool, { id: 'wamid.long-bot' });
    const query = rowsQuery(pool);
    const row = await claimNextCloudInboundEvent({ query, owner: 'long-owner', leaseMs: 1000 });
    assert.equal(row.phone_number_id, 'phone-2');
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
