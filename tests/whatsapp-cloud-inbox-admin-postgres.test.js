import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { createWhatsAppCloudInboxAdminRouter } from '../src/routes/whatsappCloudInboxAdmin.js';
import { buildCloudConversationListSql } from '../src/whatsappCloud/inboxRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL admin inbox gate requires local initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const outboxStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const outboxEndMarker = '-- END WPP OUTBOX MIGRATION';
const outboxEnd = initSql.indexOf(outboxEndMarker, outboxStart);
const projectionStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION');
const projectionEndMarker = '-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION';
const projectionEnd = initSql.indexOf(projectionEndMarker, projectionStart);
const readsStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD CONVERSATION READS MIGRATION');
const readsEndMarker = '-- END WHATSAPP CLOUD CONVERSATION READS MIGRATION';
const readsEnd = initSql.indexOf(readsEndMarker, readsStart);
assert.ok(outboxStart >= 0 && outboxEnd > outboxStart);
assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
assert.ok(readsStart >= 0 && readsEnd > readsStart);
const migrationSql = `${initSql.slice(outboxStart, outboxEnd + outboxEndMarker.length)}\n${initSql.slice(projectionStart, projectionEnd + projectionEndMarker.length)}\n${initSql.slice(readsStart, readsEnd + readsEndMarker.length)}`;
const tempPrefix = '.whatsapp-cloud-admin-api-pg-';
const createdDirectories = new Set();

