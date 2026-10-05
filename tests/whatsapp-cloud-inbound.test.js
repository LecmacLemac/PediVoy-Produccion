import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWhatsAppCloudInboundConsumer } from '../src/whatsappCloud/inboundConsumer.js';
import { createCloudInboundBotAdapter } from '../src/whatsappCloud/botAdapter.js';
import {
  claimNextCloudInboundEvent,
  finishCloudInboundEvent,
  loadActiveCloudInboundTenant,
  renewCloudInboundProcessingLease,
  resetCloudInboundEventForManualRetry,
  startCloudInboundProcessing,
} from '../src/whatsappCloud/inboundRepository.js';
import { createWhatsAppCloudCombinedConsumer } from '../src/whatsappCloud/combinedConsumer.js';
import { enqueueWppOutboxCorrelatedReply } from '../src/wpp/enqueue.js';
import { pool as dbPool, query as dbQuery, runWithSensitiveDbQueries } from '../src/db.js';

const logger = { info() {}, warn() {}, error() {} };

function textRow(overrides = {}) {
  return {
    id: 41,
    empresa_id: 2,
    message_id: 'wamid.inbound-41',
    sender_id: '5493515550041',
    message_type: 'text',
    event_data: { text: { body: 'ayuda' } },
    ...overrides,
  };
}

test('inbound text usa el bot existente y encola reply correlacionada Cloud del tenant', async () => {
  const replies = [];
  const finishes = [];
  const adapter = createCloudInboundBotAdapter({
    enqueueReply: async input => { replies.push(input); return { queued: true, transportOrigin: 'cloud' }; },
    contextResolver: async (_phone, { empresaId }) => ({
      resolution: 'unique', role: 'cliente', empresa_id: empresaId, chofer_id: null,
      source: 'conocido_historico', tenantLocked: true, workerTenantFixed: true,
    }),
    logger,
  });
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a',
    claimNext: async () => textRow(),
    loadTenant: async () => ({ empresaId: 2 }),
    startProcessing: async () => {},
    renewLease: async () => true,
    finish: async update => finishes.push(update),
    processBotMessage: adapter.process,
    logger,
  });

  const result = await consumer.processOnce();

  assert.deepEqual(result, { outcome: 'processed', eventId: 41 });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].empresaId, 2);
  assert.equal(replies[0].phone, '5493515550041@c.us');
  assert.match(replies[0].message, /Menú \(Cliente\)/);
  assert.equal(replies[0].transportOrigin, 'cloud');
  assert.equal(replies[0].correlationId, 'wamid.inbound-41');
  assert.deepEqual(finishes, [{ id: 41, owner: 'inbound-a', state: 'processed', errorCode: null }]);
});

