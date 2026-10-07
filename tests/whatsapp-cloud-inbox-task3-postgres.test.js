import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { listCloudConversations, markCloudConversationRead } from '../src/whatsappCloud/inboxRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available, 'Task 3 PostgreSQL gate requires local initdb/pg_ctl and non-root');
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const outboxStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const outboxEndMarker = '-- END WPP OUTBOX MIGRATION';
const projectionStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION');
const projectionEndMarker = '-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION';
const readsStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD CONVERSATION READS MIGRATION');
const readsEndMarker = '-- END WHATSAPP CLOUD CONVERSATION READS MIGRATION';
assert.ok(readsStart >= 0 && initSql.indexOf(readsEndMarker, readsStart) > readsStart, 'reads migration marker required');
const migrationSql = [
  initSql.slice(outboxStart, initSql.indexOf(outboxEndMarker, outboxStart) + outboxEndMarker.length),
  initSql.slice(projectionStart, initSql.indexOf(projectionEndMarker, projectionStart) + projectionEndMarker.length),
  initSql.slice(readsStart, initSql.indexOf(readsEndMarker, readsStart) + readsEndMarker.length),
].join('\n');
const readsSql = initSql.slice(readsStart, initSql.indexOf(readsEndMarker, readsStart) + readsEndMarker.length);
const tempPrefix = '.whatsapp-cloud-task3-pg-';
const created = new Set();

async function waitForAdvisoryWaiters(pool, minimum) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query("SELECT COUNT(*)::int count FROM pg_locks WHERE locktype='advisory' AND NOT granted");
    if (result.rows[0].count >= minimum) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`expected at least ${minimum} advisory lock waiters`);
}

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), tempPrefix));
  created.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let pool;
  let started = false;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'task3_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'task3_test', database: 'postgres', max: 8 });
    await pool.query('CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
    await pool.query(`CREATE TABLE usuarios (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL, empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE puntos_entrega (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      cliente TEXT, nombre TEXT, direccion TEXT, direccion_completa TEXT, ciudad TEXT,
      telefono TEXT, telefono_normalizado TEXT
    )`);
    await pool.query(`CREATE TABLE pedidos (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
      metodo_pago TEXT, fecha TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE whatsapp_cloud_events (
      id BIGSERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      event_kind TEXT NOT NULL, dedupe_key TEXT NOT NULL, message_id TEXT NOT NULL,
      sender_id TEXT, recipient_id TEXT, message_type TEXT, status TEXT, source_timestamp TEXT,
      event_data JSONB NOT NULL DEFAULT '{}'::jsonb, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (empresa_id, dedupe_key)
    )`);
    await pool.query(migrationSql);
    await work(pool);
  } finally {
    await pool?.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    created.delete(directory);
  }
}

after(() => {
  assert.deepEqual(readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix)), []);
  assert.equal(created.size, 0);
});

async function seed(pool) {
  await pool.query("INSERT INTO empresas(id) VALUES (1),(2); INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (11,'a','x','admin',1),(12,'b','x','admin',1),(21,'c','x','admin',2)");
  await pool.query(`
    INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
    VALUES
      (1,'message','one-a','one-a','5493515550001','text','{"text":{"body":"a"}}','2026-10-07T10:00:00Z'),
      (1,'message','one-b','one-b','5493515550001','text','{"text":{"body":"b"}}','2026-10-07T10:01:00Z')
  `);
  await pool.query(`INSERT INTO whatsapp_cloud_events
    (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
    VALUES (2,'message','two-a','two-a','5493515550001','text','{"text":{"body":"tenant two"}}','2026-10-07T10:02:00Z')`);
  return {
    one: (await pool.query("SELECT id::text FROM whatsapp_cloud_conversations WHERE empresa_id=1 AND participant_wa_id='5493515550001'")).rows[0].id,
    two: (await pool.query("SELECT id::text FROM whatsapp_cloud_conversations WHERE empresa_id=2 AND participant_wa_id='5493515550001'")).rows[0].id,
  };
}

