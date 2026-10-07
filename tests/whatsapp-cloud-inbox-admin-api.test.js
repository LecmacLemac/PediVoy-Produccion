import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

import { createWhatsAppCloudInboxAdminRouter } from '../src/routes/whatsappCloudInboxAdmin.js';
import {
  findCloudMessageProjectionByProviderMessageId,
  findCloudMessageProjectionBySourceEvent,
  getCloudAttachmentMetadata,
  listCloudConversationMessages,
  listCloudConversations,
  matchesCloudReplyCorrelation,
  reconcileCloudMessageProjectionStatus,
  resolveCloudConversationParticipant,
} from '../src/whatsappCloud/inboxRepository.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function createHarness({ role, empresaId = 7 } = {}) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role, empresa_id: empresaId };
      next();
    },
    async query(sql, params) {
      calls.push({ sql, params });
      return [];
    },
    pool: { connect: async () => assert.fail('enqueue must not run') },
  }));
  return { app, calls };
}

test('reply exige JSON y Origin canónico exacto antes de query o enqueue', async () => {
  let queries = 0;
  let enqueues = 0;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 22, role: 'admin', empresa_id: 7 };
      next();
    },
    async query() {
      queries += 1;
      return [{ participant_wa_id: '5493515550001' }];
    },
    async enqueueReply() {
      enqueues += 1;
      return { queued: true, id: 1, status: 'pending' };
    },
  }));

  await withServer(app, async baseUrl => {
    const path = `${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`;
    const rejected = [
      { expected: 415, headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'text=hola&idempotency_key=form-1' },
      { expected: 415, headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'multipart/form-data; boundary=test-boundary' }, body: '--test-boundary--' },
      { expected: 415, headers: { Origin: 'https://admin.pedivoy.test' }, body: 'plain text' },
      { expected: 403, headers: { Origin: 'https://sibling.pedivoy.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola', idempotency_key: 'sibling-1' }) },
      { expected: 403, headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola', idempotency_key: 'null-1' }) },
      { expected: 403, headers: { Origin: 'https://admin.pedivoy.test, https://evil.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola', idempotency_key: 'duplicate-1' }) },
      { expected: 403, headers: { Origin: 'not an origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola', idempotency_key: 'malformed-1' }) },
      { expected: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola', idempotency_key: 'missing-1' }) },
    ];
    for (const options of rejected) {
      const { expected, ...requestOptions } = options;
      const response = await fetch(path, { method: 'POST', ...requestOptions });
      assert.equal(response.status, expected);
      assert.deepEqual(await response.json(), {
        error: expected === 415 ? 'content_type_invalid' : 'request_origin_invalid',
      });
    }
    assert.equal(queries, 0);
    assert.equal(enqueues, 0);

    const accepted = await fetch(path, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: 'hola', idempotency_key: 'valid-1' }),
    });
    assert.equal(accepted.status, 202);
  });
  assert.equal(queries, 1);
  assert.equal(enqueues, 1);
});

test('reply rechaza una configuración canónica con path en vez de reducirla a origin', async () => {
  let queries = 0;
  let enqueues = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test/inbox',
    withAuth(req, _res, next) {
      req.user = { uid: 22, role: 'admin', empresa_id: 7 };
      next();
    },
    async query() { queries += 1; return []; },
    async enqueueReply() { enqueues += 1; return { queued: true }; },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hola', idempotency_key: 'configured-path-1' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'request_origin_invalid' });
  });
  assert.equal(queries, 0);
  assert.equal(enqueues, 0);
});

for (const role of ['user', 'repartidor', 'referente', 'facturacion', 'contable', 'Admin', 'super ']) {
  test(`Cloud inbox bloquea rol no autorizado ${JSON.stringify(role)} antes de consultar`, async () => {
    const { app, calls } = createHarness({ role });
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations`);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'Acceso denegado' });
    });
    assert.equal(calls.length, 0);
  });
}

test('admin queda ligado estrictamente a req.user.empresa_id aunque intente override', async () => {
  const { app, calls } = createHarness({ role: 'admin', empresaId: 7 });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?empresa_id=99`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 7);
  assert.match(calls[0].sql, /WHERE empresa_id = \$1/);
});