test('outcome unknown del enqueue aborta sin intentar una respuesta alternativa', async () => {
  const sends = [];
  const observed = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  console.error = (...args) => observed.push(args);
  console.warn = (...args) => observed.push(args);
  try {
    const adapter = createCloudInboundBotAdapter({
      enqueueReply: async input => {
        sends.push(input);
        throw Object.assign(new Error('phone=5493515550041 body=privado token=secret'), {
          code: 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN',
        });
      },
      contextResolver: async (_phone, { empresaId }) => ({
        resolution: 'unique', role: 'cliente', empresa_id: empresaId, chofer_id: null,
        source: 'conocido_historico', tenantLocked: true, workerTenantFixed: true,
      }),
      logger,
    });
    await assert.rejects(adapter.process({
      empresaId: 2, messageId: 'wamid.unknown', senderId: '5493515550041', text: 'consulta cualquiera',
    }), { code: 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN' });
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(sends.length, 1);
  assert.deepEqual(observed, []);
});

test('capability sensible de DB suprime detalle, SQL y parámetros en fallos profundos', async () => {
  const originalConnect = dbPool.connect;
  const observed = [];
  const originalError = console.error;
  dbPool.connect = async () => ({
    async query() { throw new Error('private-db-detail token=secret'); },
    release() {},
  });
  console.error = (...args) => observed.push(args);
  try {
    await assert.rejects(runWithSensitiveDbQueries(() => dbQuery(
      'SELECT $1::text AS private_body',
      ['5493515550041 ayuda ciphertext=v1:private'],
    )));
  } finally {
    dbPool.connect = originalConnect;
    console.error = originalError;
  }
  assert.deepEqual(observed, []);
});

test('fallo del adapter Cloud propaga sin loguear teléfono, body ni detalle privado', async () => {
  const observed = [];
  const originalError = console.error;
  console.error = (...args) => observed.push(args);
  try {
    const adapter = createCloudInboundBotAdapter({
      enqueueReply: async () => { throw new Error('phone=5493515550041 body=ayuda token=secret'); },
      contextResolver: async (_phone, { empresaId }) => ({
        resolution: 'unique', role: 'cliente', empresa_id: empresaId, chofer_id: null,
        source: 'conocido_historico', tenantLocked: true, workerTenantFixed: true,
      }),
      logger,
    });
    await assert.rejects(adapter.process({
      empresaId: 2, messageId: 'wamid.private', senderId: '5493515550041', text: 'ayuda',
    }));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(observed, []);
});

test('tenant Cloud deshabilitado/config cambiado se salta antes de ejecutar bot', async () => {
  let botCalls = 0;
  const finishes = [];
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a', claimNext: async () => textRow(), loadTenant: async () => null,
    startProcessing: async () => assert.fail('no debe iniciar procesamiento'),
    renewLease: async () => true,
    finish: async update => finishes.push(update),
    processBotMessage: async () => { botCalls += 1; }, logger,
  });
  assert.deepEqual(await consumer.processOnce(), {
    outcome: 'skipped', eventId: 41, errorCode: 'cloud_config_invalid',
  });
  assert.equal(botCalls, 0);
  assert.equal(finishes[0].state, 'skipped');
});

test('tipos no soportados quedan skipped sin ejecutar IA ni responder', async () => {
  let botCalls = 0;
  const finishes = [];
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a', claimNext: async () => textRow({ message_type: 'image', event_data: { image: { id: 'media-1' } } }),
    loadTenant: async () => ({ empresaId: 2 }), startProcessing: async () => assert.fail('no debe iniciar'),
    renewLease: async () => true,
    finish: async update => finishes.push(update), processBotMessage: async () => { botCalls += 1; }, logger,
  });
  assert.equal((await consumer.processOnce()).errorCode, 'unsupported_message_type');
  assert.equal(botCalls, 0);
  assert.equal(finishes[0].state, 'skipped');
});

test('fallo después de processing_started queda outcome_unknown y no se reintenta automáticamente', async () => {
  const events = [];
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a', claimNext: async () => textRow(), loadTenant: async () => ({ empresaId: 2 }),
    startProcessing: async update => events.push(['start', update]),
    renewLease: async () => true,
    finish: async update => events.push(['finish', update]),
    processBotMessage: async () => { events.push(['bot']); throw new Error('phone/private body'); }, logger,
  });
  const result = await consumer.processOnce();
  assert.equal(result.outcome, 'outcome_unknown');
  assert.deepEqual(events.map(([name]) => name), ['start', 'bot', 'finish']);
  assert.equal(events[2][1].state, 'outcome_unknown');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('consumer inbound es single-flight y shutdown drena sin nuevos claims', async () => {
  let release;
  let claims = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a', claimNext: async () => { claims += 1; return textRow(); },
    loadTenant: async () => ({ empresaId: 2 }), startProcessing: async () => {}, renewLease: async () => true, finish: async () => {},
    processBotMessage: async () => gate, logger,
  });
  const first = consumer.processOnce();
  assert.strictEqual(consumer.processOnce(), first);
  const draining = consumer.shutdown();
  assert.deepEqual(await consumer.processOnce(), { outcome: 'stopping' });
  release();
  assert.equal(await draining, true);
  assert.equal((await first).outcome, 'processed');
  assert.equal(claims, 1);
});