async function withDatabase(work, { beforeMigration } = {}) {
  const directory = mkdtempSync(join(process.cwd(), tempPrefix));
  createdDirectories.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_admin_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_admin_test', database: 'postgres', max: 6 });
    await pool.query("CREATE TABLE empresas (id INTEGER PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(`
      CREATE TABLE usuarios (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
        activo BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    await pool.query(`
      CREATE TABLE puntos_entrega (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        cliente TEXT NOT NULL,
        nombre TEXT,
        direccion TEXT,
        direccion_completa TEXT,
        ciudad TEXT,
        telefono TEXT,
        telefono_normalizado TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE pedidos (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
        estado TEXT DEFAULT 'pendiente',
        metodo_pago TEXT DEFAULT 'efectivo',
        monto NUMERIC(10,2) DEFAULT 0,
        fecha TIMESTAMPTZ DEFAULT NOW()
      )
    `);
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
    if (beforeMigration) await beforeMigration(pool);
    await pool.query(migrationSql);
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
}

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function cloudConfig(phoneNumberId) {
  return JSON.stringify({
    whatsapp: {
      provider: 'cloud',
      enabled: true,
      phone_number_id: phoneNumberId,
      access_token_encrypted: 'v1:test-only',
    },
  });
}

after(() => {
  const leftovers = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(leftovers, [], `temporary PostgreSQL clusters leaked: ${leftovers.join(', ')}`);
  assert.equal(createdDirectories.size, 0);
});

test('API admin Cloud conserva tenant, paginación, redacción e idempotencia en PostgreSQL real', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb),(2,$2::jsonb)', [
      cloudConfig('phone-one'),
      cloudConfig('phone-two'),
    ]);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (1,'admin-one','x','admin',1)");
    await pool.query(`
      INSERT INTO puntos_entrega
        (empresa_id, cliente, nombre, direccion, direccion_completa, ciudad, telefono, telefono_normalizado)
      VALUES
        (1, 'Cliente Uno', NULL, 'San Martín 123', NULL, 'Córdoba', '3515550001', '5493515550001'),
        (1, 'Cliente Dos', 'Nombre Dos', 'Belgrano 456', 'Belgrano 456, Córdoba', 'Córdoba', '3515550002', '5493515550002'),
        (2, 'Cliente Tenant Dos', NULL, 'No visible 999', NULL, 'Córdoba', '3515550001', '5493515550001')
    `);
    const points = (await pool.query(`
      SELECT id, cliente FROM puntos_entrega WHERE empresa_id = 1 ORDER BY id
    `)).rows;
    await pool.query(`
      INSERT INTO pedidos (empresa_id, punto_entrega_id, estado, metodo_pago, monto, fecha)
      VALUES
        (1, $1, 'pendiente', 'transferencia', 1000, '2026-10-06T09:00:00Z'),
        (1, $2, 'pendiente', 'efectivo', 900, '2026-10-06T08:00:00Z')
    `, [points[0].id, points[1].id]);
    const inserted = (await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,message_type,text_body,media_mime_type,
         media_caption,document_filename,delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES
        (1,'inbound','5493515550001','text','tenant one older',NULL,NULL,NULL,'received',0,
         '2026-10-06T10:02:00.123800Z','2026-10-06T10:02:00.123800Z','2026-10-06T10:02:00.123800Z'),
        (1,'inbound','5493515550001','document',NULL,'application/pdf','tenant one doc','factura.pdf',
         'received',0,'2026-10-06T10:02:00.123900Z','2026-10-06T10:02:00.123900Z','2026-10-06T10:02:00.123900Z'),
        (1,'inbound','5493515550002','text','tenant one second conversation',NULL,NULL,NULL,'received',0,
         '2026-10-06T10:02:00.123850Z','2026-10-06T10:02:00.123850Z','2026-10-06T10:02:00.123850Z'),
        (2,'inbound','5493515550001','text','tenant two secret collision',NULL,NULL,NULL,'received',0,
         '2026-10-06T10:03:00Z','2026-10-06T10:03:00Z','2026-10-06T10:03:00Z')
      RETURNING id, empresa_id, participant_wa_id, message_type
    `)).rows;
    const tenantOneDoc = inserted.find(row => row.empresa_id === 1 && row.message_type === 'document');
    const tenantTwo = inserted.find(row => row.empresa_id === 2);
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations (empresa_id,participant_wa_id,created_at,updated_at)
      SELECT empresa_id,participant_wa_id,MIN(created_at),MAX(updated_at)
        FROM whatsapp_cloud_messages
       GROUP BY empresa_id,participant_wa_id
    `);
    const tenantOneConversation = (await pool.query(`
      SELECT id::text FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='5493515550001'
    `)).rows[0];
    const tenantOneSecondConversation = (await pool.query(`
      SELECT id::text FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='5493515550002'
    `)).rows[0];
    const tenantTwoConversation = (await pool.query(`
      SELECT id::text FROM whatsapp_cloud_conversations
       WHERE empresa_id=2 AND participant_wa_id='5493515550001'
    `)).rows[0];

    const app = express();
    app.use(express.json());
    app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
      canonicalOrigin: 'https://admin.pedivoy.test',
      withAuth(req, _res, next) {
        req.user = { uid: 1, role: 'admin', empresa_id: 1 };
        next();
      },
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      pool,
    }));

    await withServer(app, async baseUrl => {
      const firstPageResponse = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?empresa_id=2&limit=1`);
      assert.equal(firstPageResponse.status, 200);
      const firstPage = await firstPageResponse.json();
      assert.equal(firstPage.conversations.length, 1);
      assert.equal(firstPage.conversations[0].conversationId, tenantOneConversation.id);
      assert.equal(firstPage.conversations[0].participant, '*********0001');
      assert.equal(firstPage.conversations[0].customerName, 'Cliente Uno');
      assert.equal(firstPage.conversations[0].customerAddress, 'San Martín 123, Córdoba');
      assert.equal(firstPage.conversations[0].paymentMethod, 'transferencia');
      assert.equal(typeof firstPage.nextCursor, 'string');
      assert.doesNotMatch(JSON.stringify(firstPage), /5493515550001|tenant one|tenant two|factura|No visible/i);

      const secondPageResponse = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
      assert.equal(secondPageResponse.status, 200);
      const secondPage = await secondPageResponse.json();
      assert.equal(secondPage.conversations.length, 1);
      assert.equal(secondPage.conversations[0].conversationId, tenantOneSecondConversation.id);
      assert.equal(secondPage.conversations[0].participant, '*********0002');
      assert.equal(secondPage.conversations[0].customerName, 'Nombre Dos');
      assert.equal(secondPage.conversations[0].customerAddress, 'Belgrano 456, Córdoba');
      assert.equal(secondPage.conversations[0].paymentMethod, 'efectivo');
      assert.equal(secondPage.nextCursor, null);

      const historyResponse = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/messages?limit=1`);
      assert.equal(historyResponse.status, 200);
      const history = await historyResponse.json();
      assert.deepEqual(history.messages.map(row => [row.id, row.type, row.attachment?.downloadable]), [
        [String(tenantOneDoc.id), 'document', false],
      ]);
      assert.equal(typeof history.nextCursor, 'string');
      assert.doesNotMatch(JSON.stringify(history), /5493515550001|phone-one|secret collision|provider|media_id|sha/i);

      const olderResponse = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/messages?limit=1&cursor=${encodeURIComponent(history.nextCursor)}`);
      assert.equal(olderResponse.status, 200);
      const older = await olderResponse.json();
      assert.equal(older.messages[0].text, 'tenant one older');
      assert.equal(older.nextCursor, null);

      const crossTenantHistory = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantTwoConversation.id}/messages`);
      assert.equal(crossTenantHistory.status, 404);
      const crossTenantAttachment = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantTwoConversation.id}/messages/${tenantTwo.id}/attachment`);
      assert.equal(crossTenantAttachment.status, 404);

      const metadata = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/messages/${tenantOneDoc.id}/attachment`);
      assert.equal(metadata.status, 200);
      assert.deepEqual(await metadata.json(), {
        messageId: String(tenantOneDoc.id),
        type: 'document',
        mimeType: 'application/pdf',
        caption: 'tenant one doc',
        filename: 'factura.pdf',
        downloadable: false,
      });
      const download = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/messages/${tenantOneDoc.id}/attachment/download`);
      assert.equal(download.status, 409);

      const replyBody = {
        empresa_id: 2,
        text: ' respuesta idempotente ',
        idempotency_key: 'pg-reply-1',
        transportOrigin: 'company',
      };
      const firstReply = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' }, body: JSON.stringify(replyBody),
      });
      assert.equal(firstReply.status, 202);
      const firstReplyBody = await firstReply.json();
      assert.equal(firstReplyBody.accepted, true);
      assert.equal(firstReplyBody.deduplicated, false);
      const replay = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' }, body: JSON.stringify(replyBody),
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), {
        accepted: true,
        deduplicated: true,
        id: firstReplyBody.id,
        status: 'accepted',
      });
      const conflict = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneConversation.id}/replies`, {
        method: 'POST',
        headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...replyBody, text: 'texto distinto' }),
      });
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), { error: 'idempotency_key_conflict' });
    });

    assert.deepEqual((await pool.query(`
      SELECT empresa_id,telefono,mensaje,transport_origin,reply_correlation_id,status
        FROM wpp_outbox
       WHERE reply_correlation_id = 'admin:pg-reply-1'
    `)).rows, [{
      empresa_id: 1,
      telefono: '5493515550001',
      mensaje: 'respuesta idempotente',
      transport_origin: 'cloud',
      reply_correlation_id: 'admin:pg-reply-1',
      status: 'pending',
    }]);
  });
});