test('conversaciones aceptan filtro por rango de fecha y transferencia sin filtrar sólo en browser', async () => {
  const { app, calls } = createHarness({ role: 'admin', empresaId: 7 });
  await withServer(app, async baseUrl => {
    const qs = new URLSearchParams({
      from: '2026-10-07T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      payment: 'transferencia',
    });
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?${qs}`);
    assert.equal(response.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.slice(0, 4), [
    7,
    26,
    null,
    null,
  ]);
  assert.equal(calls[0].params[4], '2026-10-07T00:00:00.000Z');
  assert.equal(calls[0].params[5], '2026-10-08T00:00:00.000Z');
  assert.match(calls[0].sql, /message_at >= \$5::timestamptz/);
  assert.match(calls[0].sql, /message_at < \$6::timestamptz/);
  assert.match(calls[0].sql, /metodo_pago\) = 'transferencia'/);
  assert.match(calls[0].sql, /COALESCE\(pe\.telefono_normalizado, pe\.telefono/);
});

test('conversaciones rechazan filtros de fecha o pago inválidos', async () => {
  const { app, calls } = createHarness({ role: 'admin', empresaId: 7 });
  await withServer(app, async baseUrl => {
    for (const queryString of ['from=hoy', 'to=2026-99-99T00%3A00%3A00.000Z', 'payment=efectivo']) {
      const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?${queryString}`);
      assert.equal(response.status, 400, queryString);
      assert.deepEqual(await response.json(), { error: 'filters_invalid' });
    }
  });
  assert.equal(calls.length, 0);
});