test('repository usa claim atómico con lease, fencing y policy Cloud durable', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/UPDATE whatsapp_cloud_events AS event/.test(sql)) return [textRow()];
    if (/FROM empresas/.test(sql)) return [{ empresa_id: 2 }];
    if (/SET processing_state = 'processing_started'/.test(sql)) return [{ id: 41 }];
    if (/SET processing_state = \$3/.test(sql)) return [{ id: 41 }];
    return [];
  };
  assert.equal((await claimNextCloudInboundEvent({ query, owner: 'a', leaseMs: 30000 })).id, 41);
  assert.deepEqual(await loadActiveCloudInboundTenant({ query, empresaId: 2 }), { empresaId: 2 });
  await startCloudInboundProcessing({ query, id: 41, owner: 'a', leaseMs: 30000 });
  await finishCloudInboundEvent({ query, id: 41, owner: 'a', state: 'processed', errorCode: null });
  const claimSql = calls[0].sql;
  assert.match(claimSql, /FOR UPDATE OF event SKIP LOCKED/i);
  assert.match(claimSql, /event_kind = 'message'/i);
  assert.match(claimSql, /processing_state = 'pending'/i);
  assert.match(claimSql, /processing_state = 'pre_process'.+claim_until < NOW\(\)/is);
  assert.match(claimSql, /outcome_unknown.+processing_state = 'processing_started'/is);
  assert.match(calls[1].sql, /provider.+cloud/is);
  assert.match(calls[1].sql, /enabled.+boolean/is);
  assert.match(calls[2].sql, /claim_owner = \$2/i);
  assert.match(calls[2].sql, /claim_until >= NOW\(\)/i);
  assert.match(calls[2].sql, /claim_until = NOW\(\) \+ \(\$3 \* INTERVAL '1 millisecond'\)/i);
  assert.match(calls[3].sql, /processing_state = 'processing_started'/i);
  assert.match(calls[3].sql, /claim_until >= NOW\(\)/i);
});

test('retry manual sólo reabre skipped seguros; nunca outcome_unknown', async () => {
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params }); return [{ id: 41 }]; };
  await resetCloudInboundEventForManualRetry({ query, id: 41 });
  assert.match(calls[0].sql, /processing_state = 'skipped'/i);
  assert.match(calls[0].sql, /cloud_config_invalid/i);
  assert.match(calls[0].sql, /unsupported_message_type/i);
  assert.doesNotMatch(calls[0].sql, /outcome_unknown\s*[,)]/i);
});

test('coordinador procesa inbound y outbound en un único tick y drena ambos', async () => {
  const events = [];
  const combined = createWhatsAppCloudCombinedConsumer({
    inbound: { async processOnce() { events.push('inbound'); return { outcome: 'processed' }; }, async shutdown() { events.push('inbound-stop'); return true; } },
    outbound: { async processOnce() { events.push('outbound'); return { outcome: 'idle' }; }, async shutdown() { events.push('outbound-stop'); return true; } },
  });
  assert.deepEqual(await combined.processOnce(), {
    outcome: 'tick', inbound: { outcome: 'processed' }, outbound: { outcome: 'idle' },
  });
  assert.equal(await combined.shutdown(), true);
  assert.deepEqual(events, ['inbound', 'outbound', 'inbound-stop', 'outbound-stop']);
});

