import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { saveComprobante } from '../src/postgresServices.js';
import { ensureComprobantesTransferenciaSchema, insertarComprobantePg } from '../src/transferenciasServices.js';

test('saveComprobante deriva tenant del pedido y deja la operación al trigger de claims', async () => {
  const calls = [];
  const result = await saveComprobante(20, '/tmp/c.jpg', {
    monto: 100,
    nro_operacion: ' OP-1 ',
  }, async (sql, params) => {
    calls.push({ sql, params });
    return [{ id: 9 }];
  });

  assert.deepEqual(result, { id: 9 });
  assert.match(calls[0].sql, /INSERT INTO comprobantes_transferencia\s*\(empresa_id, pedido_id/i);
  assert.match(calls[0].sql, /SELECT p\.empresa_id, p\.id/i);
  assert.match(calls[0].sql, /FROM pedidos p/i);
  assert.match(calls[0].sql, /WHERE p\.id = \$1/i);
  assert.equal(calls[0].params[9], ' OP-1 ');
});

test('insertarComprobante solo deduplica constraints esperadas y busca por tenant', async () => {
  const queryFn = async (sql, params) => {
    if (sql.includes('FROM pedidos')) return [{ pedido_id: 20, empresa_id: 7, chofer_id: 2, monto: 100, metodo_pago: 'transferencia' }];
    if (sql.includes('INSERT INTO comprobantes_transferencia')) {
      assert.doesNotMatch(sql, /ON CONFLICT DO NOTHING/i);
      throw Object.assign(new Error('duplicado'), { code: '23505', constraint: 'uq_ct_source_message_new' });
    }
    if (sql.includes('FROM comprobantes_transferencia')) {
      assert.match(sql, /empresa_id\s+IS NOT DISTINCT FROM\s+\$1/i);
      assert.match(sql, /source_message_id\s*=\s*\$2/i);
      assert.match(sql, /dedupe_file_hash\s*=\s*\$3/i);
      return [{ id: 99, empresa_id: 7, pedido_id: 20,
        source_message_id: 'msg-1', dedupe_file_hash: 'a'.repeat(64) }];
    }
    throw new Error('inesperado');
  };
  const result = await insertarComprobantePg({
    telefono: '3510000000', imagen_path: '/x.jpg', fecha: new Date(), empresaId: 7,
    sourceMessageId: 'msg-1', fileHash: 'a'.repeat(64),
  }, queryFn);
  assert.equal(result.duplicate, true);
  assert.equal(result.existing.id, 99);

  const hashResult = await insertarComprobantePg({
    telefono: '3510000000', imagen_path: '/x.jpg', fecha: new Date(), empresaId: 7,
    fileHash: 'b'.repeat(64),
  }, async (sql, params) => {
    if (sql.includes('FROM pedidos')) return [];
    if (sql.includes('INSERT INTO comprobantes_transferencia')) {
      throw Object.assign(new Error('hash duplicado'), { code: '23505', constraint: 'uq_ct_file_hash_new' });
    }
    assert.match(sql, /dedupe_file_hash\s*=\s*\$3/i);
    assert.deepEqual(params, [7, null, 'b'.repeat(64)]);
    return [{ id: 100, empresa_id: 7, pedido_id: null,
      source_message_id: null, dedupe_file_hash: 'b'.repeat(64) }];
  });
  assert.equal(hashResult.duplicate, true);
  assert.equal(hashResult.reason, 'duplicate_file_hash');

  const unexpectedUnique = Object.assign(new Error('unique ajena'), {
    code: '23505', constraint: 'uq_comprobante_otro_campo',
  });
  await assert.rejects(
    insertarComprobantePg({
      telefono: '351', imagen_path: '/x', fecha: new Date(), empresaId: 7,
    }, async sql => {
      if (sql.includes('FROM pedidos')) return [];
      throw unexpectedUnique;
    }),
    error => error === unexpectedUnique,
  );

  await assert.rejects(
    insertarComprobantePg({ telefono: '351', imagen_path: '/x', fecha: new Date(), empresaId: 7 }, async sql => {
      if (sql.includes('FROM pedidos')) return [];
      throw Object.assign(new Error('FK'), { code: '23503', constraint: 'ct_fk' });
    }),
    error => error?.constraint === 'ct_fk',
  );
});

test('insertarComprobante deriva hash y tamaño del Buffer durable dentro del servicio', async () => {
  const bytes = Buffer.from('%PDF-durable');
  const callerHash = 'c'.repeat(64);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  let insertCall;
  const result = await insertarComprobantePg({
    telefono: '3510000000',
    imagen_path: '/Transferencia/durable.pdf',
    fecha: new Date('2026-10-09T12:00:00Z'),
    empresaId: 7,
    sourceMessageId: 'wamid.durable-row',
    fileHash: callerHash,
    archivoBinario: bytes,
    mimetype: 'application/pdf',
    bytes: 999999,
  }, async (sql, params) => {
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('source_message_id = $2') && sql.includes('dedupe_file_hash = $3')) return [];
    if (sql.includes('SUM(archivo_size)')) return [{ durable_bytes: 0 }];
    if (sql.includes('FROM pedidos')) return [];
    if (sql.includes('INSERT INTO comprobantes_transferencia')) {
      insertCall = { sql, params };
      return [{ id: 101, empresa_id: 7, pedido_id: null }];
    }
    throw new Error('consulta inesperada');
  });

  assert.equal(result.id, 101);
  assert.match(insertCall.sql, /archivo_binario/);
  assert.match(insertCall.sql, /archivo_mimetype/);
  assert.match(insertCall.sql, /archivo_size/);
  assert.match(insertCall.sql, /archivo_sha256/);
  assert.deepEqual(insertCall.params.slice(-4), [bytes, 'application/pdf', bytes.length, actualHash]);
  assert.equal(insertCall.params[11], actualHash);
});

