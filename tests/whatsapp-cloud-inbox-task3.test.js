import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import { createWhatsAppCloudInboxAdminRouter } from '../src/routes/whatsappCloudInboxAdmin.js';
import { pool as dbPool, query as dbQuery } from '../src/db.js';
import {
  isConversationListContextCurrent,
  reconcileConversationCollection,
  reconcileConversationMutation,
  isListResponseCurrentForMutation,
  mergeConversationState,
  operationalMeta,
  queueCounterItems,
} from '../pedidos/whatsapp-cloud-ui.js';

test('guard de listado exige generation, tenant, revisión y snapshot exacto de filtros', () => {
  const started = {
    generation: 7,
    companyId: 9,
    contextRevision: 4,
    mutationRevision: 2,
    filters: {
      from: null, to: null, payment: null, workflowStatus: 'pending', priority: null, unread: null,
    },
  };
  assert.equal(isConversationListContextCurrent(started, structuredClone(started)), true);
  for (const changed of [
    { generation: 8 },
    { companyId: 10 },
    { contextRevision: 5 },
    { mutationRevision: 3 },
    { filters: { ...started.filters, priority: 'urgent' } },
  ]) {
    assert.equal(isConversationListContextCurrent(started, { ...structuredClone(started), ...changed }), false);
  }
  assert.equal(isConversationListContextCurrent(started, null), false);
  assert.equal(isConversationListContextCurrent({ ...started, contextRevision: Number.MAX_SAFE_INTEGER + 1 }, started), false);
});

test('guard de listado acepta sólo la misma revisión de mutación y falla cerrado con tokens inválidos', () => {
  assert.equal(isListResponseCurrentForMutation(4, 4), true);
  assert.equal(isListResponseCurrentForMutation(4, 5), false);
  assert.equal(isListResponseCurrentForMutation(undefined, undefined), false);
  assert.equal(isListResponseCurrentForMutation(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1), false);
});

test('Task 4 declara índices tenant-scoped para búsqueda operativa sin escanear mensajes', async () => {
  const [schema, repository] = await Promise.all([
    readFile(new URL('../initDb.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/whatsappCloud/inboxRepository.js', import.meta.url), 'utf8'),
  ]);
  assert.match(schema, /idx_puntos_entrega_whatsapp_search_text_tenant_trgm/);
  assert.match(schema, /idx_puntos_entrega_whatsapp_search_name_prefix/);
  assert.match(schema, /idx_puntos_entrega_whatsapp_search_address_prefix/);
  assert.match(schema, /idx_puntos_entrega_whatsapp_phone_lookup/);
  assert.match(schema, /idx_whatsapp_cloud_conversations_phone_lookup/);
  const searchSection = repository.slice(repository.indexOf('export async function searchCloudConversations'), repository.indexOf('export async function getCloudConversationContext'));
  assert.doesNotMatch(searchSection, /text_body|media_caption|provider_message_id|media_id|event_data|access_token/i);
  assert.doesNotMatch(searchSection, /LIMIT 500|ANY\s*\(|participantWaIds/i);
  assert.match(searchSection, /searchMode/);
});

test('Task 4 trata un número canónico fuera de int4 sólo como teléfono', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) { req.user = { uid: 41, role: 'admin', empresa_id: 7 }; next(); },
    async query(sql, params, options) { calls.push({ sql, params, options }); return []; },
  }));
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/search`, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '9999999999' }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[15], '9999999999');
  assert.equal(calls[0].params[16], null);
  assert.equal(calls[0].options?.sensitive, true);
});

test('Task 4 contexto usa una sola sentencia sensible y nunca consulta pedidos tras ambigüedad', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    withAuth(req, _res, next) { req.user = { uid: 41, role: 'admin', empresa_id: 7 }; next(); },
    async query(sql, params, options) {
      calls.push({ sql, params, options });
      return [{ match_status: 'ambiguous', customer_name: null, delivery_address: null, participant_wa_id: null, orders: [] }];
    },
  }));
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/context`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { matchStatus: 'ambiguous', customer: null, orders: [] });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.sensitive, true);
  assert.match(calls[0].sql, /candidate_points AS MATERIALIZED/);
  assert.match(calls[0].sql, /match_summary/);
});

