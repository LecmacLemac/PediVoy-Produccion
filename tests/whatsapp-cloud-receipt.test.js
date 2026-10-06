import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWhatsAppCloudReceiptProcessor } from '../src/whatsappCloud/receiptProcessor.js';
import { handleIncomingComprobanteFromBotPg } from '../src/transferenciasPipeline.js';
import {
  hasValidReceiptMagicBytes,
  normalizeReceiptMimeType,
  validateReceiptMediaPreEffect,
} from '../src/receiptMediaValidation.js';
import * as receiptValidationModule from '../src/receiptMediaValidation.js';
import {
  corruptJpegThatPassesStructure,
  corruptPngThatPassesStructure,
  corruptWebpThatPassesStructure,
  validJpeg,
  validJpegBaseline,
  validJpegProgressive,
  validPdf,
  validPng,
  validPngInterlaced,
  validPngPalette,
  validWebp,
  validWebpLosslessAlpha,
  validWebpLossy,
  xrefCorruptPdf,
} from './receipt-media-fixtures.js';

test('validador canónico rechaza firmas incompatibles al inicio, mitad y final del buffer completo', () => {
  const afterByte512 = Buffer.alloc(700, 0x20);
  const cases = [
    ['JPEG con HTML al inicio', Buffer.concat([Buffer.from('<html>'), validJpeg()]), 'image/jpeg'],
    ['JPEG con HTML después de byte 512', Buffer.concat([validJpeg().subarray(0, -2), afterByte512, Buffer.from('<script>bad</script>'), Buffer.from([0xff, 0xd9])]), 'image/jpeg'],
    ['JPEG con payload después de EOI', Buffer.concat([validJpeg(), Buffer.from('GIF89a')]), 'image/jpeg'],
    ['PDF con ZIP después de byte 512', Buffer.concat([validPdf().subarray(0, -6), Buffer.from(`${' '.repeat(700)}PK\u0003\u0004\n%%EOF\n`, 'latin1')]), 'application/pdf'],
    ['PDF con HTML al final', Buffer.concat([validPdf().subarray(0, -6), Buffer.from(`${' '.repeat(700)}<html>bad</html>\n%%EOF\n`, 'latin1')]), 'application/pdf'],
    ['PNG con GIF en el medio', Buffer.concat([validPng().subarray(0, 20), Buffer.from('GIF89a'), validPng().subarray(20)]), 'image/png'],
    ['PNG con payload después de IEND', Buffer.concat([validPng(), Buffer.from('GIF89a')]), 'image/png'],
  ];

  for (const [name, bytes, mimeType] of cases) {
    assert.equal(hasValidReceiptMagicBytes(bytes, mimeType), false, name);
  }
  assert.equal(hasValidReceiptMagicBytes(validJpeg(), 'image/jpeg'), true);
  assert.equal(hasValidReceiptMagicBytes(validPng(), 'image/png'), true);
  assert.equal(hasValidReceiptMagicBytes(validPdf(), 'application/pdf'), true);
});

test('normalizador MIME rechaza valores múltiples, controles y parámetros malformados', () => {
  assert.equal(normalizeReceiptMimeType(' Image/JPEG ; charset=binary '), 'image/jpeg');
  assert.equal(normalizeReceiptMimeType('image/jpeg; foo="a;b"'), 'image/jpeg');
  assert.equal(normalizeReceiptMimeType('image/jpeg; foo="a,b"'), 'image/jpeg');
  for (const value of [
    'image/jpeg; charset=binary, text/html',
    'image/jpeg; charset=binary, image/png',
    'image/jpeg\r\ntext/html',
    'image/jpeg; charset',
    'image/jpeg; =binary',
    'image/jpeg; charset="unterminated',
  ]) assert.equal(normalizeReceiptMimeType(value), null, value);
});

test('la prueba interna sólo puede salir de una validación exitosa', async () => {
  assert.equal('issueInternalReceiptValidationProof' in receiptValidationModule, false);
  assert.equal(await validateReceiptMediaPreEffect(Buffer.from('invalid'), 'image/jpeg'), false);
  const result = await validateReceiptMediaPreEffect(validJpeg(), 'image/jpeg');
  assert.ok(result?.proof);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.metadata));
});

