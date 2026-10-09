import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureComprobantesTransferenciaSchema } from '../src/transferenciasServices.js';

function schemaPool({ failWork, failRollback, failCommit } = {}) {
  const events = [];
  let connectCount = 0;
  let releasedWith;
  const client = {
    async query(sql, params = []) {
      events.push({ sql, params, client });
      if (sql === 'COMMIT' && failCommit) throw failCommit;
      if (sql === 'ROLLBACK' && failRollback) throw failRollback;
      if (failWork && /ALTER TABLE comprobantes_transferencia/i.test(sql)) throw failWork;
      if (sql.includes('expected_constraints')) return { rows: [{ ready: true }] };
      return { rows: [] };
    },
    release(error) {
      releasedWith = error;
      events.push({ sql: 'RELEASE', error, client });
    },
  };
  const pool = {
    async connect() {
      connectCount += 1;
      events.push({ sql: 'CONNECT', client });
      return client;
    },
  };
  return { pool, client, events, get connectCount() { return connectCount; }, get releasedWith() { return releasedWith; } };
}

test('DDL durable usa una conexión dedicada y comandos transaccionales separados en orden', async () => {
  const harness = schemaPool();
  await ensureComprobantesTransferenciaSchema({ pool: harness.pool }, {
    lockTimeoutMs: 123,
    statementTimeoutMs: 456,
  });

  assert.equal(harness.connectCount, 1);
  assert.ok(harness.events.every(event => event.client === harness.client));
  const sql = harness.events.map(event => event.sql);
  assert.deepEqual(sql.slice(0, 7), [
    'CONNECT',
    'BEGIN',
    'SET LOCAL search_path = public',
    "SET LOCAL lock_timeout = '123ms'",
    "SET LOCAL statement_timeout = '456ms'",
    'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',
    'LOCK TABLE public.comprobantes_transferencia IN ACCESS EXCLUSIVE MODE',
  ]);
  assert.equal(sql.at(-2), 'COMMIT');
  assert.equal(sql.at(-1), 'RELEASE');
  assert.equal(sql.some(statement => /BEGIN;[\s\S]*COMMIT;/i.test(statement)), false);
  assert.equal(harness.releasedWith, undefined);
});

test('DDL durable preserva el error de trabajo y hace rollback en el mismo cliente', async () => {
  const failure = Object.assign(new Error('private migration detail'), { code: 'XX001' });
  const harness = schemaPool({ failWork: failure });
  await assert.rejects(
    ensureComprobantesTransferenciaSchema({ pool: harness.pool }),
    error => error === failure,
  );
  const sql = harness.events.map(event => event.sql);
  assert.equal(sql.includes('ROLLBACK'), true);
  assert.equal(sql.includes('COMMIT'), false);
  assert.equal(harness.releasedWith, undefined);
});

test('DDL durable preserva el error original y descarta conexión si falla rollback', async () => {
  const failure = new Error('migration failed');
  const rollbackFailure = new Error('rollback failed');
  const harness = schemaPool({ failWork: failure, failRollback: rollbackFailure });
  await assert.rejects(
    ensureComprobantesTransferenciaSchema({ pool: harness.pool }),
    error => error === failure,
  );
  assert.equal(harness.releasedWith, rollbackFailure);
});

test('DDL durable trata COMMIT fallido como resultado indeterminado, sin rollback ni retry', async () => {
  const commitFailure = new Error('private socket commit detail');
  const harness = schemaPool({ failCommit: commitFailure });
  await assert.rejects(
    ensureComprobantesTransferenciaSchema({ pool: harness.pool }),
    error => error?.code === 'COMPROBANTE_SCHEMA_TRANSACTION_OUTCOME_UNKNOWN'
      && error.message === 'No se pudo confirmar la migración de comprobantes'
      && !Object.hasOwn(error, 'cause'),
  );
  const sql = harness.events.map(event => event.sql);
  assert.equal(sql.filter(statement => statement === 'COMMIT').length, 1);
  assert.equal(sql.includes('ROLLBACK'), false);
  assert.equal(harness.connectCount, 1);
  assert.equal(harness.releasedWith, commitFailure);
});

test('DDL durable acepta un cliente dedicado ya reservado sin liberarlo ni anidar transacción externa', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('expected_constraints')) return { rows: [{ ready: true }] };
      return { rows: [] };
    },
  };
  await ensureComprobantesTransferenciaSchema({ client });
  assert.equal(calls[0], 'BEGIN');
  assert.equal(calls.at(-1), 'COMMIT');
});