test('super debe seleccionar empresa explícita y no cae a tenant global ni empresa 1', async () => {
  const { app, calls } = createHarness({ role: 'super', empresaId: null });
  await withServer(app, async baseUrl => {
    for (const suffix of ['', '?empresa_id=', '?empresa_id=0', '?empresa_id=1.0', '?empresa_id=01']) {
      const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations${suffix}`);
      assert.equal(response.status, 400, suffix);
      assert.deepEqual(await response.json(), { error: 'empresa_id_required' });
    }
    const selected = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?empresa_id=9`);
    assert.equal(selected.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 9);
});

test('historial resuelve la conversación por id tenant-scoped y devuelve sólo campos operativos cronológicos', async () => {
  const queries = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'admin', empresa_id: 7 };
      next();
    },
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT participant_wa_id/.test(sql)) return [{ participant_wa_id: '5493515550001' }];
      return [
        {
          id: '12', direction: 'outbound', message_type: 'text', text_body: 'respuesta',
          media_mime_type: null, media_caption: null, document_filename: null,
          delivery_status: 'sent', message_at: new Date('2026-10-06T10:01:00Z'),
          provider_message_id: 'forbidden-provider', media_id: 'forbidden-media',
        },
        {
          id: '11', direction: 'inbound', message_type: 'text', text_body: 'consulta',
          media_mime_type: null, media_caption: null, document_filename: null,
          delivery_status: 'received', message_at: new Date('2026-10-06T10:00:00Z'),
          provider_message_id: 'forbidden-provider-2', opaque_payload: { secret: true },
        },
      ];
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/messages?empresa_id=99`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.messages.map(message => [message.id, message.direction, message.text]), [
      ['11', 'inbound', 'consulta'],
      ['12', 'outbound', 'respuesta'],
    ]);
    assert.equal(body.nextCursor, null);
    assert.doesNotMatch(JSON.stringify(body), /5493515550001|forbidden|provider|media_id|opaque|secret/i);
  });

  assert.equal(queries.length, 2);
  assert.ok(queries.every(call => call.params[0] === 7));
  assert.ok(queries.every(call => /empresa_id = \$1/.test(call.sql)));
});

test('attachment expone metadatos allowlisted y download falla cerrado sin storage durable', async () => {
  const queries = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'super', empresa_id: null };
      next();
    },
    async query(sql, params) {
      queries.push({ sql, params });
      return [{
        id: '91', message_type: 'document', media_mime_type: 'application/pdf',
        media_caption: 'comprobante', document_filename: 'factura.pdf',
        participant_wa_id: '5493515550001', provider_message_id: 'secret-provider',
        media_id: 'secret-media', sha256: 'secret-sha',
      }];
    },
  }));

  await withServer(app, async baseUrl => {
    const metadata = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/messages/91/attachment?empresa_id=8`);
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), {
      messageId: '91',
      type: 'document',
      mimeType: 'application/pdf',
      caption: 'comprobante',
      filename: 'factura.pdf',
      downloadable: false,
    });
    const download = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/messages/91/attachment/download?empresa_id=8`);
    assert.equal(download.status, 409);
    assert.deepEqual(await download.json(), { error: 'attachment_download_unavailable' });
  });

  assert.equal(queries.length, 2);
  assert.ok(queries.every(call => call.params[0] === 8 && call.params[1] === 91));
  assert.doesNotMatch(JSON.stringify(queries.map(call => call.sql)), /provider_message_id|media_id|sha256|event_data/i);
});

test('reply manual usa sólo enqueue correlacionado Cloud, ignora transport del caller y queda tenant-scoped', async () => {
  const queryCalls = [];
  const enqueueCalls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 22, role: 'admin', empresa_id: 7 };
      next();
    },
    async query(sql, params) {
      queryCalls.push({ sql, params });
      return [{ participant_wa_id: '5493515550001' }];
    },
    async enqueueReply(input, pool) {
      enqueueCalls.push({ input, pool });
      return { queued: true, id: 501, status: 'pending', transportOrigin: 'cloud' };
    },
    pool: { marker: 'canonical-pool' },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 999,
        text: ' respuesta manual ',
        idempotency_key: 'reply-20261006-1',
        transport: 'company',
        transportOrigin: 'general',
      }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { queued: true, id: '501', status: 'pending' });
  });

  assert.equal(queryCalls.length, 1);
  assert.deepEqual(queryCalls[0].params, [7, 44]);
  assert.match(queryCalls[0].sql, /empresa_id = \$1/);
  assert.deepEqual(enqueueCalls, [{
    input: {
      empresaId: 7,
      phone: '5493515550001',
      message: 'respuesta manual',
      transportOrigin: 'cloud',
      correlationId: 'admin:reply-20261006-1',
    },
    pool: { marker: 'canonical-pool' },
  }]);
});

test('reply distingue outcome_unknown sanitizado y no intenta retry ni fallback', async () => {
  let attempts = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 22, role: 'super', empresa_id: null };
      next();
    },
    async query() {
      return [{ participant_wa_id: '5493515550001' }];
    },
    async enqueueReply() {
      attempts += 1;
      throw Object.assign(new Error('private phone token sql detail'), {
        code: 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN',
        cause: new Error('private commit transport'),
      });
    },
    pool: { marker: 'canonical-pool' },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresa_id: 8,
        text: 'respuesta incierta',
        idempotency_key: 'reply-unknown-1',
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: 'reply_enqueue_outcome_unknown' });
    assert.doesNotMatch(JSON.stringify(body), /private|phone|token|sql|commit/i);
  });
  assert.equal(attempts, 1);
});

test('reply duplicado con la misma key pero distinto destinatario o texto responde conflicto', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 22, role: 'admin', empresa_id: 7 };
      next();
    },
    async query(sql, params, options) {
      calls.push({ sql, params, options });
      if (/FROM public\.whatsapp_cloud_messages/.test(sql)) {
        return [{ participant_wa_id: '541155550001' }];
      }
      return [{ id: 501, status: 'pending', same_phone: false, same_message: false }];
    },
    async enqueueReply() {
      return { queued: false, skipped: true, reason: 'duplicate_correlation', id: 501, status: 'pending' };
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'texto cambiado', idempotency_key: 'same-key' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'idempotency_key_conflict' });
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /FROM public\.wpp_outbox/);
  assert.deepEqual(calls[1].params, [7, 501, 'admin:same-key', '5491155550001', 'texto cambiado']);
  assert.deepEqual(calls[1].options, { sensitive: true });
});

test('lista de conversaciones pagina por última actividad, enmascara teléfono y agrega cliente/dirección', async () => {
  const calls = [];
  const rows = [
    {
      id: '31', participant_wa_id: '5493515550001', direction: 'inbound', message_type: 'text',
      delivery_status: 'received', message_at: new Date('2026-10-06T12:00:00Z'), text_body: 'secreto uno',
      customer_name: 'Cliente Uno', delivery_address: 'San Martín 123', payment_method: 'transferencia',
    },
    {
      id: '21', participant_wa_id: '5493515550002', direction: 'outbound', message_type: 'text',
      delivery_status: 'sent', message_at: new Date('2026-10-06T11:00:00Z'), text_body: 'secreto dos',
      customer_name: 'Cliente Dos', delivery_address: 'Belgrano 456', payment_method: 'efectivo',
    },
    {
      id: '11', participant_wa_id: '5493515550003', direction: 'inbound', message_type: 'document',
      delivery_status: 'received', message_at: new Date('2026-10-06T10:00:00Z'), document_filename: 'secret.pdf',
      customer_name: 'Cliente Tres', delivery_address: 'Mitre 789',
    },
  ];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'admin', empresa_id: 7 };
      next();
    },
    async query(sql, params) {
      calls.push({ sql, params });
      return rows;
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?limit=2`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.conversations.map(item => ({
      conversationId: item.conversationId,
      participant: item.participant,
      customerName: item.customerName,
      customerAddress: item.customerAddress,
      paymentMethod: item.paymentMethod,
      lastMessageAt: item.lastMessageAt,
    })), [
      { conversationId: '31', participant: '*********0001', customerName: 'Cliente Uno', customerAddress: 'San Martín 123', paymentMethod: 'transferencia', lastMessageAt: '2026-10-06T12:00:00.000Z' },
      { conversationId: '21', participant: '*********0002', customerName: 'Cliente Dos', customerAddress: 'Belgrano 456', paymentMethod: 'efectivo', lastMessageAt: '2026-10-06T11:00:00.000Z' },
    ]);
    assert.equal(typeof body.nextCursor, 'string');
    assert.ok(body.nextCursor.length > 10);
    assert.doesNotMatch(JSON.stringify(body), /549351555000|secreto|secret\.pdf/i);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.slice(0, 2), [7, 3]);
  assert.match(calls[0].sql, /ORDER BY message_at DESC, id DESC/i);
  assert.match(calls[0].sql, /LEFT JOIN LATERAL/);
  assert.match(calls[0].sql, /customer_name/);
  assert.match(calls[0].sql, /delivery_address/);
  assert.match(calls[0].sql, /payment_method/);
});