test('prueba validada rechaza objeto arbitrario, clon, bytes mutados y MIME cambiado', async () => {
  const bytes = validJpeg();
  const result = await validateReceiptMediaPreEffect(bytes, 'image/jpeg');
  const { verifiesInternalReceiptValidationProof } = receiptValidationModule;
  assert.equal(verifiesInternalReceiptValidationProof({}, bytes, 'image/jpeg'), false);
  assert.equal(verifiesInternalReceiptValidationProof({ ...result.proof }, bytes, 'image/jpeg'), false);
  assert.equal(verifiesInternalReceiptValidationProof(result.proof, Buffer.from(bytes), 'image/jpeg'), false);
  bytes[bytes.length - 3] ^= 1;
  assert.equal(verifiesInternalReceiptValidationProof(result.proof, bytes, 'image/jpeg'), false);
  assert.equal(verifiesInternalReceiptValidationProof(result.proof, bytes, 'image/png'), false);
});

test('PDF validado acepta hasta cinco páginas y limita la primera antes de efectos posteriores', async () => {
  const makeQpdfJson = ({ pages = 1, boxes = [] } = {}) => ({
    stdout: JSON.stringify({
      pages: Array.from({ length: pages }, (_, index) => ({ object: `${index + 3} 0 R` })),
      qpdf: [{}, Object.fromEntries(Array.from({ length: pages }, (_, index) => [
        `obj:${index + 3} 0 R`, { value: { '/MediaBox': boxes[index] || [0, 0, 612, 792] } },
      ]))],
    }),
    stderr: '',
  });
  for (const pageCount of [1, 2, 5]) {
    const result = await validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
      execFileImpl: async () => makeQpdfJson({ pages: pageCount }),
    });
    assert.equal(result?.metadata?.pageCount, pageCount);
  }
  for (const scenario of [
    { name: 'cero páginas', json: makeQpdfJson({ pages: 0 }) },
    { name: 'más de cinco páginas', json: makeQpdfJson({ pages: 6 }) },
    { name: 'primera MediaBox gigante', json: makeQpdfJson({ pages: 2, boxes: [[0, 0, 100000, 100000], [0, 0, 10, 10]] }) },
  ]) {
    let effects = 0;
    const result = await validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
      execFileImpl: async () => scenario.json,
      beforeDecode: async () => { effects += 1; },
    });
    assert.equal(result, false, scenario.name);
    assert.equal(effects, 1, `${scenario.name}: qpdf es el único efecto previo`);
  }

  const hugeLaterPage = await validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
    execFileImpl: async () => makeQpdfJson({
      pages: 2,
      boxes: [[0, 0, 612, 792], [0, 0, 100000, 100000]],
    }),
  });
  assert.equal(hugeLaterPage?.metadata?.pageCount, 2, 'sólo la primera página se rasteriza');
  assert.equal(hugeLaterPage?.metadata?.widthPoints, 612);
  assert.equal(hugeLaterPage?.metadata?.heightPoints, 792);
});

test('decoder sharp real rechaza cuerpos corruptos que superan el parser estructural', async () => {
  for (const [name, bytes, mimeType] of [
    ['jpeg', corruptJpegThatPassesStructure(), 'image/jpeg'],
    ['png', corruptPngThatPassesStructure(), 'image/png'],
    ['webp', corruptWebpThatPassesStructure(), 'image/webp'],
  ]) {
    assert.equal(hasValidReceiptMagicBytes(bytes, mimeType), true, `${name}: precondición estructural`);
    assert.equal(await validateReceiptMediaPreEffect(bytes, mimeType), false, name);
  }
});

test('decoder sharp real acepta variantes legítimas baseline/progressive/palette/interlaced/lossy/lossless/alpha', async () => {
  for (const [name, makeBytes, mimeType] of [
    ['jpeg baseline', validJpegBaseline, 'image/jpeg'],
    ['jpeg progressive', validJpegProgressive, 'image/jpeg'],
    ['png palette', validPngPalette, 'image/png'],
    ['png interlaced', validPngInterlaced, 'image/png'],
    ['webp lossy', validWebpLossy, 'image/webp'],
    ['webp lossless alpha', validWebpLosslessAlpha, 'image/webp'],
  ]) assert.ok((await validateReceiptMediaPreEffect(await makeBytes(), mimeType))?.proof, name);
});

