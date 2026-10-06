import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { basename, join } from 'node:path';
import pg from 'pg';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL focal gate requires local initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const outboxStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const outboxEnd = initSql.indexOf('CREATE TABLE IF NOT EXISTS push_subs (', outboxStart);
const projectionStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION');
const projectionEndMarker = '-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION';
const projectionEnd = initSql.indexOf(projectionEndMarker, projectionStart);
assert.ok(outboxStart >= 0 && outboxEnd > outboxStart, 'initDb.sql must expose the outbox migration');
assert.ok(projectionStart >= 0 && projectionEnd > projectionStart, 'initDb.sql must expose the inbox projection migration');
const outboxSql = initSql.slice(outboxStart, outboxEnd);
const projectionSql = initSql.slice(projectionStart, projectionEnd + projectionEndMarker.length);
const migrationSql = `${outboxSql}\n${projectionSql}`;
const tempPrefix = '.whatsapp-cloud-inbox-pg-';
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
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_inbox_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_inbox_test', database: 'postgres' });
    await pool.query('CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
    await pool.query(`
      CREATE TABLE whatsapp_cloud_events (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        event_kind TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sender_id TEXT,
        recipient_id TEXT,
        message_type TEXT,
        status TEXT,
        source_timestamp TEXT,
        event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (empresa_id, dedupe_key)
      )
    `);
    await work(pool, { directory, port });
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
}

