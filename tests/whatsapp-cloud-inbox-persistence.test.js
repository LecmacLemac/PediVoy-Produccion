import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { withTransaction as dbWithTransaction } from '../src/db.js';
import { createWhatsAppCloudEventHandler } from '../src/whatsappCloud/eventRepository.js';
import {
  findCloudMessageProjectionByProviderMessageId,
  findCloudMessageProjectionBySourceEvent,
  reconcileCloudMessageProjectionStatus,
} from '../src/whatsappCloud/inboxRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL persistence gate requires local initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const outboxStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const outboxEndMarker = '-- END WPP OUTBOX MIGRATION';
const outboxEnd = initSql.indexOf(outboxEndMarker, outboxStart);
const inboxStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD INBOX MIGRATION');
const inboxEndMarker = '-- END WHATSAPP CLOUD INBOX MIGRATION';
const inboxEnd = initSql.indexOf(inboxEndMarker, inboxStart);
const projectionStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION');
const projectionEndMarker = '-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION';
const projectionEnd = initSql.indexOf(projectionEndMarker, projectionStart);
assert.ok(outboxStart >= 0 && outboxEnd > outboxStart);
assert.ok(inboxStart >= 0 && inboxEnd > inboxStart);
assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
const migrationSql = `${initSql.slice(outboxStart, outboxEnd + outboxEndMarker.length)}\n${initSql.slice(inboxStart, inboxEnd + inboxEndMarker.length)}\n${initSql.slice(projectionStart, projectionEnd + projectionEndMarker.length)}`;
const tempPrefix = '.whatsapp-cloud-inbox-persistence-pg-';
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
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_persistence_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_persistence_test', database: 'postgres', max: 4 });
    await pool.query("CREATE TABLE empresas (id INTEGER PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(migrationSql);
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
}

async function seedTenant(pool, { empresaId = 1, phoneNumberId = 'phone-one' } = {}) {
  await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES ($1, $2::jsonb)', [
    empresaId,
    JSON.stringify({ whatsapp: {
      provider: 'cloud', enabled: true, phone_number_id: phoneNumberId,
      access_token_encrypted: 'v1:test-only',
    } }),
  ]);
}

function handlerFor(pool, { afterInsert } = {}) {
  return createWhatsAppCloudEventHandler({
    withTransaction: work => dbWithTransaction(async (query, client) => {
      const result = await work(query, client);
      if (afterInsert) await afterInsert(query, client);
      return result;
    }, { pool, maxRetries: 0 }),
  });
}

function inbound({ id = 'wamid.in-1', type = 'text', from = '5493515550001', timestamp = '1760000000', phoneNumberId = 'phone-one' } = {}) {
  const normalizedType = type.trim();
  const media = normalizedType === 'image'
    ? { id: 'private-media-image', mime_type: 'image/jpeg', sha256: 'private-image-sha', caption: ' comprobante ' }
    : { id: 'private-media-document', mime_type: 'application/pdf', sha256: 'private-document-sha', caption: ' factura ', filename: ' factura.pdf ' };
  return {
    kind: 'message', entryId: 'entry-private', phoneNumberId,
    message: {
      id, from, timestamp, type,
      ...(normalizedType === 'text' ? { text: { body: '  hola mundo  ' } } : { [normalizedType]: media }),
      opaque_payload: 'private-payload',
    },
  };
}

after(() => {
  const leftovers = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(leftovers, [], `temporary PostgreSQL clusters leaked: ${leftovers.join(', ')}`);
  assert.equal(createdDirectories.size, 0);
});