test('decoder de imagen recibe lease inmediato, límites y timeout acotado', async () => {
  const events = [];
  const bytes = validJpeg();
  const result = await validateReceiptMediaPreEffect(bytes, 'image/jpeg', {
    timeoutMs: 731,
    beforeDecode: async () => events.push('lease'),
    imageDecoder: async (buffer, options) => {
      events.push('decode');
      assert.equal(buffer, bytes);
      assert.equal(options.timeoutMs, 731);
      assert.ok(options.maxPixels > 0);
      assert.ok(options.maxDimension > 0);
      return true;
    },
  });
  assert.ok(result?.proof);
  assert.deepEqual(events, ['lease', 'decode']);
});

test('validador JPEG exige markers, SOF/SOS y EOI único final', () => {
  const jpeg = validJpeg();
  const firstEoi = jpeg.indexOf(Buffer.from([0xff, 0xd9]));
  for (const [name, bytes] of [
    ['trailing después de EOI', Buffer.concat([jpeg, Buffer.from('arbitrary')])],
    ['EOI ambiguo', Buffer.concat([jpeg.subarray(0, firstEoi), Buffer.from([0xff, 0xd9, 0xff, 0xd9])])],
    ['segmento truncado', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02])],
    ['sin SOF/SOS', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9])],
  ]) assert.equal(hasValidReceiptMagicBytes(bytes, 'image/jpeg'), false, name);
  assert.equal(hasValidReceiptMagicBytes(jpeg, 'image/jpeg'), true);
});

test('validador PNG verifica CRC, chunks críticos, orden e IEND final', () => {
  const png = validPng();
  const badCrc = Buffer.from(png);
  badCrc[29] ^= 0xff;
  const unknownCritical = Buffer.from(png);
  unknownCritical.write('ABCD', 12, 'ascii');
  for (const [name, bytes] of [
    ['CRC inválido', badCrc],
    ['chunk crítico desconocido', unknownCritical],
    ['trailing', Buffer.concat([png, Buffer.from([0])])],
    ['sin IDAT', Buffer.concat([png.subarray(0, 8 + 25), png.subarray(png.length - 12)])],
  ]) assert.equal(hasValidReceiptMagicBytes(bytes, 'image/png'), false, name);
  assert.equal(hasValidReceiptMagicBytes(png, 'image/png'), true);
});

test('validador WebP recorre chunks y exige payload de imagen válido', () => {
  const webp = validWebp();
  const vp8Size = webp.readUInt32LE(16);
  const vp8Payload = webp.subarray(20, 20 + vp8Size);
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.from([0])] : [])]);
  };
  const container = (...chunks) => {
    const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
    const header = Buffer.alloc(8);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const arbitrary = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPgarbage!')]);
  arbitrary.writeUInt32LE(arbitrary.length - 8, 4);
  const badSize = Buffer.from(webp);
  badSize.writeUInt32LE(webp.length - 9, 4);
  const vp8xAlphaWithoutPayload = Buffer.alloc(10);
  vp8xAlphaWithoutPayload[0] = 0x10;
  for (const [name, bytes] of [
    ['cuerpo arbitrario', arbitrary],
    ['RIFF size incorrecto', badSize],
    ['chunk truncado', webp.subarray(0, -1)],
    ['trailing', Buffer.concat([webp, Buffer.from([0, 0])])],
    ['ALPH sin VP8X', container(chunk('ALPH', Buffer.from([0])), chunk('VP8 ', vp8Payload))],
    ['VP8X declara alpha sin ALPH', container(chunk('VP8X', vp8xAlphaWithoutPayload), chunk('VP8 ', vp8Payload))],
  ]) assert.equal(hasValidReceiptMagicBytes(bytes, 'image/webp'), false, name);
  assert.equal(hasValidReceiptMagicBytes(webp, 'image/webp'), true);
});