function runPsqlFile({ port, file }) {
  return new Promise(resolve => {
    const child = spawn(join(bin, 'psql'), [
      '-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'cloud_inbox_test',
      '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', file,
    ], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

async function waitUntil(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function indexShape(pool, indexName) {
  return (await pool.query(`
    SELECT index_row.indisunique,
           index_row.indnkeyatts,
           index_row.indnatts,
           index_row.indexprs IS NOT NULL AS has_expressions,
           index_row.indoption::TEXT AS sort_options,
           COALESCE(array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
             FILTER (WHERE key_column.ordinality <= index_row.indnkeyatts), ARRAY[]::TEXT[]) AS key_columns,
           pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_index AS index_row
      CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      LEFT JOIN pg_attribute AS attribute_row
        ON attribute_row.attrelid = index_row.indrelid
       AND attribute_row.attnum = key_column.attnum
     WHERE index_row.indexrelid = $1::regclass
     GROUP BY index_row.indisunique, index_row.indnkeyatts, index_row.indnatts,
              index_row.indexprs, index_row.indoption, index_row.indpred, index_row.indrelid
  `, [indexName])).rows[0];
}

async function seedBackfillSources(pool) {
  await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
  await pool.query(`
    INSERT INTO whatsapp_cloud_events
      (empresa_id, event_kind, dedupe_key, message_id, sender_id, recipient_id,
       message_type, status, source_timestamp, event_data, received_at)
    VALUES
      (1, 'message', 'message:in-text', 'in-text', '549351555001', NULL,
       'text', NULL, '1760000000',
       '{"text":{"body":"hola"},"opaque":"no-copy"}'::jsonb, '2026-10-01T10:00:00Z'),
      (1, 'message', 'message:in-image', 'in-image', '549351555001', NULL,
       'image', NULL, '1760000001',
       '{"image":{"id":"secret-media-image","sha256":"secret-sha","mime_type":"image/jpeg","caption":"foto"}}'::jsonb, '2026-10-01T10:00:01Z'),
      (1, 'message', 'message:in-document', 'in-document', '549351555001', NULL,
       'document', NULL, 'invalid-timestamp',
       '{"document":{"id":"secret-media-document","sha256":"secret-doc-sha","mime_type":"application/pdf","caption":"factura","filename":"factura.pdf"}}'::jsonb, '2026-10-01T10:00:02Z'),
      (1, 'message', 'message:unsupported', 'unsupported', '549351555001', NULL,
       'audio', NULL, '1760000002', '{"audio":{"id":"must-not-copy"}}'::jsonb, NOW()),
      (1, 'message', 'message:bad-sender', 'bad-sender', '+54 9 351 555 001', NULL,
       'text', NULL, '1760000003', '{"text":{"body":"ambiguous"}}'::jsonb, NOW()),
      (2, 'message', 'message:tenant-two', 'tenant-two', '549351555001', NULL,
       'text', NULL, '1760000004', '{"text":{"body":"otro tenant"}}'::jsonb, NOW()),
      (1, 'status', 'status:out-sent:delivered:1760000010', 'out-sent', NULL, '549351555002',
       NULL, 'delivered', '1760000010', '{"opaque":"status-payload"}'::jsonb, NOW()),
      (1, 'status', 'status:out-sent:read:1760000020', 'out-sent', NULL, '549351555002',
       NULL, 'read', '1760000020', '{"opaque":"status-payload"}'::jsonb, NOW())
  `);
  await pool.query(migrationSql);
  await pool.query(`
    INSERT INTO wpp_outbox
      (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
       meta_message_id, cloud_dispatch_state)
    VALUES
      (1, '549351555002', 'respuesta', '2026-10-01T11:00:00Z', '2026-10-01T11:00:01Z',
       'sent', 'cloud', 'out-sent', 'sent'),
      (1, '549351555003', 'pendiente', '2026-10-01T12:00:00Z', NULL,
       'pending', 'cloud', NULL, NULL),
      (1, '549351555004', 'reintentar', '2026-10-01T13:00:00Z', NULL,
       'error', 'cloud', NULL, 'manual_retryable'),
      (1, '549351555005', 'incierto', '2026-10-01T14:00:00Z', NULL,
       'error', 'cloud', NULL, 'outcome_unknown'),
      (1, '549351555006@c.us', 'legacy jid', NOW(), NULL,
       'pending', 'cloud', NULL, NULL),
      (1, '+54 9 351 555 007', 'legacy formatted', NOW(), NULL,
       'pending', 'cloud', NULL, NULL),
      (1, '549351555008', 'web only', NOW(), NULL,
       'pending', 'company', NULL, NULL),
      (NULL, '549351555009', 'general only', NOW(), NULL,
       'pending', 'general', NULL, NULL)
  `);
}

test('migración crea proyección tenant-scoped, constraints e índices exactos y es reejecutable', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const columns = (await pool.query(`
      SELECT attname, format_type(atttypid, atttypmod) AS data_type, attnotnull
        FROM pg_attribute
       WHERE attrelid = 'whatsapp_cloud_messages'::regclass
         AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum
    `)).rows;
    assert.deepEqual(columns.map(row => row.attname), [
      'id', 'empresa_id', 'direction', 'participant_wa_id', 'source_event_id', 'outbox_id',
      'provider_message_id', 'message_type', 'text_body', 'media_mime_type', 'media_caption',
      'document_filename', 'delivery_status', 'state_rank', 'message_at', 'sent_at', 'delivered_at',
      'read_at', 'failed_at', 'created_at', 'updated_at',
    ]);
    assert.equal(columns.find(row => row.attname === 'empresa_id').attnotnull, true);
    assert.equal(columns.find(row => row.attname === 'participant_wa_id').attnotnull, true);

    const constraints = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
       ORDER BY conname
    `)).rows;
    const definitions = new Map(constraints.map(row => [row.conname, row.definition]));
    assert.match(definitions.get('whatsapp_cloud_messages_direction_check'), /inbound.*outbound/i);
    assert.match(definitions.get('whatsapp_cloud_messages_participant_check'), /\^\[0-9\]\{6,15\}\$/);
    assert.match(definitions.get('whatsapp_cloud_messages_type_check'), /text.*image.*document/i);
    assert.match(definitions.get('whatsapp_cloud_messages_content_check'), /text_body/i);
    assert.match(definitions.get('whatsapp_cloud_messages_content_length_check'), /4096.*255.*1024.*255/i);
    assert.match(definitions.get('whatsapp_cloud_messages_delivery_status_check'), /received.*queued.*sending.*sent.*delivered.*read.*failed.*manual_retry.*outcome_unknown/i);
    assert.match(definitions.get('whatsapp_cloud_messages_direction_status_check'), /inbound.*received.*outbound/i);
    assert.match(definitions.get('whatsapp_cloud_messages_state_rank_check'), /state_rank/i);
    assert.match(definitions.get('whatsapp_cloud_messages_timestamps_check'), /sent_at.*delivered_at.*read_at.*failed_at/i);
    assert.match(definitions.get('whatsapp_cloud_messages_source_direction_check'), /source_event_id/i);
    assert.match(definitions.get('whatsapp_cloud_messages_outbox_direction_check'), /outbox_id/i);
    assert.match(definitions.get('whatsapp_cloud_messages_empresa_id_fkey'), /FOREIGN KEY \(empresa_id\) REFERENCES empresas\(id\) ON DELETE CASCADE/i);
    assert.match(definitions.get('whatsapp_cloud_messages_source_event_fkey'), /FOREIGN KEY \(empresa_id, source_event_id\).*whatsapp_cloud_events\(empresa_id, id\).*ON DELETE SET NULL \(source_event_id\)/i);
    assert.match(definitions.get('whatsapp_cloud_messages_outbox_fkey'), /FOREIGN KEY \(empresa_id, outbox_id\).*wpp_outbox\(empresa_id, id\).*ON DELETE SET NULL \(outbox_id\)/i);

    for (const [indexName, linkColumn] of [
      ['whatsapp_cloud_messages_source_event_uidx', 'source_event_id'],
      ['whatsapp_cloud_messages_outbox_uidx', 'outbox_id'],
      ['whatsapp_cloud_messages_provider_message_uidx', 'provider_message_id'],
    ]) {
      const shape = await indexShape(pool, indexName);
      assert.equal(shape.indisunique, true);
      assert.equal(shape.indnkeyatts, 2);
      assert.equal(shape.indnatts, 2);
      assert.equal(shape.has_expressions, false);
      assert.equal(shape.sort_options, '0 0');
      assert.deepEqual(shape.key_columns, ['empresa_id', linkColumn]);
      assert.match(shape.predicate, new RegExp(`${linkColumn} IS NOT NULL`, 'i'));
    }

    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_messages_conversations'), {
      indisunique: false,
      indnkeyatts: 4,
      indnatts: 4,
      has_expressions: false,
      sort_options: '0 3 3 0',
      key_columns: ['empresa_id', 'message_at', 'id', 'participant_wa_id'],
      predicate: null,
    });
    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline'), {
      indisunique: false,
      indnkeyatts: 4,
      indnatts: 4,
      has_expressions: false,
      sort_options: '0 0 3 3',
      key_columns: ['empresa_id', 'participant_wa_id', 'message_at', 'id'],
      predicate: null,
    });
  });
});

test('migración toma lock advisory transaccional estable antes del primer DDL y dos ejecuciones completas frescas terminan exit 0', async () => {
  const begin = projectionSql.indexOf('BEGIN;');
  const lockTimeout = projectionSql.indexOf("SET LOCAL lock_timeout = '30s';");
  const statementTimeout = projectionSql.indexOf("SET LOCAL statement_timeout = '5min';");
  const advisoryLock = projectionSql.indexOf('SELECT pg_advisory_xact_lock(1464550724, 1229867347);');
  const firstDdl = projectionSql.search(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|SEQUENCE|INDEX)\b/i);
  assert.ok(begin >= 0 && lockTimeout > begin && statementTimeout > lockTimeout
    && advisoryLock > statementTimeout && firstDdl > advisoryLock,
  'timeouts and the stable migration advisory lock must precede the first DDL');
  assert.doesNotMatch(projectionSql,
    /LOCK\s+TABLE\s+[^;]*(?:whatsapp_cloud_events|wpp_outbox)/is,
    'migration serialization must not lock source tables explicitly');

  await withDatabase(async (pool, { directory, port }) => {
    await pool.query(outboxSql);
    const delayedMigration = projectionSql.replace(
      'SELECT pg_advisory_xact_lock(1464550724, 1229867347);',
      "SELECT pg_advisory_xact_lock(1464550724, 1229867347);\nSELECT pg_sleep(0.35);",
    );
    const file = join(directory, 'cloud-inbox-projection.sql');
    writeFileSync(file, delayedMigration);
    const startedAt = Date.now();
    const results = await Promise.all([
      runPsqlFile({ port, file }),
      runPsqlFile({ port, file }),
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(results.map(result => result.code), [0, 0],
      results.map(result => result.stderr).join('\n'));
    assert.ok(elapsedMs >= 600,
      `advisory lock must serialize both 350ms critical sections (elapsed ${elapsedMs}ms)`);
    assert.equal((await pool.query("SELECT to_regclass('whatsapp_cloud_messages') IS NOT NULL AS present")).rows[0].present, true);
  });
});

test('backfill copia sólo contenido allowlisted, estados/timestamps y vínculos Cloud inequívocos', async () => {
  await withDatabase(async pool => {
    await seedBackfillSources(pool);
    await pool.query(migrationSql);

    const rows = (await pool.query(`
      SELECT empresa_id, direction, participant_wa_id, provider_message_id, message_type,
             text_body, media_mime_type, media_caption, document_filename, delivery_status,
             source_event_id IS NOT NULL AS has_source_event,
             outbox_id IS NOT NULL AS has_outbox,
             sent_at IS NOT NULL AS has_sent_at,
             delivered_at IS NOT NULL AS has_delivered_at,
             read_at IS NOT NULL AS has_read_at
        FROM whatsapp_cloud_messages
       ORDER BY empresa_id, direction, provider_message_id NULLS LAST, text_body NULLS LAST
    `)).rows;
    assert.deepEqual(rows, [
      {
        empresa_id: 1, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'in-document', message_type: 'document', text_body: null,
        media_mime_type: 'application/pdf', media_caption: 'factura', document_filename: 'factura.pdf',
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'in-image', message_type: 'image', text_body: null,
        media_mime_type: 'image/jpeg', media_caption: 'foto', document_filename: null,
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'in-text', message_type: 'text', text_body: 'hola',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555002',
        provider_message_id: 'out-sent', message_type: 'text', text_body: 'respuesta',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'read', has_source_event: false, has_outbox: true,
        has_sent_at: true, has_delivered_at: true, has_read_at: true,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555005',
        provider_message_id: null, message_type: 'text', text_body: 'incierto',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'outcome_unknown', has_source_event: false, has_outbox: true,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555003',
        provider_message_id: null, message_type: 'text', text_body: 'pendiente',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'queued', has_source_event: false, has_outbox: true,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555004',
        provider_message_id: null, message_type: 'text', text_body: 'reintentar',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'manual_retry', has_source_event: false, has_outbox: true,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 2, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'tenant-two', message_type: 'text', text_body: 'otro tenant',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
    ]);

    const serialized = JSON.stringify((await pool.query('SELECT * FROM whatsapp_cloud_messages')).rows);
    for (const forbidden of ['secret-media-image', 'secret-media-document', 'secret-sha', 'secret-doc-sha', 'opaque', '+54 9', '@c.us']) {
      assert.equal(serialized.includes(forbidden), false, `must not copy ${forbidden}`);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM whatsapp_cloud_messages')).rows[0].total, 8);
  });
});

test('backfill limita texto outbound legacy largo por caracteres sin abortar y converge idempotentemente', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES
        (1, '549351555040', repeat('a', 4096), 'pending', 'cloud'),
        (1, '549351555041', repeat('b', 4097), 'pending', 'cloud'),
        (1, '549351555042', repeat('🙂', 5001), 'pending', 'cloud')
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const rows = (await pool.query(`
      SELECT participant_wa_id, text_body, length(text_body)::int AS character_length,
             octet_length(text_body)::int AS byte_length
        FROM whatsapp_cloud_messages
       WHERE participant_wa_id IN ('549351555040', '549351555041', '549351555042')
       ORDER BY participant_wa_id
    `)).rows;

    assert.equal(rows.length, 3, 'rerunning the migration must not duplicate projected outbox rows');
    assert.deepEqual(rows.map(row => ({
      participant_wa_id: row.participant_wa_id,
      character_length: row.character_length,
      byte_length: row.byte_length,
    })), [
      { participant_wa_id: '549351555040', character_length: 4096, byte_length: 4096 },
      { participant_wa_id: '549351555041', character_length: 4096, byte_length: 4096 },
      { participant_wa_id: '549351555042', character_length: 4096, byte_length: 16384 },
    ]);
    assert.equal(rows[0].text_body, 'a'.repeat(4096));
    assert.equal(rows[1].text_body, 'b'.repeat(4096));
    assert.equal(rows[2].text_body, '🙂'.repeat(4096));
  });
});

test('backfill conserva status sent legacy sin sent_at usando created_at sólo como timestamp mínimo de envío', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES
        (1, '549351555010', 'sent legacy sin timestamp', '2026-10-01T15:00:00Z', NULL,
         'sent', 'cloud', 'out-sent-without-timestamp', 'sent')
    `);

    await pool.query(projectionSql);

    const row = (await pool.query(`
      SELECT delivery_status, state_rank, message_at, sent_at, delivered_at, read_at, failed_at
        FROM whatsapp_cloud_messages
       WHERE provider_message_id = 'out-sent-without-timestamp'
    `)).rows[0];
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.state_rank, 30);
    assert.equal(row.message_at.toISOString(), '2026-10-01T15:00:00.000Z');
    // El status fuente prueba envío, pero no delivery: created_at es sólo el fallback conservador
    // necesario para mantener el estado sent coherente con el constraint temporal.
    assert.equal(row.sent_at.toISOString(), '2026-10-01T15:00:00.000Z');
    assert.equal(row.delivered_at, null);
    assert.equal(row.read_at, null);
    assert.equal(row.failed_at, null);
  });
});