test('eventRepository inserta inbound text y el trigger produce una sola proyección allowlisted en la misma conexión', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    const backendPids = new Set();
    const handler = handlerFor(pool, {
      afterInsert: async (query) => {
        const [{ pid }] = await query('SELECT pg_backend_pid() AS pid');
        backendPids.add(pid);
        const [{ total }] = await query("SELECT count(*)::int AS total FROM whatsapp_cloud_messages WHERE provider_message_id = 'wamid.in-1'");
        assert.equal(total, 1, 'projection must be visible before the event transaction commits');
      },
    });

    assert.deepEqual(await handler([inbound()]), { accepted: 1, duplicates: 0 });
    assert.equal(backendPids.size, 1);
    const source = (await pool.query("SELECT id FROM whatsapp_cloud_events WHERE message_id = 'wamid.in-1'")).rows[0];
    const dto = await findCloudMessageProjectionBySourceEvent({
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      empresaId: 1,
      sourceEventId: source.id,
    });
    assert.deepEqual(dto, {
      id: dto.id,
      direction: 'inbound',
      providerMessageId: 'wamid.in-1',
      messageType: 'text',
      textBody: '  hola mundo  ',
      mediaMimeType: null,
      mediaCaption: null,
      documentFilename: null,
      deliveryStatus: 'received',
      messageAt: dto.messageAt,
      createdAt: dto.createdAt,
      updatedAt: dto.updatedAt,
    });
    assert.match(String(dto.id), /^\d+$/);
    assert.ok(dto.messageAt instanceof Date);
    assert.ok(dto.createdAt instanceof Date);
    assert.ok(dto.updatedAt instanceof Date);
    const serialized = JSON.stringify(dto);
    assert.doesNotMatch(serialized, /5493515550001|phone-one|entry-private|private-payload|private-media|private-.*-sha/);
  });
});

test('inbound image/document produce exactamente una proyección allowlisted sin media id ni SHA', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    const handler = handlerFor(pool);
    assert.deepEqual(await handler([
      inbound({ id: ' wamid.image-1 ', type: ' image ' }),
      inbound({ id: ' wamid.document-1 ', type: ' document ' }),
    ]), { accepted: 2, duplicates: 0 });

    const rows = (await pool.query(`
      SELECT provider_message_id, message_type, text_body, media_mime_type,
             media_caption, document_filename
        FROM whatsapp_cloud_messages
       ORDER BY provider_message_id
    `)).rows;
    assert.deepEqual(rows, [
      {
        provider_message_id: 'wamid.document-1', message_type: 'document', text_body: null,
        media_mime_type: 'application/pdf', media_caption: ' factura ', document_filename: ' factura.pdf ',
      },
      {
        provider_message_id: 'wamid.image-1', message_type: 'image', text_body: null,
        media_mime_type: 'image/jpeg', media_caption: ' comprobante ', document_filename: null,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(rows), /private-media|private-.*-sha|5493515550001|phone-one/);
  });
});

test('rollback posterior al INSERT revierte juntos evento y proyección y devuelve error loggable sanitizado', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    const handler = handlerFor(pool, {
      afterInsert: async () => {
        throw new Error('private SQL payload phone-one 5493515550001 private-media-image');
      },
    });
    await assert.rejects(handler([inbound({ id: 'wamid.rollback' })]), error => {
      assert.equal(error.code, 'processing_failed');
      assert.equal(error.message, 'WhatsApp Cloud event rejected');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /private|phone-one|5493515550001|media/i);
      return true;
    });
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM whatsapp_cloud_events) AS events,
      (SELECT count(*)::int FROM whatsapp_cloud_messages) AS projections
    `)).rows[0], { events: 0, projections: 0 });
  });
});

test('replay del mismo evento es idempotente y conserva una sola proyección', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    const handler = handlerFor(pool);
    assert.deepEqual(await handler([inbound({ id: ' wamid.duplicate ' })]), { accepted: 1, duplicates: 0 });
    assert.deepEqual(await handler([inbound({ id: 'wamid.duplicate' })]), { accepted: 0, duplicates: 1 });
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM whatsapp_cloud_events) AS events,
      (SELECT count(*)::int FROM whatsapp_cloud_messages) AS projections
    `)).rows[0], { events: 1, projections: 1 });
  });
});