test('insertarComprobante usa cap absoluto de 10 MiB aunque el entorno intente ampliarlo', async () => {
  const previous = process.env.TRANSFERENCIA_MAX_BYTES;
  process.env.TRANSFERENCIA_MAX_BYTES = String(100 * 1024 * 1024);
  let queries = 0;
  try {
    await assert.rejects(insertarComprobantePg({
      telefono: '3510000000',
      imagen_path: '/Transferencia/too-large.jpg',
      fecha: new Date(),
      empresaId: 7,
      fileHash: 'd'.repeat(64),
      archivoBinario: Buffer.alloc(10 * 1024 * 1024 + 1),
      mimetype: 'image/jpeg',
      bytes: 1,
    }, async () => {
      queries += 1;
      return [];
    }), error => error?.code === 'archivo_comprobante_invalido');
    assert.equal(queries, 0);
  } finally {
    if (previous === undefined) delete process.env.TRANSFERENCIA_MAX_BYTES;
    else process.env.TRANSFERENCIA_MAX_BYTES = previous;
  }
});

test('Cloud durable exige tenant positivo y aplica lock antes de cuota e INSERT', async () => {
  const bytes = Buffer.from('%PDF-quota');
  await assert.rejects(insertarComprobantePg({
    telefono: '351', imagen_path: '/Transferencia/no-tenant.pdf', fecha: new Date(),
    transportOrigin: 'cloud', archivoBinario: bytes, mimetype: 'application/pdf',
  }, async () => []), error => error?.code === 'empresa_comprobante_invalida');

  const calls = [];
  await assert.rejects(insertarComprobantePg({
    telefono: '351', imagen_path: '/Transferencia/quota.pdf', fecha: new Date(), empresaId: 7,
    transportOrigin: 'cloud', archivoBinario: bytes, mimetype: 'application/pdf',
  }, async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('source_message_id = $2') && sql.includes('dedupe_file_hash = $3')) return [];
    if (sql.includes('SUM(archivo_size)')) return [{ durable_bytes: 1024 * 1024 * 1024 }];
    throw new Error('no debe superar la cuota');
  }), error => error?.code === 'cuota_comprobantes_durables_excedida');

  assert.match(calls[0].sql, /pg_advisory_xact_lock/i);
  assert.match(calls[1].sql, /source_message_id\s*=\s*\$2/i);
  assert.match(calls[2].sql, /SUM\(archivo_size\)/i);
  assert.equal(calls.some(call => /INSERT INTO comprobantes_transferencia/i.test(call.sql)), false);
});

