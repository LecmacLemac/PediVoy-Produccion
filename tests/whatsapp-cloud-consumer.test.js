import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudDeliveryOutcome,
  createWhatsAppCloudConsumer,
} from '../src/whatsappCloud/consumer.js';
import { createWhatsAppCloudGraphClient } from '../src/whatsappCloud/graphClient.js';
import {
  claimNextCloudOutboxRow,
  finishCloudOutboxRow,
  loadDurableCloudConfig,
  markCloudDispatchStarted,
} from '../src/whatsappCloud/outboxRepository.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('claim Cloud es disjunto y single-flight', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return [{ id: 9, empresa_id: 4, telefono: '5493515550000', mensaje: 'hola' }];
  };

  const row = await claimNextCloudOutboxRow({ query, owner: 'cloud-worker-1', leaseMs: 30_000 });

  assert.equal(row.id, 9);
  assert.match(calls[0].sql, /transport_origin\s*=\s*'cloud'/i);
  assert.match(calls[0].sql, /FOR UPDATE OF o SKIP LOCKED/i);
  assert.match(calls[0].sql, /SET status = 'sending'/i);
  assert.match(calls[0].sql, /cloud_dispatch_state = 'pre_dispatch'/i);
  assert.match(calls[0].sql, /status = 'sending'.+cloud_dispatch_state = 'pre_dispatch'/is);
  assert.match(calls[0].sql, /claim_until IS NULL OR o\.claim_until < NOW\(\)/i);
  assert.match(calls[0].sql, /LIMIT 1/i);
  assert.doesNotMatch(calls[0].sql, /transport_origin IS NULL/i);
});

test('claim Cloud normaliza lease hostil antes de enviarlo a PostgreSQL', async () => {
  const observed = [];
  const query = async (_sql, params) => {
    observed.push(params[1]);
    return [];
  };
  const invalid = [NaN, Infinity, -Infinity, 0, -1, 1.5, '', 'abc', '10ms', '1e3', '1.5', '9007199254740992', 2 ** 40];

  for (const leaseMs of invalid) {
    await claimNextCloudOutboxRow({ query, owner: 'worker', leaseMs });
  }
  await claimNextCloudOutboxRow({ query, owner: 'worker', leaseMs: '1000' });
  await claimNextCloudOutboxRow({ query, owner: 'worker', leaseMs: '900000' });

  assert.deepEqual(observed, [
    ...invalid.map(() => 120_000),
    1_000,
    900_000,
  ]);
});

test('Graph success usa v26.0, Bearer y payload text sin filtrar token', async () => {
  const requests = [];
  const client = createWhatsAppCloudGraphClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(200, { messages: [{ id: 'wamid.safe_123' }] });
    },
  });

  const result = await client.sendText({
    phoneNumberId: '12345',
    accessToken: 'secret-token',
    to: '+54 (351) 555-0000',
    text: 'Hola',
  });

  assert.deepEqual(result, { outcome: CloudDeliveryOutcome.SENT, messageId: 'wamid.safe_123' });
  assert.equal(requests[0].url, 'https://graph.facebook.com/v26.0/12345/messages');
  assert.equal(requests[0].options.headers.authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '543515550000',
    type: 'text',
    text: { preview_url: false, body: 'Hola' },
  });
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('consumer preserva leaseMs decimal string hasta el normalizador del repository', async () => {
  const claims = [];
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    leaseMs: '900000',
    claimNext: async options => { claims.push(options); return null; },
    loadConfig: async () => null,
    startDispatch: async () => {},
    finish: async () => {},
    decryptToken: value => value,
    graphClient: { sendText: async () => ({ outcome: CloudDeliveryOutcome.SENT, messageId: 'x' }) },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(await consumer.processOnce(), { outcome: 'idle' });
  assert.deepEqual(claims, [{ owner: 'worker', leaseMs: '900000' }]);
});

