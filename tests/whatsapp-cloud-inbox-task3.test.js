import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import { createWhatsAppCloudInboxAdminRouter } from '../src/routes/whatsappCloudInboxAdmin.js';
import {
  mergeConversationState,
  operationalMeta,
  queueCounterItems,
} from '../pedidos/whatsapp-cloud-ui.js';

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

test('POST read exige JSON y Origin, ignora usuario del body y usa actor autenticado', async () => {
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
            if (/RETURNING last_read_message_id/.test(sql)) return { rows: [{ last_read_message_id: '99' }] };
            if (/SELECT conversation\.participant_wa_id/.test(sql)) return { rows: [{ participant_wa_id: '5493515550001' }] };
            if (/SELECT MAX\(message\.id\)/.test(sql)) return { rows: [{ max_inbound_id: '99' }] };
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
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario_id: 999, empresa_id: 9 }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { conversationId: stableId, lastReadMessageId: '99' });
  });

  const upsert = transactions.find(call => /INSERT INTO public\.whatsapp_cloud_conversation_reads/.test(call.sql));
  assert.deepEqual(upsert.params, [9, stableId, 41, '99']);
  assert.ok(transactions.findIndex(call => /whatsapp_cloud_messages_lock_projection/.test(call.sql))
    < transactions.findIndex(call => /SELECT MAX\(message\.id\)/.test(call.sql)));
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