test('backfill canoniza cronologías irregulares sin abortar ni violar constraints', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES
        (1, '549351555020', 'delivered sin sent', '2026-10-01T10:00:00Z', NULL,
         'sending', 'cloud', 'irregular-delivered-only', 'pre_dispatch'),
        (1, '549351555021', 'reloj desalineado', '2026-10-01T11:00:00Z', NULL,
         'sending', 'cloud', 'irregular-clock-skew', 'pre_dispatch'),
        (1, '549351555022', 'sent y failed', '2026-10-01T12:00:00Z', NULL,
         'sending', 'cloud', 'irregular-sent-failed', 'pre_dispatch'),
        (1, '549351555023', 'failed legacy con sent_at', '2026-10-01T13:00:00Z',
         '2026-10-01T13:02:00Z', 'error', 'cloud', 'irregular-failed', 'definitive_failed')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'irregular:delivered-only', 'irregular-delivered-only', '549351555020',
         'delivered', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:05:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T10:05:01Z'),
        (1, 'status', 'irregular:clock:delivered', 'irregular-clock-skew', '549351555021',
         'delivered', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T11:01:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T11:01:01Z'),
        (1, 'status', 'irregular:clock:sent', 'irregular-clock-skew', '549351555021',
         'sent', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T11:03:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T11:03:01Z'),
        (1, 'status', 'irregular:mixed:failed', 'irregular-sent-failed', '549351555022',
         'failed', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:04:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T12:04:01Z'),
        (1, 'status', 'irregular:mixed:sent', 'irregular-sent-failed', '549351555022',
         'sent', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:02:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T12:02:01Z')
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const rows = (await pool.query(`
      SELECT provider_message_id, delivery_status, state_rank,
             to_char(message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS message_at,
             to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
             to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at,
             to_char(failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS failed_at
        FROM whatsapp_cloud_messages
       WHERE provider_message_id LIKE 'irregular-%'
       ORDER BY provider_message_id
    `)).rows;
    assert.deepEqual(rows, [
      {
        provider_message_id: 'irregular-clock-skew', delivery_status: 'delivered', state_rank: 40,
        message_at: '2026-10-01T11:00:00Z', sent_at: '2026-10-01T11:01:00Z',
        delivered_at: '2026-10-01T11:01:00Z', read_at: null, failed_at: null,
      },
      {
        provider_message_id: 'irregular-delivered-only', delivery_status: 'delivered', state_rank: 40,
        message_at: '2026-10-01T10:00:00Z', sent_at: '2026-10-01T10:05:00Z',
        delivered_at: '2026-10-01T10:05:00Z', read_at: null, failed_at: null,
      },
      {
        provider_message_id: 'irregular-failed', delivery_status: 'failed', state_rank: 25,
        message_at: '2026-10-01T13:00:00Z', sent_at: null, delivered_at: null,
        read_at: null, failed_at: '2026-10-01T13:02:00Z',
      },
      {
        provider_message_id: 'irregular-sent-failed', delivery_status: 'sent', state_rank: 30,
        message_at: '2026-10-01T12:00:00Z', sent_at: '2026-10-01T12:02:00Z',
        delivered_at: null, read_at: null, failed_at: null,
      },
    ]);
  });
});

test('backfill converge timestamps inferidos cuando llega después el evento real más temprano', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES
        (1, '549351555030', 'convergencia temporal', '2026-10-01T10:00:00Z', NULL,
         'sending', 'cloud', 'convergent-timestamps', 'pre_dispatch')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'convergent:delivered', 'convergent-timestamps', '549351555030',
         'delivered', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:05:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T10:05:01Z')
    `);

    await pool.query(projectionSql);

    const inferred = (await pool.query(`
      SELECT delivery_status, state_rank, message_at, sent_at, delivered_at, read_at, failed_at
        FROM whatsapp_cloud_messages
       WHERE provider_message_id = 'convergent-timestamps'
    `)).rows[0];
    assert.equal(inferred.delivery_status, 'delivered');
    assert.equal(inferred.state_rank, 40);
    assert.equal(inferred.sent_at.toISOString(), '2026-10-01T10:05:00.000Z');
    assert.equal(inferred.delivered_at.toISOString(), '2026-10-01T10:05:00.000Z');
    assert.equal(inferred.read_at, null);
    assert.equal(inferred.failed_at, null);

    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'convergent:sent', 'convergent-timestamps', '549351555030',
         'sent', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:02:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T10:06:00Z')
    `);

    await pool.query(projectionSql);

    const converged = (await pool.query(`
      SELECT delivery_status, state_rank, message_at, sent_at, delivered_at, read_at, failed_at,
             message_at <= sent_at AS message_before_sent,
             sent_at <= delivered_at AS sent_before_delivered,
             delivered_at <= COALESCE(read_at, delivered_at) AS delivered_before_read
        FROM whatsapp_cloud_messages
       WHERE provider_message_id = 'convergent-timestamps'
    `)).rows[0];
    assert.equal(converged.delivery_status, 'delivered');
    assert.equal(converged.state_rank, 40);
    assert.equal(converged.message_at.toISOString(), '2026-10-01T10:00:00.000Z');
    assert.equal(converged.sent_at.toISOString(), '2026-10-01T10:02:00.000Z');
    assert.equal(converged.delivered_at.toISOString(), '2026-10-01T10:05:00.000Z');
    assert.equal(converged.read_at, null);
    assert.equal(converged.failed_at, null);
    assert.equal(converged.message_before_sent, true);
    assert.equal(converged.sent_before_delivered, true);
    assert.equal(converged.delivered_before_read, true);
  });
});

