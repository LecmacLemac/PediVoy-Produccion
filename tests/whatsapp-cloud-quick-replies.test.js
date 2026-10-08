import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import { createWhatsAppCloudQuickRepliesAdminRouter } from '../src/routes/whatsappCloudQuickRepliesAdmin.js';
import { createQuickRepliesRepository } from '../src/whatsappCloud/quickRepliesRepository.js';
import {
  insertQuickReplyAtSelection,
  normalizeQuickReplyCatalog,
} from '../pedidos/whatsapp-cloud-ui.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function harness({ role = 'admin', empresaId = 7, repository = {} } = {}) {
  const calls = [];
  const defaults = {
    async list(input) { calls.push(['list', input]); return []; },
    async create(input) { calls.push(['create', input]); return { outcome: 'created', quickReply: { id: '11111111-1111-4111-8111-111111111111', shortcut: input.shortcut, title: input.title, body: input.body, sortOrder: input.sortOrder, isActive: input.isActive, version: 1 } }; },
    async update(input) { calls.push(['update', input]); return { outcome: 'updated', quickReply: { id: input.id, shortcut: input.shortcut || 'hola', title: input.title || 'Hola', body: input.body || 'Texto', sortOrder: input.sortOrder ?? 0, isActive: input.isActive ?? true, version: input.expectedVersion + 1 } }; },
    async disable(input) { calls.push(['disable', input]); return { outcome: 'updated', quickReply: { id: input.id, shortcut: 'hola', title: 'Hola', body: 'Texto', sortOrder: 0, isActive: false, version: input.expectedVersion + 1 } }; },
    ...repository,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin/whatsapp-cloud/quick-replies', createWhatsAppCloudQuickRepliesAdminRouter({
    canonicalOrigin: 'https://admin.pedivoy.test',
    withAuth(req, _res, next) { req.user = { uid: 11, role, empresa_id: empresaId }; next(); },
    repository: defaults,
  }));
  return { app, calls };
}

const mutationHeaders = { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'application/json' };

test('quick replies admin fija tenant; super exige selector explícito y GET lista activas por defecto', async () => {
  const admin = harness();
  await withServer(admin.app, async base => {
    assert.equal((await fetch(`${base}/api/admin/whatsapp-cloud/quick-replies?empresa_id=99`)).status, 400);
    assert.equal((await fetch(`${base}/api/admin/whatsapp-cloud/quick-replies`)).status, 200);
  });
  assert.deepEqual(admin.calls, [['list', { empresaId: 7, includeInactive: false }]]);

  const superUser = harness({ role: 'super', empresaId: null });
  await withServer(superUser.app, async base => {
    assert.equal((await fetch(`${base}/api/admin/whatsapp-cloud/quick-replies`)).status, 400);
    assert.equal((await fetch(`${base}/api/admin/whatsapp-cloud/quick-replies?empresa_id=9&include_inactive=true`)).status, 200);
  });
  assert.deepEqual(superUser.calls, [['list', { empresaId: 9, includeInactive: true }]]);
});

test('quick replies mutaciones exigen JSON+Origin, body allowlist y actor server-side', async () => {
  const { app, calls } = harness();
  await withServer(app, async base => {
    const url = `${base}/api/admin/whatsapp-cloud/quick-replies`;
    for (const request of [
      { headers: { ...mutationHeaders, Origin: 'https://evil.test' }, body: JSON.stringify({ shortcut: 'hola', title: 'Hola', body: 'Texto' }), expected: 403 },
      { headers: { Origin: 'https://admin.pedivoy.test', 'Content-Type': 'text/plain' }, body: '{}', expected: 415 },
      { headers: mutationHeaders, body: JSON.stringify({ shortcut: 'hola', title: 'Hola', body: 'Texto', createdBy: 999 }), expected: 400 },
      { headers: mutationHeaders, body: JSON.stringify({ shortcut: 'á'.repeat(33), title: 'Hola', body: 'Texto' }), expected: 400 },
      { headers: mutationHeaders, body: JSON.stringify({ shortcut: 'hola', title: '', body: 'Texto' }), expected: 400 },
      { headers: mutationHeaders, body: JSON.stringify({ shortcut: 'hola', title: 'Hola', body: 'x'.repeat(4097) }), expected: 400 },
      { headers: mutationHeaders, body: JSON.stringify({ shortcut: 'hola', title: 'Hola', body: 'Texto', sortOrder: 100001 }), expected: 400 },
    ]) {
      const response = await fetch(url, { method: 'POST', headers: request.headers, body: request.body });
      assert.equal(response.status, request.expected);
    }
    const created = await fetch(url, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ shortcut: '  ÁYUDA.Rápida ', title: ' Ayuda ', body: ' Texto plano \n', sortOrder: 2 }) });
    assert.equal(created.status, 201);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], {
    empresaId: 7, usuarioId: 11, actorRole: 'admin', shortcut: 'ayuda.rapida',
    title: 'Ayuda', body: ' Texto plano \n', sortOrder: 2, isActive: true,
  });
});

