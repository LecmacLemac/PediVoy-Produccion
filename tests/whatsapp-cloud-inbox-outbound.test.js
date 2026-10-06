import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { withTransaction as dbWithTransaction } from '../src/db.js';
import {
  enqueueWppOutbox,
  enqueueWppOutboxCorrelatedReply,
  enqueueWppOutboxInTransaction,
} from '../src/wpp/enqueue.js';
import { createWhatsAppCloudEventHandler } from '../src/whatsappCloud/eventRepository.js';
import {
  claimNextCloudOutboxRow,
  finishCloudOutboxRow,
  markCloudDispatchStarted,
} from '../src/whatsappCloud/outboxRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL outbound gate requires local initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');

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
const tempPrefix = '.whatsapp-cloud-inbox-outbound-pg-';
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
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_outbound_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_outbound_test', database: 'postgres', max: 4 });
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

async function seedCloudTenant(pool, empresaId = 1) {
  await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES ($1, $2::jsonb)', [
    empresaId,
    JSON.stringify({ whatsapp: {
      provider: 'cloud', enabled: true, phone_number_id: `phone-${empresaId}`,
      access_token_encrypted: 'v1:test-only',
    } }),
  ]);
}

const rowsQuery = pool => async (sql, params = [], options = {}) => (await pool.query({ text: sql, values: params, ...options })).rows;

function eventHandlerFor(pool) {
  return createWhatsAppCloudEventHandler({
    withTransaction: work => dbWithTransaction(work, { pool, maxRetries: 0 }),
  });
}

function statusEvent({ phoneNumberId, messageId, status, timestamp }) {
  return {
    kind: 'status',
    entryId: 'private-entry',
    phoneNumberId,
    status: {
      id: messageId,
      status,
      timestamp,
      recipient_id: '5493515550001',
      conversation: { id: 'private-conversation' },
      pricing: { category: 'utility' },
      errors: [{ title: 'private-provider-error' }],
    },
  };
}

async function enqueueCloud(pool, message) {
  return enqueueWppOutbox({
    empresaId: 1,
    phone: '5493515550001',
    message,
  }, pool);
}

after(() => {
  const leftovers = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(leftovers, [], `temporary PostgreSQL clusters leaked: ${leftovers.join(', ')}`);
  assert.equal(createdDirectories.size, 0);
});

test('identidad provider duplicada falla cerrada, atómica y con error sanitizado', async () => {
  await withDatabase(async pool => {
    await seedCloudTenant(pool);
    await enqueueCloud(pool, 'primero');
    await enqueueCloud(pool, 'segundo');
    const query = rowsQuery(pool);

    const first = await claimNextCloudOutboxRow({ query, owner: 'worker-one' });
    await markCloudDispatchStarted({ query, id: first.id, owner: 'worker-one' });
    await finishCloudOutboxRow({
      query, id: first.id, owner: 'worker-one', status: 'sent',
      dispatchState: 'sent', messageId: 'wamid.private-duplicate',
    });

    const second = await claimNextCloudOutboxRow({ query, owner: 'worker-two' });
    await markCloudDispatchStarted({ query, id: second.id, owner: 'worker-two' });
    await assert.rejects(
      finishCloudOutboxRow({
        query, id: second.id, owner: 'worker-two', status: 'sent',
        dispatchState: 'sent', messageId: 'wamid.private-duplicate',
      }),
      error => {
        assert.equal(error.code, 'CLOUD_OUTBOX_PROVIDER_IDENTITY_CONFLICT');
        assert.equal(Object.hasOwn(error, 'cause'), false);
        assert.doesNotMatch([
          error.message,
          error.stack,
          JSON.stringify(error),
          JSON.stringify(Object.getOwnPropertyDescriptors(error)),
        ].join('\n'), /wamid\.private-duplicate|5493515550001|segundo/);
        return true;
      },
    );

    const rows = (await pool.query(`
      SELECT o.mensaje, o.status, o.cloud_dispatch_state, o.meta_message_id,
             m.delivery_status, m.provider_message_id
        FROM wpp_outbox o
        JOIN whatsapp_cloud_messages m ON m.empresa_id=o.empresa_id AND m.source_outbox_id=o.id
       ORDER BY o.id
    `)).rows;
    assert.deepEqual(rows, [
      {
        mensaje: 'primero', status: 'sent', cloud_dispatch_state: 'sent',
        meta_message_id: 'wamid.private-duplicate', delivery_status: 'sent',
        provider_message_id: 'wamid.private-duplicate',
      },
      {
        mensaje: 'segundo', status: 'sending', cloud_dispatch_state: 'dispatch_started',
        meta_message_id: null, delivery_status: 'sending', provider_message_id: null,
      },
    ]);
  });
});