test('constraints aíslan tenant, dirección/estado/rank/timestamps y rechazan enlaces cruzados', async () => {
  await withDatabase(async pool => {
    await seedBackfillSources(pool);
    const eventId = (await pool.query("SELECT id FROM whatsapp_cloud_events WHERE message_id = 'tenant-two'")).rows[0].id;
    const outboxId = (await pool.query("SELECT id FROM wpp_outbox WHERE mensaje = 'pendiente'")).rows[0].id;

    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'sideways', '549351555001', 'text', 'x', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '+549****5001', 'text', 'x', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, media_mime_type, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555001', 'text', 'x', 'image/jpeg', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, source_event_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555001', $1, 'text', 'x', 'received', 0, NOW())
    `, [eventId]), error => error?.code === '23503');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, outbox_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (2, 'outbound', '549351555003', $1, 'text', 'x', 'queued', 10, NOW())
    `, [outboxId]), error => error?.code === '23503');

    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555001', 'text', 'x', 'sent', 30, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'outbound', '549351555001', 'text', 'x', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'outbound', '549351555001', 'text', 'x', 'delivered', 30, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank,
         message_at, delivered_at)
      VALUES (1, 'outbound', '549351555001', 'text', 'x', 'queued', 10, NOW(), NOW())
    `), error => error?.code === '23514');
  });
});

test('cleanup de fuentes conserva la proyección y sólo anula el vínculo borrado', async () => {
  await withDatabase(async pool => {
    await seedBackfillSources(pool);
    await pool.query(migrationSql);
    const inbound = (await pool.query("SELECT id, source_event_id FROM whatsapp_cloud_messages WHERE provider_message_id = 'in-text'")).rows[0];
    const outbound = (await pool.query("SELECT id, outbox_id FROM whatsapp_cloud_messages WHERE provider_message_id = 'out-sent'")).rows[0];

    await pool.query('DELETE FROM whatsapp_cloud_events WHERE id = $1', [inbound.source_event_id]);
    await pool.query('DELETE FROM wpp_outbox WHERE id = $1', [outbound.outbox_id]);

    assert.deepEqual((await pool.query(
      'SELECT empresa_id, source_event_id, provider_message_id, text_body FROM whatsapp_cloud_messages WHERE id = $1',
      [inbound.id],
    )).rows[0], { empresa_id: 1, source_event_id: null, provider_message_id: 'in-text', text_body: 'hola' });
    assert.deepEqual((await pool.query(
      'SELECT empresa_id, outbox_id, provider_message_id, text_body FROM whatsapp_cloud_messages WHERE id = $1',
      [outbound.id],
    )).rows[0], { empresa_id: 1, outbox_id: null, provider_message_id: 'out-sent', text_body: 'respuesta' });
  });
});

test('source_timestamp usa límites explícitos contra received_at y fallback fuera de tolerancia', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'message', 'message:epoch-zero', 'epoch-zero', '549351555001', 'text', '0',
         '{"text":{"body":"zero"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:past-boundary', 'past-boundary', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-09-01T12:00:00Z')::bigint::text,
         '{"text":{"body":"past-boundary"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:past-outside', 'past-outside', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-09-01T11:59:59Z')::bigint::text,
         '{"text":{"body":"past-outside"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:future-boundary', 'future-boundary', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:05:00Z')::bigint::text,
         '{"text":{"body":"future-boundary"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:future-outside', 'future-outside', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:05:01Z')::bigint::text,
         '{"text":{"body":"future-outside"}}', '2026-10-01T12:00:00Z')
    `);

    await pool.query(migrationSql);
    const rows = (await pool.query(`
      SELECT provider_message_id, message_at
        FROM whatsapp_cloud_messages
       ORDER BY provider_message_id
    `)).rows.map(row => ({ ...row, message_at: row.message_at.toISOString() }));
    assert.deepEqual(rows, [
      { provider_message_id: 'epoch-zero', message_at: '2026-10-01T12:00:00.000Z' },
      { provider_message_id: 'future-boundary', message_at: '2026-10-01T12:05:00.000Z' },
      { provider_message_id: 'future-outside', message_at: '2026-10-01T12:00:00.000Z' },
      { provider_message_id: 'past-boundary', message_at: '2026-09-01T12:00:00.000Z' },
      { provider_message_id: 'past-outside', message_at: '2026-10-01T12:00:00.000Z' },
    ]);
  });
});