test('Task 4 fallo de query sensible no registra teléfono ni datos financieros', async () => {
  const originalConnect = dbPool.connect;
  const originalError = console.error;
  const logs = [];
  dbPool.connect = async () => { throw new Error('driver leaked 5493515550101 total 1234.50'); };
  console.error = (...args) => logs.push(args);
  try {
    await assert.rejects(dbQuery('SELECT $1::text', ['5493515550101 total 1234.50'], { sensitive: true }));
  } finally {
    dbPool.connect = originalConnect;
    console.error = originalError;
  }
  const rendered = JSON.stringify(logs);
  assert.match(rendered, /Consulta sensible fallida/);
  assert.doesNotMatch(rendered, /5493515550101|1234\.50|SELECT \$1/);
});

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const stableId = '4ad1a4a8-8877-4dc6-a7a0-e81b87f8e2a1';

test('listado valida filtros operativos y deriva usuario autenticado para unread', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 41, role: 'admin', empresa_id: 7 };
      next();
    },
    async query(sql, params) {
      calls.push({ sql, params });
      return [];
    },
  }));

  await withServer(app, async baseUrl => {
    const accepted = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?workflowStatus=pending&priority=urgent&unread=true`);
    assert.equal(accepted.status, 200);
    for (const suffix of ['workflowStatus=open', 'priority=critical', 'unread=1']) {
      const rejected = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations?${suffix}`);
      assert.equal(rejected.status, 400, suffix);
      assert.deepEqual(await rejected.json(), { error: 'filters_invalid' });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[6], 41);
  assert.ok(calls[0].params.includes('pending'));
  assert.ok(calls[0].params.includes('urgent'));
  assert.ok(calls[0].params.includes(true));
  assert.match(calls[0].sql, /whatsapp_cloud_conversation_reads/);
  assert.match(calls[0].sql, /queue_bucket/);
  assert.match(calls[0].sql, /pending_count/);
});

test('Task 4 super exige empresa explícita canónica en body de búsqueda y query de contexto', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) { req.user = { uid: 41, role: 'super', empresa_id: null }; next(); },
    async query() { return []; },
  }));
  await withServer(app, async baseUrl => {
    const headers = { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' };
    const endpoint = `${baseUrl}/api/admin/whatsapp-cloud/conversations/search`;
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: 'Ana' }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: 'Ana', empresa_id: '7' }) })).status, 400);
    assert.equal((await fetch(`${endpoint}?empresa_id=7`, { method: 'POST', headers, body: JSON.stringify({ query: 'Ana', empresa_id: 7 }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: 'Ana', empresa_id: 7 }) })).status, 200);

    const contextBase = `${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/context`;
    assert.equal((await fetch(contextBase)).status, 400);
    assert.equal((await fetch(`${contextBase}?empresa_id=07`)).status, 400);
    assert.equal((await fetch(`${contextBase}?empresa_id=7&phone=1`)).status, 400);
    assert.equal((await fetch(`${contextBase}?empresa_id=7`)).status, 404);
  });
});

test('POST read exige JSON, Origin y el máximo inbound renderizado exacto', async () => {
  const transactions = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) {
      req.user = { uid: 41, role: 'super', empresa_id: null };
      next();
    },
    pool: {
      async connect() {
        return {
          async query(sql, params) {
            transactions.push({ sql, params });
            if (/FROM public\.usuarios/.test(sql)) return { rows: [{ role: 'super', empresa_id: null, activo: true }] };
            if (/RETURNING last_read_message_id/.test(sql)) return { rows: [{ last_read_message_id: '91' }] };
            if (/SELECT conversation\.participant_wa_id/.test(sql)) return { rows: [{ participant_wa_id: '5493515550001' }] };
            if (/SELECT message\.id/.test(sql)) return { rows: [{ id: '91' }] };
            return { rows: [] };
          },
          release() {},
        };
      },
    },
  }));

  await withServer(app, async baseUrl => {
    const url = `${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/read?empresa_id=9`;
    const rejected = await fetch(url, { method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(rejected.status, 415);
    const bodyActorRejected = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario_id: 999, empresa_id: 9, lastReadMessageId: '91' }),
    });
    assert.equal(bodyActorRejected.status, 400);
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa_id: 9, lastReadMessageId: '91' }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { conversationId: stableId, lastReadMessageId: '91' });
  });

  const upsert = transactions.find(call => /INSERT INTO public\.whatsapp_cloud_conversation_reads/.test(call.sql));
  assert.deepEqual(upsert.params, [9, stableId, 41, '91']);
  assert.ok(transactions.findIndex(call => /whatsapp_cloud_messages_lock_projection/.test(call.sql))
    < transactions.findIndex(call => /SELECT message\.id/.test(call.sql)));
});

