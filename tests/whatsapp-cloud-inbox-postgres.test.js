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
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_inbox_test', '--no-locale'], { stdio: 'pipe' });
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
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
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
        id BIGINT NOT NULL PRIMARY KEY,
        empresa_id INTEGER,
        direction TEXT,
        participant_wa_id TEXT,
        message_at TIMESTAMPTZ
      )
    `);

    await pool.query(projectionSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (id, empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES
        (9001, 1, 'outbound', '549351555011', 'text', 'legacy explícito',
         'queued', 10, '2026-10-01T16:00:00Z')
    `);

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
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM whatsapp_cloud_messages')).rows[0].total, 2);
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

after(() => {
  assert.deepEqual([...createdDirectories].map(basename), [], 'all temporary PostgreSQL clusters must be removed');
  const residual = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(residual, [], 'no residual temporary PostgreSQL cluster directories');
});