test('coordinador aísla fallo inbound y siempre intenta outbound con resultado sanitizado', async () => {
  const calls = [];
  const logs = [];
  const combined = createWhatsAppCloudCombinedConsumer({
    inbound: { async processOnce() { calls.push('inbound'); throw new Error('private inbound body'); }, async shutdown() { return true; } },
    outbound: { async processOnce() { calls.push('outbound'); return { outcome: 'sent' }; }, async shutdown() { return true; } },
    logger: { error: (...args) => logs.push(args) },
  });
  assert.deepEqual(await combined.processOnce(), {
    outcome: 'tick', inbound: { outcome: 'operational_error' }, outbound: { outcome: 'sent' },
  });
  assert.deepEqual(calls.sort(), ['inbound', 'outbound']);
  assert.equal(JSON.stringify(logs).includes('private'), false);
});

test('coordinador aísla fallo outbound y siempre intenta inbound', async () => {
  const calls = [];
  const combined = createWhatsAppCloudCombinedConsumer({
    inbound: { async processOnce() { calls.push('inbound'); return { outcome: 'idle' }; }, async shutdown() { return true; } },
    outbound: { async processOnce() { calls.push('outbound'); throw new Error('private outbound phone'); }, async shutdown() { return true; } },
    logger,
  });
  assert.deepEqual(await combined.processOnce(), {
    outcome: 'tick', inbound: { outcome: 'idle' }, outbound: { outcome: 'operational_error' },
  });
  assert.deepEqual(calls.sort(), ['inbound', 'outbound']);
});

test('coordinador termina seguro cuando fallan ambos canales y conserva single-flight', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const combined = createWhatsAppCloudCombinedConsumer({
    inbound: { async processOnce() { await gate; throw new Error('inbound secret'); }, async shutdown() { return true; } },
    outbound: { async processOnce() { await gate; throw new Error('outbound secret'); }, async shutdown() { return true; } },
    logger,
  });
  const first = combined.processOnce();
  assert.strictEqual(combined.processOnce(), first);
  release();
  assert.deepEqual(await first, {
    outcome: 'tick', inbound: { outcome: 'operational_error' }, outbound: { outcome: 'operational_error' },
  });
});

test('heartbeat renueva durante IA, fencea cada reply y limpia timer al completar', async () => {
  let intervalCallback;
  const cleared = [];
  const renewals = [];
  let releaseBot;
  const botGate = new Promise(resolve => { releaseBot = resolve; });
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a', leaseMs: 1200,
    claimNext: async () => textRow(), loadTenant: async () => ({ empresaId: 2 }),
    startProcessing: async () => {},
    renewLease: async input => { renewals.push(input); return true; },
    finish: async () => {},
    processBotMessage: async ({ assertLease }) => { await botGate; await assertLease(); },
    setIntervalImpl: callback => { intervalCallback = callback; return 91; },
    clearIntervalImpl: handle => cleared.push(handle),
    logger,
  });
  const processing = consumer.processOnce();
  await new Promise(resolve => setImmediate(resolve));
  await intervalCallback();
  releaseBot();
  assert.equal((await processing).outcome, 'processed');
  assert.equal(renewals.length, 3, 'heartbeat, guard pre-reply y revalidación pre-finish');
  assert.deepEqual(cleared, [91]);
});

test('lease perdido antes del reply aborta sin enqueue, fallback ni finish del owner vencido', async () => {
  let enqueues = 0;
  let finishes = 0;
  const adapter = createCloudInboundBotAdapter({
    enqueueReply: async () => { enqueues += 1; },
    contextResolver: async (_phone, { empresaId }) => ({
      resolution: 'unique', role: 'cliente', empresa_id: empresaId, chofer_id: null,
      source: 'conocido_historico', tenantLocked: true, workerTenantFixed: true,
    }),
    logger,
  });
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'expired-owner', leaseMs: 1000,
    claimNext: async () => textRow(), loadTenant: async () => ({ empresaId: 2 }),
    startProcessing: async () => {}, renewLease: async () => false,
    finish: async () => { finishes += 1; }, processBotMessage: adapter.process, logger,
  });
  assert.deepEqual(await consumer.processOnce(), {
    outcome: 'lease_lost', eventId: 41, errorCode: 'cloud_inbound_lease_lost',
  });
  assert.equal(enqueues, 0);
  assert.equal(finishes, 0);
});