test('consumer persiste dispatch_started antes de invocar Graph', async () => {
  const events = [];
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => ({ id: 30, empresa_id: 7, telefono: '3515550000', mensaje: 'hola' }),
    loadConfig: async () => ({ phoneNumberId: '123', accessTokenEncrypted: 'cipher' }),
    startDispatch: async update => events.push(['dispatch_started', update]),
    finish: async update => events.push(['finish', update]),
    decryptToken: () => 'token',
    graphClient: {
      sendText: async () => {
        events.push(['graph']);
        return { outcome: CloudDeliveryOutcome.SENT, messageId: 'wamid.30' };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await consumer.processOnce();

  assert.deepEqual(events.map(([event]) => event), ['dispatch_started', 'graph', 'finish']);
  assert.deepEqual(events[0][1], { id: 30, owner: 'worker' });
  assert.equal(events[2][1].dispatchState, 'sent');
});

test('si no puede persistir dispatch_started no invoca Graph ni finaliza', async () => {
  let graphCalls = 0;
  let finishCalls = 0;
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => ({ id: 31, empresa_id: 7, telefono: '3515550000', mensaje: 'hola' }),
    loadConfig: async () => ({ phoneNumberId: '123', accessTokenEncrypted: 'cipher' }),
    startDispatch: async () => { throw new Error('db unavailable'); },
    finish: async () => { finishCalls += 1; },
    decryptToken: () => 'token',
    graphClient: { sendText: async () => { graphCalls += 1; } },
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(consumer.processOnce(), /db unavailable/);
  assert.equal(graphCalls, 0);
  assert.equal(finishCalls, 0);
});

test('config durable inválida falla cerrado antes de Graph y sin fallback', async () => {
  let graphCalls = 0;
  const finishes = [];
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => ({ id: 1, empresa_id: 7, telefono: '3515550000', mensaje: 'hola' }),
    loadConfig: async () => null,
    startDispatch: async () => assert.fail('dispatch no debe comenzar'),
    finish: async update => finishes.push(update),
    decryptToken: () => { throw new Error('no debe descifrar'); },
    graphClient: { sendText: async () => { graphCalls += 1; } },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await consumer.processOnce();

  assert.equal(result.outcome, CloudDeliveryOutcome.DEFINITIVE_FAILURE);
  assert.equal(graphCalls, 0);
  assert.equal(finishes[0].status, 'error');
  assert.equal(finishes[0].errorCode, 'cloud_config_invalid');
  assert.equal(finishes[0].dispatchState, 'definitive_failed');
  assert.equal(JSON.stringify(finishes).includes('company'), false);
  assert.equal(JSON.stringify(finishes).includes('general'), false);
});

test('token inválido se sanitiza y nunca llega a logs, errores ni DTO', async () => {
  const secretCiphertext = 'v1:encrypted-secret-material';
  const logs = [];
  const finishes = [];
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => ({ id: 2, empresa_id: 8, telefono: '3515550000', mensaje: 'hola' }),
    loadConfig: async () => ({ phoneNumberId: '123', accessTokenEncrypted: secretCiphertext }),
    startDispatch: async () => assert.fail('dispatch no debe comenzar'),
    finish: async update => finishes.push(update),
    decryptToken: () => { throw new Error(`bad token ${secretCiphertext}`); },
    graphClient: { sendText: async () => assert.fail('Graph no debe ejecutarse') },
    logger: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
  });

  const result = await consumer.processOnce();

  const observable = JSON.stringify({ logs, finishes, result });
  assert.equal(observable.includes(secretCiphertext), false);
  assert.equal(observable.includes('bad token'), false);
  assert.equal(finishes[0].errorCode, 'cloud_token_invalid');
});