test('PATCH/DELETE usan CAS, errores públicos allowlisted y no reflejan SQL/body', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const outcomes = ['conflict', 'stale', 'not_found', 'outcome_unknown'];
  for (const outcome of outcomes) {
    const repository = {
      async update() {
        if (outcome === 'outcome_unknown') throw Object.assign(new Error('secret sql body'), { code: 'QUICK_REPLY_OUTCOME_UNKNOWN' });
        return { outcome, quickReply: outcome === 'stale' ? { id, shortcut: 'actual', title: 'Actual', body: 'Actual', sortOrder: 1, isActive: true, version: 4 } : null };
      },
    };
    const { app } = harness({ repository });
    await withServer(app, async base => {
      const response = await fetch(`${base}/api/admin/whatsapp-cloud/quick-replies/${id}`, {
        method: 'PATCH', headers: mutationHeaders,
        body: JSON.stringify({ title: 'Nuevo', expectedVersion: 3 }),
      });
      const expectedStatus = { conflict: 409, stale: 409, not_found: 404, outcome_unknown: 503 }[outcome];
      assert.equal(response.status, expectedStatus);
      const payload = await response.json();
      assert.doesNotMatch(JSON.stringify(payload), /secret|sql body/i);
    });
  }

  const { app, calls } = harness();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/admin/whatsapp-cloud/quick-replies/${id}`, {
      method: 'DELETE', headers: mutationHeaders, body: JSON.stringify({ expectedVersion: 2 }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(calls[0][0], 'disable');
  assert.deepEqual(calls[0][1], { empresaId: 7, usuarioId: 11, actorRole: 'admin', id, expectedVersion: 2 });
});

test('catálogo frontend ordena/filtra y la inserción preserva selección, foco, edición y límite sin enviar', () => {
  assert.deepEqual(normalizeQuickReplyCatalog([
    { id: 'b', shortcut: 'zeta', title: 'Zeta', body: 'Z', sortOrder: 2, isActive: true },
    { id: 'c', shortcut: 'off', title: 'Off', body: 'OFF', sortOrder: 0, isActive: false },
    { id: 'a', shortcut: 'alpha', title: 'Alpha', body: 'A', sortOrder: 1, isActive: true },
  ]).map(item => item.id), ['a', 'b']);

  let focused = 0;
  const input = { value: 'Hola mundo', selectionStart: 5, selectionEnd: 5, disabled: false, focus() { focused += 1; } };
  const events = [];
  input.dispatchEvent = event => events.push(event.type);
  const result = insertQuickReplyAtSelection(input, 'querida ');
  assert.deepEqual(result, { inserted: true, value: 'Hola querida mundo', cursor: 13 });
  assert.equal(input.value, 'Hola querida mundo');
  assert.equal(focused, 1);
  assert.deepEqual(events, ['input']);
  input.value += '!';
  assert.equal(input.value, 'Hola querida mundo!');

  const full = { ...input, value: 'x'.repeat(4096), selectionStart: 4096, selectionEnd: 4096, focus() { focused += 1; }, dispatchEvent() { throw new Error('no mutation event'); } };
  assert.deepEqual(insertQuickReplyAtSelection(full, 'y'), { inserted: false, reason: 'max_length' });
  assert.equal(full.value.length, 4096);
});

test('COMMIT ambiguo descarta conexión, no hace rollback y expone outcome_unknown sanitizado', async () => {
  const statements = [];
  let releasedWith;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (/FROM public\.usuarios/.test(sql)) return { rows: [{ role: 'admin', empresa_id: 7, activo: true }] };
      if (/^INSERT INTO public\.whatsapp_cloud_quick_replies/.test(sql.trim())) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', shortcut: 'hola', title: 'Hola', body: 'Texto', sort_order: 0, is_active: true, version: 1, updated_at: new Date() }] };
      }
      if (sql === 'COMMIT') throw new Error('private transport after commit');
      return { rows: [] };
    },
    release(error) { releasedWith = error; },
  };
  const repository = createQuickRepliesRepository({ pool: { async connect() { return client; } } });
  await assert.rejects(repository.create({
    empresaId: 7, usuarioId: 11, actorRole: 'admin', shortcut: 'hola', title: 'Hola', body: 'Texto', sortOrder: 0, isActive: true,
  }), error => error?.code === 'QUICK_REPLY_OUTCOME_UNKNOWN' && !/private|transport/i.test(error.message));
  assert.equal(statements.includes('ROLLBACK'), false);
  assert.equal(releasedWith?.code, 'QUICK_REPLY_OUTCOME_UNKNOWN');
});

test('Task 5 no importa enqueue ni escribe outbox fuera del boundary productivo', async () => {
  const files = [
    new URL('../src/routes/whatsappCloudQuickRepliesAdmin.js', import.meta.url),
    new URL('../src/whatsappCloud/quickRepliesRepository.js', import.meta.url),
    new URL('../pedidos/whatsapp-cloud.js', import.meta.url),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /enqueueWpp|INSERT\s+INTO\s+(?:public\.)?wpp_outbox/i);
  }
});