test('último pedido real define medio de pago antes de allowlist y filtros', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb),(2,$2::jsonb)', [
      cloudConfig('phone-payment-one'), cloudConfig('phone-payment-two'),
    ]);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (1,'admin-payment','x','admin',1)");
    const points = (await pool.query(`
      INSERT INTO puntos_entrega
        (empresa_id,cliente,nombre,direccion,ciudad,telefono,telefono_normalizado)
      VALUES
        (1,'Último otro','Último otro','Ruta 1','Córdoba','3515551001','5493515551001'),
        (1,'Último null','Último null','Ruta 2','Córdoba','3515551002','5493515551002'),
        (2,'Tenant ajeno','Tenant ajeno','Oculta','Córdoba','3515551001','5493515551001')
      RETURNING id,empresa_id,telefono_normalizado
    `)).rows;
    const otherPoint = points.find(row => row.empresa_id === 1 && row.telefono_normalizado.endsWith('1001'));
    const nullPoint = points.find(row => row.empresa_id === 1 && row.telefono_normalizado.endsWith('1002'));
    const foreignPoint = points.find(row => row.empresa_id === 2);
    await pool.query(`
      INSERT INTO pedidos (id,empresa_id,punto_entrega_id,metodo_pago,fecha)
      VALUES
        (9101,1,$1,'transferencia','2026-10-06T09:00:00Z'),
        (9102,1,$1,'tarjeta','2026-10-07T09:00:00Z'),
        (9201,1,$2,'transferencia','2026-10-06T09:00:00Z'),
        (9202,1,$2,NULL,'2026-10-07T09:00:00Z'),
        (9301,2,$3,'efectivo','2026-10-08T09:00:00Z')
    `, [otherPoint.id, nullPoint.id, foreignPoint.id]);
    await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES
        (1,'inbound','5493515551001','text','otro más nuevo','received',0,'2026-10-07T12:00:00Z','2026-10-07T12:00:00Z','2026-10-07T12:00:00Z'),
        (1,'inbound','5493515551002','text','null más nuevo','received',0,'2026-10-07T11:00:00Z','2026-10-07T11:00:00Z','2026-10-07T11:00:00Z')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations (empresa_id,participant_wa_id,created_at,updated_at)
      SELECT empresa_id,participant_wa_id,MIN(created_at),MAX(updated_at)
        FROM whatsapp_cloud_messages GROUP BY empresa_id,participant_wa_id
    `);

    const app = express();
    app.use(express.json());
    app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
      canonicalOrigin: 'https://admin.pedivoy.test',
      withAuth(req, _res, next) { req.user = { uid: 1, role: 'admin', empresa_id: 1 }; next(); },
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      pool,
    }));

    await withServer(app, async baseUrl => {
      const unfiltered = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations`);
      assert.equal(unfiltered.status, 200);
      const body = await unfiltered.json();
      assert.deepEqual(body.conversations.map(row => [row.participant, row.paymentMethod]), [
        ['*********1001', null],
        ['*********1002', null],
      ]);
      for (const payment of ['transferencia', 'efectivo']) {
        const filtered = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?payment=${payment}`);
        assert.equal(filtered.status, 200, payment);
        assert.deepEqual((await filtered.json()).conversations, [], payment);
      }
    });
  });
});

test('reply serializa revocación/reasignación/degradación con actor→participante→outbox', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb),(2,$2::jsonb)', [
      cloudConfig('phone-race-one'), cloudConfig('phone-race-two'),
    ]);
    await pool.query(`
      INSERT INTO usuarios(id,username,password,role,empresa_id,activo) VALUES
        (1,'admin-reply-race','x','admin',1,true),
        (2,'super-reply-race','x','super',NULL,true)
    `);
    const messages = (await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES
        (1,'inbound','5493515557001','text','tenant one','received',0,NOW(),NOW(),NOW()),
        (2,'inbound','5493515557002','text','tenant two','received',0,NOW(),NOW(),NOW())
      RETURNING id,empresa_id
    `)).rows;
    const tenantOneMessageId = String(messages.find(row => row.empresa_id === 1).id);
    const tenantTwoMessageId = String(messages.find(row => row.empresa_id === 2).id);

    let actorLockedResolve = null;
    const routePool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(input, params) {
            const text = typeof input === 'string' ? input : input.text;
            const result = await client.query(input, params);
            if (/FROM public\.usuarios/.test(text)) actorLockedResolve?.();
            return result;
          },
          release(error) { client.release(error); },
        };
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
      canonicalOrigin: 'https://admin.pedivoy.test',
      withAuth(req, _res, next) {
        req.user = req.get('x-test-actor') === 'super'
          ? { uid: 2, role: 'super', empresa_id: null }
          : { uid: 1, role: 'admin', empresa_id: 1 };
        next();
      },
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      pool: routePool,
    }));
    const request = (baseUrl, { actor = 'admin', key, messageId = tenantOneMessageId }) => fetch(
      `${baseUrl}/api/admin/whatsapp-cloud/conversations/${messageId}/replies${actor === 'super' ? '?empresa_id=1' : ''}`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://admin.pedivoy.test',
          'Content-Type': 'application/json',
          'x-test-actor': actor,
        },
        body: JSON.stringify({ text: `respuesta ${key}`, idempotency_key: key }),
      },
    );

    await withServer(app, async baseUrl => {
      const losingChanges = [
        ['admin-deactivated', 1, 'UPDATE usuarios SET activo=false WHERE id=1'],
        ['admin-reassigned', 1, 'UPDATE usuarios SET empresa_id=2 WHERE id=1'],
        ['admin-demoted', 1, "UPDATE usuarios SET role='user' WHERE id=1"],
        ['super-deactivated', 2, 'UPDATE usuarios SET activo=false WHERE id=2'],
        ['super-demoted', 2, "UPDATE usuarios SET role='admin', empresa_id=1 WHERE id=2"],
      ];
      for (const [name, actorId, changeSql] of losingChanges) {
        await pool.query(`UPDATE usuarios SET
          role=CASE WHEN id=1 THEN 'admin' ELSE 'super' END,
          empresa_id=CASE WHEN id=1 THEN 1 ELSE NULL END,
          activo=true WHERE id=$1`, [actorId]);
        await pool.query('DELETE FROM wpp_outbox');
        const changer = await pool.connect();
        try {
          await changer.query('BEGIN');
          await changer.query(changeSql);
          let settled = false;
          const pending = request(baseUrl, {
            actor: actorId === 2 ? 'super' : 'admin',
            key: `revocation-wins-${name}`,
          }).then(response => { settled = true; return response; });
          await new Promise(resolve => setTimeout(resolve, 60));
          assert.equal(settled, false, `${name}: reply debe esperar el lock del actor`);
          await changer.query('COMMIT');
          const response = await pending;
          assert.equal(response.status, 403, name);
          assert.deepEqual(await response.json(), { error: 'actor_forbidden' }, name);
          assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM wpp_outbox')).rows[0].count, 0, name);
        } finally {
          await changer.query('ROLLBACK').catch(() => {});
          changer.release();
        }
      }

      await pool.query("UPDATE usuarios SET role='admin',empresa_id=1,activo=true WHERE id=1");
      await pool.query('DELETE FROM wpp_outbox');
      const crossTenant = await request(baseUrl, {
        key: 'cross-tenant-reply', messageId: tenantTwoMessageId,
      });
      assert.equal(crossTenant.status, 404);
      assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM wpp_outbox')).rows[0].count, 0);

      await pool.query("UPDATE usuarios SET role='admin',empresa_id=1,activo=true WHERE id=1");
      await pool.query('DELETE FROM wpp_outbox');
      const participantBlocker = await pool.connect();
      const changer = await pool.connect();
      try {
        await participantBlocker.query('BEGIN');
        await participantBlocker.query(
          'SELECT id FROM whatsapp_cloud_messages WHERE empresa_id=1 AND id=$1::bigint FOR UPDATE',
          [tenantOneMessageId],
        );
        const actorLocked = new Promise(resolve => { actorLockedResolve = resolve; });
        const pending = request(baseUrl, { key: 'reply-wins-admin-deactivation' });
        await actorLocked;

        await changer.query('BEGIN');
        let changeSettled = false;
        const change = changer.query('UPDATE usuarios SET activo=false WHERE id=1')
          .then(() => { changeSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(changeSettled, false, 'revocación debe esperar el lock transaccional del reply');

        await participantBlocker.query('COMMIT');
        const response = await pending;
        assert.equal(response.status, 202);
        await change;
        await changer.query('COMMIT');
        assert.deepEqual((await pool.query(`
          SELECT empresa_id,telefono,mensaje,transport_origin,reply_correlation_id
            FROM wpp_outbox
        `)).rows, [{
          empresa_id: 1,
          telefono: '5493515557001',
          mensaje: 'respuesta reply-wins-admin-deactivation',
          transport_origin: 'cloud',
          reply_correlation_id: 'admin:reply-wins-admin-deactivation',
        }]);
      } finally {
        actorLockedResolve = null;
        await participantBlocker.query('ROLLBACK').catch(() => {});
        await changer.query('ROLLBACK').catch(() => {});
        participantBlocker.release();
        changer.release();
      }
    });
  });
});