test('prepare ejecuta preflight PDF real y rechaza startxref inexistente antes del pipeline', async () => {
  const goodPdf = validPdf();
  const badPdf = xrefCorruptPdf();
  assert.equal(hasValidReceiptMagicBytes(badPdf, 'application/pdf'), true, 'la capa barata no detecta el xref mutado');
  let current = goodPdf;
  let pipelineCalls = 0;
  const processor = createWhatsAppCloudReceiptProcessor({
    loadTenant: async () => ({ empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher' }),
    decryptToken: () => 'token',
    mediaClient: { download: async () => ({
      buffer: current,
      metadata: { mimeType: 'application/pdf', httpContentType: 'application/pdf' },
    }) },
    processPipeline: async () => { pipelineCalls += 1; return { saved: true }; },
    enqueueReply: async () => assert.fail('no responde'),
  });
  const input = {
    empresaId: 2, messageId: 'm-pdf', senderId: '5493515550002', originalPhoneNumberId: 'phone-2',
    messageType: 'document', media: { id: 'pdf', mime_type: 'application/pdf', sha256: 'hash' }, tenant: { empresaId: 2 },
  };

  const prepared = await processor.prepare(input);
  assert.deepEqual(prepared.downloaded.buffer, goodPdf);
  current = badPdf;
  await assert.rejects(processor.prepare(input), error => error?.code === 'invalid_file_signature');
  assert.equal(pipelineCalls, 0);
});

test('preflight PDF inyectable usa execFile acotado, sanea fallos operativos y limpia scratch', async () => {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-preflight-test-'));
  const calls = [];
  try {
    const validQpdfJson = JSON.stringify({
      pages: [{ object: '3 0 R' }],
      qpdf: [{}, { 'obj:3 0 R': { value: { '/MediaBox': [0, 0, 10, 10] } } }],
    });
    const validated = await validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
      scratchRoot,
      timeoutMs: 700,
      execFileImpl: async (...args) => { calls.push(args); return { stdout: validQpdfJson, stderr: '' }; },
    });
    assert.ok(validated?.proof);
    assert.equal(calls[0][0], 'qpdf');
    assert.equal(calls[0][1][0], '--json');
    assert.equal(calls[0][2].shell, false);
    assert.equal(calls[0][2].timeout, 700);
    assert.deepEqual(await fs.readdir(scratchRoot), []);

    assert.equal(await validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
      scratchRoot,
      execFileImpl: async () => { throw Object.assign(new Error('private parser output'), { code: 1 }); },
    }), false);
    assert.equal(await validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
      scratchRoot,
      execFileImpl: async () => ({ stdout: '', stderr: 'WARNING: damaged xref reconstructed' }),
    }), false);
    await assert.rejects(validateReceiptMediaPreEffect(validPdf(), 'application/pdf', {
      scratchRoot,
      execFileImpl: async () => { throw Object.assign(new Error('private executable path'), { code: 'ENOENT' }); },
    }), error => error?.code === 'receipt_pdf_preflight_unavailable'
      && error?.retryable === true
      && !String(error).includes('private'));
    assert.deepEqual(await fs.readdir(scratchRoot), []);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