async function seedOutbound(pool, {
  empresaId = 1,
  participant = '5493515550001',
  providerMessageId = 'wamid.out-1',
  status = 'sent',
} = {}) {
  const sent = status === 'sent';
  await pool.query(`
    INSERT INTO wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state,
       meta_message_id, created_at, sent_at)
    VALUES ($1, $2, 'respuesta segura', $4, 'cloud', $5, $3,
            '2026-10-06T10:00:00Z', $6)
  `, [
    empresaId, participant, providerMessageId, status,
    sent ? 'sent' : null,
    sent ? '2026-10-06T10:00:01Z' : null,
  ]);
}

function statusEvent(status, timestamp, {
  phoneNumberId = 'phone-one',
  id = 'wamid.out-1',
  recipientId = ' 5493515550001 ',
} = {}) {
  return {
    kind: 'status', entryId: 'private-status-entry', phoneNumberId,
    status: {
      id: ` ${id} `, status: ` ${status} `, timestamp: ` ${timestamp} `,
      recipient_id: recipientId,
      conversation: { id: 'private-conversation' },
      pricing: { category: 'utility' },
      errors: [{ title: 'private provider failure' }],
    },
  };
}

for (const [status, timestamp, rank] of [
  ['sent', '1760000010', 30],
  ['delivered', '1760000020', 40],
  ['read', '1760000030', 50],
  ['failed', '1760000040', 25],
]) {
  test(`status ${status} correlaciona por tenant/provider y actualiza proyección sin DTO privado`, async () => {
    await withDatabase(async pool => {
      await seedTenant(pool);
      await seedOutbound(pool, { status: status === 'failed' ? 'pending' : 'sent' });
      const handler = handlerFor(pool);
      assert.deepEqual(await handler([statusEvent(status, timestamp)]), { accepted: 1, duplicates: 0 });
      const dto = await findCloudMessageProjectionByProviderMessageId({
        query: async (sql, params) => (await pool.query(sql, params)).rows,
        empresaId: 1,
        providerMessageId: ' wamid.out-1 ',
      });
      assert.equal(dto.deliveryStatus, status);
      assert.equal((await pool.query(`SELECT state_rank FROM whatsapp_cloud_messages
        WHERE empresa_id=1 AND provider_message_id='wamid.out-1'`)).rows[0].state_rank, rank);
      assert.doesNotMatch(JSON.stringify(dto),
        /5493515550001|phone-one|private-status-entry|private-conversation|provider failure|utility/);
      const statusRow = (await pool.query(`SELECT message_id,status,source_timestamp,recipient_id,event_data
        FROM whatsapp_cloud_events WHERE event_kind='status'`)).rows[0];
      assert.deepEqual(statusRow, {
        message_id: 'wamid.out-1', status, source_timestamp: timestamp,
        recipient_id: '5493515550001',
        event_data: { conversationId: 'private-conversation', pricingCategory: 'utility' },
      });
    });
  });
}

test('status duplicado, fuera de orden y desconocido no degrada el estado monotónico', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    await seedOutbound(pool);
    const handler = handlerFor(pool);
    assert.deepEqual(await handler([
      statusEvent('read', '1760000030'),
      statusEvent('read', '1760000030'),
      statusEvent('delivered', '1760000020'),
      statusEvent('future_status', '1760000040'),
      statusEvent('failed', '1760000050'),
    ]), { accepted: 4, duplicates: 1 });
    const row = (await pool.query(`
      SELECT delivery_status, state_rank, sent_at IS NOT NULL AS sent,
             delivered_at IS NOT NULL AS delivered, read_at IS NOT NULL AS read,
             failed_at
        FROM whatsapp_cloud_messages
       WHERE empresa_id=1 AND provider_message_id='wamid.out-1'
    `)).rows[0];
    assert.deepEqual(row, {
      delivery_status: 'read', state_rank: 50, sent: true, delivered: true, read: true, failed_at: null,
    });
    assert.equal((await pool.query("SELECT count(*)::int AS total FROM whatsapp_cloud_events WHERE status='future_status'" )).rows[0].total, 1);
  });
});