test('dos PATCH concurrentes con expectedVersion producen un ganador y un stale tenant-scoped', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb),(2,$2::jsonb)', [
      cloudConfig('phone-one'), cloudConfig('phone-two'),
    ]);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id,activo) VALUES (1,'admin-race','x','admin',1,true)");
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','state-race-one','wamid.state-race-one','549351555777','text',
              '{"text":{"body":"tenant one"}}'::jsonb,'2026-10-07T12:00:00Z')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (2,'message','state-race-two','wamid.state-race-two','549351555777','text',
              '{"text":{"body":"tenant two"}}'::jsonb,'2026-10-07T12:00:00Z')
    `);
    const conversation = (await pool.query(`
      SELECT id::text,version FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='549351555777'
    `)).rows[0];
    const app = express();
    app.use(express.json());
    app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
      canonicalOrigin: 'https://admin.pedivoy.test',
      withAuth(req, _res, next) {
        req.user = { uid: 1, role: 'admin', empresa_id: 1 };
        next();
      },
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      pool,
    }));

    await withServer(app, async baseUrl => {
      const url = `${baseUrl}/api/admin/whatsapp-cloud/conversations/${conversation.id}/state`;
      const options = priority => ({
        method: 'PATCH',
        headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority, expectedVersion: conversation.version }),
      });
      const responses = await Promise.all([
        fetch(url, options('high')),
        fetch(url, options('urgent')),
      ]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      const bodies = await Promise.all(responses.map(response => response.json()));
      const stale = bodies.find(body => body.error === 'stale_conversation_version');
      assert.ok(stale);
      assert.equal(stale.current.version, conversation.version + 1);
      assert.ok(['high', 'urgent'].includes(stale.current.priority));
      assert.doesNotMatch(JSON.stringify(stale), /549351555777|tenant one|tenant two/i);
    });

    const tenantOne = (await pool.query(`SELECT priority,version FROM whatsapp_cloud_conversations
      WHERE empresa_id=1 AND id=$1::uuid`, [conversation.id])).rows[0];
    assert.equal(tenantOne.version, conversation.version + 1);
    assert.ok(['high', 'urgent'].includes(tenantOne.priority));
    assert.deepEqual((await pool.query(`SELECT priority,version FROM whatsapp_cloud_conversations
      WHERE empresa_id=2 AND participant_wa_id='549351555777'`)).rows[0], {
      priority: 'normal', version: 1,
    });
  });
});

test('Task 4 busca fuera de la primera página y resuelve context exact, ambiguous y none sin cruces tenant', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb),(2,$2::jsonb)', [
      cloudConfig('phone-search-one'), cloudConfig('phone-search-two'),
    ]);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id,activo) VALUES (1,'admin-search','x','admin',1,true)");
    const points = (await pool.query(`
      INSERT INTO puntos_entrega
        (empresa_id,cliente,nombre,direccion,direccion_completa,ciudad,telefono,telefono_normalizado)
      VALUES
        (1,'Cliente Exacto','Ana Segura','Ruta 9 123','Ruta 9 123, Córdoba','Córdoba','3515550101','5493515550101'),
        (1,'Duplicado A','Compartido A','Calle A 1',NULL,'Córdoba','3515550202','5493515550202'),
        (1,'Duplicado B','Compartido B','Calle B 2',NULL,'Córdoba','3515550202','5493515550202'),
        (1,'Grupo Buscar Uno','Grupo Buscar Uno','Ruta Grupo 1',NULL,'Córdoba','351553000','549351553000'),
        (1,'Grupo Buscar Dos','Grupo Buscar Dos','Ruta Grupo 2',NULL,'Córdoba','351553001','549351553001'),
        (1,'Al Norte','Al Norte','Camino Norte 1',NULL,'Córdoba','3515550404','5493515550404'),
        (1,'Destino Breve','Destino Breve','Zo Sur 2',NULL,'Córdoba','3515550505','5493515550505'),
        (2,'Secreto Tenant Dos','No visible','Oculta 999',NULL,'Córdoba','3515550101','5493515550101')
      RETURNING id,empresa_id,telefono_normalizado
    `)).rows;
    const exactPoint = points.find(row => row.empresa_id === 1 && row.telefono_normalizado.endsWith('0101'));
    await pool.query(`
      INSERT INTO pedidos (id,empresa_id,punto_entrega_id,estado,metodo_pago,monto,fecha)
      VALUES
        (7001,1,$1,'pendiente','transferencia',1234.50,'2026-10-07T09:00:00Z'),
        (7002,1,$1,'entregado','efectivo',900.00,'2026-10-06T09:00:00Z'),
        (8001,2,$2,'pendiente','efectivo',9999.00,'2026-10-07T10:00:00Z')
    `, [exactPoint.id, points.find(row => row.empresa_id === 2).id]);
    for (let index = 0; index < 28; index += 1) {
      const suffix = String(3000 + index);
      await pool.query(`
        INSERT INTO whatsapp_cloud_messages
          (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
        VALUES (1,'inbound',$1,'text',$2,'received',0,$3,$3,$3)
      `, [`54935155${suffix}`, `mensaje genérico ${index}`, new Date(Date.UTC(2026, 9, 7, 12, index)).toISOString()]);
    }
    await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES
        (1,'inbound','5493515550101','text','texto que no debe buscarse','received',0,'2026-10-01T08:00:00Z','2026-10-01T08:00:00Z','2026-10-01T08:00:00Z'),
        (1,'inbound','5493515550202','text','ambiguo','received',0,'2026-10-07T08:00:00Z','2026-10-07T08:00:00Z','2026-10-07T08:00:00Z'),
        (1,'inbound','5493515550303','text','sin cliente','received',0,'2026-10-07T07:00:00Z','2026-10-07T07:00:00Z','2026-10-07T07:00:00Z'),
        (1,'inbound','5493515550404','text','nombre corto','received',0,'2026-10-07T06:00:00Z','2026-10-07T06:00:00Z','2026-10-07T06:00:00Z'),
        (1,'inbound','5493515550505','text','dirección corta','received',0,'2026-10-07T05:00:00Z','2026-10-07T05:00:00Z','2026-10-07T05:00:00Z'),
        (2,'inbound','5493515550101','text','secreto cross tenant','received',0,'2026-10-07T13:00:00Z','2026-10-07T13:00:00Z','2026-10-07T13:00:00Z')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations (empresa_id,participant_wa_id,created_at,updated_at)
      SELECT empresa_id,participant_wa_id,MIN(created_at),MAX(updated_at)
        FROM whatsapp_cloud_messages GROUP BY empresa_id,participant_wa_id
    `);
    const idsByPhone = Object.fromEntries((await pool.query(`
      SELECT participant_wa_id,id::text FROM whatsapp_cloud_conversations WHERE empresa_id=1
    `)).rows.map(row => [row.participant_wa_id, row.id]));

    const app = express();
    app.use(express.json());
    app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
      canonicalOrigin: 'https://admin.pedivoy.test',
      withAuth(req, _res, next) { req.user = { uid: 1, role: 'admin', empresa_id: 1 }; next(); },
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      pool,
    }));

    await withServer(app, async baseUrl => {
      const endpoint = `${baseUrl}/api/admin/whatsapp-cloud/conversations/search`;
      const post = body => fetch(endpoint, {
        method: 'POST',
        headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal((await post({ query: 'A' })).status, 400);
      const shortSearch = await post({ query: 'zz' });
      assert.equal(shortSearch.status, 200);
      assert.deepEqual((await shortSearch.json()).conversations, []);
      assert.equal((await post({ query: 'x'.repeat(81) })).status, 400);
      assert.equal((await post({ query: 'Ana', actor_id: 99 })).status, 400);
      assert.equal((await fetch(`${endpoint}?query=Ana`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Ana' }),
      })).status, 400);
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Ana' }) })).status, 403);

      const searchResponse = await post({ query: '  Ana Segura  ', limit: 1 });
      assert.equal(searchResponse.status, 200);
      const search = await searchResponse.json();
      assert.equal(search.conversations.length, 1);
      assert.equal(search.conversations[0].conversationId, idsByPhone['5493515550101']);
      assert.equal(search.conversations[0].participant, '*********0101');
      assert.equal(search.conversations[0].participant.includes('5493515550101'), false);
      assert.equal(Object.hasOwn(search, 'query'), false);
      assert.equal(search.conversations.some(row => row.customerName === 'Secreto Tenant Dos'), false);

      const overflowPhone = await post({ query: '9999999999' });
      assert.equal(overflowPhone.status, 200);
      assert.deepEqual((await overflowPhone.json()).conversations, []);

      for (const suffix of ['550101', '515550101', '3515550101']) {
        const phoneSearch = await post({ query: suffix });
        assert.equal(phoneSearch.status, 200, suffix);
        assert.deepEqual((await phoneSearch.json()).conversations.map(row => row.conversationId), [idsByPhone['5493515550101']], suffix);
      }
      for (const outOfRange of ['50101', '93515550101']) {
        const phoneSearch = await post({ query: outOfRange });
        assert.equal(phoneSearch.status, 200, outOfRange);
        assert.deepEqual((await phoneSearch.json()).conversations, [], outOfRange);
      }

      const shortName = await (await post({ query: 'Al' })).json();
      assert.deepEqual(shortName.conversations.map(row => row.conversationId), [idsByPhone['5493515550404']]);
      const shortAddress = await (await post({ query: 'Zo' })).json();
      assert.deepEqual(shortAddress.conversations.map(row => row.conversationId), [idsByPhone['5493515550505']]);

      const groupFirstResponse = await post({ query: 'Grupo Buscar', limit: 1 });
      assert.equal(groupFirstResponse.status, 200);
      const groupFirst = await groupFirstResponse.json();
      assert.equal(groupFirst.conversations.length, 1);
      assert.equal(typeof groupFirst.nextCursor, 'string');
      const groupSecondResponse = await post({ query: 'Grupo Buscar', limit: 1, cursor: groupFirst.nextCursor });
      assert.equal(groupSecondResponse.status, 200);
      const groupSecond = await groupSecondResponse.json();
      assert.equal(groupSecond.conversations.length, 1);
      assert.notEqual(groupSecond.conversations[0].conversationId, groupFirst.conversations[0].conversationId);
      assert.equal(groupSecond.nextCursor, null);

      const messageOnly = await post({ query: 'texto que no debe buscarse' });
      assert.equal(messageOnly.status, 200);
      assert.deepEqual((await messageOnly.json()).conversations, []);

      const forbiddenContextInput = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${idsByPhone['5493515550101']}/context?phone=5493515550101`);
      assert.equal(forbiddenContextInput.status, 400);
      const context = async phone => {
        const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${idsByPhone[phone]}/context`);
        assert.equal(response.status, 200);
        return response.json();
      };
      const exact = await context('5493515550101');
      assert.equal(exact.matchStatus, 'exact');
      assert.deepEqual(exact.customer, {
        name: 'Ana Segura', phone: '*********0101', address: 'Ruta 9 123, Córdoba',
      });
      assert.deepEqual(exact.orders.map(order => order.publicId), ['7001', '7002']);
      assert.equal(exact.customer.phone, '*********0101');
      assert.equal(exact.orders.some(order => order.total === '9999.00'), false);
      assert.equal(Object.hasOwn(exact, 'tracking'), false);
      assert.equal(Object.hasOwn(exact, 'provider'), false);
      assert.deepEqual(await context('5493515550202'), { matchStatus: 'ambiguous', customer: null, orders: [] });
      assert.deepEqual(await context('5493515550303'), { matchStatus: 'none', customer: null, orders: [] });
    });
  });
});

