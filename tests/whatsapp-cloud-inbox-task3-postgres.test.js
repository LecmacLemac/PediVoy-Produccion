import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import {
  listCloudConversations,
  markCloudConversationRead,
  updateCloudConversationState,
} from '../src/whatsappCloud/inboxRepository.js';

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
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k '' -c allow_system_table_mods=on`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'task3_test', database: 'postgres', max: 8 });
    await pool.query('CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
    await pool.query(`CREATE TABLE usuarios (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL, empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
      activo BOOLEAN NOT NULL DEFAULT TRUE
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
    await pool.query(`INSERT INTO whatsapp_cloud_conversation_reads
      (empresa_id,conversation_id,usuario_id,last_read_message_id) VALUES (1,$1::uuid,11,1)`, [ids.one]);
    const before = (await pool.query(`SELECT conname,oid::text,pg_get_constraintdef(oid,true) definition
      FROM pg_constraint WHERE conrelid='whatsapp_cloud_conversation_reads'::regclass ORDER BY conname`)).rows;
    const beforeIndexes = (await pool.query(`SELECT indexrelid::text oid, xmin::text xmin, indexrelid::regclass::text name, pg_get_indexdef(indexrelid) definition
      FROM pg_index WHERE indrelid='whatsapp_cloud_conversation_reads'::regclass ORDER BY name`)).rows;
    const beforeRow = (await pool.query(`SELECT xmin::text xmin, updated_at FROM whatsapp_cloud_conversation_reads
      WHERE empresa_id=1 AND conversation_id=$1 AND usuario_id=11`, [ids.one])).rows[0];
    await pool.query(readsSql);
    assert.deepEqual((await pool.query(`SELECT conname,oid::text,pg_get_constraintdef(oid,true) definition
      FROM pg_constraint WHERE conrelid='whatsapp_cloud_conversation_reads'::regclass ORDER BY conname`)).rows, before);
    assert.deepEqual((await pool.query(`SELECT indexrelid::text oid, xmin::text xmin, indexrelid::regclass::text name, pg_get_indexdef(indexrelid) definition
      FROM pg_index WHERE indrelid='whatsapp_cloud_conversation_reads'::regclass ORDER BY name`)).rows, beforeIndexes);
    assert.deepEqual((await pool.query(`SELECT xmin::text xmin, updated_at FROM whatsapp_cloud_conversation_reads
      WHERE empresa_id=1 AND conversation_id=$1 AND usuario_id=11`, [ids.one])).rows[0], beforeRow);
    await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_conversation_reads
      (empresa_id,conversation_id,usuario_id) VALUES (1,$1::uuid,11)`, [ids.two]), error => error?.code === '23503');
    await assert.rejects(pool.query(`INSERT INTO whatsapp_cloud_conversation_reads
      (empresa_id,conversation_id,usuario_id) VALUES (1,$1::uuid,999)`, [ids.one]), error => error?.code === '23503');
  });
});

test('migración rechaza índice homónimo alien y tipos incompatibles antes de mutar', async () => {
  await withDatabase(async pool => {
    await pool.query('DROP INDEX idx_whatsapp_cloud_conversation_reads_user');
    await pool.query('CREATE INDEX idx_whatsapp_cloud_conversation_reads_user ON whatsapp_cloud_conversation_reads(usuario_id)');
    const before = (await pool.query(`SELECT c.oid::text oid, pg_get_indexdef(c.oid) definition
      FROM pg_class c WHERE c.oid='idx_whatsapp_cloud_conversation_reads_user'::regclass`)).rows[0];
    await assert.rejects(pool.query(readsSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_conversation_reads_schema_unsafe');
    assert.deepEqual((await pool.query(`SELECT c.oid::text oid, pg_get_indexdef(c.oid) definition
      FROM pg_class c WHERE c.oid='idx_whatsapp_cloud_conversation_reads_user'::regclass`)).rows[0], before);
  });
  await withDatabase(async pool => {
    await pool.query('ALTER TABLE whatsapp_cloud_conversation_reads ALTER COLUMN last_read_message_id TYPE numeric');
    const before = (await pool.query(`SELECT atttypid::regtype::text type FROM pg_attribute
      WHERE attrelid='whatsapp_cloud_conversation_reads'::regclass AND attname='last_read_message_id'`)).rows[0];
    await assert.rejects(pool.query(readsSql), error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_conversation_reads_schema_unsafe');
    assert.deepEqual((await pool.query(`SELECT atttypid::regtype::text type FROM pg_attribute
      WHERE attrelid='whatsapp_cloud_conversation_reads'::regclass AND attname='last_read_message_id'`)).rows[0], before);
  });
});

test('migración falla cerrada ante índice exacto inválido/no-ready/dead antes de mutar', async () => {
  for (const flag of ['indisvalid', 'indisready', 'indislive']) {
    await withDatabase(async pool => {
      const indexName = 'idx_whatsapp_cloud_messages_inbound_unread';
      const beforeTable = (await pool.query("SELECT xmin::text xmin FROM pg_class WHERE oid='whatsapp_cloud_messages'::regclass")).rows[0];
      await pool.query(`UPDATE pg_catalog.pg_index SET ${flag}=false WHERE indexrelid=$1::regclass`, [indexName]);
      await assert.rejects(pool.query(readsSql), error => (
        error?.code === 'P0001' && error?.message === 'whatsapp_cloud_conversation_reads_schema_unsafe'
      ));
      assert.deepEqual(
        (await pool.query("SELECT xmin::text xmin FROM pg_class WHERE oid='whatsapp_cloud_messages'::regclass")).rows[0],
        beforeTable,
      );
      assert.equal((await pool.query(`SELECT ${flag} value FROM pg_catalog.pg_index WHERE indexrelid=$1::regclass`, [indexName])).rows[0].value, false);
    });
  }
});

test('migración instala índices exactos de reads y unread inbound', async () => {
  await withDatabase(async pool => {
    const definitions = (await pool.query(`SELECT indexrelid::regclass::text name, pg_get_indexdef(indexrelid) definition
      FROM pg_index WHERE indexrelid IN (
        'idx_whatsapp_cloud_conversation_reads_user'::regclass,
        'idx_whatsapp_cloud_messages_inbound_unread'::regclass
      ) ORDER BY name`)).rows;
    assert.equal(definitions.length, 2);
    const sql = definitions.map(row => row.definition).join('\n');
    assert.match(sql, /whatsapp_cloud_messages.*\(empresa_id, participant_wa_id, id\).*WHERE \(direction = 'inbound'::text\)/);
    assert.match(sql, /whatsapp_cloud_conversation_reads.*\(empresa_id, usuario_id, conversation_id, last_read_message_id\)/);
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
    const query = async (sql, params) => (await pool.query(sql, params)).rows;
    const renderedId = (await pool.query("SELECT max(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND participant_wa_id='5493515550001' AND direction='inbound'")).rows[0].id;
    await markCloudConversationRead({ pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: renderedId });
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

test('inbound insertado después del GET history permanece unread al confirmar sólo el máximo renderizado', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const query = async (sql, params) => (await pool.query(sql, params)).rows;
    const renderedId = (await pool.query("SELECT max(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND participant_wa_id='5493515550001' AND direction='inbound'")).rows[0].id;
    await pool.query(`INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','after-history','after-history','5493515550001','text','{"text":{"body":"after"}}','2026-10-07T10:04:00Z')`);
    await markCloudConversationRead({
      pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: renderedId,
    });
    const listed = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    assert.equal(listed.conversations[0].unreadCount, 1);
  });
});