test('provider_message_id idéntico correlaciona sólo dentro del tenant resuelto', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool, { empresaId: 1, phoneNumberId: 'phone-one' });
    await seedTenant(pool, { empresaId: 2, phoneNumberId: 'phone-two' });
    await seedOutbound(pool, { empresaId: 1, participant: '5493515550001', providerMessageId: 'wamid.shared' });
    await seedOutbound(pool, { empresaId: 2, participant: '5493515550002', providerMessageId: 'wamid.shared' });
    const handler = handlerFor(pool);
    await handler([statusEvent('read', '1760000030', {
      phoneNumberId: ' phone-two ', id: 'wamid.shared', recipientId: ' 5493515550002 ',
    })]);
    assert.deepEqual((await pool.query(`
      SELECT empresa_id, delivery_status FROM whatsapp_cloud_messages
       WHERE provider_message_id='wamid.shared' ORDER BY empresa_id
    `)).rows, [
      { empresa_id: 1, delivery_status: 'sent' },
      { empresa_id: 2, delivery_status: 'read' },
    ]);
  });
});

test('helper de reconciliación invoca la función canónica y falla cerrado sin filtrar argumentos', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    await seedOutbound(pool);
    await pool.query(`INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,recipient_id,status,source_timestamp,event_data,phone_number_id)
      VALUES (1,'status','manual-reconcile','wamid.out-1','5493515550001','delivered','1760000020','{}','phone-one')`);
    await pool.query("UPDATE whatsapp_cloud_messages SET delivery_status='sent',state_rank=30,delivered_at=NULL WHERE empresa_id=1");
    const result = await reconcileCloudMessageProjectionStatus({
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      empresaId: 1,
      providerMessageId: ' wamid.out-1 ',
    });
    assert.deepEqual(result, { result: 'reconciled' });
    assert.equal((await pool.query('SELECT delivery_status FROM whatsapp_cloud_messages WHERE empresa_id=1')).rows[0].delivery_status, 'delivered');

    assert.deepEqual(await reconcileCloudMessageProjectionStatus({
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      empresaId: '1',
      providerMessageId: 'wamid.out-1',
    }), { result: 'unchanged' });
    assert.deepEqual(await reconcileCloudMessageProjectionStatus({
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      empresaId: 1,
      providerMessageId: 'wamid.missing',
    }), { result: 'not_found' });

    await assert.rejects(reconcileCloudMessageProjectionStatus({
      query: async () => { throw new Error('private phone 5493515550001 wamid.out-1'); },
      empresaId: 1,
      providerMessageId: 'wamid.out-1',
    }), error => {
      assert.equal(error.code, 'CLOUD_INBOX_RECONCILE_FAILED');
      assert.equal(error.message, 'WhatsApp Cloud projection reconciliation failed');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /5493515550001|wamid\.out-1|private/);
      return true;
    });
  });
});

