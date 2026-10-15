import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { createAgentService } from '../src/agents/service.js';
import { createAgentTools } from '../src/agents/tools.js';
import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const operationId = '12345678-1234-4234-8234-123456789abc';
const tool = 'reabrir_pedido_cancelado';

// Capture every console method and both output streams, never print raw errors.
async function captureLogs(t, work) {
  const output = [];
  const mocks = [];
  for (const name of Object.keys(console)) {
    if (typeof console[name] === 'function' && /^[a-z]/.test(name)) {
      mocks.push(t.mock.method(console, name, (...args) => {
        output.push(inspect(args, { depth: null }));
      }));
    }
  }
  for (const stream of [process.stdout, process.stderr]) {
    mocks.push(t.mock.method(stream, 'write', (chunk, encoding, callback) => {
      output.push(String(chunk));
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) done();
      return true;
    }));
  }
  try { await work(); } finally { mocks.reverse().forEach(mock => mock.mock.restore()); }
  return output.join('\n');
}

test('real canonical reopening SQL failure is secret-safe and rolls back before audit/cache/effects', postgresOptions, async t => {
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE empresas(id int PRIMARY KEY, plan_estado text, plan_vencimiento timestamptz);
      CREATE TABLE choferes(id int PRIMARY KEY, empresa_id int, activo boolean);
      CREATE TABLE referentes(id int PRIMARY KEY, empresa_id int, activo boolean, deleted_at timestamptz);
      CREATE TABLE usuarios(id int PRIMARY KEY, username text, role text, empresa_id int,
        chofer_id int, referente_id int, activo boolean);
      CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, punto_entrega_id int,
        monto numeric, estado text);
      INSERT INTO empresas VALUES(7, 'active', NULL);
      INSERT INTO usuarios VALUES(2, 'synthetic-admin', 'admin', 7, NULL, NULL, TRUE);
      INSERT INTO pedidos VALUES(2, 7, 3, 30, 'cancelado');
      CREATE FUNCTION synthetic_update_failure() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'synthetic_sql_message_canary',
          DETAIL = 'synthetic_sql_detail_canary customer-canary@example.invalid',
          HINT = 'synthetic_sql_hint_canary pva_synthetic_token_canary';
      END;
      $$;
    `);
    await pool.query(await readFile(new URL('../src/agents/schema.sql', import.meta.url), 'utf8'));
    const query = async (sql, values) => (await pool.query(sql, values)).rows;
    let updates = 0;
    let stateBeforeFailure;
    let savepointRollbacks = 0;
    let sqlError;
    const service = createAgentService({
      query, enabled: true, canonicalOrigin: 'https://synthetic.pedivoy.example',
      withTransaction: async (work, options) => {
        assert.equal(options.maxRetries, 0);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(async (sql, values) => {
            if (/^ROLLBACK TO SAVEPOINT agent_operation/.test(sql)) savepointRollbacks++;
            const result = await client.query(sql, values);
            if (/^UPDATE pedidos SET/.test(sql.trim())) {
              updates++;
              stateBeforeFailure = result.rows[0].estado;
              // Fail in PostgreSQL after the real canonical UPDATE has written.
              try { await client.query('SELECT synthetic_update_failure()'); }
              catch (error) { sqlError = error; throw error; }
            }
            return result.rows;
          });
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
    });
    const admin = await service.createConnection({ uid: 2 }, {
      name: 'Synthetic admin', scopes: ['orders:reopen'],
    });
    const effects = [];
    let canonicalCalls = 0;
    const tools = createAgentTools({
      createUpdatePedidoHandlerFn: options => {
        canonicalCalls++;
        const observedOptions = { ...options };
        for (const name of ['notifyEstadoFn', 'notifyEnRutaFn', 'awardPointsFn', 'generateComisionesFn', 'postEntregaFn']) {
          observedOptions[name] = async (...args) => {
            effects.push(name);
            return options[name](...args);
          };
        }
        return createUpdatePedidoHandler(observedOptions);
      },
    });
    let rejection;
    const logs = await captureLogs(t, async () => {
      try {
        await service.execute(admin.token, {
          scope: 'orders:reopen', tool, write: true,
          idempotencyKey: operationId, requestHash: 'a'.repeat(64),
        }, context => tools.call(tool, { pedido_id: 2, operation_id: operationId }, context));
      } catch (error) { rejection = error; }
    });
    assert.equal(canonicalCalls, 1);
    assert.equal(updates, 1);
    assert.equal(stateBeforeFailure, 'pendiente', 'canonical UPDATE really wrote before failure');
    assert.equal(sqlError?.code, '23514', 'failure must come from PostgreSQL');
    assert.equal(typeof sqlError?.detail, 'string');
    assert.equal(typeof sqlError?.stack, 'string');
    assert.equal(rejection?.code, 'DOMAIN_REJECTED');
    assert.equal(rejection?.statusCode, 500);
    assert.equal(savepointRollbacks, 1);
    assert.deepEqual((await pool.query('SELECT estado,monto FROM pedidos WHERE id=2')).rows,
      [{ estado: 'cancelado', monto: '30' }]);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM agent_idempotency')).rows[0].count, 0);
    assert.deepEqual((await pool.query('SELECT outcome FROM agent_audit WHERE tool=$1', [tool])).rows,
      [{ outcome: 'error' }]);
    assert.deepEqual(effects, [], 'no notification, points, commission or marketing callback');
    const serialized = `${logs}\n${inspect(rejection, { depth: null })}`;
    for (const value of [sqlError.message, sqlError.detail, sqlError.hint, sqlError.stack,
      'customer-canary@example.invalid', 'pva_synthetic_token_canary', admin.token]) {
      assert.equal(serialized.includes(value), false, 'SQL diagnostics/PII/token must not reach output');
    }
    assert.equal(logs.includes('synthetic_update_failure'), false, 'SQL context must not reach logs');
    assert.equal(logs, inspect(['AGENT.PEDIDO.UPDATE.ERROR'], { depth: null }),
      'the only log must be the fixed event without error objects or diagnostics');
  });
});