test('Task 4 pagina más de 500 coincidencias por actividad desc sin priorizar urgent', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb)', [cloudConfig('phone-many')]);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (1,'admin-many','x','admin',1)");
    await pool.query(`INSERT INTO puntos_entrega (empresa_id,cliente,nombre,direccion,ciudad,telefono,telefono_normalizado)
      SELECT 1,'Mass Match '||v,'Mass Match '||v,'Ruta '||v,'Córdoba','351'||LPAD(v::text,7,'0'),'549351'||LPAD(v::text,7,'0') FROM generate_series(1,505) v`);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      SELECT 1,'inbound','549351'||LPAD(v::text,7,'0'),'text','bulk','received',0,
        '2026-10-07T10:00:00Z'::timestamptz-v*interval '1 second','2026-10-07T10:00:00Z'::timestamptz-v*interval '1 second','2026-10-07T10:00:00Z'::timestamptz-v*interval '1 second'
      FROM generate_series(1,505) v`);
    await pool.query(`INSERT INTO whatsapp_cloud_conversations (empresa_id,participant_wa_id,created_at,updated_at)
      SELECT empresa_id,participant_wa_id,MIN(created_at),MAX(updated_at) FROM whatsapp_cloud_messages GROUP BY empresa_id,participant_wa_id`);
    await pool.query("UPDATE whatsapp_cloud_conversations SET priority='urgent' WHERE participant_wa_id='5493510000505'");
    const urgent = (await pool.query("SELECT id::text FROM whatsapp_cloud_conversations WHERE participant_wa_id='5493510000505'")).rows[0].id;
    const newest = (await pool.query("SELECT id::text FROM whatsapp_cloud_conversations WHERE participant_wa_id='5493510000001'")).rows[0].id;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
      canonicalOrigin: 'https://admin.pedivoy.test',
      withAuth(req, _res, next) { req.user = { uid: 1, role: 'admin', empresa_id: 1 }; next(); },
      query: async (sql, params) => (await pool.query(sql, params)).rows, pool,
    }));
    await withServer(app, async base => {
      let cursor = null;
      const ids = [];
      do {
        const response = await fetch(`${base}/api/admin/whatsapp-cloud/conversations/search`, {
          method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'Mass Match', limit: 100, ...(cursor ? { cursor } : {}) }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        ids.push(...body.conversations.map(row => row.conversationId));
        cursor = body.nextCursor;
      } while (cursor);
      assert.equal(ids.length, 505);
      assert.equal(new Set(ids).size, 505);
      assert.equal(ids[0], newest);
      assert.equal(ids.at(-1), urgent);
    });
  });
});

test('Task 4 EXPLAIN ANALYZE ejecuta SQL productivo sin SubPlan, arrays ni truncamiento', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id, config_integraciones) VALUES (1,$1::jsonb),(2,$2::jsonb)', [cloudConfig('phone-plan'), cloudConfig('phone-plan-foreign')]);
    await pool.query("INSERT INTO usuarios(id,username,password,role,empresa_id) VALUES (1,'admin-plan','x','admin',1)");
    await pool.query(`INSERT INTO puntos_entrega (empresa_id,cliente,nombre,direccion,direccion_completa,ciudad,telefono,telefono_normalizado)
      SELECT 1,CASE WHEN v=17777 THEN 'Al Plan Exacto' ELSE 'Cliente '||v END,CASE WHEN v=17777 THEN 'Al Plan Exacto' ELSE 'Cliente '||v END,
        CASE WHEN v=18888 THEN 'Zo Índice' ELSE 'Ruta '||v END,CASE WHEN v=18888 THEN 'Zo Índice' ELSE 'Ruta '||v END,'Córdoba',
        '351'||LPAD(v::text,7,'0'),'549351'||LPAD(v::text,7,'0') FROM generate_series(1,20000) v`);
    await pool.query(`INSERT INTO puntos_entrega (empresa_id,cliente,nombre,direccion,direccion_completa,ciudad,telefono,telefono_normalizado)
      SELECT 2,'Foreign '||v,'Foreign '||v,'Oculta '||v,'Oculta '||v,'Córdoba',
        '352'||LPAD(v::text,7,'0'),'549352'||LPAD(v::text,7,'0') FROM generate_series(1,20000) v`);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      SELECT 1,'inbound','549351'||LPAD(v::text,7,'0'),'text','plan','received',0,'2026-10-07T10:00:00Z','2026-10-07T10:00:00Z','2026-10-07T10:00:00Z' FROM generate_series(1,20000) v`);
    await pool.query(`INSERT INTO whatsapp_cloud_messages
      (empresa_id,direction,participant_wa_id,message_type,text_body,delivery_status,state_rank,message_at,created_at,updated_at)
      SELECT 2,'inbound','549352'||LPAD(v::text,7,'0'),'text','foreign','received',0,'2026-10-07T10:00:00Z','2026-10-07T10:00:00Z','2026-10-07T10:00:00Z' FROM generate_series(1,20000) v`);
    await pool.query(`INSERT INTO whatsapp_cloud_conversations (empresa_id,participant_wa_id,created_at,updated_at)
      SELECT empresa_id,participant_wa_id,MIN(created_at),MAX(updated_at) FROM whatsapp_cloud_messages GROUP BY empresa_id,participant_wa_id`);
    await pool.query(`INSERT INTO pedidos(id,empresa_id,punto_entrega_id)
      SELECT v,1,(SELECT MIN(id) FROM puntos_entrega) FROM generate_series(1,5000) v`);
    await pool.query(`INSERT INTO pedidos(id,empresa_id,punto_entrega_id) SELECT 777777,1,id FROM puntos_entrega WHERE nombre='Cliente 18000'`);
    for (const table of ['puntos_entrega','whatsapp_cloud_conversations','whatsapp_cloud_messages','pedidos']) await pool.query(`ANALYZE ${table}`);
    const cases = [
      ['prefix',/idx_puntos_entrega_whatsapp_search_name_prefix/],
      ['substring',/idx_puntos_entrega_whatsapp_search_text_tenant_trgm/],
      ['phone',/idx_puntos_entrega_whatsapp_phone_lookup/],
      ['order',/pedidos_pkey/],
    ];
    for (const [searchMode, expectedIndex] of cases) {
      const statement = await buildCloudConversationListSql({ searchMode });
      assert.doesNotMatch(statement.sql, /LIMIT 500|ANY\s*\(|ARRAY\s*\[/i);
      const phoneSuffixes = searchMode === 'phone' ? ['017777', '510017777', '3510017777'] : [statement.params[15]];
      for (const phoneSuffix of phoneSuffixes) {
        const params = [...statement.params];
        if (searchMode === 'phone') params[15] = phoneSuffix;
        const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, params);
        const root = explained.rows[0]['QUERY PLAN'][0];
        const plan = JSON.stringify(root);
        assert.doesNotMatch(plan, /SubPlan/);
        assert.match(plan, expectedIndex, `${searchMode}:${phoneSuffix || 'n/a'}`);
        assert.equal(Number.isFinite(Number(root.Plan['Total Cost'])), true);
        if (searchMode === 'substring') assert.match(plan, /idx_puntos_entrega_whatsapp_search_text_tenant_trgm/);
        const nodes = [];
        const visit = node => { nodes.push(node); for (const child of node.Plans || []) visit(child); };
        visit(root.Plan);
        const messageScans = nodes.filter(node => String(node['Relation Name'] || '') === 'whatsapp_cloud_messages');
        assert.ok(messageScans.length > 0);
        assert.ok(messageScans.every(node => Number(node['Actual Rows']) < 100), `message history was not candidate-scoped: ${plan}`);
      }
    }
  });
});