test('empresaId acepta sólo int4 positivo o decimal canónico', async () => {
  const accepted = [];
  const query = async (_sql, params) => { accepted.push(params[0]); return []; };
  for (const value of [1, 2147483647, '1', '2147483647']) {
    assert.equal(await findCloudMessageProjectionByProviderMessageId({
      query, empresaId: value, providerMessageId: 'wamid.valid',
    }), null);
  }
  assert.deepEqual(accepted, [1, 2147483647, 1, 2147483647]);

  for (const value of [
    true, false, null, undefined, {}, [], 0, -1, 1.5, 2147483648,
    '', ' 1', '1 ', '+1', '-1', '01', '0', '1.0', '1e3', '2147483648',
  ]) {
    await assert.rejects(findCloudMessageProjectionByProviderMessageId({
      query: async () => assert.fail('invalid empresaId must fail before query'),
      empresaId: value,
      providerMessageId: 'wamid.invalid',
    }), error => error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT');
  }
});

test('lookup por provider limita a dos, no usa recencia y falla cerrado ante cardinalidad múltiple', async () => {
  let capturedSql = '';
  await assert.rejects(findCloudMessageProjectionByProviderMessageId({
    query: async sql => {
      capturedSql = sql;
      return [{ id: 1 }, { id: 2 }];
    },
    empresaId: 1,
    providerMessageId: 'wamid.ambiguous',
  }), error => error?.code === 'CLOUD_INBOX_LOOKUP_FAILED'
    && error?.message === 'WhatsApp Cloud projection lookup failed'
    && error?.cause === undefined);
  assert.match(capturedSql, /LIMIT 2/i);
  assert.doesNotMatch(capturedSql, /ORDER BY/i);
});

test('segundo attachment del mismo provider outbound falla atómico', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    await seedOutbound(pool, { providerMessageId: 'wamid.unique-provider' });
    const before = (await pool.query('SELECT count(*)::int AS total FROM wpp_outbox')).rows[0].total;
    await assert.rejects(seedOutbound(pool, {
      participant: '5493515550002', providerMessageId: 'wamid.unique-provider',
    }), error => error?.code === '23505');
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM wpp_outbox) AS outbox,
      (SELECT count(*)::int FROM whatsapp_cloud_messages
        WHERE empresa_id=1 AND direction='outbound' AND provider_message_id='wamid.unique-provider') AS projections
    `)).rows[0], { outbox: before, projections: 1 });
  });
});

test('status ante identidad outbound ambigua falla atómico y nunca actualiza ambas filas', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    await pool.query('DROP INDEX whatsapp_cloud_messages_provider_message_idx');
    await seedOutbound(pool, { providerMessageId: 'wamid.ambiguous-status' });
    await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,provider_message_id,message_type,text_body,
         delivery_status,state_rank,message_at,sent_at,created_at,updated_at)
      VALUES (1,'outbound','5493515550002','wamid.ambiguous-status','text','segunda',
              'sent',30,'2026-10-06T10:00:00Z','2026-10-06T10:00:01Z',
              '2026-10-06T10:00:00Z','2026-10-06T10:00:01Z')
    `);
    const handler = handlerFor(pool);
    await assert.rejects(handler([statusEvent('read', '1760000030', {
      id: 'wamid.ambiguous-status',
    })]), error => error?.code === 'processing_failed'
      && error?.message === 'WhatsApp Cloud event rejected'
      && error?.cause === undefined);
    assert.deepEqual((await pool.query(`
      SELECT delivery_status FROM whatsapp_cloud_messages
       WHERE empresa_id=1 AND direction='outbound' AND provider_message_id='wamid.ambiguous-status'
       ORDER BY id
    `)).rows, [{ delivery_status: 'sent' }, { delivery_status: 'sent' }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS total FROM whatsapp_cloud_events
      WHERE message_id='wamid.ambiguous-status'`)).rows[0].total, 0);
  });
});

test('helpers de lookup convierten fallos privados en errores loggables allowlisted', async () => {
  for (const lookup of [
    () => findCloudMessageProjectionBySourceEvent({
      query: async () => { throw new Error('private event 91 phone 5493515550001'); },
      empresaId: 1,
      sourceEventId: 91,
    }),
    () => findCloudMessageProjectionByProviderMessageId({
      query: async () => { throw new Error('private provider wamid.secret phone 5493515550001'); },
      empresaId: 1,
      providerMessageId: 'wamid.secret',
    }),
  ]) {
    await assert.rejects(lookup(), error => {
      assert.equal(error.code, 'CLOUD_INBOX_LOOKUP_FAILED');
      assert.equal(error.message, 'WhatsApp Cloud projection lookup failed');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /private|5493515550001|wamid\.secret|91/);
      return true;
    });
  }
});

test('lookup por provider_message_id selecciona la proyección outbound aun si existe inbound más reciente', async () => {
  await withDatabase(async pool => {
    await seedTenant(pool);
    await seedOutbound(pool, { providerMessageId: 'wamid.same-direction' });
    const handler = handlerFor(pool);
    await handler([inbound({ id: 'wamid.same-direction' })]);
    const dto = await findCloudMessageProjectionByProviderMessageId({
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      empresaId: 1,
      providerMessageId: 'wamid.same-direction',
    });
    assert.equal(dto.direction, 'outbound');
    assert.equal(dto.textBody, 'respuesta segura');
  });
});
