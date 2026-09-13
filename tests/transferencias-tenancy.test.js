import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  insertarComprobantePg,
  verificarDuplicadoOperacionPg,
  ensureComprobantesTransferenciaSchema,
} from '../src/transferenciasServices.js';

test('canal empresarial asocia solo un pedido de su empresa y conserva empresa fija', async () => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM pedidos')) {
      return [{ pedido_id: 202, empresa_id: 7, chofer_id: 4, monto: '1500.00' }];
    }
    return [{ id: 99, empresa_id: params[5], pedido_id: params[4] }];
  };

  const result = await insertarComprobantePg({
    telefono: '5493510000000',
    imagen_path: '/Transferencia/seguro.jpg',
    fecha: new Date('2026-09-13T12:00:00Z'),
    empresaId: 7,
  }, queryFn);

  assert.match(calls[0].sql, /p\.empresa_id = \$2/);
  assert.deepEqual(calls[0].params, ['3510000000', 7]);
  assert.equal(calls[1].params[5], 7);
  assert.equal(result.empresa_id, 7);
  assert.equal(result.pedido_monto, 1500);
});

test('empresa fija descarta una fila inconsistente perteneciente a otro tenant', async () => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM pedidos')) {
      return [{ pedido_id: 888, empresa_id: 8, chofer_id: 4, monto: '1500.00' }];
    }
    return [{ id: 101, empresa_id: params[5], pedido_id: params[4] }];
  };

  const result = await insertarComprobantePg({
    telefono: '5493510000000',
    imagen_path: '/Transferencia/inconsistente.jpg',
    fecha: new Date('2026-09-13T12:00:00Z'),
    empresaId: 7,
  }, queryFn);

  assert.equal(calls[1].params[4], null);
  assert.equal(calls[1].params[5], 7);
  assert.equal(result.pedido_id, null);
  assert.equal(result.association_reason, 'pedido_no_asociado');
});

test('canal General no asocia ni elige empresa cuando el teléfono aparece en varias empresas', async () => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM pedidos')) {
      return [
        { pedido_id: 301, empresa_id: 3, chofer_id: 8, monto: '900.00' },
        { pedido_id: 402, empresa_id: 4, chofer_id: 9, monto: '900.00' },
      ];
    }
    return [{ id: 100, empresa_id: params[5], pedido_id: params[4] }];
  };

  const result = await insertarComprobantePg({
    telefono: '3510000000',
    imagen_path: '/Transferencia/ambiguo.jpg',
    fecha: new Date('2026-09-13T12:00:00Z'),
  }, queryFn);

  assert.match(calls[0].sql, /DISTINCT ON \(p\.empresa_id\)/);
  assert.equal(calls[1].params[4], null);
  assert.equal(calls[1].params[5], null);
  assert.equal(calls[1].params[7], 100);
  assert.equal(calls[1].params[8], 'telefono_multiempresa');
  assert.equal(calls[1].params[9], 'telefono_multiempresa');
  assert.equal(result.ambiguous, true);
});

test('duplicado de operación se comprueba dentro de la empresa', async () => {
  let captured;
  const found = await verificarDuplicadoOperacionPg('OP-123', 7, async (sql, params) => {
    captured = { sql, params };
    return [{ id: 1 }];
  });

  assert.equal(found, true);
  assert.match(captured.sql, /empresa_id = \$2/);
  assert.deepEqual(captured.params, ['OP-123', 7]);
});

test('inserción reserva source message y hash atómicamente sin duplicar por tenant', async () => {
  const reserved = new Set();
  const queryFn = async (sql, params) => {
    if (sql.includes('FROM pedidos')) {
      return [{
        pedido_id: 202, empresa_id: 7, chofer_id: 4, monto: '1500.00',
        metodo_pago: 'transferencia', pago_acreditado: false,
      }];
    }
    const key = `${params[5]}:${params[10]}`;
    if (sql.includes('INSERT INTO comprobantes_transferencia')) {
      assert.match(sql, /source_message_id/);
      assert.match(sql, /dedupe_file_hash/);
      assert.doesNotMatch(sql, /ON CONFLICT DO NOTHING/);
      if (reserved.has(key)) {
        throw Object.assign(new Error('source duplicado'), {
          code: '23505', constraint: 'uq_ct_source_message_new',
        });
      }
      reserved.add(key);
      return [{ id: 99, empresa_id: 7, pedido_id: 202 }];
    }
    assert.match(sql, /FROM comprobantes_transferencia/);
    assert.match(sql, /empresa_id IS NOT DISTINCT FROM \$1/);
    return [{ id: 99, empresa_id: 7, pedido_id: 202 }];
  };
  const input = {
    telefono: '5493510000000', imagen_path: '/Transferencia/seguro.jpg',
    fecha: new Date(), empresaId: 7, sourceMessageId: 'false_wa_msg_1',
    fileHash: 'b'.repeat(64),
  };

  const [first, duplicate] = await Promise.all([
    insertarComprobantePg(input, queryFn),
    insertarComprobantePg(input, queryFn),
  ]);

  assert.equal([first, duplicate].filter(row => !row.duplicate).length, 1);
  assert.equal([first, duplicate].filter(row => row.duplicate).length, 1);
});

test('migración runtime instala sin drift el bloque completo marcado de initDb.sql', async () => {
  const statements = [];
  await ensureComprobantesTransferenciaSchema(async sql => { statements.push(sql); return []; });
  const sql = statements.join('\n');
  const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const startMarker = '-- BEGIN COMPROBANTE CONCURRENCY MIGRATION';
  const endMarker = '-- END COMPROBANTE CONCURRENCY MIGRATION';
  const expectedBlock = initSql.slice(
    initSql.indexOf(startMarker) + startMarker.length,
    initSql.indexOf(endMarker),
  ).trim();

  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_message_id/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS dedupe_file_hash/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS approval_dedupe_key/);
  assert.match(sql, /UNIQUE[\s\S]*COALESCE\(empresa_id, 0\)[\s\S]*source_message_id/);
  assert.match(sql, /WHERE source_message_id IS NOT NULL/);
  assert.doesNotMatch(sql, /UPDATE comprobantes_transferencia SET (?:dedupe|approval)/);
  assert.ok(statements.some(statement => statement.trim() === expectedBlock));
  assert.match(sql, /CREATE OR REPLACE FUNCTION normalizar_comprobante_operacion/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS comprobante_operacion_claims/);
  assert.match(sql, /CREATE TRIGGER trg_validar_aprobacion_comprobante/);
  assert.match(sql, /CREATE TRIGGER trg_serializar_pedido_pago_comprobante/);
});
