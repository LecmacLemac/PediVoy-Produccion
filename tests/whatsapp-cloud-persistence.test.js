import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createWhatsAppCloudEventHandler } from '../src/whatsappCloud/eventRepository.js';
import { mountWhatsAppCloudWebhook } from '../src/routes/mountApiModules.js';

function createTransactionHarness(queryImpl) {
  const calls = [];
  let transactions = 0;
  return {
    calls,
    get transactions() { return transactions; },
    withTransaction: async (work) => {
      transactions += 1;
      return work(async (sql, params = []) => {
        calls.push({ sql, params });
        return queryImpl(sql, params);
      });
    },
  };
}

test('resuelve el tenant Cloud desde empresas y persiste un mensaje sanitizado', async () => {
  const harness = createTransactionHarness(async (sql) => {
    if (sql.includes('FROM empresas')) return [{ empresa_id: 17 }];
    if (sql.includes('INSERT INTO whatsapp_cloud_events')) return [{ id: 1 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const handler = createWhatsAppCloudEventHandler({ withTransaction: harness.withTransaction });

  const result = await handler([{
    kind: 'message',
    entryId: 'entry-safe',
    phoneNumberId: 'cloud-number-safe',
    empresaId: 999,
    credentials: { accessToken: 'no-usar' },
    message: {
      id: 'message-safe',
      from: 'sender-safe',
      timestamp: '1710000000',
      type: 'text',
      text: { body: 'contenido necesario' },
      unexpected_secret: 'no-persistir',
    },
  }]);

  assert.deepEqual(result, { accepted: 1, duplicates: 0 });
  const tenantCall = harness.calls.find(({ sql }) => sql.includes('FROM empresas'));
  assert.deepEqual(tenantCall.params, ['cloud-number-safe']);
  assert.match(tenantCall.sql, /config_integraciones[\s\S]*whatsapp[\s\S]*provider[\s\S]*cloud/i);
  assert.match(tenantCall.sql, /enabled/i);
  assert.match(tenantCall.sql, /FOR SHARE/i);

  const insertCall = harness.calls.find(({ sql }) => sql.includes('INSERT INTO whatsapp_cloud_events'));
  assert.ok(insertCall);
  assert.equal(insertCall.params[0], 17);
  assert.equal(insertCall.params[1], 'message');
  assert.equal(insertCall.params[2], 'message:message-safe');
  assert.equal(insertCall.params[3], 'message-safe');
  assert.equal(insertCall.params[4], 'entry-safe');
  assert.equal(insertCall.params[5], 'sender-safe');
  assert.equal(insertCall.params[6], null);
  assert.equal(insertCall.params[7], 'text');
  assert.equal(insertCall.params[8], null);
  assert.equal(insertCall.params[9], '1710000000');
  assert.deepEqual(insertCall.params[10], { text: { body: 'contenido necesario' } });
  assert.equal(JSON.stringify(insertCall.params).includes('no-persistir'), false);
  assert.equal(JSON.stringify(insertCall.params).includes('no-usar'), false);
  assert.equal(insertCall.params.includes(999), false);
  assert.match(insertCall.sql, /ON CONFLICT\s*\(empresa_id,\s*dedupe_key\)\s*DO NOTHING/i);
});

test('confirma grupos multiempresa independientes y el retry recupera solo lo pendiente', async () => {
  const tenants = new Map([
    ['cloud-a', 10],
    ['cloud-b', 20],
  ]);
  const committed = new Set();
  let transactions = 0;
  const withTransaction = async (work) => {
    transactions += 1;
    const pending = new Set();
    const result = await work(async (sql, params = []) => {
      if (sql.includes('FROM empresas')) {
        const empresaId = tenants.get(params[0]);
        return empresaId === undefined ? [] : [{ empresa_id: empresaId }];
      }
      if (sql.includes('INSERT INTO whatsapp_cloud_events')) {
        const key = `${params[0]}:${params[2]}`;
        if (committed.has(key) || pending.has(key)) return [];
        pending.add(key);
        return [{ id: committed.size + pending.size }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    });
    for (const key of pending) committed.add(key);
    return result;
  };
  const handler = createWhatsAppCloudEventHandler({ withTransaction });
  const events = [
    { kind: 'message', phoneNumberId: 'cloud-a', message: { id: 'same-id', from: 'sender-a', timestamp: '1', type: 'future' } },
    { kind: 'message', phoneNumberId: 'cloud-missing', message: { id: 'pending-id', from: 'sender-x', timestamp: '2', type: 'future' } },
    { kind: 'message', phoneNumberId: 'cloud-b', message: { id: 'same-id', from: 'sender-b', timestamp: '3', type: 'future' } },
  ];

  await assert.rejects(handler(events), error => error?.code === 'unknown_tenant');
  assert.deepEqual([...committed].sort(), [
    '10:message:same-id',
    '20:message:same-id',
  ]);
  assert.equal(transactions, 3);

  tenants.set('cloud-missing', 30);
  assert.deepEqual(await handler(events), { accepted: 1, duplicates: 2 });
  assert.deepEqual([...committed].sort(), [
    '10:message:same-id',
    '20:message:same-id',
    '30:message:pending-id',
  ]);
  assert.equal(transactions, 6);
});

test('procesa un batch multiempresa y distingue transiciones de estado sin duplicar reintentos', async () => {
  const insertedKeys = new Set();
  const harness = createTransactionHarness(async (sql, params) => {
    if (sql.includes('FROM empresas')) {
      if (params[0] === 'cloud-a') return [{ empresa_id: 10 }];
      if (params[0] === 'cloud-b') return [{ empresa_id: 20 }];
    }
    if (sql.includes('INSERT INTO whatsapp_cloud_events')) {
      const dedupeKey = params[2];
      if (insertedKeys.has(dedupeKey)) return [];
      insertedKeys.add(dedupeKey);
      return [{ id: insertedKeys.size }];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const handler = createWhatsAppCloudEventHandler({ withTransaction: harness.withTransaction });
  const delivered = {
    kind: 'status',
    entryId: 'entry-b',
    phoneNumberId: 'cloud-b',
    status: {
      id: 'outbound-safe',
      status: 'delivered',
      timestamp: '1710000100',
      recipient_id: 'recipient-safe',
      conversation: { id: 'conversation-safe' },
      pricing: { category: 'utility' },
      unexpected_secret: 'no-persistir',
    },
  };

  const result = await handler([
    {
      kind: 'message',
      entryId: 'entry-a',
      phoneNumberId: 'cloud-a',
      message: { id: 'incoming-safe', from: 'sender-safe', timestamp: '1710000000', type: 'image', image: { id: 'media-safe', caption: 'foto' } },
    },
    delivered,
    delivered,
    { ...delivered, status: { ...delivered.status, status: 'read', timestamp: '1710000200' } },
  ]);

  assert.deepEqual(result, { accepted: 3, duplicates: 1 });
  const tenantLookups = harness.calls.filter(({ sql }) => sql.includes('FROM empresas'));
  assert.deepEqual(tenantLookups.map(call => call.params[0]), ['cloud-a', 'cloud-b']);
  const inserts = harness.calls.filter(({ sql }) => sql.includes('INSERT INTO whatsapp_cloud_events'));
  assert.deepEqual(inserts.map(call => call.params[0]), [10, 20, 20, 20]);
  assert.deepEqual(inserts.map(call => call.params[2]), [
    'message:incoming-safe',
    'status:outbound-safe:delivered:1710000100',
    'status:outbound-safe:delivered:1710000100',
    'status:outbound-safe:read:1710000200',
  ]);
  assert.deepEqual(inserts[0].params[10], { image: { id: 'media-safe', caption: 'foto' } });
  assert.deepEqual(inserts[1].params.slice(3, 11), [
    'outbound-safe',
    'entry-b',
    null,
    'recipient-safe',
    null,
    'delivered',
    '1710000100',
    { conversationId: 'conversation-safe', pricingCategory: 'utility' },
  ]);
  assert.equal(JSON.stringify(inserts).includes('no-persistir'), false);
});

test('falla cerrado con tenant ausente, desconocido o ambiguo sin filtrar el phone number id', async () => {
  const cases = [
    { phoneNumberId: null, tenants: [], code: 'invalid_event' },
    { phoneNumberId: 'unknown-sensitive', tenants: [], code: 'unknown_tenant' },
    { phoneNumberId: 'ambiguous-sensitive', tenants: [{ empresa_id: 1 }, { empresa_id: 2 }], code: 'ambiguous_tenant' },
  ];

  for (const scenario of cases) {
    let insertCalls = 0;
    const harness = createTransactionHarness(async (sql) => {
      if (sql.includes('FROM empresas')) return scenario.tenants;
      if (sql.includes('INSERT INTO whatsapp_cloud_events')) insertCalls += 1;
      return [];
    });
    const handler = createWhatsAppCloudEventHandler({ withTransaction: harness.withTransaction });
    await assert.rejects(
      handler([{
        kind: 'message',
        phoneNumberId: scenario.phoneNumberId,
        message: { id: 'safe-id', type: 'text', text: { body: 'safe' } },
      }]),
      error => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.message.includes(String(scenario.phoneNumberId)), false);
        return true;
      }
    );
    assert.equal(insertCalls, 0);
  }
});

test('rechaza estados sin identidad completa antes de persistir', async () => {
  const harness = createTransactionHarness(async (sql) => {
    if (sql.includes('FROM empresas')) return [{ empresa_id: 1 }];
    assert.fail('no debe insertar un estado sin timestamp');
  });
  const handler = createWhatsAppCloudEventHandler({ withTransaction: harness.withTransaction });

  await assert.rejects(
    handler([{
      kind: 'status',
      phoneNumberId: 'cloud-safe',
      status: { id: 'out-safe', status: 'delivered' },
    }]),
    error => error?.code === 'invalid_event'
  );
});

test('rechaza mensajes inbound con identidad incompleta o payload conocido incompleto', async () => {
  const invalidMessages = [
    { id: '', from: 'sender', timestamp: '1', type: 'future' },
    { id: 'm-1', from: '', timestamp: '1', type: 'future' },
    { id: 'm-1', from: 'sender', timestamp: '', type: 'future' },
    { id: 'm-1', from: 'sender', timestamp: '1', type: '' },
    { id: 'm-1', from: 'sender', timestamp: '1', type: 'text', text: {} },
    { id: 'm-1', from: 'sender', timestamp: '1', type: 'image', image: {} },
  ];

  for (const message of invalidMessages) {
    let inserts = 0;
    const harness = createTransactionHarness(async (sql) => {
      if (sql.includes('FROM empresas')) return [{ empresa_id: 1 }];
      if (sql.includes('INSERT INTO whatsapp_cloud_events')) inserts += 1;
      return [];
    });
    const handler = createWhatsAppCloudEventHandler({ withTransaction: harness.withTransaction });
    await assert.rejects(
      handler([{ kind: 'message', phoneNumberId: 'cloud-safe', message }]),
      error => error?.code === 'invalid_event'
    );
    assert.equal(inserts, 0);
  }
});

test('persiste tipos futuros sin copiar el payload opaco', async () => {
  const harness = createTransactionHarness(async (sql) => {
    if (sql.includes('FROM empresas')) return [{ empresa_id: 1 }];
    if (sql.includes('INSERT INTO whatsapp_cloud_events')) return [{ id: 1 }];
    return [];
  });
  const handler = createWhatsAppCloudEventHandler({ withTransaction: harness.withTransaction });

  await handler([{
    kind: 'message',
    phoneNumberId: 'cloud-safe',
    message: { id: 'future-1', from: 'sender', timestamp: '1', type: 'future_type', future_type: { secret: 'opaque' } },
  }]);

  const insert = harness.calls.find(({ sql }) => sql.includes('INSERT INTO whatsapp_cloud_events'));
  assert.deepEqual(insert.params[10], {});
});

test('initDb crea y migra el inbox Cloud con constraints de idempotencia', async () => {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('-- BEGIN WHATSAPP CLOUD INBOX MIGRATION');
  const end = sql.indexOf('-- END WHATSAPP CLOUD INBOX MIGRATION');
  assert.ok(start >= 0 && end > start, 'falta bloque de migración Cloud delimitado');
  const migration = sql.slice(start, end);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS whatsapp_cloud_events/i);
  assert.match(migration, /BEGIN;[\s\S]*COMMIT;/i);
  assert.doesNotMatch(migration, /LOCK TABLE whatsapp_cloud_events/i);
  assert.match(migration, /empresa_id\s+INTEGER\s+NOT NULL\s+REFERENCES empresas\(id\)/i);
  assert.match(migration, /dedupe_key\s+TEXT\s+NOT NULL/i);
  assert.match(migration, /CHECK\s*\(event_kind IN \('message', 'status'\)\)/i);
  assert.match(migration, /ALTER TABLE whatsapp_cloud_events ADD COLUMN %I %s/i);
  assert.match(migration, /CREATE SEQUENCE IF NOT EXISTS whatsapp_cloud_events_id_seq AS BIGINT/i);
  assert.match(migration, /ALTER COLUMN id SET DEFAULT nextval/i);
  assert.match(migration, /ALTER COLUMN event_data SET DEFAULT/i);
  assert.match(migration, /ALTER TABLE whatsapp_cloud_events ALTER COLUMN %I SET NOT NULL/i);
  assert.doesNotMatch(migration, /DROP INDEX IF EXISTS idx_whatsapp_cloud_events_dedupe_key/i);
  assert.match(migration, /CREATE UNIQUE INDEX idx_whatsapp_cloud_events_dedupe_key[\s\S]*\(empresa_id,\s*dedupe_key\)/i);
  assert.match(migration, /CREATE UNIQUE INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique[\s\S]*phone_number_id/i);
  assert.match(migration, /CONSTRAINT whatsapp_cloud_events_empresa_id_fkey[\s\S]*REFERENCES empresas\(id\)[\s\S]*ON DELETE CASCADE/i);
  assert.match(migration, /FROM pg_constraint/i);
  assert.match(migration, /FROM pg_index/i);
});

test('montaje Cloud conecta transacción, handler y router usando dependencias inyectadas', () => {
  const uses = [];
  const app = { use: (...args) => uses.push(args) };
  const withTransaction = async () => {};
  const handler = async () => {};
  const router = { name: 'cloud-router' };
  let handlerOptions;
  let routerOptions;

  const mounted = mountWhatsAppCloudWebhook(app, {
    withTransaction,
    createEventHandler(options) {
      handlerOptions = options;
      return handler;
    },
    createWebhookRouter(options) {
      routerOptions = options;
      return router;
    },
  });

  assert.deepEqual(handlerOptions, { withTransaction });
  assert.deepEqual(routerOptions, { handler });
  assert.deepEqual(uses, [['/api/webhooks/whatsapp', router]]);
  assert.deepEqual(mounted, { handler, router });
});
