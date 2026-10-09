import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { asociarComprobantePedidoPg, insertarComprobantePg } from '../src/transferenciasServices.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

function transactionRunner(pool) {
  return async work => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(async (sql, params = []) => (await client.query(sql, params)).rows);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY, empresa_id integer NOT NULL,
      telefono_normalizado text
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, punto_entrega_id integer,
      chofer_id integer, zona_id integer, metodo_pago text, estado text,
      monto numeric, fecha timestamptz DEFAULT now()
    );
    CREATE TABLE pedido_pagos (
      id serial PRIMARY KEY, pedido_id integer, empresa_id integer,
      settlement_at timestamptz, estado text
    );
    CREATE TABLE comprobante_pedido_aprobado_claims (
      tenant_key integer, pedido_id integer, comprobante_id integer
    );
    CREATE TABLE comprobantes_transferencia (
      id serial PRIMARY KEY, telefono text, archivo_path text, comprobante_path text,
      fecha timestamptz, pedido_id integer, empresa_id integer, chofer_id integer,
      zona_id integer, created_at timestamptz, updated_at timestamptz,
      validado integer DEFAULT 0, procesado boolean DEFAULT false,
      estado_revision text DEFAULT 'pendiente', riesgo_score integer, riesgo_flags text,
      verified_reason text, source_message_id text, file_hash text, dedupe_file_hash text,
      source_chat_jid text, transport_origin text, verified_by integer, verified_at timestamptz,
      archivo_binario bytea, archivo_mimetype text, archivo_size bigint, archivo_sha256 text
    );
    CREATE UNIQUE INDEX uq_ct_source_message_new
      ON comprobantes_transferencia ((COALESCE(empresa_id, 0)), source_message_id)
      WHERE source_message_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_ct_file_hash_new
      ON comprobantes_transferencia ((COALESCE(empresa_id, 0)), dedupe_file_hash)
      WHERE dedupe_file_hash IS NOT NULL;

    INSERT INTO puntos_entrega VALUES
      (10, 1, '3510000000'),
      (20, 2, '3510000000');
    INSERT INTO pedidos VALUES
      (100, 1, 10, 11, 101, 'transferencia', 'pendiente', 1000, now()),
      (200, 2, 20, 22, 202, 'transferencia', 'pendiente', 2000, now()),
      (101, 2, 10, 22, 202, 'transferencia', 'pendiente', 9000, now()),
      (201, 1, 20, 11, 101, 'transferencia', 'pendiente', 8000, now());
    INSERT INTO comprobantes_transferencia
      (id, telefono, fecha, empresa_id, estado_revision, validado, procesado)
      VALUES
      (1, '3510000000', now(), 1, 'pendiente', 0, false),
      (2, '3510000000', now(), 2, 'pendiente', 0, false),
      (3, '3510000000', now(), 1, 'pendiente', 0, false);
    SELECT setval(pg_get_serial_sequence('comprobantes_transferencia','id'), 10, true);
  `);
}

test('PostgreSQL real: asociación manual/automática cierra tenant, es transaccional y exact-row', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const withTransaction = transactionRunner(pool);

    await t.test('manual rechaza links corruptos en ambas direcciones y conserva válidos', async () => {
      await assert.rejects(
        asociarComprobantePedidoPg({
          id: 1, pedidoId: 201, actorRole: 'admin', actorEmpresaId: 1,
          actorId: 9, reason: 'intento corrupto A-B',
        }, { withTransaction }),
        error => error?.code === 'pedido_no_asociado',
      );
      await assert.rejects(
        asociarComprobantePedidoPg({
          id: 2, pedidoId: 101, actorRole: 'admin', actorEmpresaId: 2,
          actorId: 9, reason: 'intento corrupto B-A',
        }, { withTransaction }),
        error => error?.code === 'pedido_no_asociado',
      );
      const valid = await asociarComprobantePedidoPg({
        id: 1, pedidoId: 100, actorRole: 'admin', actorEmpresaId: 1,
        actorId: 9, reason: 'válido',
      }, { withTransaction });
      assert.equal(valid.empresa_id, 1);
      assert.equal(valid.pedido_id, 100);
    });

    await t.test('automática usa una transacción y el mismo teléfono no cruza pedidos corruptos', async () => {
      let transactionCount = 0;
      const result = await insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/auto.jpg',
        fecha: new Date('2026-09-28T12:00:00Z'), empresaId: 2,
        sourceMessageId: 'auto-tenant-2', fileHash: 'a'.repeat(64),
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, {
        withTransaction: async work => {
          transactionCount += 1;
          return withTransaction(work);
        },
      });
      assert.equal(transactionCount, 1);
      assert.equal(result.empresa_id, 2);
      assert.equal(result.pedido_id, 200);
      assert.equal(result.pedido_monto, 2000);
    });

    await t.test('Cloud persiste bytea y metadatos en la misma fila transaccional', async () => {
      const bytes = Buffer.from('%PDF-real-durable');
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      const result = await insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/cloud.pdf',
        fecha: new Date('2026-10-09T12:00:00Z'), empresaId: 2,
        sourceMessageId: 'cloud-durable-real', fileHash: 'e'.repeat(64), transportOrigin: 'cloud',
        archivoBinario: bytes, mimetype: 'application/pdf', bytes: 999999,
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction });

      const stored = (await pool.query(`
        SELECT archivo_binario, archivo_mimetype, archivo_size, archivo_sha256
          FROM comprobantes_transferencia
         WHERE id = $1 AND empresa_id = $2
      `, [result.id, 2])).rows[0];
      assert.deepEqual(stored.archivo_binario, bytes);
      assert.equal(stored.archivo_mimetype, 'application/pdf');
      assert.equal(Number(stored.archivo_size), bytes.length);
      assert.equal(stored.archivo_sha256, actualHash);
    });

    await t.test('Cloud serializa cuota por tenant y rechaza superar 1 GiB dentro de la transacción', async () => {
      await pool.query(`
        INSERT INTO comprobantes_transferencia
          (telefono, empresa_id, archivo_binario, archivo_mimetype, archivo_size, archivo_sha256)
        VALUES ('seed', 2, decode('00', 'hex'), 'image/jpeg', $1, $2)
      `, [1024 * 1024 * 1024, '0'.repeat(64)]);
      await assert.rejects(insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/quota-real.pdf',
        fecha: new Date(), empresaId: 2, transportOrigin: 'cloud',
        sourceMessageId: 'cloud-quota-real', archivoBinario: Buffer.from('%PDF-more'),
        mimetype: 'application/pdf',
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction }),
      error => error?.code === 'cuota_comprobantes_durables_excedida');
      const rows = await pool.query(
        'SELECT COUNT(*)::int AS c FROM comprobantes_transferencia WHERE source_message_id=$1',
        ['cloud-quota-real'],
      );
      assert.equal(rows.rows[0].c, 0);
    });

    await t.test('replay durable cerca de 1 GiB devuelve duplicate antes de cuota', async () => {
      const bytes = Buffer.from('%PDF-replay-near-quota');
      const first = await insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/replay-near-quota.pdf',
        fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
        sourceMessageId: 'cloud-replay-near-quota', archivoBinario: bytes,
        mimetype: 'application/pdf',
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction });
      await pool.query(`
        INSERT INTO comprobantes_transferencia
          (telefono, empresa_id, archivo_binario, archivo_mimetype, archivo_size, archivo_sha256)
        VALUES ('quota-fill', 1, decode('00', 'hex'), 'image/jpeg', $1, $2)
      `, [1024 * 1024 * 1024 - bytes.length, '0'.repeat(64)]);

      const replay = await insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/replay-near-quota.pdf',
        fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
        sourceMessageId: 'cloud-replay-near-quota', archivoBinario: bytes,
        mimetype: 'application/pdf',
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction });
      assert.equal(replay.duplicate, true);
      assert.equal(replay.existing.id, first.id);
    });

    await t.test('source y hash deben resolver exactamente la misma fila durable', async () => {
      await pool.query("DELETE FROM comprobantes_transferencia WHERE empresa_id=1 AND telefono='quota-fill'");
      const firstBytes = Buffer.from('%PDF-idempotency-original');
      const differentBytes = Buffer.from('%PDF-idempotency-different');
      const first = await insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/idempotency.pdf',
        fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
        sourceMessageId: 'cloud-idempotency-exact', archivoBinario: firstBytes,
        mimetype: 'application/pdf',
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction });

      await assert.rejects(insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/idempotency.pdf',
        fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
        sourceMessageId: 'cloud-idempotency-exact', archivoBinario: differentBytes,
        mimetype: 'application/pdf',
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction }),
      error => error?.code === 'comprobante_idempotencia_conflictiva');

      await assert.rejects(insertarComprobantePg({
        telefono: '5493510000000', imagen_path: '/Transferencia/idempotency.pdf',
        fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
        sourceMessageId: 'cloud-idempotency-other-source', archivoBinario: firstBytes,
        mimetype: 'application/pdf',
      }, async (sql, params = []) => (await pool.query(sql, params)).rows, { withTransaction }),
      error => error?.code === 'comprobante_idempotencia_conflictiva');

      const stored = await pool.query(
        'SELECT id, source_message_id FROM comprobantes_transferencia WHERE id=$1',
        [first.id],
      );
      assert.deepEqual(stored.rows, [{ id: first.id, source_message_id: 'cloud-idempotency-exact' }]);
    });

    await t.test('dos vinculaciones automáticas del mismo evento reservan una sola fila durable', async () => {
      const input = {
        telefono: '5493510000000', imagen_path: '/Transferencia/retry.jpg',
        fecha: new Date('2026-09-28T12:01:00Z'), empresaId: 1,
        sourceMessageId: 'auto-race-tenant-1', fileHash: 'b'.repeat(64),
      };
      const queryFn = async (sql, params = []) => (await pool.query(sql, params)).rows;
      const results = await Promise.all([
        insertarComprobantePg(input, queryFn, { withTransaction }),
        insertarComprobantePg(input, queryFn, { withTransaction }),
      ]);
      assert.equal(results.filter(result => !result.duplicate).length, 1);
      assert.equal(results.filter(result => result.duplicate).length, 1);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS c FROM comprobantes_transferencia WHERE empresa_id=1 AND source_message_id=$1',
        ['auto-race-tenant-1'],
      )).rows[0].c, 1);
    });

    await t.test('dos asociaciones concurrentes del mismo comprobante consumen exactamente una vez', async () => {
      const input = {
        id: 3, pedidoId: 100, actorRole: 'admin', actorEmpresaId: 1,
        actorId: 9, reason: 'carrera controlada',
      };
      const results = await Promise.allSettled([
        asociarComprobantePedidoPg(input, { withTransaction }),
        asociarComprobantePedidoPg(input, { withTransaction }),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      const row = (await pool.query('SELECT empresa_id, pedido_id FROM comprobantes_transferencia WHERE id=3')).rows[0];
      assert.deepEqual(row, { empresa_id: 1, pedido_id: 100 });
    });
  });
});