test('mark-read rechaza IDs outbound, ajenos y cross-tenant sin mutar watermark', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const ownInbound = (await pool.query("SELECT min(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND direction='inbound'")).rows[0].id;
    await markCloudConversationRead({ pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: ownInbound });
    const before = (await pool.query('SELECT last_read_message_id::text id, xmin::text xmin FROM whatsapp_cloud_conversation_reads WHERE empresa_id=1 AND conversation_id=$1 AND usuario_id=11', [ids.one])).rows[0];
    const outbound = (await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,sent_at,created_at,updated_at)
      VALUES (1,'outbound','5493515550001','text','x','sent',30,NOW(),NOW(),NOW(),NOW()) RETURNING id::text`)).rows[0].id;
    await pool.query(`INSERT INTO whatsapp_cloud_events (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data)
      VALUES (1,'message','other-participant','other-participant','5493515550099','text','{"text":{"body":"x"}}')`);
    const other = (await pool.query("SELECT id::text FROM whatsapp_cloud_messages WHERE empresa_id=1 AND participant_wa_id='5493515550099'")).rows[0].id;
    const crossTenant = (await pool.query("SELECT id::text FROM whatsapp_cloud_messages WHERE empresa_id=2 AND direction='inbound'")).rows[0].id;
    for (const candidate of [outbound, other, crossTenant]) {
      await assert.rejects(markCloudConversationRead({ pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: candidate }), error => error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT');
    }
    const after = (await pool.query('SELECT last_read_message_id::text id, xmin::text xmin FROM whatsapp_cloud_conversation_reads WHERE empresa_id=1 AND conversation_id=$1 AND usuario_id=11', [ids.one])).rows[0];
    assert.deepEqual(after, before);
  });
});

test('actor lock primero: read y PATCH ganan antes de desactivación/reasignación y luego ésta progresa', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const renderedId = (await pool.query("SELECT max(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND direction='inbound'")).rows[0].id;

    const projectionBlocker = await pool.connect();
    try {
      await projectionBlocker.query('BEGIN');
      await projectionBlocker.query('SELECT public.whatsapp_cloud_messages_lock_projection(1)');
      const readPromise = markCloudConversationRead({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: renderedId,
      });
      await waitForAdvisoryWaiters(pool, 1);
      let actorChangeSettled = false;
      const actorChange = pool.query('UPDATE usuarios SET activo=false WHERE id=11').finally(() => { actorChangeSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(actorChangeSettled, false, 'actor update must wait behind the mutation actor lock');
      await projectionBlocker.query('COMMIT');
      assert.equal((await readPromise).lastReadMessageId, renderedId);
      await actorChange;
      assert.equal((await pool.query('SELECT activo FROM usuarios WHERE id=11')).rows[0].activo, false);
    } finally {
      await projectionBlocker.query('ROLLBACK').catch(() => {});
      projectionBlocker.release();
    }

    await pool.query("UPDATE usuarios SET activo=true, role='admin', empresa_id=1 WHERE id=11");
    const patchVersion = (await pool.query(
      'SELECT version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one],
    )).rows[0].version;
    const conversationBlocker = await pool.connect();
    try {
      await conversationBlocker.query('BEGIN');
      await conversationBlocker.query('SELECT 1 FROM whatsapp_cloud_conversations WHERE empresa_id=1 AND id=$1::uuid FOR UPDATE', [ids.one]);
      const patchPromise = updateCloudConversationState({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin',
        workflowStatus: 'resolved', expectedVersion: patchVersion,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      let reassignmentSettled = false;
      const reassignment = pool.query('UPDATE usuarios SET empresa_id=2 WHERE id=11').finally(() => { reassignmentSettled = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(reassignmentSettled, false, 'actor reassignment must wait behind the mutation actor lock');
      await conversationBlocker.query('COMMIT');
      assert.equal((await patchPromise).outcome, 'updated');
      await reassignment;
      assert.equal((await pool.query('SELECT empresa_id FROM usuarios WHERE id=11')).rows[0].empresa_id, 2);
    } finally {
      await conversationBlocker.query('ROLLBACK').catch(() => {});
      conversationBlocker.release();
    }
  });
});

test('actor change primero: read y PATCH rechazan desactivación/reasignación sin mutar', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const renderedId = (await pool.query("SELECT max(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND direction='inbound'")).rows[0].id;

    const actorWriter = await pool.connect();
    try {
      await actorWriter.query('BEGIN');
      await actorWriter.query('UPDATE usuarios SET activo=false WHERE id=11');
      const readPromise = markCloudConversationRead({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: renderedId,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      await actorWriter.query('COMMIT');
      await assert.rejects(readPromise, error => error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN');
      assert.equal((await pool.query('SELECT count(*)::int count FROM whatsapp_cloud_conversation_reads WHERE usuario_id=11')).rows[0].count, 0);
    } finally {
      await actorWriter.query('ROLLBACK').catch(() => {});
      actorWriter.release();
    }

    await pool.query("UPDATE usuarios SET activo=true, role='admin', empresa_id=1 WHERE id=11");
    const beforePatch = (await pool.query(
      'SELECT workflow_status,version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one],
    )).rows[0];
    const reassignmentWriter = await pool.connect();
    try {
      await reassignmentWriter.query('BEGIN');
      await reassignmentWriter.query('UPDATE usuarios SET empresa_id=2 WHERE id=11');
      const patchPromise = updateCloudConversationState({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin',
        workflowStatus: 'resolved', expectedVersion: beforePatch.version,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      await reassignmentWriter.query('COMMIT');
      await assert.rejects(patchPromise, error => error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN');
      const current = (await pool.query('SELECT workflow_status,version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one])).rows[0];
      assert.deepEqual(current, beforePatch);
    } finally {
      await reassignmentWriter.query('ROLLBACK').catch(() => {});
      reassignmentWriter.release();
    }
  });
});

test('actor races cubren read-reasignación y PATCH-desactivación en ambos ganadores', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    const renderedId = (await pool.query("SELECT max(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND direction='inbound'")).rows[0].id;

    const projectionBlocker = await pool.connect();
    try {
      await projectionBlocker.query('BEGIN');
      await projectionBlocker.query('SELECT public.whatsapp_cloud_messages_lock_projection(1)');
      const read = markCloudConversationRead({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: renderedId,
      });
      await waitForAdvisoryWaiters(pool, 1);
      let reassigned = false;
      const reassign = pool.query('UPDATE usuarios SET empresa_id=2 WHERE id=11').finally(() => { reassigned = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(reassigned, false);
      await projectionBlocker.query('COMMIT');
      await read;
      await reassign;
    } finally {
      await projectionBlocker.query('ROLLBACK').catch(() => {});
      projectionBlocker.release();
    }

    await pool.query("UPDATE usuarios SET activo=true, empresa_id=1 WHERE id=11");
    const patchVersion = (await pool.query('SELECT version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one])).rows[0].version;
    const conversationBlocker = await pool.connect();
    try {
      await conversationBlocker.query('BEGIN');
      await conversationBlocker.query('SELECT 1 FROM whatsapp_cloud_conversations WHERE id=$1::uuid FOR UPDATE', [ids.one]);
      const patch = updateCloudConversationState({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin',
        priority: 'urgent', expectedVersion: patchVersion,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      let deactivated = false;
      const deactivate = pool.query('UPDATE usuarios SET activo=false WHERE id=11').finally(() => { deactivated = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(deactivated, false);
      await conversationBlocker.query('COMMIT');
      assert.equal((await patch).outcome, 'updated');
      await deactivate;
    } finally {
      await conversationBlocker.query('ROLLBACK').catch(() => {});
      conversationBlocker.release();
    }

    await pool.query("UPDATE usuarios SET activo=true, empresa_id=1 WHERE id=11");
    const reassignmentWriter = await pool.connect();
    try {
      await reassignmentWriter.query('BEGIN');
      await reassignmentWriter.query('UPDATE usuarios SET empresa_id=2 WHERE id=11');
      const read = markCloudConversationRead({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin', lastReadMessageId: renderedId,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      await reassignmentWriter.query('COMMIT');
      await assert.rejects(read, error => error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN');
    } finally {
      await reassignmentWriter.query('ROLLBACK').catch(() => {});
      reassignmentWriter.release();
    }

    await pool.query("UPDATE usuarios SET activo=true, empresa_id=1 WHERE id=11");
    const beforePatch = (await pool.query('SELECT workflow_status,priority,version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one])).rows[0];
    const actorWriter = await pool.connect();
    try {
      await actorWriter.query('BEGIN');
      await actorWriter.query('UPDATE usuarios SET activo=false WHERE id=11');
      const patch = updateCloudConversationState({
        pool, empresaId: 1, conversationId: ids.one, usuarioId: 11, actorRole: 'admin',
        workflowStatus: 'resolved', expectedVersion: beforePatch.version,
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      await actorWriter.query('COMMIT');
      await assert.rejects(patch, error => error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN');
      assert.deepEqual(
        (await pool.query('SELECT workflow_status,priority,version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one])).rows[0],
        beforePatch,
      );
    } finally {
      await actorWriter.query('ROLLBACK').catch(() => {});
      actorWriter.release();
    }
  });
});

test('super se revalida exacto, activo y global dentro de la transacción', async () => {
  await withDatabase(async pool => {
    const ids = await seed(pool);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id,activo) VALUES (31,'super','x','super',NULL,true)");
    const version = (await pool.query('SELECT version FROM whatsapp_cloud_conversations WHERE id=$1::uuid', [ids.one])).rows[0].version;
    const updated = await updateCloudConversationState({
      pool, empresaId: 1, conversationId: ids.one, usuarioId: 31, actorRole: 'super',
      priority: 'urgent', expectedVersion: version,
    });
    assert.equal(updated.outcome, 'updated');

    await pool.query("UPDATE usuarios SET role='admin', empresa_id=1 WHERE id=31");
    await assert.rejects(updateCloudConversationState({
      pool, empresaId: 1, conversationId: ids.one, usuarioId: 31, actorRole: 'super',
      workflowStatus: 'resolved', expectedVersion: updated.conversation.version,
    }), error => error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN');

    await pool.query("UPDATE usuarios SET role='super', empresa_id=NULL, activo=false WHERE id=31");
    const renderedId = (await pool.query("SELECT max(id)::text id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND direction='inbound'")).rows[0].id;
    await assert.rejects(markCloudConversationRead({
      pool, empresaId: 1, conversationId: ids.one, usuarioId: 31, actorRole: 'super', lastReadMessageId: renderedId,
    }), error => error?.code === 'CLOUD_INBOX_ACTOR_FORBIDDEN');
  });
});

test('listado aplica contadores pre-filtro y orden pending urgent/high/normal, review incluido manual_retry, inProcess, resolved', async () => {
  await withDatabase(async pool => {
    await pool.query("INSERT INTO empresas(id) VALUES (1); INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (11,'a','x','admin',1)");
    const participants = ['5493515550101','5493515550102','5493515550103','5493515550104','5493515550105','5493515550106','5493515550107'];
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
      VALUES (1,'outbound',$1,'text','manual','manual_retry',15,'2026-10-07T08:30:00Z','2026-10-07T08:30:00Z','2026-10-07T08:30:00Z')`, [participants[6]]);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES (1,'outbound',$1,'text','queued','queued',10,'2026-10-07T09:00:00Z','2026-10-07T09:00:00Z','2026-10-07T09:00:00Z')`, [participants[4]]);
    await pool.query(`UPDATE whatsapp_cloud_conversations SET workflow_status='resolved' WHERE participant_wa_id=$1`, [participants[5]]);
    const query = async (sql, params) => (await pool.query(sql, params)).rows;
    const all = await listCloudConversations({ query, empresaId: 1, usuarioId: 11 });
    assert.deepEqual(all.conversations.map(item => item.participant), [
      ...participants.slice(0, 3), participants[6], ...participants.slice(3, 6),
    ].map(value => `*********${value.slice(-4)}`));
    assert.deepEqual(all.counters, { total: 7, pending: 3, inProcess: 1, review: 2, resolved: 1 });
    for (const item of all.conversations) {
      assert.ok(Number.isInteger(item.queueBucket));
      assert.ok(Number.isInteger(item.queuePriorityRank));
      assert.ok(item.effectiveActivityAt instanceof Date);
      assert.equal(Number.isNaN(item.effectiveActivityAt.getTime()), false);
      assert.match(item.lastMessageActivityKey, /^[1-9][0-9]*$/);
      if (item.lastInboundActivityKey != null) assert.match(item.lastInboundActivityKey, /^[1-9][0-9]*$/);
      assert.match(item.lastMessageId, /^[1-9][0-9]*$/);
    }
    const filtered = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, priority: 'urgent', unread: true });
    assert.equal(filtered.conversations.length, 1);
    assert.deepEqual(filtered.counters, all.counters);
    const emptyFiltered = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, workflowStatus: 'resolved', priority: 'urgent' });
    assert.deepEqual(emptyFiltered.conversations, []);
    assert.deepEqual(emptyFiltered.counters, all.counters);
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

test('plan de listado agrega set-based, pagina antes de hidratar y usa índice unread sin SubPlan correlacionado', async () => {
  await withDatabase(async pool => {
    await pool.query("INSERT INTO empresas(id) VALUES (1); INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (11,'a','x','admin',1)");
    await pool.query(`INSERT INTO whatsapp_cloud_conversations
      (id,empresa_id,participant_wa_id,workflow_status,priority,version,created_at,updated_at)
      SELECT ('00000000-0000-4000-8000-' || lpad(participant::text, 12, '0'))::uuid,
             1, '549351' || lpad(participant::text, 9, '0'),
             'pending', 'normal', 1, NOW(), NOW()
        FROM generate_series(1, 120) participant`);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      SELECT 1, 'inbound', '549351' || lpad(participant::text, 9, '0'), 'text', 'fixture', 'received', 0,
             '2026-10-07T00:00:00Z'::timestamptz + (participant * 100 + message) * interval '1 second', NOW(), NOW()
        FROM generate_series(1, 120) participant
        CROSS JOIN generate_series(1, 20) message`);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,sent_at,created_at,updated_at)
      SELECT 1, 'outbound', '549351' || lpad(participant::text, 9, '0'), 'text', 'older outbound', 'sent', 30,
             activity_at, activity_at, NOW(), NOW()
        FROM (
          SELECT participant, message,
                 '2026-10-06T00:00:00Z'::timestamptz + (participant * 100 + message) * interval '1 second' AS activity_at
            FROM generate_series(1, 120) participant
            CROSS JOIN generate_series(1, 80) message
        ) fixture`);
    await pool.query('ANALYZE whatsapp_cloud_messages; ANALYZE whatsapp_cloud_conversations');
    let captured;
    const query = async (sql, params) => {
      captured = { sql, params };
      return (await pool.query(sql, params)).rows;
    };
    const first = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, limit: 10 });
    assert.equal(first.conversations.length, 10);
    assert.ok(first.counters);
    assert.doesNotMatch(captured.sql, /array_agg/i);
    assert.match(captured.sql, /latest_messages AS/);
    assert.match(captured.sql, /inbound_stats AS/);
    assert.ok(captured.sql.indexOf('LIMIT $2') < captured.sql.indexOf('FROM public.puntos_entrega'));
    const collectPlanNodes = plan => {
      const nodes = [];
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node['Node Type']) nodes.push(node);
        for (const child of node.Plans || []) visit(child);
      };
      for (const root of plan) visit(root.Plan);
      return nodes;
    };
    const normalExplain = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`, captured.params);
    const normalNodes = collectPlanNodes(normalExplain.rows[0]['QUERY PLAN']);
    assert.equal(normalNodes.some(node => node['Parent Relationship'] === 'SubPlan'), false);
    assert.equal(normalNodes.some(node => (
      node['Relation Name'] === 'whatsapp_cloud_messages' && Number(node['Actual Loops']) > 1
    )), false, 'productive message scans must stay set-based under the normal planner');
    assert.equal(normalNodes.some(node => (
      /Aggregate/.test(String(node['Node Type'])) && Number(node['Actual Loops']) > 1
    )), false, 'productive aggregates must not run once per conversation');

    await pool.query('SET enable_seqscan = off');
    const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`, captured.params);
    const productivePlan = explained.rows[0]['QUERY PLAN'];
    const nodes = collectPlanNodes(productivePlan);
    assert.equal(nodes.some(node => node['Parent Relationship'] === 'SubPlan'), false);
    assert.equal(nodes.some(node => String(node['Index Name'] || '') === 'idx_whatsapp_cloud_messages_inbound_unread'), true);
    assert.equal(nodes.some(node => /^idx_whatsapp_cloud_messages_(?:timeline|conversations)$/.test(String(node['Index Name'] || ''))), true);

    const second = await listCloudConversations({ query, empresaId: 1, usuarioId: 11, limit: 10, cursor: first.nextCursor });
    assert.equal(second.counters, null);
    assert.doesNotMatch(captured.sql, /counters AS/);
  });
});