test('replay durable se resuelve bajo lock antes de consultar cuota', async () => {
  const bytes = Buffer.from('%PDF-replay');
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  const result = await insertarComprobantePg({
    telefono: '351', imagen_path: '/Transferencia/replay.pdf', fecha: new Date(), empresaId: 7,
    transportOrigin: 'cloud', sourceMessageId: 'wamid.replay',
    archivoBinario: bytes, mimetype: 'application/pdf',
  }, async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('source_message_id = $2') && sql.includes('dedupe_file_hash = $3')) {
      assert.deepEqual(params, [7, 'wamid.replay', actualHash]);
      return [{ id: 77, empresa_id: 7, pedido_id: null,
        source_message_id: 'wamid.replay', dedupe_file_hash: actualHash }];
    }
    throw new Error('replay no debe consultar cuota ni insertar');
  });

  assert.equal(result.duplicate, true);
  assert.equal(result.existing.id, 77);
  assert.equal(calls.some(call => call.sql.includes('SUM(archivo_size)')), false);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO comprobantes_transferencia')), false);
});

test('replay con source y hash apuntando a filas distintas falla cerrado', async () => {
  const bytes = Buffer.from('%PDF-split-brain');
  await assert.rejects(insertarComprobantePg({
    telefono: '351', imagen_path: '/Transferencia/conflict.pdf', fecha: new Date(), empresaId: 7,
    transportOrigin: 'cloud', sourceMessageId: 'wamid.conflict',
    archivoBinario: bytes, mimetype: 'application/pdf',
  }, async sql => {
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('source_message_id = $2') && sql.includes('dedupe_file_hash = $3')) {
      return [
        { id: 77, source_message_id: 'wamid.conflict', dedupe_file_hash: 'a'.repeat(64) },
        { id: 78, source_message_id: 'other', dedupe_file_hash: createHash('sha256').update(bytes).digest('hex') },
      ];
    }
    throw new Error('conflicto no debe continuar');
  }), error => error?.code === 'comprobante_idempotencia_conflictiva');
});

test('replay durable exige que source y hash coincidan exactamente en la misma fila', async () => {
  const bytes = Buffer.from('%PDF-source-hash-consistency');
  const actualHash = createHash('sha256').update(bytes).digest('hex');

  for (const existing of [
    { id: 77, source_message_id: 'wamid.same-source', dedupe_file_hash: 'a'.repeat(64) },
    { id: 78, source_message_id: 'wamid.other-source', dedupe_file_hash: actualHash },
  ]) {
    const calls = [];
    await assert.rejects(insertarComprobantePg({
      telefono: '351', imagen_path: '/Transferencia/conflict.pdf', fecha: new Date(), empresaId: 7,
      transportOrigin: 'cloud', sourceMessageId: 'wamid.same-source',
      archivoBinario: bytes, mimetype: 'application/pdf',
    }, async sql => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('source_message_id = $2') && sql.includes('dedupe_file_hash = $3')) return [existing];
      throw new Error('conflicto no debe consultar cuota ni insertar');
    }), error => error?.code === 'comprobante_idempotencia_conflictiva');
    assert.equal(calls.some(sql => sql.includes('SUM(archivo_size)')), false);
    assert.equal(calls.some(sql => sql.includes('INSERT INTO comprobantes_transferencia')), false);
  }
});

test('initDb y ensure instalan constraints durables idempotentes y validados', async () => {
  const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  for (const constraint of [
    'ck_ct_archivo_metadata_consistente',
    'ck_ct_archivo_size_real',
    'ck_ct_archivo_size_cap',
    'ck_ct_archivo_mimetype',
    'ck_ct_archivo_sha256',
  ]) {
    assert.match(initSql, new RegExp(`['\"]${constraint}['\"]`, 'i'));
    assert.match(initSql, /ADD CONSTRAINT %I %s NOT VALID/i);
    assert.match(initSql, new RegExp(`VALIDATE CONSTRAINT ${constraint}`, 'i'));
  }
  assert.match(initSql, /octet_length\(archivo_binario\)/i);
  assert.match(initSql, /archivo_size\s*<=\s*10485760/i);
  assert.match(initSql, /application\/pdf[\s\S]+image\/jpeg[\s\S]+image\/png[\s\S]+image\/webp/i);

  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: sql.includes('expected_constraints') ? [{ ready: true }] : [] };
    },
    release() {},
  };
  await ensureComprobantesTransferenciaSchema({
    pool: { async connect() { return client; } },
  });
  const combined = calls.join('\n');
  assert.match(combined, /ck_ct_archivo_metadata_consistente/i);
  assert.match(combined, /VALIDATE CONSTRAINT ck_ct_archivo_sha256/i);
});