test('migración de watermarks es idempotente y sus FKs compuestas bloquean cruces tenant', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const before = (await pool.query(`SELECT conname,oid::text,pg_get_constraintdef(oid,true) definition
      FROM pg_constraint WHERE conrelid='whatsapp_cloud_conversation_reads'::regclass ORDER BY conname`)).rows;
    await pool.query(readsSql);
    assert.deepEqual((await pool.query(`SELECT conname,oid::text,pg_get_constraintdef(oid,true) definition
      FROM pg_constraint WHERE conrelid='whatsapp_cloud_conversation_reads'::regclass ORDER BY conname`)).rows, before);
    await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_conversation_reads
      (empresa_id,conversation_id,usuario_id) VALUES (1,$1::uuid,11)`, [ids.two]), error => error?.code === '23503');
    await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_conversation_reads
      (empresa_id,conversation_id,usuario_id) VALUES (1,$1::uuid,999)`, [ids.one]), error => error?.code === '23503');
  });
});

test('migración de watermarks falla cerrada ante una FK canónica de nombre pero definición insegura', async () => {
  await withDatabase(async pool => {
    await pool.query(`
      ALTER TABLE whatsapp_cloud_conversation_reads
        DROP CONSTRAINT whatsapp_cloud_conversation_reads_conversation_fkey;
      ALTER TABLE whatsapp_cloud_conversation_reads
        ADD CONSTRAINT whatsapp_cloud_conversation_reads_conversation_fkey
        FOREIGN KEY (conversation_id) REFERENCES whatsapp_cloud_conversations(id) ON DELETE CASCADE
    `);
    await assert.rejects(pool.query(readsSql), error => (
      error?.code === 'P0001' && error?.message === 'whatsapp_cloud_conversation_reads_schema_unsafe'
    ));
    const definition = (await pool.query(`SELECT pg_get_constraintdef(oid,true) definition
      FROM pg_constraint
      WHERE conrelid='whatsapp_cloud_conversation_reads'::regclass
        AND conname='whatsapp_cloud_conversation_reads_conversation_fkey'`)).rows[0].definition;
    assert.equal(definition, 'FOREIGN KEY (conversation_id) REFERENCES whatsapp_cloud_conversations(id) ON DELETE CASCADE');
  });
});

test('watermarks son independientes por usuario y outbound/status no incrementa unread', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const query = async (sql, params, options) => (await pool.query(sql, params, options)).rows;
    await markCloudConversationRead({ pool, empresaId: 1, conversationId: ids.one, usuarioId: 11 });
    let user11 = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    let user12 = await listCloudConversations({ query, empresaId: 1, usuarioId: 12 });
    assert.equal(user11.conversations[0].unreadCount, 0);
    assert.equal(user12.conversations[0].unreadCount, 2);

    await pool.query(`INSERT INTO wpp_outbox
      (empresa_id,telefono,mensaje,status,transport_origin,created_at)
      VALUES (1,'5493515550001','outbound','pending','cloud','2026-10-07T10:03:00Z')`);
    user11 = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    user12 = await listCloudConversations({ query, empresaId: 1, usuarioId: 12 });
    assert.equal(user11.conversations[0].unreadCount, 0);
    assert.equal(user12.conversations[0].unreadCount, 2);
  });
});

test('mark-read antes de inbound deja el inbound concurrente no leído; inbound antes queda leído', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const query = async (sql, params) => (await pool.query(sql, params)).rows;

    const blockerOne = await pool.connect();
    await blockerOne.query('BEGIN');
    await blockerOne.query('SELECT whatsapp_cloud_messages_lock_projection(1)');
    const readFirst = markCloudConversationRead({ pool, empresaId: 1, conversationId: ids.one, usuarioId: 11 });
    await waitForAdvisoryWaiters(pool, 1);
    const inboundSecond = pool.query(`INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','after-read','after-read','5493515550001','text','{"text":{"body":"after"}}','2026-10-07T10:04:00Z')`);
    await waitForAdvisoryWaiters(pool, 2);
    await blockerOne.query('COMMIT');
    blockerOne.release();
    await Promise.all([readFirst, inboundSecond]);
    let listed = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    assert.equal(listed.conversations[0].unreadCount, 1);

    const blockerTwo = await pool.connect();
    await blockerTwo.query('BEGIN');
    await blockerTwo.query('SELECT whatsapp_cloud_messages_lock_projection(1)');
    const inboundFirst = pool.query(`INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','before-read','before-read','5493515550001','text','{"text":{"body":"before"}}','2026-10-07T10:05:00Z')`);
    await waitForAdvisoryWaiters(pool, 1);
    const readSecond = markCloudConversationRead({ pool, empresaId: 1, conversationId: ids.one, usuarioId: 11 });
    await waitForAdvisoryWaiters(pool, 2);
    await blockerTwo.query('COMMIT');
    blockerTwo.release();
    await Promise.all([inboundFirst, readSecond]);
    listed = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    assert.equal(listed.conversations[0].unreadCount, 0);
  });
});