test('enqueue Cloud y su proyección comparten la transacción externa y el rollback', async () => {
  await withDatabase(async pool => {
    await seedCloudTenant(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rolledBack = await enqueueWppOutboxInTransaction({
        empresaId: 1,
        phone: '5493515550001',
        message: 'respuesta rollback',
      }, { client, transactionOwner: 'caller' });
      assert.equal(rolledBack.transportOrigin, 'cloud');
      assert.deepEqual((await client.query(`SELECT
        (SELECT count(*)::int FROM wpp_outbox) AS outbox,
        (SELECT count(*)::int FROM whatsapp_cloud_messages) AS projections
      `)).rows[0], { outbox: 1, projections: 1 });
      await client.query('ROLLBACK');

      assert.deepEqual((await pool.query(`SELECT
        (SELECT count(*)::int FROM wpp_outbox) AS outbox,
        (SELECT count(*)::int FROM whatsapp_cloud_messages) AS projections
      `)).rows[0], { outbox: 0, projections: 0 });

      await client.query('BEGIN');
      const committed = await enqueueWppOutboxInTransaction({
        empresaId: 1,
        phone: '5493515550001',
        message: 'respuesta commit',
      }, { client, transactionOwner: 'caller' });
      assert.equal(committed.transportOrigin, 'cloud');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const durable = (await pool.query(`
      SELECT o.id, o.transport_origin, o.status, m.outbox_id::integer AS outbox_id,
             m.source_outbox_id::integer AS source_outbox_id,
             m.direction, m.delivery_status, m.text_body
        FROM wpp_outbox o
        JOIN whatsapp_cloud_messages m ON m.empresa_id=o.empresa_id AND m.source_outbox_id=o.id
    `)).rows;
    assert.equal(durable.length, 1);
    assert.deepEqual(durable[0], {
      id: durable[0].id,
      transport_origin: 'cloud',
      status: 'pending',
      outbox_id: durable[0].id,
      source_outbox_id: durable[0].id,
      direction: 'outbound',
      delivery_status: 'queued',
      text_body: 'respuesta commit',
    });
  });
});

test('replay correlacionado deduplica y configuraciones no Cloud no crean proyección', async () => {
  await withDatabase(async pool => {
    await seedCloudTenant(pool, 1);
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (2, $1::jsonb), (3, $2::jsonb)', [
      JSON.stringify({}),
      JSON.stringify({ whatsapp: {
        provider: 'cloud', enabled: false, phone_number_id: 'phone-disabled',
        access_token_encrypted: 'v1:test-only',
      } }),
    ]);

    const first = await enqueueWppOutboxCorrelatedReply({
      empresaId: 1,
      phone: '5493515550001',
      message: 'respuesta correlacionada',
      transportOrigin: 'cloud',
      correlationId: 'request-1',
    }, pool);
    const replay = await enqueueWppOutboxCorrelatedReply({
      empresaId: 1,
      phone: '5493515550001',
      message: 'payload replay distinto',
      transportOrigin: 'cloud',
      correlationId: 'request-1',
    }, pool);
    assert.equal(first.queued, true);
    assert.deepEqual(replay, {
      queued: false,
      skipped: true,
      reason: 'duplicate_correlation',
      id: first.id,
      status: 'pending',
      transportOrigin: 'cloud',
    });

    for (const empresaId of [2, 3]) {
      const result = await enqueueWppOutbox({
        empresaId,
        phone: '5493515550001',
        message: `web sin proyección ${empresaId}`,
      }, pool);
      assert.equal(result.transportOrigin, 'company');
    }

    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM wpp_outbox WHERE empresa_id=1) AS cloud_outbox,
      (SELECT count(*)::int FROM whatsapp_cloud_messages WHERE empresa_id=1) AS cloud_projection,
      (SELECT count(*)::int FROM wpp_outbox WHERE empresa_id IN (2,3) AND transport_origin='company') AS web_outbox,
      (SELECT count(*)::int FROM whatsapp_cloud_messages WHERE empresa_id IN (2,3)) AS web_projection
    `)).rows[0], {
      cloud_outbox: 1, cloud_projection: 1, web_outbox: 2, web_projection: 0,
    });
  });
});

test('COMMIT ambiguo no reclama resultado determinista, no revierte, reintenta ni hace fallback', async () => {
  await withDatabase(async pool => {
    await seedCloudTenant(pool);
    const calls = [];
    const transactionPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(input, params) {
            const text = typeof input === 'string' ? input : input.text;
            calls.push(text);
            if (text === 'COMMIT') {
              await client.query(input, params);
              throw new Error('private socket outcome after commit 5493515550001');
            }
            return client.query(input, params);
          },
          release(error) { client.release(error); },
        };
      },
    };

    await assert.rejects(
      enqueueWppOutbox({
        empresaId: 1,
        phone: '5493515550001',
        message: 'resultado commit ambiguo privado',
      }, transactionPool),
      error => {
        assert.equal(error.code, 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN');
        assert.equal(Object.hasOwn(error, 'cause'), false);
        assert.doesNotMatch([
          error.message, error.stack, JSON.stringify(error),
          JSON.stringify(Object.getOwnPropertyDescriptors(error)),
        ].join('\n'), /5493515550001|resultado commit ambiguo privado|socket/);
        return true;
      },
    );

    assert.equal(calls.filter(text => text === 'COMMIT').length, 1);
    assert.equal(calls.filter(text => text === 'ROLLBACK').length, 0);
    assert.equal(calls.filter(text => /INSERT INTO wpp_outbox/i.test(text)).length, 1);
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM wpp_outbox) AS outbox,
      (SELECT count(*)::int FROM wpp_outbox WHERE transport_origin='cloud') AS cloud,
      (SELECT count(*)::int FROM wpp_outbox WHERE transport_origin IN ('company','general')) AS fallback,
      (SELECT count(*)::int FROM whatsapp_cloud_messages) AS projections
    `)).rows[0], { outbox: 1, cloud: 1, fallback: 0, projections: 1 });
  });
});

