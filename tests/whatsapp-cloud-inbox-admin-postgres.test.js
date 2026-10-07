import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { createWhatsAppCloudInboxAdminRouter } from '../src/routes/whatsappCloudInboxAdmin.js';

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
assert.ok(outboxStart >= 0 && outboxEnd > outboxStart);
assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
const migrationSql = `${initSql.slice(outboxStart, outboxEnd + outboxEndMarker.length)}\n${initSql.slice(projectionStart, projectionEnd + projectionEndMarker.length)}`;
const tempPrefix = '.whatsapp-cloud-admin-api-pg-';
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
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_admin_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_admin_test', database: 'postgres', max: 6 });
    await pool.query("CREATE TABLE empresas (id INTEGER PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
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
      assert.equal(firstPage.conversations[0].conversationId, String(tenantOneDoc.id));
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
      assert.equal(secondPage.conversations[0].participant, '*********0002');
      assert.equal(secondPage.conversations[0].customerName, 'Nombre Dos');
      assert.equal(secondPage.conversations[0].customerAddress, 'Belgrano 456, Córdoba');
      assert.equal(secondPage.conversations[0].paymentMethod, 'efectivo');
      assert.equal(secondPage.nextCursor, null);

      const historyResponse = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneDoc.id}/messages?limit=1`);
      assert.equal(historyResponse.status, 200);
      const history = await historyResponse.json();
      assert.deepEqual(history.messages.map(row => [row.id, row.type, row.attachment?.downloadable]), [
        [String(tenantOneDoc.id), 'document', false],
      ]);
      assert.equal(typeof history.nextCursor, 'string');
      assert.doesNotMatch(JSON.stringify(history), /5493515550001|phone-one|secret collision|provider|media_id|sha/i);

      const olderResponse = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneDoc.id}/messages?limit=1&cursor=${encodeURIComponent(history.nextCursor)}`);
      assert.equal(olderResponse.status, 200);
      const older = await olderResponse.json();
      assert.equal(older.messages[0].text, 'tenant one older');
      assert.equal(older.nextCursor, null);

      const crossTenantHistory = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantTwo.id}/messages`);
      assert.equal(crossTenantHistory.status, 404);
      const crossTenantAttachment = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/messages/${tenantTwo.id}/attachment`);
      assert.equal(crossTenantAttachment.status, 404);

      const metadata = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/messages/${tenantOneDoc.id}/attachment`);
      assert.equal(metadata.status, 200);
      assert.deepEqual(await metadata.json(), {
        messageId: String(tenantOneDoc.id),
        type: 'document',
        mimeType: 'application/pdf',
        caption: 'tenant one doc',
        filename: 'factura.pdf',
        downloadable: false,
      });
      const download = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/messages/${tenantOneDoc.id}/attachment/download`);
      assert.equal(download.status, 409);

      const replyBody = {
        empresa_id: 2,
        text: ' respuesta idempotente ',
        idempotency_key: 'pg-reply-1',
        transportOrigin: 'company',
      };
      const firstReply = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneDoc.id}/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' }, body: JSON.stringify(replyBody),
      });
      assert.equal(firstReply.status, 202);
      const firstReplyBody = await firstReply.json();
      assert.equal(firstReplyBody.accepted, true);
      assert.equal(firstReplyBody.deduplicated, false);
      const replay = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneDoc.id}/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' }, body: JSON.stringify(replyBody),
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), {
        accepted: true,
        deduplicated: true,
        id: firstReplyBody.id,
        status: 'accepted',
      });
      const conflict = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${tenantOneDoc.id}/replies`, {
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