test('heartbeat limpia timer cuando el bot falla', async () => {
  const cleared = [];
  const consumer = createWhatsAppCloudInboundConsumer({
    owner: 'inbound-a', leaseMs: 1000,
    claimNext: async () => textRow(), loadTenant: async () => ({ empresaId: 2 }),
    startProcessing: async () => {}, renewLease: async () => true, finish: async () => {},
    processBotMessage: async () => { throw new Error('private bot failure'); },
    setIntervalImpl: () => 92, clearIntervalImpl: handle => cleared.push(handle), logger,
  });
  assert.equal((await consumer.processOnce()).outcome, 'outcome_unknown');
  assert.deepEqual(cleared, [92]);
});

test('shutdown del coordinador cierra admisión antes de esperar un tick activo', async () => {
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const combined = createWhatsAppCloudCombinedConsumer({
    inbound: {
      async processOnce() { events.push('inbound-active'); await gate; return { outcome: 'processed' }; },
      async shutdown() { events.push('inbound-stop'); return true; },
    },
    outbound: {
      async processOnce() { events.push('outbound'); return { outcome: 'idle' }; },
      async shutdown() { events.push('outbound-stop'); return true; },
    },
  });
  const tick = combined.processOnce();
  await Promise.resolve();
  const stopping = combined.shutdown();
  await Promise.resolve();
  assert.deepEqual(events, ['inbound-active', 'outbound', 'inbound-stop', 'outbound-stop']);
  release();
  await tick;
  assert.equal(await stopping, true);
});

test('reply correlacionada sólo permite general o cloud interno y Cloud revalida config bajo lock', async () => {
  const queries = [];
  const client = {
    async query(request, values) {
      const text = typeof request === 'string' ? request : request.text;
      const params = typeof request === 'string' ? (values || []) : request.values;
      queries.push({ text, params, sensitive: typeof request === 'object' && request.sensitive === true });
      if (/SELECT config_integraciones FROM empresas/.test(text)) return { rows: [{ config_integraciones: {
        whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-2', access_token_encrypted: 'v1:test' },
      } }] };
      if (/SELECT id, status, transport_origin/.test(text)) return { rows: [] };
      if (/INSERT INTO wpp_outbox/.test(text)) return { rows: [{ id: 9, status: 'pending', transport_origin: params[3] }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const result = await enqueueWppOutboxCorrelatedReply({
    empresaId: 2, phone: '5493515550002@c.us', message: 'respuesta', transportOrigin: 'cloud',
    correlationId: 'wamid.reply-2',
  }, pool);
  assert.equal(result.transportOrigin, 'cloud');
  assert.ok(queries.some(call => /pg_advisory_xact_lock/.test(call.text)));
  assert.ok(queries.some(call => /INSERT INTO wpp_outbox/.test(call.text) && call.params[3] === 'cloud' && call.sensitive));
  assert.ok(queries.some(call => /INSERT INTO wpp_outbox/.test(call.text)
    && /reply_correlation_id/.test(call.text) && call.params[4] === 'wamid.reply-2'));
  await assert.rejects(
    enqueueWppOutboxCorrelatedReply({ empresaId: 2, phone: '1', message: 'x', transportOrigin: 'company' }, pool),
    { code: 'transport_origin_correlacionado_no_permitido' },
  );
});

test('worker Cloud cablea inbound y outbound en el mismo runtime', () => {
  const source = readFileSync(new URL('../src/whatsappCloud/worker.js', import.meta.url), 'utf8');
  assert.match(source, /createWhatsAppCloudInboundConsumer/);
  assert.match(source, /createCloudInboundBotAdapter/);
  assert.match(source, /enqueueWppOutboxCorrelatedReply/);
  assert.match(source, /createWhatsAppCloudCombinedConsumer/);
  assert.match(source, /consumer:\s*combinedConsumer/);
});
