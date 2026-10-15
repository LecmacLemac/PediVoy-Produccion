import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { createAgentService } from '../src/agents/service.js';
import { createAgentTools } from '../src/agents/tools.js';
import { createAgentToolsRouter } from '../src/routes/agentTools.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const key = '12345678-1234-4234-8234-123456789abc';
async function fixture(pool) {
  await pool.query(`CREATE TABLE empresas(id int PRIMARY KEY, plan_estado text, plan_vencimiento timestamptz);
    CREATE TABLE choferes(id int PRIMARY KEY, empresa_id int, activo boolean);
    CREATE TABLE referentes(id int PRIMARY KEY, empresa_id int, activo boolean, deleted_at timestamptz);
    CREATE TABLE usuarios(id int PRIMARY KEY, username text, role text, empresa_id int, chofer_id int, referente_id int, activo boolean);
    CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, chofer_id int, punto_entrega_id int, monto numeric, estado text, fecha timestamptz, fecha_entrega timestamptz);
    INSERT INTO empresas VALUES(7,'active',NULL),(8,'active',NULL);
    INSERT INTO choferes VALUES(4,7,TRUE),(5,7,TRUE);
    INSERT INTO usuarios VALUES(1,'synthetic-driver','repartidor',7,4,NULL,TRUE),(2,'synthetic-admin','admin',7,NULL,NULL,TRUE),(3,'synthetic-driver2','repartidor',7,5,NULL,TRUE);
    INSERT INTO pedidos VALUES(1,7,NULL,1,20,'pendiente',NOW(),NULL),(2,7,NULL,2,30,'cancelado',NOW(),NULL),(3,7,NULL,3,40,'entregado',NOW(),NOW()),(4,8,NULL,4,50,'cancelado',NOW(),NULL),(5,7,NULL,5,60,'pendiente',NOW(),NULL);`);
  await pool.query(await readFile(new URL('../src/agents/schema.sql', import.meta.url), 'utf8'));
  const query = async (sql, values) => (await pool.query(sql, values)).rows;
  const withTransaction = async (work, options) => {
    assert.equal(options.maxRetries, 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(async (sql, values) => (await client.query(sql, values)).rows);
      await client.query('COMMIT');
      return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  };
  return createAgentService({ query, withTransaction, enabled: true, canonicalOrigin: 'https://synthetic.pedivoy.example' });
}
async function serve(service, tools, work) {
  const app = express();
  app.use('/api/agent/v1', createAgentToolsRouter({ service, tools }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/agent/v1`;
  const call = (token, name, args) => fetch(`${base}/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ arguments: args }) });
  try { await work(call); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('real REST + service + tools: atomic claims, replay/hash conflict, role/scope denial and error audit', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const service = await fixture(pool);
    const driver = await service.createConnection({ uid: 1 }, { name: 'Synthetic driver', scopes: ['deliveries:read','deliveries:claim'] });
    const reader = await service.createConnection({ uid: 1 }, { name: 'Synthetic readonly', scopes: ['deliveries:read'] });
    const second = await service.createConnection({ uid: 3 }, { name: 'Synthetic driver2', scopes: ['deliveries:claim'] });
    await serve(service, createAgentTools({}), async call => {
      const available = await call(driver.token, 'listar_pedidos_disponibles', {});
      assert.equal(available.status, 200);
      assert.deepEqual((await available.json()).result.rows.map(row => row.id), [1,5]);
      assert.equal((await call(reader.token, 'tomar_pedido', { pedido_id: 1, operation_id: key })).status, 403);
      assert.equal((await call(driver.token, 'tomar_pedido', { pedido_id: 1 })).status, 400);
      const first = await call(driver.token, 'tomar_pedido', { operation_id: key, pedido_id: 1 });
      assert.equal(first.status, 200);
      const result = await first.json();
      assert.deepEqual(result, { ok: true, result: { pedido_id: 1, ok: true } });
      await assert.rejects(service.execute(driver.token, {
        scope: 'deliveries:claim', tool: 'otra_herramienta', write: true,
        idempotencyKey: key, requestHash: 'a'.repeat(64),
      }, () => assert.fail('tool mismatch must never execute work')), { status: 409 });
      const replay = await call(driver.token, 'tomar_pedido', { pedido_id: 1, operation_id: key });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), result);
      assert.equal((await call(driver.token, 'tomar_pedido', { pedido_id: 5, operation_id: key })).status, 409);
      const simultaneous = await Promise.all([
        call(driver.token, 'tomar_pedido', { pedido_id: 5, operation_id: '22345678-1234-4234-8234-123456789abc' }),
        call(second.token, 'tomar_pedido', { pedido_id: 5, operation_id: key }),
      ]);
      assert.deepEqual(simultaneous.map(res => res.status).sort(), [200,404]);
      const invalid = await call(driver.token, 'listar_entregas', { filter: { empresa_id: 8 } });
      assert.equal(invalid.status, 400);
      assert.equal((await call(driver.token, 'listar_pedidos', {})).status, 403);
    });
    assert.equal((await pool.query('SELECT chofer_id FROM pedidos WHERE id=1')).rows[0].chofer_id, 4);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM agent_idempotency')).rows[0].count, 2);
    const audit = (await pool.query("SELECT outcome FROM agent_audit WHERE tool='tomar_pedido' ORDER BY id")).rows.map(row => row.outcome);
    assert.ok(audit.includes('replayed'));
    assert.ok(audit.includes('error'));
  });
});

test('real reopening stays tenant-bound, rejects delivered and rolls back canonical handler failures', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    const service = await fixture(pool);
    const admin = await service.createConnection({ uid: 2 }, { name: 'Synthetic admin', scopes: ['orders:reopen'] });
    await serve(service, createAgentTools({}), async call => {
      for (const pedido_id of [3,4]) assert.equal((await call(admin.token, 'reabrir_pedido_cancelado', { pedido_id, operation_id: key })).status, 409);
      const res = await call(admin.token, 'reabrir_pedido_cancelado', { pedido_id: 2, operation_id: key });
      assert.equal(res.status, 200);
      const first = await res.json();
      assert.deepEqual(await (await call(admin.token, 'reabrir_pedido_cancelado', { operation_id: key, pedido_id: 2 })).json(), first);
    });
    assert.deepEqual((await pool.query('SELECT estado,monto,chofer_id FROM pedidos WHERE id=2')).rows[0], { estado: 'pendiente', monto: '30', chofer_id: null });
    assert.equal((await pool.query('SELECT estado FROM pedidos WHERE id=3')).rows[0].estado, 'entregado');
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=2");
    const rejectedTools = createAgentTools({ createUpdatePedidoHandlerFn: options => async (_req, res) => {
      // Synthetic downstream failure after a write must not be mistaken for success.
      await options.withTransactionFn(query => query("UPDATE pedidos SET estado='pendiente' WHERE id=2 AND empresa_id=7"));
      res.status(409).json({ error: 'SQL secret pva_should_not_escape' });
    } });
    await serve(service, rejectedTools, async call => {
      const res = await call(admin.token, 'reabrir_pedido_cancelado', { pedido_id: 2, operation_id: '32345678-1234-4234-8234-123456789abc' });
      assert.equal(res.status, 409);
      assert.equal(JSON.stringify(await res.json()).includes('secret'), false);
    });
    assert.equal((await pool.query('SELECT estado FROM pedidos WHERE id=2')).rows[0].estado, 'cancelado');
  });
});
