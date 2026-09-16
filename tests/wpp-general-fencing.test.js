import test from 'node:test';
import assert from 'node:assert/strict';

import handlers from '../src/handlers.js';
import {
  claimWppOutboxRows,
  finishWppOutboxClaim,
  releaseWppOutboxClaim,
  startWppOutboxDelivery,
} from '../src/wpp/delivery.js';
import { createIncomingMediaHandler } from '../src/wpp/incomingMedia.js';
import { createOutboxProcessor } from '../src/wpp/outboxProcessor.js';

function outboxQuery(row) {
  const statements = [];
  const query = async (sql, params = []) => {
    statements.push({ sql: String(sql), params });
    if (/WITH candidates AS/i.test(sql)) return [row];
    if (/UPDATE wpp_outbox[\s\S]*status = 'sending'/i.test(sql)) return [{ id: row.id }];
    if (/RETURNING id/i.test(sql)) return [{ id: row.id }];
    return [];
  };
  return { query, statements };
}

test('General pierde ownership inmediatamente antes del envío, no transporta y libera pending con el mismo fence', async () => {
  const { query, statements } = outboxQuery({ id: 11, telefono: '123@lid', mensaje: 'hola' });
  let sends = 0;
  let gates = 0;
  const client = {
    getChatById: async () => null,
    sendMessage: async () => { sends += 1; },
  };
  const withActiveClient = async fn => {
    gates += 1;
    if (gates === 4) throw Object.assign(new Error('lease lost'), { code: 'WPP_NOT_OWNER' });
    return fn({ client, ownerId: 'runtime-owner', epoch: 7n, generation: 1 });
  };
  const processor = createOutboxProcessor({
    ENABLE_WPP: true,
    query,
    lidByPhone: new Map(),
    safeErrorString: String,
    getClient: () => client,
    getIsReady: () => true,
    getIsShuttingDown: () => false,
    requestRestart: async () => {},
    withActiveClient,
  });

  await processor.processOutbox();

  assert.equal(sends, 0);
  assert.equal(gates, 4, 'cada uso del transporte debe volver a atravesar el fence');
  const claim = statements.find(({ sql }) => /WITH candidates AS/i.test(sql));
  assert.equal(claim.params[0], 'runtime-owner');
  assert.ok(statements.some(({ sql, params }) =>
    /SET status = 'pending'/i.test(sql) && params[1] === 11 && params[2] === 'runtime-owner'));
  assert.equal(statements.some(({ params }) => params[0] === 'error'), false);
});

test('si cambió el owner global, el fallo pre-transporte deja sending para revisión manual', async () => {
  const statements = [];
  let sends = 0;
  const row = { id: 12, telefono: '123@lid', mensaje: 'hola' };
  const query = async (sql, params = []) => {
    statements.push({ sql: String(sql), params });
    if (/WITH candidates AS/i.test(sql)) return [row];
    if (/SET status = 'sending'/i.test(sql)) return [{ id: row.id }];
    if (/SET status = 'pending'/i.test(sql)) return [];
    return [];
  };
  let gates = 0;
  const client = {
    getChatById: async () => null,
    sendMessage: async () => { sends += 1; },
  };
  const processor = createOutboxProcessor({
    ENABLE_WPP: true,
    query,
    lidByPhone: new Map(),
    safeErrorString: String,
    getClient: () => client,
    getIsReady: () => true,
    getIsShuttingDown: () => false,
    requestRestart: async () => {},
    withActiveClient: async fn => {
      gates += 1;
      if (gates === 4) throw Object.assign(new Error('owner changed'), { code: 'WPP_NOT_OWNER' });
      return fn({ client, ownerId: 'owner-old', epoch: 7n, generation: 1 });
    },
  });

  await processor.processOutbox();

  assert.equal(sends, 0);
  assert.ok(statements.some(({ sql }) => /SET status = 'sending'/i.test(sql)));
  assert.ok(statements.some(({ sql }) => /SET status = 'pending'/i.test(sql)));
  assert.equal(statements.some(({ params }) => params[0] === 'error'), false);
});

test('un resultado de entrega desconocido queda fuera del reintento automático', async () => {
  const { query, statements } = outboxQuery({ id: 13, telefono: '123@lid', mensaje: 'hola' });
  const client = {
    getChatById: async () => null,
    sendMessage: async () => { throw new Error('socket closed after dispatch'); },
  };
  const processor = createOutboxProcessor({
    ENABLE_WPP: true,
    query,
    lidByPhone: new Map(),
    safeErrorString: String,
    getClient: () => client,
    getIsReady: () => true,
    getIsShuttingDown: () => false,
    requestRestart: async () => {},
    withActiveClient: fn => fn({ client, ownerId: 'general-a', epoch: 7n, generation: 1 }),
  });

  await processor.processOutbox();

  const rowUpdates = statements.filter(({ sql, params }) =>
    /UPDATE wpp_outbox/i.test(sql) && params.includes(13));
  assert.ok(rowUpdates.some(({ sql }) => /status = 'sending'/i.test(sql)));
  assert.ok(rowUpdates.some(({ params }) => params[0] === 'error'));
  assert.equal(
    rowUpdates.some(({ sql, params }) => /status = 'pending'/i.test(sql) && params[1] === 13),
    false,
    'una entrega iniciada nunca vuelve a pending automáticamente',
  );
});