test('POST read rechaza int8 no canónico antes de abrir transacción', async () => {
  let connects = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) { req.user = { uid: 41, role: 'admin', empresa_id: 7 }; next(); },
    pool: { async connect() { connects += 1; throw new Error('must not connect'); } },
  }));
  await withServer(app, async baseUrl => {
    for (const lastReadMessageId of ['01', '+1', '1.0', '9223372036854775808', 91]) {
      const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/read`, {
        method: 'POST',
        headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastReadMessageId }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'last_read_message_id_invalid' });
    }
  });
  assert.equal(connects, 0);
});

test('read y PATCH exponen 403 sanitizado si el actor fue revocado dentro de la transacción', async () => {
  let targetStatements = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) { req.user = { uid: 41, role: 'admin', empresa_id: 7 }; next(); },
    pool: { async connect() { return {
      async query(sql) {
        if (/FROM public\.usuarios/.test(sql)) return { rows: [{ role: 'admin', empresa_id: 7, activo: false }] };
        if (!['BEGIN', 'ROLLBACK'].includes(sql)) targetStatements += 1;
        return { rows: [] };
      },
      release() {},
    }; } },
  }));
  await withServer(app, async baseUrl => {
    const headers = { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' };
    const read = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/read`, {
      method: 'POST', headers, body: JSON.stringify({ lastReadMessageId: '91' }),
    });
    assert.equal(read.status, 403);
    assert.deepEqual(await read.json(), { error: 'actor_forbidden' });
    const patch = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/state`, {
      method: 'PATCH', headers, body: JSON.stringify({ priority: 'urgent', expectedVersion: 4 }),
    });
    assert.equal(patch.status, 403);
    assert.deepEqual(await patch.json(), { error: 'actor_forbidden' });
  });
  assert.equal(targetStatements, 0);
});

test('COMMIT ambiguo de read no hace rollback, descarta conexión y expone código sanitizado', async () => {
  const calls = [];
  let releasedWith;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud', createWhatsAppCloudInboxAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) { req.user = { uid: 41, role: 'admin', empresa_id: 7 }; next(); },
    pool: { async connect() { return {
      async query(sql) {
        calls.push(sql);
        if (/FROM public\.usuarios/.test(sql)) return { rows: [{ role: 'admin', empresa_id: 7, activo: true }] };
        if (/SELECT conversation\.participant_wa_id/.test(sql)) return { rows: [{ participant_wa_id: '5493515550001' }] };
        if (/SELECT message\.id/.test(sql)) return { rows: [{ id: '91' }] };
        if (/RETURNING last_read_message_id/.test(sql)) return { rows: [{ last_read_message_id: '91' }] };
        if (sql === 'COMMIT') throw Object.assign(new Error('socket closed with private data'), { code: 'ECONNRESET' });
        return { rows: [] };
      },
      release(error) { releasedWith = error; },
    }; } },
  }));
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/admin/whatsapp-cloud/conversations/${stableId}/read`, {
      method: 'POST', headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastReadMessageId: '91' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'read_outcome_unknown' });
  });
  assert.equal(calls.filter(sql => sql === 'ROLLBACK').length, 0);
  assert.ok(releasedWith instanceof Error);
  assert.doesNotMatch(JSON.stringify(releasedWith), /private|socket/i);
});

test('helpers operativos exponen aliases y merge stale seguro sin retry', () => {
  assert.deepEqual(operationalMeta({ workflowStatus: 'pending', unreadCount: 2, lastDirection: 'inbound', lastDeliveryStatus: 'received' }), {
    key: 'pending', label: 'Por responder', tone: 'pending',
  });
  assert.equal(operationalMeta({ workflowStatus: 'pending', unreadCount: 0, lastDirection: 'outbound', lastDeliveryStatus: 'outcome_unknown' }).key, 'review');
  assert.equal(operationalMeta({ workflowStatus: 'pending', unreadCount: 0, lastDirection: 'outbound', lastDeliveryStatus: 'queued' }).key, 'inProcess');
  assert.equal(operationalMeta({ workflowStatus: 'resolved', unreadCount: 3, lastDirection: 'inbound', lastDeliveryStatus: 'received' }).key, 'resolved');
  assert.deepEqual(queueCounterItems({ total: 9, pending: 3, inProcess: 2, review: 1, resolved: 3 }).map(item => item.label), [
    'Total', 'Por responder', 'En proceso', 'Revisar', 'Respondidas',
  ]);
  const local = { conversationId: stableId, workflowStatus: 'pending', priority: 'urgent', version: 4, unreadCount: 2, participant: '*********0001' };
  assert.deepEqual(mergeConversationState(local, {
    conversationId: stableId, workflowStatus: 'resolved', priority: 'high', version: 5, participant: 'forbidden', unreadCount: 0,
  }), {
    ...local, workflowStatus: 'resolved', priority: 'high', version: 5,
  });
});