test('Task 4 migration actualiza índices telefónicos legacy al contrato de sufijo variable', async () => {
  await withDatabase(async pool => {
    const definitions = (await pool.query(`
      SELECT c.relname, pg_catalog.pg_get_indexdef(c.oid) AS definition
        FROM pg_catalog.pg_class AS c
       WHERE c.relname IN ('idx_puntos_entrega_whatsapp_phone_lookup', 'idx_puntos_entrega_whatsapp_phone_fallback')
       ORDER BY c.relname
    `)).rows;
    assert.equal(definitions.length, 2);
    assert.ok(definitions.every(row => /reverse\(/.test(row.definition)));
    assert.ok(definitions.every(row => /text_pattern_ops/.test(row.definition)));
    assert.ok(definitions.every(row => !/"right"\(/.test(row.definition)));
  }, {
    beforeMigration: async pool => {
      await pool.query(`CREATE INDEX idx_puntos_entrega_whatsapp_phone_lookup
        ON puntos_entrega (empresa_id, (RIGHT(telefono_normalizado, 10)))`);
      await pool.query(`CREATE INDEX idx_puntos_entrega_whatsapp_phone_fallback
        ON puntos_entrega (empresa_id, (RIGHT(regexp_replace(COALESCE(telefono, ''), '\\\\D', '', 'g'), 10)))
        WHERE telefono_normalizado IS NULL`);
    },
  });
});

test('Task 4 migration rechaza índice homónimo alien antes de crear índices canónicos', async () => {
  await assert.rejects(
    withDatabase(async () => {}, {
      beforeMigration: async pool => {
        await pool.query('CREATE INDEX idx_puntos_entrega_whatsapp_phone_lookup ON puntos_entrega (empresa_id, id)');
      },
    }),
    error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_conversation_reads_schema_unsafe',
  );
});

test('Task 4 migration rechaza índice canónico inválido y rerun preserva OID/xmin', async () => {
  await assert.rejects(
    withDatabase(async () => {}, {
      beforeMigration: async pool => {
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await pool.query(`CREATE INDEX idx_puntos_entrega_whatsapp_search_text_tenant_trgm
          ON puntos_entrega USING gin (((empresa_id::text || ':' || lower(
            coalesce(nullif(btrim(nombre), ''), cliente, '') || ' ' ||
            coalesce(direccion_completa, direccion, '') || ' ' || coalesce(ciudad, '')
          ))) gin_trgm_ops)`);
        await pool.query(`UPDATE pg_catalog.pg_index SET indisvalid=false
          WHERE indexrelid='idx_puntos_entrega_whatsapp_search_text_tenant_trgm'::regclass`);
      },
    }),
    error => error?.code === 'P0001' && error?.message === 'whatsapp_cloud_conversation_reads_schema_unsafe',
  );

  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query("INSERT INTO puntos_entrega(empresa_id,cliente) VALUES (1,'estable')");
    const before = (await pool.query(`
      SELECT c.oid::text AS oid, i.indisvalid, i.indisready, i.indislive
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
       WHERE c.relname='idx_puntos_entrega_whatsapp_search_text_tenant_trgm'
    `)).rows[0];
    const rowBefore = (await pool.query("SELECT xmin::text FROM puntos_entrega WHERE cliente='estable'")).rows[0];

    await pool.query(migrationSql);
    const after = (await pool.query(`
      SELECT c.oid::text AS oid, i.indisvalid, i.indisready, i.indislive
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
       WHERE c.relname='idx_puntos_entrega_whatsapp_search_text_tenant_trgm'
    `)).rows[0];
    const rowAfter = (await pool.query("SELECT xmin::text FROM puntos_entrega WHERE cliente='estable'")).rows[0];
    assert.deepEqual(after, before);
    assert.deepEqual(rowAfter, rowBefore);
  });
});