test('un epoch viejo no puede finalizar el claim de outbox', async () => {
  let captured;
  await assert.rejects(
    finishWppOutboxClaim({
      query: async (sql, params) => { captured = { sql: String(sql), params }; return []; },
      id: 12,
      owner: 'general-a',
      epoch: 6n,
      status: 'sent',
      sent: true,
    }),
    error => error?.code === 'WPP_OUTBOX_CLAIM_LOST'
  );

  assert.match(captured.sql, /claim_epoch\s*=\s*\$6/i);
  assert.equal(captured.params[5], '6');
});

test('claim General queda etiquetado y globalmente cercado por owner y epoch', async () => {
  let captured;
  await claimWppOutboxRows({
    query: async (sql, params) => { captured = { sql: String(sql), params }; return []; },
    owner: 'general-a',
    epoch: 9n,
    limit: 3,
  });

  assert.match(captured.sql, /claim_epoch\s*=\s*\$2/i);
  assert.match(captured.sql, /EXISTS\s*\([\s\S]*wpp_general_control[\s\S]*owner_id\s*=\s*\$1[\s\S]*epoch\s*=\s*\$2/i);
  assert.deepEqual(captured.params.slice(0, 4), ['general-a', '9', 120000, 3]);
});

test('start finish y release General exigen el mismo owner+epoch global y una fila exacta', async () => {
  const statements = [];
  const query = async (sql, params) => {
    statements.push({ sql: String(sql), params });
    return [{ id: 17 }];
  };

  await startWppOutboxDelivery({ query, id: 17, owner: 'owner-a', epoch: 9n });
  await finishWppOutboxClaim({
    query, id: 17, owner: 'owner-a', epoch: 9n, status: 'sent', sent: true,
  });
  await releaseWppOutboxClaim({
    query, id: 17, owner: 'owner-a', epoch: 9n, error: 'retry',
  });

  assert.equal(statements.length, 3);
  for (const { sql, params } of statements) {
    assert.match(sql, /EXISTS\s*\([\s\S]*wpp_general_control[\s\S]*owner_id[\s\S]*epoch/i);
    assert.ok(params.includes('owner-a'));
    assert.ok(params.includes('9'));
  }
});

test('release General falla cerrado cuando el fence global ya cambió', async () => {
  await assert.rejects(
    releaseWppOutboxClaim({
      query: async () => [],
      id: 18,
      owner: 'owner-old',
      epoch: 4n,
      error: 'retry',
    }),
    error => error?.code === 'WPP_OUTBOX_CLAIM_LOST',
  );
});

test('lease loss cierra el handler completo antes de resolver contexto o usar transporte', async () => {
  let listener;
  let resolves = 0;
  let sends = 0;
  const client = {
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage() { sends += 1; },
  };
  handlers.start(client, {
    contextResolver: async () => {
      resolves += 1;
      return { role: 'cliente', empresa_id: 7, source: 'cliente' };
    },
    withActiveClient: () => {
      throw Object.assign(new Error('lease lost'), { code: 'WPP_NOT_OWNER' });
    },
  });

  const listenerResult = listener({
    from: '5493510000000@c.us',
    body: 'ayuda',
    id: { _serialized: 'handler-fence-1', fromMe: false },
  });
  assert.equal(typeof listenerResult?.then, 'function');
  await listenerResult;

  assert.equal(resolves, 0);
  assert.equal(sends, 0);
});

test('handler callback already admitted remains active until business work drains', async () => {
  let listener;
  let activeWork = 0;
  let resolveContext;
  let contextStarted;
  const started = new Promise(resolve => { contextStarted = resolve; });
  const contextRelease = new Promise(resolve => { resolveContext = resolve; });
  const client = {
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage() {},
  };
  handlers.start(client, {
    contextResolver: async () => {
      contextStarted();
      await contextRelease;
      return null;
    },
    withActiveClient: async fn => {
      activeWork += 1;
      try {
        return await fn({ client, generation: 3, epoch: 9n, ownerId: 'owner-a' });
      } finally {
        activeWork -= 1;
      }
    },
  });

  listener({
    from: '5493510000001@c.us',
    body: 'ayuda',
    id: { _serialized: 'handler-drain-1', fromMe: false },
  });
  await started;
  assert.equal(activeWork, 1);

  resolveContext();
  for (let attempt = 0; attempt < 10 && activeWork !== 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(activeWork, 0);
});

test('lease loss cierra respuestas de media General', async () => {
  let replies = 0;
  let downloads = 0;
  const handler = createIncomingMediaHandler({
    query: async () => [{ empresa_id: 7 }, { empresa_id: 8 }],
    lidByPhone: new Map(),
    handleIncomingComprobanteFromBotPg: async () => { throw new Error('no debe procesar'); },
    withActiveClient: async () => {
      throw Object.assign(new Error('lease lost'), { code: 'WPP_NOT_OWNER' });
    },
  });

  await handler({
    from: '5493510000000@c.us',
    type: 'image',
    hasMedia: true,
    id: { fromMe: false, id: 'media-fence-1', remote: '5493510000000@c.us' },
    reply: async () => { replies += 1; },
    downloadMedia: async () => { downloads += 1; return null; },
  });

  assert.equal(replies, 0);
  assert.equal(downloads, 0);
});