test('reconciliación local aplica filtros activos, orden canónico y preserva chat fuera de lista', () => {
  const urgent = { conversationId: stableId, workflowStatus: 'pending', priority: 'urgent', unreadCount: 1, lastDirection: 'inbound', lastDeliveryStatus: 'received', lastMessageAt: '2026-10-07T10:00:00Z', effectiveActivityAt: '2026-10-07T10:00:00Z', lastMessageId: '10' };
  const normal = { ...urgent, conversationId: '5ad1a4a8-8877-4dc6-a7a0-e81b87f8e2a2', priority: 'normal', lastMessageAt: '2026-10-07T09:00:00Z', effectiveActivityAt: '2026-10-07T09:00:00Z', lastMessageId: '9' };
  const moved = reconcileConversationCollection({
    conversations: [normal, urgent], current: { conversationId: normal.conversationId, priority: 'urgent', version: 2 },
    filters: { workflowStatus: 'pending', priority: null, unread: true }, activeConversationId: normal.conversationId,
  });
  assert.deepEqual(moved.conversations.map(item => item.conversationId), [normal.conversationId, urgent.conversationId]);
  assert.equal(moved.activeConversation.priority, 'urgent');
  const removed = reconcileConversationCollection({
    conversations: moved.conversations, current: { conversationId: normal.conversationId, workflowStatus: 'resolved', version: 3 },
    filters: { workflowStatus: 'pending', priority: null, unread: true }, activeConversationId: normal.conversationId,
  });
  assert.deepEqual(removed.conversations.map(item => item.conversationId), [urgent.conversationId]);
  assert.equal(removed.activeConversation.workflowStatus, 'resolved');
});

test('mutaciones reconcilian contadores desde el chat completo aunque la tarjeta esté filtrada', () => {
  const active = {
    conversationId: stableId,
    workflowStatus: 'pending',
    priority: 'high',
    unreadCount: 3,
    lastDirection: 'outbound',
    lastDeliveryStatus: 'sent',
    lastMessageAt: '2026-10-07T12:00:00Z',
    effectiveActivityAt: '2026-10-07T10:00:00Z',
    lastMessageId: '12',
    version: 4,
  };
  const read = reconcileConversationMutation({
    conversations: [], activeConversation: active,
    current: { conversationId: stableId, unreadCount: 0 },
    counters: { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 },
    filters: { unread: true }, allowUnread: true,
  });
  assert.deepEqual(read.counters, { total: 1, pending: 0, inProcess: 0, review: 0, resolved: 1 });
  assert.equal(read.activeConversation.unreadCount, 0);

  const priority = reconcileConversationMutation({
    conversations: [], activeConversation: read.activeConversation,
    current: { conversationId: stableId, priority: 'urgent', version: 5 },
    counters: read.counters, filters: { unread: true },
  });
  assert.deepEqual(priority.counters, read.counters, 'priority cannot drift bucket counters');

  const reopened = reconcileConversationMutation({
    conversations: [],
    activeConversation: { ...priority.activeConversation, workflowStatus: 'resolved', lastDirection: 'inbound' },
    current: { conversationId: stableId, workflowStatus: 'pending', version: 6 },
    counters: priority.counters, filters: { workflowStatus: 'resolved' },
  });
  assert.deepEqual(reopened.counters, { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 });
  assert.equal(reopened.activeConversation.workflowStatus, 'pending');

  const refreshed = reconcileConversationMutation({
    conversations: [{ ...active, workflowStatus: 'resolved', unreadCount: 0, version: 8 }],
    activeConversation: active,
    current: { conversationId: stableId, workflowStatus: 'resolved', priority: 'high', version: 8 },
    counters: { total: 1, pending: 0, inProcess: 0, review: 0, resolved: 1 },
  });
  assert.deepEqual(refreshed.counters, { total: 1, pending: 0, inProcess: 0, review: 0, resolved: 1 });
  assert.equal(refreshed.activeConversation.workflowStatus, 'resolved');

  const filteredRefresh = reconcileConversationMutation({
    conversations: [], activeConversation: active,
    current: { conversationId: stableId, workflowStatus: 'resolved', priority: 'high', version: 8 },
    counters: { total: 1, pending: 0, inProcess: 0, review: 0, resolved: 1 },
    counterBaselineTrusted: false,
  });
  assert.deepEqual(filteredRefresh.counters, { total: 1, pending: 0, inProcess: 0, review: 0, resolved: 1 });
  assert.equal(filteredRefresh.countersNeedReload, true);

  const refreshedUnread = reconcileConversationMutation({
    conversations: [{ ...active, unreadCount: 2, version: 9 }],
    activeConversation: { ...active, unreadCount: 0 },
    current: { conversationId: stableId, priority: 'urgent', version: 10 },
    counters: { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 },
  });
  assert.equal(refreshedUnread.activeConversation.unreadCount, 2);
  assert.deepEqual(refreshedUnread.counters, { total: 1, pending: 1, inProcess: 0, review: 0, resolved: 0 });
});