test('migración repara secuencia propia para id BIGINT legacy sin default y la sincroniza sobre MAX(id)', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      CREATE TABLE whatsapp_cloud_messages (
        id BIGINT NOT NULL,
        empresa_id INTEGER,
        direction TEXT,
        participant_wa_id TEXT,
        message_type TEXT,
        text_body TEXT,
        delivery_status TEXT,
        state_rank SMALLINT,
        message_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (id, empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES
        (9001, 1, 'outbound', '549351555011', 'text', 'legacy explícito',
         'queued', 10, '2026-10-01T16:00:00Z')
    `);

    const legacyId = (await pool.query(`
      SELECT column_row.attnotnull,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression,
             pg_get_serial_sequence('whatsapp_cloud_messages', 'id') AS sequence_name
        FROM pg_attribute AS column_row
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = column_row.attrelid
         AND default_row.adnum = column_row.attnum
       WHERE column_row.attrelid = 'whatsapp_cloud_messages'::regclass
         AND column_row.attname = 'id'
    `)).rows[0];
    assert.deepEqual(legacyId, {
      attnotnull: true,
      default_expression: null,
      sequence_name: null,
    });

    await pool.query(projectionSql);

    const sequence = (await pool.query(`
      SELECT pg_get_serial_sequence('whatsapp_cloud_messages', 'id') AS name,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
        FROM pg_attribute AS column_row
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = column_row.attrelid
         AND default_row.adnum = column_row.attnum
       WHERE column_row.attrelid = 'whatsapp_cloud_messages'::regclass
         AND column_row.attname = 'id'
    `)).rows[0];
    assert.equal(sequence.name, 'public.whatsapp_cloud_messages_id_seq');
    assert.match(sequence.default_expression, /^nextval\('whatsapp_cloud_messages_id_seq'::regclass\)$/);

    const ownership = (await pool.query(`
      SELECT count(*)::int AS total
        FROM pg_depend
       WHERE classid = 'pg_class'::regclass
         AND objid = $1::regclass
         AND refclassid = 'pg_class'::regclass
         AND refobjid = 'whatsapp_cloud_messages'::regclass
         AND refobjsubid = (
           SELECT attnum
             FROM pg_attribute
            WHERE attrelid = 'whatsapp_cloud_messages'::regclass
              AND attname = 'id'
         )
         AND deptype = 'a'
    `, [sequence.name])).rows[0];
    assert.equal(ownership.total, 1);

    const inserted = (await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES
        (1, 'outbound', '549351555012', 'text', 'id automático',
         'queued', 10, '2026-10-01T16:01:00Z')
      RETURNING id
    `)).rows[0];
    assert.ok(Number(inserted.id) > 9001);

    await pool.query(projectionSql);

    assert.deepEqual((await pool.query(`
      SELECT id::text, text_body
        FROM whatsapp_cloud_messages
       ORDER BY id
    `)).rows, [
      { id: '9001', text_body: 'legacy explícito' },
      { id: inserted.id, text_body: 'id automático' },
    ]);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM pg_depend
       WHERE classid = 'pg_class'::regclass
         AND objid = 'whatsapp_cloud_messages_id_seq'::regclass
         AND refclassid = 'pg_class'::regclass
         AND refobjid = 'whatsapp_cloud_messages'::regclass
         AND deptype = 'a'
    `)).rows[0].total, 1);
  });
});

test('migración repara fixture legacy incompleto, constraints, uniques e índices parentales engañosos', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query(`
      CREATE UNIQUE INDEX whatsapp_cloud_events_empresa_id_id_uidx
        ON whatsapp_cloud_events (empresa_id) INCLUDE (id)
       WHERE id IS NOT NULL;
      CREATE UNIQUE INDEX wpp_outbox_empresa_id_id_uidx
        ON wpp_outbox (empresa_id) INCLUDE (id)
       WHERE id IS NOT NULL;
      CREATE TABLE whatsapp_cloud_messages (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INTEGER,
        direction TEXT,
        participant_wa_id TEXT,
        message_at TIMESTAMP WITHOUT TIME ZONE
      );
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_direction_check CHECK (direction <> 'sideways');
      CREATE UNIQUE INDEX whatsapp_cloud_messages_source_event_uidx
        ON whatsapp_cloud_messages (empresa_id) INCLUDE (id);
      CREATE INDEX idx_whatsapp_cloud_messages_timeline
        ON whatsapp_cloud_messages (empresa_id, message_at, id)
        INCLUDE (participant_wa_id)
       WHERE participant_wa_id IS NOT NULL;
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const columns = (await pool.query(`
      SELECT attname, format_type(atttypid, atttypmod) AS data_type, attnotnull
        FROM pg_attribute
       WHERE attrelid = 'whatsapp_cloud_messages'::regclass
         AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum
    `)).rows;
    assert.deepEqual(new Set(columns.map(row => row.attname)), new Set([
      'id', 'empresa_id', 'direction', 'participant_wa_id', 'delivery_status', 'message_at',
      'source_event_id', 'outbox_id', 'provider_message_id', 'message_type', 'text_body',
      'media_mime_type', 'media_caption', 'document_filename', 'state_rank', 'sent_at',
      'delivered_at', 'read_at', 'failed_at', 'created_at', 'updated_at',
    ]));
    for (const required of ['empresa_id', 'direction', 'participant_wa_id', 'delivery_status',
      'message_at', 'message_type', 'state_rank', 'created_at', 'updated_at']) {
      assert.equal(columns.find(row => row.attname === required).attnotnull, true, `${required} repaired NOT NULL`);
    }
    assert.equal(columns.find(row => row.attname === 'message_at').data_type, 'timestamp with time zone');

    assert.deepEqual((await indexShape(pool, 'whatsapp_cloud_events_empresa_id_id_uidx')).key_columns,
      ['empresa_id', 'id']);
    assert.deepEqual((await indexShape(pool, 'wpp_outbox_empresa_id_id_uidx')).key_columns,
      ['empresa_id', 'id']);
    assert.deepEqual((await indexShape(pool, 'whatsapp_cloud_messages_source_event_uidx')).key_columns,
      ['empresa_id', 'source_event_id']);
    assert.deepEqual((await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline')).key_columns,
      ['empresa_id', 'participant_wa_id', 'message_at', 'id']);
  });
});

