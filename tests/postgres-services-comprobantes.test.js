import test from 'node:test';
import assert from 'node:assert/strict';

import { saveComprobante } from '../src/postgresServices.js';
import { insertarComprobantePg } from '../src/transferenciasServices.js';

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
      return [{ id: 99, empresa_id: 7, pedido_id: 20 }];
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
    assert.match(sql, /dedupe_file_hash\s*=\s*\$2/i);
    assert.deepEqual(params, [7, 'b'.repeat(64)]);
    return [{ id: 100, empresa_id: 7, pedido_id: null }];
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