test('orden local usa exactamente actividad efectiva, último message ID y UUID canónicos', () => {
  const laterOutbound = {
    conversationId: '11111111-1111-4111-8111-111111111111', workflowStatus: 'pending', priority: 'high',
    unreadCount: 1, lastDirection: 'outbound', lastDeliveryStatus: 'sent',
    lastMessageAt: '2026-10-07T12:00:00Z', effectiveActivityAt: '2026-10-07T10:00:00Z', lastMessageId: '12',
    queueBucket: 0, queuePriorityRank: 1, queueActivityKey: '1791367200000000',
    lastMessageActivityKey: '1791374400000000', lastInboundActivityKey: '1791367200000000', version: 1,
  };
  const laterInbound = {
    ...laterOutbound, conversationId: '22222222-2222-4222-8222-222222222222', priority: 'urgent', queuePriorityRank: 0,
    lastDirection: 'inbound', lastMessageAt: '2026-10-07T11:00:00Z', effectiveActivityAt: '2026-10-07T11:00:00Z', lastMessageId: '11',
    queueActivityKey: '1791370800000000', lastMessageActivityKey: '1791370800000000', lastInboundActivityKey: '1791370800000000',
  };
  const tiedHigherMessage = {
    ...laterOutbound, conversationId: '33333333-3333-4333-8333-333333333333', priority: 'urgent', queuePriorityRank: 0,
    lastMessageId: '13',
  };
  const mutated = reconcileConversationMutation({
    conversations: [laterInbound, tiedHigherMessage, laterOutbound], activeConversation: laterOutbound,
    current: { conversationId: laterOutbound.conversationId, priority: 'urgent', version: 2 },
    counters: { total: 3, pending: 3, inProcess: 0, review: 0, resolved: 0 },
  });
  assert.deepEqual(mutated.conversations.map(item => item.conversationId), [
    laterOutbound.conversationId, tiedHigherMessage.conversationId, laterInbound.conversationId,
  ]);
  assert.equal(mutated.activeConversation.queuePriorityRank, 0);
  assert.equal(mutated.activeConversation.queueActivityKey, '1791367200000000');
});

test('frontend declara chips, contadores y PATCH CAS; marca leído sólo después de render exitoso', async () => {
  const [html, controller] = await Promise.all([
    readFile(new URL('../pedidos/whatsapp-cloud.html', import.meta.url), 'utf8'),
    readFile(new URL('../pedidos/whatsapp-cloud.js', import.meta.url), 'utf8'),
  ]);
  for (const id of ['queueCounters', 'workflowFilter', 'priorityFilter', 'unreadFilter', 'conversationWorkflow', 'conversationPriority']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(controller, /expectedVersion:\s*conversation\.version/);
  assert.match(controller, /stale_conversation_version/);
  assert.doesNotMatch(controller, /stale_conversation_version[\s\S]{0,300}(?:retry|setTimeout)/i);
  const renderIndex = controller.indexOf('renderHistory({ preserveScroll: older })');
  const readIndex = controller.lastIndexOf('markConversationRead(conversationId');
  assert.ok(renderIndex >= 0 && readIndex > renderIndex, 'mark read must happen after successful history render');
  assert.match(controller, /async function markConversationRead\(conversationId,\s*\{\s*generation,\s*companyId\s*\}\)/);
  assert.match(controller, /historyGate\.isCurrent\(generation\)[\s\S]{0,250}state\.companyId !== companyId/);
  assert.doesNotMatch(`${html}\n${controller}`, /localStorage|sessionStorage|innerHTML/i);
});