test('reparación canónica reemplaza sólo timestamps legacy y sanea filas antes de validar', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      ALTER TABLE whatsapp_cloud_messages
        DROP CONSTRAINT whatsapp_cloud_messages_timestamps_check;
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_timestamps_check
        CHECK (
          direction = 'inbound'
          OR (direction = 'outbound'
            AND (sent_at IS NULL OR sent_at >= message_at)
            AND (failed_at IS NULL OR failed_at >= message_at)
            AND CASE delivery_status
              WHEN 'failed' THEN delivered_at IS NULL AND read_at IS NULL AND failed_at IS NOT NULL
              ELSE TRUE
            END)
        );
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at, sent_at, failed_at)
      VALUES
        (1, 'outbound', '549351555024', 'text', 'legacy permitido',
         'failed', 25, '2026-10-01T14:00:00Z', '2026-10-01T14:01:00Z',
         '2026-10-01T14:02:00Z')
    `);

    await pool.query(projectionSql);

    assert.deepEqual((await pool.query(`
      SELECT sent_at, delivered_at, read_at, failed_at IS NOT NULL AS has_failed_at
        FROM whatsapp_cloud_messages
       WHERE text_body = 'legacy permitido'
    `)).rows[0], {
      sent_at: null, delivered_at: null, read_at: null, has_failed_at: true,
    });
    const definition = (await pool.query(`
      SELECT lower(pg_get_constraintdef(oid)) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = 'whatsapp_cloud_messages_timestamps_check'
    `)).rows[0].definition;
    assert.match(definition, /when 'failed'::text then .*sent_at is null.*failed_at is not null/i);
  });
});

test('reparación canónica exacta corrige variantes engañosas de todas las constraints y conserva constraints ajenos', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    const canonicalNames = [
      'whatsapp_cloud_messages_empresa_id_fkey',
      'whatsapp_cloud_messages_source_event_fkey',
      'whatsapp_cloud_messages_outbox_fkey',
      'whatsapp_cloud_messages_direction_check',
      'whatsapp_cloud_messages_participant_check',
      'whatsapp_cloud_messages_type_check',
      'whatsapp_cloud_messages_content_check',
      'whatsapp_cloud_messages_content_length_check',
      'whatsapp_cloud_messages_delivery_status_check',
      'whatsapp_cloud_messages_direction_status_check',
      'whatsapp_cloud_messages_state_rank_check',
      'whatsapp_cloud_messages_timestamps_check',
      'whatsapp_cloud_messages_source_direction_check',
      'whatsapp_cloud_messages_outbox_direction_check',
    ];
    const canonicalBefore = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [canonicalNames])).rows;
    assert.equal(canonicalBefore.length, canonicalNames.length);

    await pool.query(`
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_unrelated_check
        CHECK (char_length(participant_wa_id) >= 6)
    `);
    const unrelatedBefore = (await pool.query(`
      SELECT oid::text, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = 'whatsapp_cloud_messages_unrelated_check'
    `)).rows[0];

    for (const constraint of canonicalBefore) {
      await pool.query(`ALTER TABLE whatsapp_cloud_messages DROP CONSTRAINT ${constraint.conname}`);
      if (constraint.contype === 'c') {
        assert.match(constraint.definition, /^CHECK \([\s\S]*\)$/);
        const expression = constraint.definition.slice('CHECK ('.length, -1);
        await pool.query(`
          ALTER TABLE whatsapp_cloud_messages
            ADD CONSTRAINT ${constraint.conname}
            CHECK ((${expression}) OR participant_wa_id = 'not-a-wa-id')
        `);
      } else {
        assert.equal(constraint.contype, 'f');
        await pool.query(`
          ALTER TABLE whatsapp_cloud_messages
            ADD CONSTRAINT ${constraint.conname}
            ${constraint.definition} DEFERRABLE INITIALLY DEFERRED
        `);
      }
    }

    await pool.query(projectionSql);

    const canonicalAfter = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [canonicalNames])).rows;
    assert.deepEqual(canonicalAfter, canonicalBefore,
      'every canonical constraint must be repaired to its exact PostgreSQL definition');
    assert.deepEqual((await pool.query(`
      SELECT oid::text, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = 'whatsapp_cloud_messages_unrelated_check'
    `)).rows[0], unrelatedBefore, 'unrelated constraints must retain identity and definition');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', 'not-a-wa-id', 'text', 'rechazar', 'received', 0, NOW())
    `), error => error?.code === '23514'
      && error?.constraint === 'whatsapp_cloud_messages_participant_check');
  });
});

test('reparación legacy conserva constraints ajenos durante doble migración', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(projectionSql);
    await pool.query(`
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_independent_check
        CHECK (char_length(participant_wa_id) >= 6),
        ADD CONSTRAINT whatsapp_cloud_messages_independent_unique
        UNIQUE (empresa_id, id, participant_wa_id)
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const constraints = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname LIKE 'whatsapp_cloud_messages_independent_%'
       ORDER BY conname
    `)).rows;
    assert.deepEqual(constraints.map(row => ({ conname: row.conname, contype: row.contype })), [
      { conname: 'whatsapp_cloud_messages_independent_check', contype: 'c' },
      { conname: 'whatsapp_cloud_messages_independent_unique', contype: 'u' },
    ]);
    assert.match(constraints[0].definition, /char_length\(participant_wa_id\) >= 6/i);
    assert.match(constraints[1].definition, /UNIQUE \(empresa_id, id, participant_wa_id\)/i);
  });
});