test('historial pagina hacia atrás pero responde cada página en orden cronológico', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'admin', empresa_id: 7 };
      next();
    },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT participant_wa_id/.test(sql)) return [{ participant_wa_id: '5493515550001' }];
      return [
        { id: '13', direction: 'outbound', message_type: 'text', text_body: 'tres', delivery_status: 'sent', message_at: new Date('2026-10-06T10:03:00Z') },
        { id: '12', direction: 'inbound', message_type: 'text', text_body: 'dos', delivery_status: 'received', message_at: new Date('2026-10-06T10:02:00Z') },
        { id: '11', direction: 'inbound', message_type: 'text', text_body: 'uno', delivery_status: 'received', message_at: new Date('2026-10-06T10:01:00Z') },
      ];
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/messages?limit=2`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.messages.map(item => item.id), ['12', '13']);
    assert.equal(typeof body.nextCursor, 'string');
  });
  assert.deepEqual(calls[1].params.slice(0, 3), [7, '5493515550001', 3]);
  assert.match(calls[1].sql, /ORDER BY message_at DESC, id DESC/i);
});

test('router Cloud inbox queda montado en el árbol productivo /api/admin/whatsapp-cloud', () => {
  const source = readFileSync(new URL('../src/routes/mountApiModules.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ createWhatsAppCloudInboxAdminRouter \} from '\.\/whatsappCloudInboxAdmin\.js';/);
  assert.match(source, /app\.use\('\/api\/admin\/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter\(\{ query, pool, withAuth \}\)\);/);
});

test('validación estricta rechaza cursores, ids, empresa y reply mal tipados antes de query/enqueue', async () => {
  let queries = 0;
  let enqueues = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'super', empresa_id: null };
      next();
    },
    async query() {
      queries += 1;
      return [];
    },
    async enqueueReply() {
      enqueues += 1;
      return { queued: true };
    },
  }));

  await withServer(app, async baseUrl => {
    const requests = [
      fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?empresa_id=8&cursor=not-a-real-cursor`),
      fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/01/messages?empresa_id=8`),
      fetch(`${baseUrl}/api/admin/whatsapp-cloud/messages/1.0/attachment?empresa_id=8`),
      fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa_id: '8', text: 'ok', idempotency_key: 'typed' }),
      }),
      fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa_id: 8, text: 9, idempotency_key: 'typed' }),
      }),
      fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
        method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa_id: 8, text: 'ok', idempotency_key: ' con espacio ' }),
      }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(response => response.status), [400, 400, 400, 400, 400, 400]);
  });
  assert.equal(queries, 0);
  assert.equal(enqueues, 0);
});

test('reply super rechaza selectores de empresa discordantes antes de query o enqueue', async () => {
  let queries = 0;
  let enqueues = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'super', empresa_id: null };
      next();
    },
    async query() {
      queries += 1;
      return [{ participant_wa_id: '5493515550001' }];
    },
    async enqueueReply() {
      enqueues += 1;
      return { queued: true, id: 1, status: 'pending' };
    },
  }));

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies?empresa_id=9`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id: 8, text: 'ok', idempotency_key: 'tenant-conflict' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'empresa_id_required' });
  });
  assert.equal(queries, 0);
  assert.equal(enqueues, 0);
});