test('listado aplica contadores pre-filtro y orden pending urgent/high/normal, review, inProcess, resolved', async () => {
  await withDatabase(async pool => {
    await pool.query("INSERT INTO empresas(id) VALUES (1); INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (11,'a','x','admin',1)");
    const participants = ['5493515550101','5493515550102','5493515550103','5493515550104','5493515550105','5493515550106'];
    for (let index = 0; index < participants.length; index += 1) {
      await pool.query(`INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
        VALUES (1,'message',$1,$2,$3,'text','{"text":{"body":"queue"}}',$4::timestamptz)`,
      [`q-${index}`, `q-${index}`, participants[index], `2026-10-07T0${index + 1}:00:00Z`]);
    }
    await pool.query(`UPDATE whatsapp_cloud_conversations SET priority='urgent' WHERE participant_wa_id=$1`, [participants[0]]);
    await pool.query(`UPDATE whatsapp_cloud_conversations SET priority='high' WHERE participant_wa_id=$1`, [participants[1]]);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,failed_at,created_at,updated_at)
      VALUES (1,'outbound',$1,'text','failed','failed',25,'2026-10-07T08:00:00Z','2026-10-07T08:00:00Z','2026-10-07T08:00:00Z','2026-10-07T08:00:00Z')`, [participants[3]]);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES (1,'outbound',$1,'text','queued','queued',10,'2026-10-07T09:00:00Z','2026-10-07T09:00:00Z','2026-10-07T09:00:00Z')`, [participants[4]]);
    await pool.query(`UPDATE whatsapp_cloud_conversations SET workflow_status='resolved' WHERE participant_wa_id=$1`, [participants[5]]);
    const query = async (sql, params) => (await pool.query(sql, params)).rows;
    const all = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    assert.deepEqual(all.conversations.map(item => item.participant), participants.map(value => `*********${value.slice(-4)}`));
    assert.deepEqual(all.counters, { total: 6, pending: 3, inProcess: 1, review: 1, resolved: 1 });
    const filtered = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, priority: 'urgent', unread: true });
    assert.equal(filtered.conversations.length, 1);
    assert.deepEqual(filtered.counters, all.counters);
  });
});

test('cursor pagina buckets no-pending sin depender de prioridad invisible en el ORDER BY', async () => {
  await withDatabase(async pool => {
    await pool.query("INSERT INTO empresas(id) VALUES (1); INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (11,'a','x','admin',1)");
    const olderUrgent = '5493515550201';
    const newerHigh = '5493515550202';
    for (const [index, participant] of [olderUrgent, newerHigh].entries()) {
      await pool.query(`INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
        VALUES (1,'message',$1,$2,$3,'text','{"text":{"body":"queue"}}',$4::timestamptz)`,
      [`cursor-in-${index}`, `cursor-in-${index}`, participant, `2026-10-07T0${index + 1}:00:00Z`]);
      await pool.query(`INSERT INTO whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,failed_at,created_at,updated_at)
        VALUES (1,'outbound',$1,'text','failed','failed',25,$2::timestamptz,$2::timestamptz,$2::timestamptz,$2::timestamptz)`,
      [participant, `2026-10-07T0${index + 3}:00:00Z`]);
    }
    await pool.query("UPDATE whatsapp_cloud_conversations SET priority='urgent' WHERE participant_wa_id=$1", [olderUrgent]);
    await pool.query("UPDATE whatsapp_cloud_conversations SET priority='high' WHERE participant_wa_id=$1", [newerHigh]);
    const query = async (sql, params) => (await pool.query(sql, params)).rows;

    const first = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, limit: 1 });
    assert.equal(first.conversations[0].participant, `*********${newerHigh.slice(-4)}`);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, limit: 1, cursor: first.nextCursor });
    assert.equal(second.conversations[0].participant, `*********${olderUrgent.slice(-4)}`);
    assert.equal(second.nextCursor, null);
  });
});