test('reejecución normal no pide ACCESS EXCLUSIVE sobre eventos/outbox ni bloquea sus escritores', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    assert.doesNotMatch(projectionSql,
      /LOCK\s+TABLE\s+[^;]*(?:whatsapp_cloud_events|wpp_outbox)[^;]*ACCESS\s+EXCLUSIVE/is);
    const canonicalObjectsBefore = (await pool.query(`
      SELECT 'constraint' AS kind, conname AS name, oid::text
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname LIKE 'whatsapp_cloud_messages_%'
      UNION ALL
      SELECT 'index', relname, oid::text
        FROM pg_class
       WHERE relname IN (
         'whatsapp_cloud_events_empresa_id_id_uidx',
         'wpp_outbox_empresa_id_id_uidx',
         'whatsapp_cloud_messages_source_event_uidx',
         'whatsapp_cloud_messages_outbox_uidx',
         'whatsapp_cloud_messages_provider_message_uidx',
         'idx_whatsapp_cloud_messages_conversations',
         'idx_whatsapp_cloud_messages_timeline'
       )
       ORDER BY kind, name
    `)).rows;

    const writer = await pool.connect();
    let committed = false;
    try {
      await writer.query('BEGIN');
      await writer.query(`
        INSERT INTO whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (1, 'message', 'concurrent:event', 'concurrent-event', '549351555030', 'text',
                '{"text":{"body":"concurrente"}}'::jsonb)
      `);
      await writer.query(`
        INSERT INTO wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin)
        VALUES (1, '549351555031', 'concurrente', 'pending', 'cloud')
      `);

      const migrator = await pool.connect();
      try {
        await migrator.query("SET lock_timeout = '750ms'");
        await migrator.query(projectionSql);
      } finally {
        migrator.release();
      }
      await writer.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }

    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM whatsapp_cloud_events
       WHERE dedupe_key = 'concurrent:event'
    `)).rows[0].total, 1);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM wpp_outbox
       WHERE mensaje = 'concurrente'
    `)).rows[0].total, 1);
    const canonicalObjectsAfter = (await pool.query(`
      SELECT 'constraint' AS kind, conname AS name, oid::text
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname LIKE 'whatsapp_cloud_messages_%'
      UNION ALL
      SELECT 'index', relname, oid::text
        FROM pg_class
       WHERE relname IN (
         'whatsapp_cloud_events_empresa_id_id_uidx',
         'wpp_outbox_empresa_id_id_uidx',
         'whatsapp_cloud_messages_source_event_uidx',
         'whatsapp_cloud_messages_outbox_uidx',
         'whatsapp_cloud_messages_provider_message_uidx',
         'idx_whatsapp_cloud_messages_conversations',
         'idx_whatsapp_cloud_messages_timeline'
       )
       ORDER BY kind, name
    `)).rows;
    assert.deepEqual(canonicalObjectsAfter, canonicalObjectsBefore,
      'canonical constraints and indexes must not be rebuilt on a normal rerun');
  });
});

test('migración reemplaza índice legacy engañoso aunque contenga columnas sólo en INCLUDE/predicado', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('DROP INDEX idx_whatsapp_cloud_messages_timeline');
    await pool.query(`
      CREATE INDEX idx_whatsapp_cloud_messages_timeline
        ON whatsapp_cloud_messages (empresa_id, message_at, id)
        INCLUDE (participant_wa_id)
       WHERE participant_wa_id IS NOT NULL
    `);

    await pool.query(migrationSql);
    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline'), {
      indisunique: false,
      indnkeyatts: 4,
      indnatts: 4,
      has_expressions: false,
      sort_options: '0 0 3 3',
      key_columns: ['empresa_id', 'participant_wa_id', 'message_at', 'id'],
      predicate: null,
    });
    await pool.query(migrationSql);
    assert.deepEqual((await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline')).key_columns,
      ['empresa_id', 'participant_wa_id', 'message_at', 'id']);
  });
});

test('backfill de contenido sólo acepta strings JSON y limita texto, MIME, caption y filename', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'message', 'json-types:image', 'json-types-image', '549351555041', 'image',
         '1760000000',
         '{"image":{"mime_type":{"opaque":"image/jpeg"},"caption":["opaque"]}}'::jsonb,
         '2026-10-01T10:00:00Z'),
        (1, 'message', 'json-types:document', 'json-types-document', '549351555042', 'document',
         '1760000001',
         jsonb_build_object('document', jsonb_build_object(
           'mime_type', repeat('m', 300), 'caption', repeat('c', 1100),
           'filename', repeat('f', 300))),
         '2026-10-01T10:00:01Z'),
        (1, 'message', 'json-types:text', 'json-types-text', '549351555043', 'text',
         '1760000002', jsonb_build_object('text', jsonb_build_object('body', repeat('t', 5000))),
         '2026-10-01T10:00:02Z')
    `);

    await pool.query(migrationSql);

    const rows = (await pool.query(`
      SELECT provider_message_id, media_mime_type, media_caption, document_filename,
             length(text_body) AS text_length, length(media_mime_type) AS mime_length,
             length(media_caption) AS caption_length, length(document_filename) AS filename_length
        FROM whatsapp_cloud_messages
       ORDER BY provider_message_id
    `)).rows;
    assert.deepEqual(rows, [
      {
        provider_message_id: 'json-types-document', media_mime_type: 'm'.repeat(255),
        media_caption: 'c'.repeat(1024), document_filename: 'f'.repeat(255),
        text_length: null, mime_length: 255, caption_length: 1024, filename_length: 255,
      },
      {
        provider_message_id: 'json-types-image', media_mime_type: null,
        media_caption: null, document_filename: null,
        text_length: null, mime_length: null, caption_length: null, filename_length: null,
      },
      {
        provider_message_id: 'json-types-text', media_mime_type: null,
        media_caption: null, document_filename: null,
        text_length: 4096, mime_length: null, caption_length: null, filename_length: null,
      },
    ]);
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555044', 'text', repeat('x', 4097), 'received', 0, NOW())
    `), error => error?.code === '23514'
      && error?.constraint === 'whatsapp_cloud_messages_content_length_check');
  });
});