test('reply super acepta un selector query único y duplicados concordantes', async () => {
  const selectedTenants = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'super', empresa_id: null };
      next();
    },
    async query(_sql, params) {
      selectedTenants.push(params[0]);
      return [{ participant_wa_id: '5493515550001' }];
    },
    async enqueueReply(input) {
      selectedTenants.push(input.empresaId);
      return { queued: true, id: selectedTenants.length, status: 'pending' };
    },
  }));

  await withServer(app, async baseUrl => {
    const queryOnly = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies?empresa_id=9`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'query', idempotency_key: 'tenant-query' }),
    });
    assert.equal(queryOnly.status, 202);

    const concordant = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies?empresa_id=8`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id: 8, text: 'same', idempotency_key: 'tenant-same' }),
    });
    assert.equal(concordant.status, 202);
  });
  assert.deepEqual(selectedTenants, [9, 9, 8, 8]);
});

test('API rechaza empresa_id fuera de int4 y tipos JSON no numéricos antes de query o enqueue', async () => {
  let queries = 0;
  let enqueues = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 11, role: 'super', empresa_id: null };
      next();
    },
    async query() {
      queries += 1;
      return [];
    },
    async enqueueReply() {
      enqueues += 1;
      return { queued: true };
    },
  }));

  await withServer(app, async baseUrl => {
    const getPaths = [
      '/conversations',
      '/conversations/44/messages',
      '/messages/91/attachment',
      '/messages/91/attachment/download',
    ];
    for (const path of getPaths) {
      const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud${path}?empresa_id=2147483648`);
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: 'empresa_id_required' });
    }

    for (const empresa_id of [2147483648, 0, -1, 1.5, true, [], {}, '8']) {
      const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/44/replies`, {
        method: 'POST',
        headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa_id, text: 'ok', idempotency_key: 'strict-tenant' }),
      });
      assert.equal(response.status, 400, JSON.stringify(empresa_id));
      assert.deepEqual(await response.json(), { error: 'empresa_id_required' });
    }
  });
  assert.equal(queries, 0);
  assert.equal(enqueues, 0);
});

test('repositorio rechaza empresaId fuera de int4 antes de ejecutar SQL', async () => {
  let queries = 0;
  const query = async () => {
    queries += 1;
    return [];
  };
  const calls = [
    () => listCloudConversations({ query, empresaId: 2147483648 }),
    () => listCloudConversationMessages({ query, empresaId: 2147483648, conversationId: 1 }),
    () => getCloudAttachmentMetadata({ query, empresaId: 2147483648, messageId: 1 }),
    () => resolveCloudConversationParticipant({ query, empresaId: 2147483648, conversationId: 1 }),
    () => matchesCloudReplyCorrelation({
      query,
      empresaId: 2147483648,
      outboxId: 1,
      correlationId: 'admin:key',
      participant: '5493515550001',
      message: 'ok',
    }),
    () => findCloudMessageProjectionBySourceEvent({ query, empresaId: 2147483648, sourceEventId: 1 }),
    () => findCloudMessageProjectionByProviderMessageId({ query, empresaId: 2147483648, providerMessageId: 'wamid.1' }),
    () => reconcileCloudMessageProjectionStatus({ query, empresaId: 2147483648, providerMessageId: 'wamid.1' }),
  ];

  for (const call of calls) {
    await assert.rejects(call, error => error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT');
  }
  for (const empresaId of [0, -1, 1.5, true, [], {}, '01', '1.0', '2147483648']) {
    await assert.rejects(
      () => listCloudConversations({ query, empresaId }),
      error => error?.code === 'CLOUD_INBOX_INVALID_ARGUMENT',
    );
  }
  assert.equal(queries, 0);
});