test('worker adjunta provider id al mismo outbound tenant-scoped y delivered/read convergen', async () => {
  await withDatabase(async pool => {
    await seedCloudTenant(pool, 1);
    await seedCloudTenant(pool, 2);
    const query = rowsQuery(pool);

    const firstEnqueue = await enqueueCloud(pool, 'tenant uno');
    const secondEnqueue = await enqueueWppOutbox({
      empresaId: 2,
      phone: '5493515550002',
      message: 'tenant dos',
    }, pool);

    for (const [owner, expectedId] of [['worker-1', firstEnqueue.id], ['worker-2', secondEnqueue.id]]) {
      const row = await claimNextCloudOutboxRow({ query, owner });
      assert.equal(row.id, expectedId);
      await markCloudDispatchStarted({ query, id: row.id, owner });
      await finishCloudOutboxRow({
        query, id: row.id, owner, status: 'sent', dispatchState: 'sent',
        messageId: 'wamid.shared-provider',
      });
    }

    const beforeStatuses = (await pool.query(`
      SELECT empresa_id, source_outbox_id::integer AS source_outbox_id,
             provider_message_id, delivery_status
        FROM whatsapp_cloud_messages
       ORDER BY empresa_id
    `)).rows;
    assert.deepEqual(beforeStatuses, [
      { empresa_id: 1, source_outbox_id: firstEnqueue.id, provider_message_id: 'wamid.shared-provider', delivery_status: 'sent' },
      { empresa_id: 2, source_outbox_id: secondEnqueue.id, provider_message_id: 'wamid.shared-provider', delivery_status: 'sent' },
    ]);

    const handler = eventHandlerFor(pool);
    assert.deepEqual(await handler([
      statusEvent({ phoneNumberId: 'phone-1', messageId: 'wamid.shared-provider', status: 'delivered', timestamp: '1760000020' }),
      statusEvent({ phoneNumberId: 'phone-1', messageId: 'wamid.shared-provider', status: 'read', timestamp: '1760000030' }),
    ]), { accepted: 2, duplicates: 0 });

    assert.deepEqual((await pool.query(`
      SELECT empresa_id, delivery_status, state_rank,
             delivered_at IS NOT NULL AS delivered, read_at IS NOT NULL AS read
        FROM whatsapp_cloud_messages
       ORDER BY empresa_id
    `)).rows, [
      { empresa_id: 1, delivery_status: 'read', state_rank: 50, delivered: true, read: true },
      { empresa_id: 2, delivery_status: 'sent', state_rank: 30, delivered: false, read: false },
    ]);
  });
});