test('colisiones cross-table de todos los índices canónicos abortan sin tocar objetos ajenos', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query(`
      CREATE TABLE foreign_index_owner (
        empresa_id INTEGER NOT NULL, id BIGINT NOT NULL, source_event_id BIGINT,
        outbox_id BIGINT, provider_message_id TEXT, message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        participant_wa_id TEXT NOT NULL DEFAULT '549351555099'
      )
    `);
    const canonicalIndexes = [
      'whatsapp_cloud_events_empresa_id_id_uidx',
      'wpp_outbox_empresa_id_id_uidx',
      'whatsapp_cloud_messages_source_event_uidx',
      'whatsapp_cloud_messages_outbox_uidx',
      'whatsapp_cloud_messages_provider_message_uidx',
      'idx_whatsapp_cloud_messages_conversations',
      'idx_whatsapp_cloud_messages_timeline',
    ];
    for (const indexName of canonicalIndexes) {
      await pool.query(`CREATE UNIQUE INDEX ${indexName} ON foreign_index_owner (empresa_id, id)`);
      await pool.query(`ALTER TABLE foreign_index_owner ADD CONSTRAINT ${indexName} UNIQUE USING INDEX ${indexName}`);
      const before = (await pool.query(`
        SELECT constraint_row.oid::text AS constraint_oid, index_row.oid::text AS index_oid,
               constraint_row.conrelid::regclass::text AS table_name
          FROM pg_constraint AS constraint_row
          JOIN pg_class AS index_row ON index_row.oid = constraint_row.conindid
         WHERE constraint_row.conname = $1
      `, [indexName])).rows[0];
      await assert.rejects(pool.query(projectionSql), error => error?.code === 'P0001'
        && /canonical index name collision/i.test(error.message));
      await pool.query('ROLLBACK');
      assert.deepEqual((await pool.query(`
        SELECT constraint_row.oid::text AS constraint_oid, index_row.oid::text AS index_oid,
               constraint_row.conrelid::regclass::text AS table_name
          FROM pg_constraint AS constraint_row
          JOIN pg_class AS index_row ON index_row.oid = constraint_row.conindid
         WHERE constraint_row.conname = $1
      `, [indexName])).rows[0], before, `${indexName} must remain untouched`);
      assert.equal((await pool.query("SELECT to_regclass('whatsapp_cloud_messages') AS relation")).rows[0].relation, null);
      await pool.query(`ALTER TABLE foreign_index_owner DROP CONSTRAINT ${indexName}`);
    }
  });
});

test('status backfill usa compare-and-set monotónico en ambos ganadores del row lock', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES (1, '549351555050', 'race monotónica', '2026-10-01T10:00:00Z',
              '2026-10-01T10:01:00Z', 'sent', 'cloud', 'race-monotonic', 'sent');
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES (1, 'status', 'race:sent', 'race-monotonic', '549351555050', 'sent',
              EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:01:00Z')::bigint::text,
              '{}'::jsonb, '2026-10-01T10:01:01Z')
    `);
    await pool.query(projectionSql);

    const writer = await pool.connect();
    const migrator = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT id FROM whatsapp_cloud_messages WHERE provider_message_id = 'race-monotonic' FOR UPDATE");
      const migrationPromise = migrator.query(projectionSql);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [migrator.processID],
      )).rows[0]?.wait_event_type === 'Lock', 'migration did not wait on the writer row lock');
      await writer.query(`
        UPDATE whatsapp_cloud_messages
           SET delivery_status = 'read', state_rank = 50,
               delivered_at = '2026-10-01T10:02:00Z', read_at = '2026-10-01T10:03:00Z',
               updated_at = '2026-10-01T10:03:00Z'
         WHERE provider_message_id = 'race-monotonic'
      `);
      await writer.query('COMMIT');
      await migrationPromise;
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      migrator.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT delivery_status, state_rank,
             to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
             to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at
        FROM whatsapp_cloud_messages WHERE provider_message_id = 'race-monotonic'
    `)).rows[0], {
      delivery_status: 'read', state_rank: 50,
      sent_at: '2026-10-01T10:01:00Z', delivered_at: '2026-10-01T10:02:00Z',
      read_at: '2026-10-01T10:03:00Z',
    });

    await pool.query(`
      UPDATE whatsapp_cloud_messages
         SET delivery_status = 'sent', state_rank = 30,
             sent_at = '2026-10-01T10:01:00Z', delivered_at = NULL, read_at = NULL,
             updated_at = '2026-10-01T10:01:00Z'
       WHERE provider_message_id = 'race-monotonic';
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES (1, 'status', 'race:sent-earlier', 'race-monotonic', '549351555050', 'sent',
              EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:00:30Z')::bigint::text,
              '{}'::jsonb, '2026-10-01T10:04:00Z')
    `);
    const delayedProjection = projectionSql.replace(
      /\r?\nCOMMIT;\r?\n-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION/,
      '\nSELECT pg_sleep(0.4);\nCOMMIT;\n-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION',
    );
    assert.notEqual(delayedProjection, projectionSql);
    const migratorFirst = await pool.connect();
    const writerSecond = await pool.connect();
    try {
      const migrationPromise = migratorFirst.query(delayedProjection);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [migratorFirst.processID],
      )).rows[0]?.wait_event === 'PgSleep', 'migration did not reach its post-update hold');
      const writerPromise = writerSecond.query(`
        UPDATE whatsapp_cloud_messages
           SET delivery_status = 'read', state_rank = 50,
               delivered_at = '2026-10-01T10:02:00Z', read_at = '2026-10-01T10:03:00Z',
               updated_at = '2026-10-01T10:03:00Z'
         WHERE provider_message_id = 'race-monotonic'
      `);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [writerSecond.processID],
      )).rows[0]?.wait_event_type === 'Lock', 'writer did not wait on the migration row lock');
      await migrationPromise;
      await writerPromise;
    } finally {
      migratorFirst.release();
      writerSecond.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT delivery_status, state_rank,
             to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
             to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at
        FROM whatsapp_cloud_messages WHERE provider_message_id = 'race-monotonic'
    `)).rows[0], {
      delivery_status: 'read', state_rank: 50,
      sent_at: '2026-10-01T10:00:30Z', delivered_at: '2026-10-01T10:02:00Z',
      read_at: '2026-10-01T10:03:00Z',
    });
  });
});

after(() => {
  assert.deepEqual([...createdDirectories].map(basename), [], 'all temporary PostgreSQL clusters must be removed');
  const residual = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(residual, [], 'no residual temporary PostgreSQL cluster directories');
});