for (const scenario of [
  { messageType: 'image', mimeType: 'image/jpeg', filename: undefined },
  { messageType: 'document', mimeType: 'application/pdf', filename: 'ticket.pdf' },
]) {
  test(`procesa ${scenario.messageType} Cloud con token tenant y correlaciones por efecto`, async () => {
    const events = [];
    const bytes = scenario.messageType === 'image' ? validJpeg() : validPdf();
    const processor = createWhatsAppCloudReceiptProcessor({
      loadTenant: async ({ empresaId }) => {
        events.push(`tenant:${empresaId}`);
        return { empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher-2' };
      },
      decryptToken: encrypted => { events.push(`decrypt:${encrypted}`); return 'plain-token-2'; },
      mediaClient: {
        async download(input) {
          events.push('download');
          assert.deepEqual(input, {
            mediaId: 'media-2', phoneNumberId: 'phone-2', accessToken: 'plain-token-2',
            expectedMimeType: scenario.mimeType, expectedSha256: 'remote-hash',
          });
          return { buffer: bytes, metadata: { id: 'media-2', mimeType: scenario.mimeType, httpContentType: scenario.mimeType, sha256: 'local-hash', size: bytes.length } };
        },
      },
      processPipeline: async (botData, options) => {
        events.push('pipeline');
        assert.equal(botData.type, scenario.messageType);
        assert.equal(botData.telefono, '5493515550002');
        assert.equal(botData.replyJid, null);
        assert.equal(botData.empresaId, 2);
        assert.equal(botData.sourceMessageId, 'wamid.receipt-2');
        assert.equal(botData.transportOrigin, 'cloud');
        assert.deepEqual(botData.buffer, bytes);
        assert.equal(botData.filename, scenario.filename || `media-2.${scenario.mimeType === 'application/pdf' ? 'pdf' : 'jpg'}`);
        await options.enqueueReply({ effect: 'received', empresaId: 2, phone: botData.telefono, message: 'recibido', transportOrigin: 'cloud' });
        await options.enqueueReply({ effect: 'pending', empresaId: 2, phone: botData.telefono, message: 'pendiente', transportOrigin: 'cloud' });
        return { ok: false, saved: true, reason: 'manual_review' };
      },
      enqueueReply: async input => { events.push(`enqueue:${input.correlationId}`); return { queued: true }; },
    });

    const result = await processor.process({
      empresaId: 2,
      messageId: 'wamid.receipt-2',
      senderId: '5493515550002',
      originalPhoneNumberId: 'phone-2',
      messageType: scenario.messageType,
      media: { id: 'media-2', mime_type: scenario.mimeType, sha256: 'remote-hash', ...(scenario.filename ? { filename: scenario.filename } : {}) },
      tenant: { empresaId: 2, phoneNumberId: 'stale-phone', accessTokenEncrypted: 'stale-cipher' },
      assertLease: async () => events.push('lease'),
    });

    assert.deepEqual(result, { ok: false, saved: true, handled: true, reason: 'manual_review' });
    assert.deepEqual(events, [
      'lease', 'tenant:2', 'lease', 'decrypt:cipher-2', 'lease', 'download', 'lease', 'lease', 'pipeline',
      'lease', 'enqueue:wamid.receipt-2:receipt:received',
      'lease', 'enqueue:wamid.receipt-2:receipt:pending',
    ]);
  });
}

test('prepare descarga sin efectos y processPrepared inicia pipeline sin segunda descarga', async () => {
  const events = [];
  const bytes = validJpeg();
  const processor = createWhatsAppCloudReceiptProcessor({
    loadTenant: async () => ({ empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher-2' }),
    decryptToken: () => 'plain-token-2',
    mediaClient: { download: async () => { events.push('download'); return { buffer: bytes, metadata: { mimeType: 'image/jpeg', httpContentType: 'image/jpeg' } }; } },
    processPipeline: async botData => { events.push('pipeline'); assert.deepEqual(botData.buffer, bytes); return { saved: true }; },
    enqueueReply: async () => ({ queued: true }),
  });
  const input = {
    empresaId: 2, messageId: 'wamid.split', senderId: '5493515550002', originalPhoneNumberId: 'phone-2',
    messageType: 'image', media: { id: 'media-split', mime_type: 'image/jpeg', sha256: 'hash' },
    tenant: { empresaId: 2 }, assertLease: async () => {},
  };

  const prepared = await processor.prepare(input);
  assert.deepEqual(events, ['download']);
  assert.equal(prepared.downloaded.buffer, bytes);
  assert.deepEqual(await processor.processPrepared({ ...input, prepared }), { saved: true, handled: true });
  assert.deepEqual(events, ['download', 'pipeline']);
});

test('Cloud entrega prueba interna de bytes validados y el pipeline omite sólo el segundo decoder', async () => {
  const bytes = validJpeg();
  let preflightCalls = 0;
  const processor = createWhatsAppCloudReceiptProcessor({
    loadTenant: async () => ({ empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher-2' }),
    decryptToken: () => 'plain-token-2',
    mediaClient: { download: async () => ({
      buffer: bytes,
      metadata: { mimeType: 'image/jpeg', httpContentType: 'image/jpeg' },
    }) },
    validateMedia: async (...args) => {
      preflightCalls += 1;
      return validateReceiptMediaPreEffect(...args);
    },
    processPipeline: async (botData, options) => handleIncomingComprobanteFromBotPg(botData, {
      ...options,
      deps: {
        validateReceiptMediaPreEffect: async () => assert.fail('no debe ejecutar un segundo decoder'),
        saveFileToDisk: async () => ({
          absolutePath: '/tmp/not-created', relativePath: '/Transferencia/prepared.jpg',
          mimetype: 'image/jpeg', size: bytes.length,
        }),
        insertarComprobantePg: async () => ({ duplicate: true }),
      },
    }),
    enqueueReply: async () => assert.fail('duplicado no responde'),
  });
  const input = {
    empresaId: 2, messageId: 'wamid.preflight-once', senderId: '5493515550002', originalPhoneNumberId: 'phone-2',
    messageType: 'image', media: { id: 'media-once', mime_type: 'image/jpeg', sha256: 'hash' }, tenant: { empresaId: 2 },
  };

  const prepared = await processor.prepare(input);
  assert.deepEqual(await processor.processPrepared({ ...input, prepared }), {
    ok: false, handled: true, saved: true, duplicate: true, reason: 'duplicate_event_or_file',
  });
  assert.equal(preflightCalls, 1);
});

test('receiptProcessor rechaza senderId no decimal como defensa en profundidad', async () => {
  let tenantLoads = 0;
  const processor = createWhatsAppCloudReceiptProcessor({
    loadTenant: async () => { tenantLoads += 1; return { empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher' }; },
    decryptToken: () => assert.fail('no debe descifrar'),
    mediaClient: { download: async () => assert.fail('no debe descargar') },
    processPipeline: async () => assert.fail('no debe procesar'),
    enqueueReply: async () => assert.fail('no debe responder'),
  });

  await assert.rejects(processor.process({
    empresaId: 2, messageId: 'm', senderId: '54935abc50002', originalPhoneNumberId: 'phone-2',
    messageType: 'image', media: { id: 'media', mime_type: 'image/jpeg', sha256: 'hash' },
    tenant: { empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher' },
  }), error => error?.code === 'cloud_media_payload_invalid');
  assert.equal(tenantLoads, 0);
});

test('falla cerrado si el phone_number_id original cambió antes de descifrar', async () => {
  let decryptCalls = 0;
  const processor = createWhatsAppCloudReceiptProcessor({
    loadTenant: async () => ({ empresaId: 2, phoneNumberId: 'phone-B', accessTokenEncrypted: 'cipher-B' }),
    decryptToken: () => { decryptCalls += 1; return 'plain-token'; },
    mediaClient: { download: async () => assert.fail('no debe descargar') },
    processPipeline: async () => assert.fail('no debe procesar'),
    enqueueReply: async () => assert.fail('no debe responder'),
  });

  await assert.rejects(processor.process({
    empresaId: 2, messageId: 'm', senderId: '5493515550002', messageType: 'image',
    media: { id: 'media', mime_type: 'image/jpeg', sha256: 'hash' },
    tenant: { empresaId: 2, phoneNumberId: 'phone-B', accessTokenEncrypted: 'cipher-B' },
    originalPhoneNumberId: 'phone-A',
  }), error => error?.code === 'cloud_config_invalid');
  assert.equal(decryptCalls, 0);
});

test('falla cerrado si tenant no coincide o config carece de secreto', async () => {
  const processor = createWhatsAppCloudReceiptProcessor({
    loadTenant: async () => null,
    decryptToken: () => assert.fail('no debe descifrar'),
    mediaClient: { download: async () => assert.fail('no debe descargar') },
    processPipeline: async () => assert.fail('no debe procesar'),
    enqueueReply: async () => assert.fail('no debe responder'),
  });
  for (const tenant of [
    { empresaId: 9, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher' },
    { empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: '' },
  ]) {
    await assert.rejects(processor.process({
      empresaId: 2, messageId: 'm', senderId: '5493515550002', originalPhoneNumberId: 'phone-2', messageType: 'image',
      media: { id: 'media', mime_type: 'image/jpeg', sha256: 'hash' }, tenant,
    }), error => error?.code === 'cloud_config_invalid');
  }
});

test('prepare valida tipo, MIME webhook/Graph/HTTP y magic bytes antes del pipeline', async () => {
  const cases = [
    { name: 'imagen declarada PDF', messageType: 'image', webhook: 'application/pdf', graph: 'application/pdf', http: 'application/pdf', bytes: Buffer.from('%PDF-1.4'), code: 'unsupported_type' },
    { name: 'documento declarado JPEG', messageType: 'document', webhook: 'image/jpeg', graph: 'image/jpeg', http: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), code: 'unsupported_type' },
    { name: 'metadata distinta', messageType: 'image', webhook: 'image/jpeg', graph: 'image/png', http: 'image/png', bytes: Buffer.from([137,80,78,71,13,10,26,10]), code: 'cloud_media_mime_mismatch' },
    { name: 'HTTP ausente', messageType: 'image', webhook: 'image/jpeg', graph: 'image/jpeg', http: null, bytes: validJpeg(), code: 'cloud_media_mime_mismatch' },
    { name: 'HTTP vacío', messageType: 'image', webhook: 'image/jpeg', graph: 'image/jpeg', http: '', bytes: validJpeg(), code: 'cloud_media_mime_mismatch' },
    { name: 'HTTP inválido', messageType: 'image', webhook: 'image/jpeg', graph: 'image/jpeg', http: 'not-a-mime', bytes: validJpeg(), code: 'cloud_media_mime_mismatch' },
    { name: 'HTTP múltiple ambiguo', messageType: 'image', webhook: 'image/jpeg', graph: 'image/jpeg', http: 'image/jpeg, text/html', bytes: validJpeg(), code: 'cloud_media_mime_mismatch' },
    { name: 'HTTP distinto', messageType: 'image', webhook: 'image/jpeg', graph: 'image/jpeg', http: 'text/html', bytes: validJpeg(), code: 'cloud_media_mime_mismatch' },
    { name: 'GIF', messageType: 'image', webhook: 'image/gif', graph: 'image/gif', http: 'image/gif', bytes: Buffer.from('GIF89a'), code: 'unsupported_type' },
    { name: 'Office ZIP', messageType: 'document', webhook: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', graph: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', http: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from('PK\u0003\u0004'), code: 'unsupported_type' },
    { name: 'HTML', messageType: 'document', webhook: 'application/pdf', graph: 'application/pdf', http: 'application/pdf', bytes: Buffer.from('<html>no</html>'), code: 'invalid_file_signature' },
    { name: 'polyglot', messageType: 'image', webhook: 'image/jpeg', graph: 'image/jpeg', http: 'image/jpeg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html>no</html>')]), code: 'invalid_file_signature' },
  ];

  for (const scenario of cases) {
    let pipelineCalls = 0;
    const processor = createWhatsAppCloudReceiptProcessor({
      loadTenant: async () => ({ empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher' }),
      decryptToken: () => 'token',
      mediaClient: { download: async () => ({
        buffer: scenario.bytes,
        metadata: { mimeType: scenario.graph, httpContentType: scenario.http },
      }) },
      processPipeline: async () => { pipelineCalls += 1; return { saved: true }; },
      enqueueReply: async () => assert.fail('no responde'),
    });
    await assert.rejects(processor.prepare({
      empresaId: 2, messageId: 'm', senderId: '5493515550002', originalPhoneNumberId: 'phone-2',
      messageType: scenario.messageType,
      media: { id: 'media', mime_type: scenario.webhook, sha256: 'hash' },
      tenant: { empresaId: 2 },
    }), error => error?.code === scenario.code, scenario.name);
    assert.equal(pipelineCalls, 0, scenario.name);
  }
});

test('processPrepared devuelve contrato explícito y no trata rechazo no durable como handled', async () => {
  const bytes = validJpeg();
  for (const [pipelineResult, expected] of [
    [{ ok: false, reason: 'unsupported_type' }, { ok: false, reason: 'unsupported_type', handled: false, saved: false }],
    [{ ok: false, saved: true, reason: 'manual_review' }, { ok: false, saved: true, reason: 'manual_review', handled: true }],
  ]) {
    const processor = createWhatsAppCloudReceiptProcessor({
      loadTenant: async () => ({ empresaId: 2, phoneNumberId: 'phone-2', accessTokenEncrypted: 'cipher' }),
      decryptToken: () => 'token',
      mediaClient: { download: async () => ({ buffer: bytes, metadata: { mimeType: 'image/jpeg', httpContentType: 'image/jpeg' } }) },
      processPipeline: async () => pipelineResult,
      enqueueReply: async () => ({ queued: true }),
    });
    const prepared = await processor.prepare({
      empresaId: 2, messageId: 'm', senderId: '5493515550002', originalPhoneNumberId: 'phone-2',
      messageType: 'image', media: { id: 'media', mime_type: 'image/jpeg', sha256: 'hash' }, tenant: { empresaId: 2 },
    });
    assert.deepEqual(await processor.processPrepared({ prepared }), expected);
  }
});