test('timeout/network tras despachar queda unknown, terminal y sin retry automático', async () => {
  let fetchCalls = 0;
  const keepAlive = setTimeout(() => {}, 250);
  const client = createWhatsAppCloudGraphClient({
    timeoutMs: 100,
    fetchImpl: async (_url, { signal }) => {
      fetchCalls += 1;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('secret network detail'), { name: 'AbortError' })), { once: true }));
    },
  });

  let result;
  try {
    result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
  } finally {
    clearTimeout(keepAlive);
  }

  assert.deepEqual(result, { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' });
  assert.equal(fetchCalls, 1);
});

test('429 se distingue como rechazo retryable pero queda terminal para replay manual', async () => {
  const client = createWhatsAppCloudGraphClient({
    fetchImpl: async () => jsonResponse(429, { error: { message: 'contains PII and token' } }, { 'retry-after': '30' }),
  });

  const result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });

  assert.deepEqual(result, {
    outcome: CloudDeliveryOutcome.RETRYABLE_REJECTED,
    errorCode: 'cloud_rate_limited',
  });
  assert.equal(JSON.stringify(result).includes('PII'), false);
});

test('408 se trata como unknown terminal porque el outcome remoto es ambiguo', async () => {
  const client = createWhatsAppCloudGraphClient({
    fetchImpl: async () => jsonResponse(408, { error: { message: 'unsafe detail' } }),
  });
  const result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
  assert.deepEqual(result, { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' });
});

test('respuestas Graph 4xx, 429 y 5xx cancelan el body una vez sin parsearlo', async () => {
  for (const [status, expected] of [
    [400, { outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_remote_rejected' }],
    [429, { outcome: CloudDeliveryOutcome.RETRYABLE_REJECTED, errorCode: 'cloud_rate_limited' }],
    [503, { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' }],
  ]) {
    let cancelCalls = 0;
    let readCalls = 0;
    const client = createWhatsAppCloudGraphClient({
      fetchImpl: async () => ({
        ok: false,
        status,
        body: {
          async cancel() { cancelCalls += 1; },
          async json() { readCalls += 1; },
          async text() { readCalls += 1; },
        },
      }),
    });
    const result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
    assert.deepEqual(result, expected);
    assert.equal(cancelCalls, 1);
    assert.equal(readCalls, 0);
  }
});

test('cancelación de body colgada queda acotada y conserva la clasificación original', async () => {
  let cancelCalls = 0;
  const keepAlive = setTimeout(() => {}, 250);
  const client = createWhatsAppCloudGraphClient({
    cancelTimeoutMs: 15,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      body: {
        cancel() {
          cancelCalls += 1;
          return new Promise(() => {});
        },
      },
    }),
  });

  const startedAt = Date.now();
  let result;
  try {
    result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
  } finally {
    clearTimeout(keepAlive);
  }
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, { outcome: CloudDeliveryOutcome.RETRYABLE_REJECTED, errorCode: 'cloud_rate_limited' });
  assert.equal(cancelCalls, 1);
  assert.ok(elapsedMs >= 8, `cancelación terminó demasiado pronto: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 200, `cancelación excedió el límite: ${elapsedMs}ms`);
});

test('rechazo tardío de cancelación queda observado sin alterar el resultado', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let cancelCalls = 0;
    const client = createWhatsAppCloudGraphClient({
      cancelTimeoutMs: 5,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        body: {
          cancel() {
            cancelCalls += 1;
            return new Promise((_, reject) => setTimeout(() => reject(new Error('late secret body detail')), 25));
          },
        },
      }),
    });

    const result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
    await new Promise(resolve => setTimeout(resolve, 35));

    assert.deepEqual(result, { outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_remote_rejected' });
    assert.equal(cancelCalls, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('fallo al cancelar body no-ok no cambia la clasificación ni filtra detalles', async () => {
  const client = createWhatsAppCloudGraphClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: { async cancel() { throw new Error('secret body detail'); } },
    }),
  });
  const result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
  assert.deepEqual(result, { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' });
});

test('5xx se trata como unknown para evitar duplicados', async () => {
  const client = createWhatsAppCloudGraphClient({
    fetchImpl: async () => jsonResponse(503, { error: { message: 'unsafe detail' } }),
  });
  const result = await client.sendText({ phoneNumberId: '123', accessToken: 'secret', to: '3515550000', text: 'hola' });
  assert.deepEqual(result, { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' });
});

test('message id se sanitiza antes de persistir', async () => {
  const calls = [];
  await finishCloudOutboxRow({
    query: async (sql, params) => { calls.push({ sql, params }); return [{ id: 4 }]; },
    id: 4,
    owner: 'worker',
    status: 'sent',
    dispatchState: 'sent',
    messageId: ' wamid.safe_ABC-123:xyz\nBearer secret ',
  });

  assert.equal(calls[0].params[3], 'wamid.safe_ABC-123:xyzBearersecret');
  assert.equal(calls[0].params[3].includes('\n'), false);
});

test('dispatch_started usa fencing por owner y sólo parte de pre_dispatch', async () => {
  const calls = [];
  await markCloudDispatchStarted({
    query: async (sql, params) => { calls.push({ sql, params }); return [{ id: 4 }]; },
    id: 4,
    owner: 'worker',
  });
  assert.match(calls[0].sql, /cloud_dispatch_state = 'dispatch_started'/i);
  assert.match(calls[0].sql, /cloud_dispatch_state = 'pre_dispatch'/i);
  assert.match(calls[0].sql, /claim_owner = \$2/i);
});

test('config durable exige empresa y Cloud completo con boolean true', async () => {
  const calls = [];
  const config = await loadDurableCloudConfig({
    query: async (sql, params) => { calls.push({ sql, params }); return []; },
    empresaId: 22,
  });
  assert.equal(config, null);
  assert.match(calls[0].sql, /jsonb_typeof\(.+enabled.+\) = 'boolean'/is);
  assert.match(calls[0].sql, /provider.+cloud/is);
  assert.match(calls[0].sql, /access_token_encrypted/is);
});

test('concurrencia local ejecuta un solo claim a la vez', async () => {
  let claims = 0;
  let releaseClaim;
  const claimGate = new Promise(resolve => { releaseClaim = resolve; });
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => { claims += 1; await claimGate; return null; },
    loadConfig: async () => null,
    startDispatch: async () => {},
    finish: async () => {},
    decryptToken: value => value,
    graphClient: { sendText: async () => ({ outcome: CloudDeliveryOutcome.SENT, messageId: 'x' }) },
    logger: { info() {}, warn() {}, error() {} },
  });

  const first = consumer.processOnce();
  const second = consumer.processOnce();
  assert.strictEqual(first, second);
  releaseClaim();
  await first;
  assert.equal(claims, 1);
});

test('shutdown deja de reclamar y espera drain acotado', async () => {
  let finishSend;
  let claims = 0;
  const sendGate = new Promise(resolve => { finishSend = resolve; });
  const consumer = createWhatsAppCloudConsumer({
    owner: 'worker',
    claimNext: async () => { claims += 1; return { id: 5, empresa_id: 9, telefono: '3515550000', mensaje: 'hola' }; },
    loadConfig: async () => ({ phoneNumberId: '123', accessTokenEncrypted: 'cipher' }),
    startDispatch: async () => {},
    finish: async () => {},
    decryptToken: () => 'token',
    graphClient: { sendText: async () => { await sendGate; return { outcome: CloudDeliveryOutcome.SENT, messageId: 'wamid.1' }; } },
    logger: { info() {}, warn() {}, error() {} },
  });

  const active = consumer.processOnce();
  const drain = consumer.shutdown({ timeoutMs: 100 });
  assert.deepEqual(await consumer.processOnce(), { outcome: 'stopping' });
  finishSend();
  assert.equal(await drain, true);
  await active;
  assert.equal(claims, 1);
});
