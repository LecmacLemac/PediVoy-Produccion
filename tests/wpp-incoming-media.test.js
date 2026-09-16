import test from 'node:test';
import assert from 'node:assert/strict';

import { createIncomingMediaHandler } from '../src/wpp/incomingMedia.js';
import { handleIncomingComprobanteFromBotPg } from '../src/transferenciasPipeline.js';

function mediaMessage(phone = '5493510000000') {
  return {
    from: `${phone}@c.us`,
    type: 'image',
    hasMedia: true,
    id: { fromMe: false, id: 'msg-test', remote: `${phone}@c.us` },
    downloadMedia: async () => ({
      data: Buffer.from('comprobante-test').toString('base64'),
      mimetype: 'image/jpeg',
      filename: 'comprobante.jpg',
    }),
  };
}

test('handler empresarial valida cliente dentro del tenant y propaga empresaId fijo', async () => {
  const queries = [];
  const received = [];
  const handler = createIncomingMediaHandler({
    empresaId: 7,
    lidByPhone: new Map(),
    query: async (sql, params) => {
      queries.push({ sql, params });
      return [{ id: 44 }];
    },
    handleIncomingComprobanteFromBotPg: async payload => {
      received.push(payload);
      return { ok: false, reason: 'manual_review', id: 10 };
    },
  });

  await handler(mediaMessage());

  assert.match(queries[0].sql, /empresa_id = \$2/);
  assert.deepEqual(queries[0].params, ['3510000000', 7]);
  assert.equal(received.length, 1);
  assert.equal(received[0].empresaId, 7);
  assert.equal(received[0].sourceMessageId, 'false_5493510000000@c.us_msg-test');
});

test('handler empresarial ignora un teléfono que solo existe en otra empresa', async () => {
  let downloaded = false;
  let processed = false;
  const msg = mediaMessage();
  msg.downloadMedia = async () => {
    downloaded = true;
    return null;
  };

  const handler = createIncomingMediaHandler({
    empresaId: 7,
    lidByPhone: new Map(),
    query: async () => [],
    handleIncomingComprobanteFromBotPg: async () => {
      processed = true;
    },
  });

  await handler(msg);

  assert.equal(downloaded, false);
  assert.equal(processed, false);
});

test('canal General detecta teléfono multiempresa antes de descargar aunque haya un solo pedido elegible', async () => {
  let downloaded = false;
  let processed = false;
  const replies = [];
  const msg = mediaMessage();
  msg.reply = async text => replies.push(text);
  msg.downloadMedia = async () => { downloaded = true; return null; };
  const handler = createIncomingMediaHandler({
    lidByPhone: new Map(),
    query: async sql => {
      assert.match(sql, /SELECT DISTINCT empresa_id/);
      return [{ empresa_id: 7 }, { empresa_id: 8 }];
    },
    handleIncomingComprobanteFromBotPg: async () => { processed = true; },
  });

  await handler(msg);

  assert.equal(downloaded, false);
  assert.equal(processed, false);
  assert.match(replies[0], /empresa/i);
});

test('canal General propaga la única empresa resuelta al pipeline', async () => {
  let payload;
  const msg = mediaMessage();
  msg.id._serialized = 'msg-general-1';
  msg.downloadMedia = async () => ({
    data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64'),
    mimetype: 'image/jpeg',
  });
  const handler = createIncomingMediaHandler({
    query: async () => [{ empresa_id: 7 }],
    lidByPhone: new Map(),
    handleIncomingComprobanteFromBotPg: async input => { payload = input; return { ok: true, id: 1 }; },
  });
  await handler(msg);
  assert.equal(payload.empresaId, 7);
});

test('lease loss while resolving an @lid contact aborts before database and media work', async () => {
  const calls = { query: 0, download: 0, pipeline: 0, reply: 0 };
  const notOwner = Object.assign(new Error('lease lost during contact resolution'), { code: 'WPP_NOT_OWNER' });
  const handler = createIncomingMediaHandler({
    lidByPhone: new Map(),
    query: async () => { calls.query += 1; return [{ empresa_id: 7 }]; },
    handleIncomingComprobanteFromBotPg: async () => { calls.pipeline += 1; },
    withActiveClient: fn => fn(),
  });
  const msg = mediaMessage('123456789012345');
  msg.from = '123456789012345@lid';
  msg.id.remote = msg.from;
  msg.getContact = async () => { throw notOwner; };
  msg.downloadMedia = async () => { calls.download += 1; return null; };
  msg.reply = async () => { calls.reply += 1; };

  await handler(msg);

  assert.deepEqual(calls, { query: 0, download: 0, pipeline: 0, reply: 0 });
});

test('rechaza HTML como documento y magic bytes falsos antes de guardar o analizar', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const htmlResult = await handleIncomingComprobanteFromBotPg({
    type: 'document', telefono: '3510000000', buffer: html,
    mimetype: 'text/html', filename: 'comprobante.pdf', empresaId: 7,
  });
  const fakeJpegResult = await handleIncomingComprobanteFromBotPg({
    type: 'image', telefono: '3510000000', buffer: html,
    mimetype: 'image/jpeg', filename: 'comprobante.jpg', empresaId: 7,
  });

  assert.equal(htmlResult.reason, 'unsupported_type');
  assert.equal(fakeJpegResult.reason, 'invalid_file_signature');
});

test('rechaza payload mayor al límite configurable antes de decodificar', async () => {
  const result = await handleIncomingComprobanteFromBotPg({
    type: 'image', telefono: '3510000000',
    base64: 'A'.repeat(32), mimetype: 'image/jpeg', empresaId: 7,
  }, { maxBytes: 8 });

  assert.equal(result.reason, 'file_too_large');
});
