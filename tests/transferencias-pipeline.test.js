import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __testables, finalizeReceiptValidation, procesarArchivoTransferenciaPg } from '../src/transferenciasPipeline.js';
import { validateReceiptMediaPreEffect } from '../src/receiptMediaValidation.js';
import { validPdf, validPdfWithPages, validPng } from './receipt-media-fixtures.js';

test('raster PDF usa scratch privado, primera página, timeout, límites y limpia siempre', async () => {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-raster-'));
  const pdf = validPdf();
  const validation = await validateReceiptMediaPreEffect(pdf, 'application/pdf');
  const calls = [];
  try {
    const base64 = await __testables.convertPdfFirstPageWithPdftoppm({
      buffer: pdf,
      validation,
    }, {
      scratchRoot,
      timeoutMs: 700,
      execFileImpl: async (command, args, options) => {
        calls.push({ command, args, options });
        await fs.writeFile(`${args.at(-1)}.png`, validPng());
      },
    });
    assert.deepEqual(Buffer.from(base64, 'base64'), validPng());
    assert.equal(calls[0].command, 'pdftoppm');
    assert.deepEqual(calls[0].args.slice(0, 6), ['-f', '1', '-l', '1', '-singlefile', '-png']);
    assert.equal(calls[0].options.shell, false);
    assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 700);
    assert.deepEqual(await fs.readdir(scratchRoot), []);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

test('PDF real de dos páginas se acepta y sólo rasteriza/analiza la primera', async () => {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-raster-two-pages-'));
  const pdf = validPdfWithPages([[0, 0, 10, 10], [0, 0, 20, 20]]);
  const validation = await validateReceiptMediaPreEffect(pdf, 'application/pdf');
  const calls = [];
  try {
    assert.equal(validation?.metadata?.pageCount, 2);
    const imagePayload = await __testables.prepareImageForAI({
      buffer: pdf,
      validation,
      mimetype: 'application/pdf',
      ext: 'pdf',
    }, {
      convertPdf: (input) => __testables.convertPdfFirstPageWithPdftoppm(input, {
        scratchRoot,
        execFileImpl: async (command, args) => {
          calls.push({ command, args });
          await fs.writeFile(`${args.at(-1)}.png`, validPng());
        },
      }),
    });
    assert.equal(imagePayload.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(imagePayload.base64, 'base64'), validPng());
    let analysisCalls = 0;
    const analyzed = await __testables.analyzeReceiptWithAI(imagePayload, {
      maxAttempts: 1,
      createCompletion: async payload => {
        analysisCalls += 1;
        assert.equal(payload.messages[1].content[1].image_url.url,
          `data:image/png;base64,${validPng().toString('base64')}`);
        return { choices: [{ message: { content: '{"monto":123}' } }] };
      },
    });
    assert.deepEqual(analyzed, { monto: 123 });
    assert.equal(analysisCalls, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'pdftoppm');
    assert.deepEqual(calls[0].args.slice(0, 6), ['-f', '1', '-l', '1', '-singlefile', '-png']);
    assert.deepEqual(await fs.readdir(scratchRoot), []);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

test('raster PDF rechaza timeout, PNG sobredimensionado/corrupto y limpia prefijos', async () => {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-raster-fail-'));
  const pdf = validPdf();
  const validation = await validateReceiptMediaPreEffect(pdf, 'application/pdf');
  try {
    for (const execFileImpl of [
      async () => { throw Object.assign(new Error('private path'), { code: 'ETIMEDOUT', killed: true }); },
      async (_command, args) => { await fs.writeFile(`${args.at(-1)}.png`, Buffer.alloc(4097)); },
      async (_command, args) => { await fs.writeFile(`${args.at(-1)}.png`, Buffer.from('not png')); },
    ]) {
      await assert.rejects(__testables.convertPdfFirstPageWithPdftoppm({ buffer: pdf, validation }, {
        scratchRoot, execFileImpl, maxOutputBytes: 4096,
      }), error => error?.code === 'receipt_pdf_raster_unavailable' || error?.code === 'receipt_pdf_raster_invalid');
      assert.deepEqual(await fs.readdir(scratchRoot), []);
    }
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

test('raster PDF real renderiza un PDF válido y mata un pdftoppm colgado sin huérfanos', async () => {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-raster-real-'));
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-pdftoppm-fake-'));
  const pdf = validPdf();
  const validation = await validateReceiptMediaPreEffect(pdf, 'application/pdf');
  const previousPath = process.env.PATH;
  try {
    const base64 = await __testables.convertPdfFirstPageWithPdftoppm({ buffer: pdf, validation }, {
      scratchRoot, timeoutMs: 2000,
    });
    assert.equal(Buffer.from(base64, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.deepEqual(await fs.readdir(scratchRoot), []);

    const fakePdftoppm = path.join(fakeBin, 'pdftoppm');
    await fs.writeFile(fakePdftoppm, '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o700 });
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const startedAt = Date.now();
    await assert.rejects(
      __testables.convertPdfFirstPageWithPdftoppm({ buffer: pdf, validation }, {
        scratchRoot, timeoutMs: 150,
      }),
      error => error?.code === 'receipt_pdf_raster_unavailable',
    );
    assert.ok(Date.now() - startedAt < 2000);
    assert.deepEqual(await fs.readdir(scratchRoot), []);
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(scratchRoot, { recursive: true, force: true });
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

test('clasifica Premature close de OpenAI como error transitorio', () => {
  assert.equal(
    __testables.isTransientOpenAIError(new Error('Invalid response body: Premature close')),
    true
  );
});

test('prepareImageForAI y analyzeReceiptWithAI no filtran errores internos en flujo sensible', async () => {
  const secret = 'phone=5493515550002 SQL=SELECT URL=https://private token=secret ciphertext=v1:abc body=privado';
  const logs = [];
  const logger = { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) };

  const prepared = await __testables.prepareImageForAI({
    mimetype: 'application/pdf', ext: 'pdf', absolutePath: `/tmp/${secret}.pdf`,
  }, {
    logger,
    convertPdf: async () => { throw Object.assign(new Error(secret), { cause: new Error(secret) }); },
  });
  assert.equal(prepared, null);

  const analyzed = await __testables.analyzeReceiptWithAI({ base64: 'private-body', mimeType: 'image/jpeg' }, {
    logger,
    maxAttempts: 1,
    createCompletion: async () => { throw Object.assign(new Error(secret), { status: 500, cause: new Error(secret) }); },
    waitImpl: async () => {},
  });
  assert.equal(analyzed, null);
  const exposed = JSON.stringify(logs);
  for (const fragment of ['5493515550002', 'SELECT', 'https://private', 'secret', 'v1:abc', 'privado']) {
    assert.equal(exposed.includes(fragment), false, fragment);
  }
});

test('pipeline Web conserva tolerancia histórica al fallo del aviso received', async () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 1]);
  let enqueueCalls = 0;
  const result = await procesarArchivoTransferenciaPg({ buffer, mimetype: 'image/jpeg' }, '3515550000', {
    empresaId: 1,
    transportOrigin: 'company',
    deps: {
      saveFileToDisk: async () => ({ absolutePath: '/tmp/not-created', relativePath: '/Transferencia/x.jpg', mimetype: 'image/jpeg', size: buffer.length }),
      insertarComprobantePg: async () => ({ id: 8, empresa_id: 1, pedido_id: null, transport_origin: 'company', file_hash: 'a'.repeat(64) }),
      enqueueWppMessagePg: async () => {
        enqueueCalls += 1;
        if (enqueueCalls === 1) throw new Error('outbox temporal');
      },
      prepareImageForAI: async () => ({ base64: 'x', mimeType: 'image/jpeg' }),
      analyzeReceiptWithAI: async () => ({ fecha: '2026-10-06', monto: null, nro_operacion: null }),
      resolverCuentaBancariaDestinoPg: async () => null,
      actualizarComprobanteDatosPg: async () => {},
    },
  });
  assert.equal(result.saved, true);
  assert.equal(result.handled, true);
  assert.equal(result.reason, 'manual_review');
});

test('pipeline Cloud sanea error desconocido en logs y resultado sin causa privada', async () => {
  const observed = [];
  const originalError = console.error;
  const secret = 'phone=5493515550002 SQL=SELECT*FROM pagos URL=https://private token=secret ciphertext=v1:abc body=privado';
  console.error = (...args) => observed.push(args);
  try {
    const result = await procesarArchivoTransferenciaPg({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 1]), mimetype: 'image/jpeg',
    }, '5493515550002', {
      empresaId: 2,
      transportOrigin: 'cloud',
      enqueueReply: async () => ({ queued: true }),
      deps: {
        saveFileToDisk: async () => { throw new Error(secret); },
      },
    });
    assert.deepEqual(result, {
      ok: false,
      error: 'cloud_receipt_processing_failed',
      code: 'cloud_receipt_processing_failed',
    });
    assert.equal(Object.hasOwn(result, 'cause'), false);
  } finally {
    console.error = originalError;
  }
  const exposed = JSON.stringify(observed);
  for (const fragment of ['5493515550002', 'SELECT*FROM', 'https://private', 'secret', 'v1:abc', 'privado']) {
    assert.equal(exposed.includes(fragment), false, fragment);
  }
});

test('pipeline Cloud propaga outcome unknown en received sin intentar effect=error', async () => {
  const effects = [];
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 1]);
  await assert.rejects(procesarArchivoTransferenciaPg({ buffer, mimetype: 'image/jpeg' }, '5493515550002', {
    empresaId: 2,
    sourceMessageId: 'wamid.receipt-unknown-received',
    transportOrigin: 'cloud',
    enqueueReply: async ({ effect }) => {
      effects.push(effect);
      throw Object.assign(new Error('private enqueue detail'), {
        code: 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN',
        cause: new Error('private cause'),
      });
    },
    deps: {
      saveFileToDisk: async () => ({ absolutePath: '/tmp/not-created', relativePath: '/Transferencia/x.jpg', mimetype: 'image/jpeg', size: buffer.length }),
      insertarComprobantePg: async () => ({ id: 9, empresa_id: 2, pedido_id: null, transport_origin: 'cloud', file_hash: 'a'.repeat(64) }),
    },
  }), error => {
    assert.equal(error.code, 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN');
    assert.equal(error.message, 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
  assert.deepEqual(effects, ['received']);
});

test('pipeline Cloud propaga outcome unknown en respuestas terminales sin effect=error', async () => {
  for (const terminalEffect of ['pending', 'approved']) {
    const effects = [];
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 1]);
    await assert.rejects(procesarArchivoTransferenciaPg({ buffer, mimetype: 'image/jpeg' }, '5493515550002', {
      empresaId: 2,
      sourceMessageId: `wamid.receipt-unknown-${terminalEffect}`,
      transportOrigin: 'cloud',
      enqueueReply: async ({ effect }) => {
        effects.push(effect);
        if (effect === terminalEffect) {
          throw Object.assign(new Error('private terminal enqueue detail'), {
            code: 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN',
          });
        }
      },
      deps: {
        saveFileToDisk: async () => ({ absolutePath: '/tmp/not-created', relativePath: '/Transferencia/x.jpg', mimetype: 'image/jpeg', size: buffer.length }),
        insertarComprobantePg: async () => ({
          id: 10, empresa_id: 2, pedido_id: terminalEffect === 'approved' ? 20 : null,
          pedido_monto: terminalEffect === 'approved' ? 1000 : null,
          pedido_metodo_pago: terminalEffect === 'approved' ? 'transferencia' : null,
          pedido_pago_acreditado: false, transport_origin: 'cloud', file_hash: 'a'.repeat(64),
        }),
        prepareImageForAI: async () => ({ base64: 'x', mimeType: 'image/jpeg' }),
        analyzeReceiptWithAI: async () => terminalEffect === 'approved'
          ? { fecha: '2026-10-06', monto: 1000, nro_operacion: 'op-1', banco_destino: 'Banco' }
          : { fecha: '2026-10-06', monto: null, nro_operacion: null },
        resolverCuentaBancariaDestinoPg: async () => terminalEffect === 'approved'
          ? { cuenta_bancaria_id: 3, confianza: 100, fuente: 'cbu', detalle: 'ok', cuenta: { banco: 'Banco' } }
          : null,
        actualizarComprobanteDatosPg: async () => {},
        aprobarComprobanteAtomicoPg: async () => true,
      },
    }), { code: 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN' });
    assert.deepEqual(effects, ['received', terminalEffect]);
  }
});

test('pipeline Cloud fencea efectos y responde por callback correlacionable por efecto', async () => {
  const events = [];
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 1]);
  const result = await procesarArchivoTransferenciaPg({ buffer, mimetype: 'image/jpeg', originalName: 'x.jpg' }, '5493515550002', {
    empresaId: 2,
    sourceMessageId: 'wamid.receipt-1',
    transportOrigin: 'cloud',
    assertLease: async () => events.push('lease'),
    enqueueReply: async ({ effect, empresaId, phone, transportOrigin }) => {
      events.push(`reply:${effect}`);
      assert.equal(empresaId, 2);
      assert.equal(phone, '5493515550002');
      assert.equal(transportOrigin, 'cloud');
    },
    deps: {
      saveFileToDisk: async () => assert.fail('Cloud no debe escribir en filesystem'),
      insertarComprobantePg: async input => {
        events.push('insert');
        assert.equal(input.empresaId, 2);
        assert.equal(input.sourceMessageId, 'wamid.receipt-1');
        assert.equal(input.replyJid, null);
        assert.equal(input.transportOrigin, 'cloud');
        return { id: 7, empresa_id: 2, pedido_id: null, source_chat_jid: null, transport_origin: 'cloud', file_hash: 'a'.repeat(64) };
      },
      prepareImageForAI: async () => { events.push('prepare'); return { base64: 'x', mimeType: 'image/jpeg' }; },
      analyzeReceiptWithAI: async () => { events.push('ai'); return { fecha: '2026-10-06', monto: null, nro_operacion: null }; },
      resolverCuentaBancariaDestinoPg: async () => null,
      actualizarComprobanteDatosPg: async () => { events.push('update'); },
      aprobarComprobanteAtomicoPg: async () => assert.fail('no debe aprobar'),
    },
  });

  assert.equal(result.saved, true);
  assert.equal(result.handled, true);
  assert.deepEqual(events, [
    'lease', 'lease', 'insert', 'lease', 'reply:received',
    'lease', 'prepare', 'lease', 'ai', 'lease', 'update', 'lease', 'reply:pending',
  ]);
});

test('commit ambiguo de acreditación se propaga saneado sin compensar ni responder terminal', async () => {
  let approvalCalls = 0;
  let updateCalls = 0;
  const effects = [];
  const privateDetail = 'COMMIT lost phone=5493515550002 SQL=UPDATE pedidos token=private';

  await assert.rejects(finalizeReceiptValidation({
    registroDB: {
      id: 77,
      empresa_id: 2,
      pedido_id: 99,
      pedido_monto: 1000,
      pedido_metodo_pago: 'transferencia',
      pedido_pago_acreditado: false,
      transport_origin: 'cloud',
      file_hash: 'a'.repeat(64),
    },
    datosIA: {
      fecha: '2026-10-06', monto: 1000, nro_operacion: 'op-ambigua', banco_destino: 'Banco',
    },
    telefono: '5493515550002',
    transportOrigin: 'cloud',
    enqueueReply: async ({ effect }) => effects.push(effect),
    deps: {
      resolverCuentaBancariaDestinoPg: async () => ({
        cuenta_bancaria_id: 3, confianza: 100, fuente: 'cbu', detalle: 'ok', cuenta: { banco: 'Banco' },
      }),
      aprobarComprobanteAtomicoPg: async () => {
        approvalCalls += 1;
        throw Object.assign(new Error(privateDetail), {
          code: 'TRANSACTION_OUTCOME_UNKNOWN',
          cause: new Error(privateDetail),
        });
      },
      actualizarComprobanteDatosPg: async () => { updateCalls += 1; },
    },
  }), error => {
    assert.equal(error.code, 'TRANSACTION_OUTCOME_UNKNOWN');
    assert.equal(error.message, 'TRANSACTION_OUTCOME_UNKNOWN');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(String(error.stack).includes(privateDetail), false);
    return true;
  });

  assert.equal(approvalCalls, 1, 'no reintenta la acreditación posiblemente aplicada');
  assert.equal(updateCalls, 0, 'no compensa a pendiente después de COMMIT ambiguo');
  assert.deepEqual(effects, [], 'no emite pending/error/approved');
});
