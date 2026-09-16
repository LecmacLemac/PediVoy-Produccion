import test from 'node:test';
import assert from 'node:assert/strict';

import handlers from '../src/handlers.js';
import {
  claimWppOutboxRows,
  finishWppOutboxClaim,
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

test('General pierde ownership inmediatamente antes del envío y no usa el transporte', async () => {
  const { query } = outboxQuery({ id: 11, telefono: '123@lid', mensaje: 'hola' });
  let sends = 0;
  let gates = 0;
  const client = {
    getChatById: async () => null,
    sendMessage: async () => { sends += 1; },
  };
  const withActiveClient = async fn => {
    gates += 1;
    if (gates === 4) throw Object.assign(new Error('lease lost'), { code: 'WPP_NOT_OWNER' });
    return fn({ client, epoch: 7n, generation: 1 });
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
    claimOwner: 'general-a',
    withActiveClient,
  });

  await processor.processOutbox();

  assert.equal(sends, 0);
  assert.equal(gates, 4, 'cada uso del transporte debe volver a atravesar el fence');
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
    claimOwner: 'general-a',
    withActiveClient: fn => fn({ client, epoch: 7n, generation: 1 }),
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

test('claim General queda etiquetado con owner y epoch', async () => {
  let captured;
  await claimWppOutboxRows({
    query: async (sql, params) => { captured = { sql: String(sql), params }; return []; },
    owner: 'general-a',
    epoch: 9n,
    limit: 3,
  });

  assert.match(captured.sql, /claim_epoch\s*=\s*\$2/i);
  assert.deepEqual(captured.params.slice(0, 4), ['general-a', '9', 120000, 3]);
});

test('lease loss cierra respuestas de handlers General', async () => {
  let listener;
  let sends = 0;
  const client = {
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage() { sends += 1; },
  };
  handlers.start(client, {
    contextResolver: async () => ({ role: 'cliente', empresa_id: 7, source: 'cliente' }),
    withActiveClient: async () => {
      throw Object.assign(new Error('lease lost'), { code: 'WPP_NOT_OWNER' });
    },
  });

  await listener({
    from: '5493510000000@c.us',
    body: 'ayuda',
    id: { _serialized: 'handler-fence-1', fromMe: false },
  });

  assert.equal(sends, 0);
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
