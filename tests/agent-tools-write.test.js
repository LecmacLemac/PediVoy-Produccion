import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from '../src/agents/tools.js';
import { createUpdatePedidoHandler } from '../src/routes/pedidos.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
const operation = '12345678-1234-4234-8234-123456789abc';

test('claim reuses canonical transaction and validates operation UUID before writes', postgresOptions, async () => {
  const tools = createAgentTools({});
  await withIsolatedPostgres(async pool => {
    await pool.query(`CREATE TABLE choferes(id int, empresa_id int, activo boolean);
      CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, chofer_id int, estado text);
      INSERT INTO choferes VALUES (4,7,TRUE),(5,7,FALSE);
      INSERT INTO pedidos VALUES (1,7,NULL,'pendiente'),(2,8,NULL,'pendiente'),(3,7,6,'pendiente'),(4,7,NULL,'entregado');`);
    const client = await pool.connect();
    const ctx = { empresaId: 7, scopes: ['deliveries:claim'], actor: { role: 'repartidor', empresa_id: 7, chofer_id: 4 }, query: async (sql, values) => (await client.query(sql, values)).rows };
    try {
      await client.query('BEGIN');
      for (const args of [{ pedido_id: 1 }, { pedido_id: 1, operation_id: 'bad' }, { pedido_id: 1, operation_id: `${operation}\n` }, { pedido_id: 1, operation_id: operation, chofer_id: 5 }]) {
        await assert.rejects(tools.call('tomar_pedido', args, ctx), { code: 'INVALID_ARGUMENTS' });
      }
      await assert.rejects(tools.call('tomar_pedido', { pedido_id: 1, operation_id: operation }, { ...ctx, scopes: [] }), { code: 'FORBIDDEN' });
      for (const pedido_id of [2,3,4]) await assert.rejects(tools.call('tomar_pedido', { pedido_id, operation_id: operation }, ctx), { statusCode: 404 });
      await assert.rejects(tools.call('tomar_pedido', { pedido_id: 1, operation_id: operation }, { ...ctx, actor: { ...ctx.actor, chofer_id: 5 } }), { statusCode: 403 });
      assert.deepEqual(await tools.call('tomar_pedido', { pedido_id: 1, operation_id: operation }, ctx), { pedido_id: 1, ok: true });
      assert.equal((await client.query('SELECT chofer_id FROM pedidos WHERE id=1')).rows[0].chofer_id, 4);
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT chofer_id FROM pedidos WHERE id=1')).rows[0].chofer_id, null);
    } finally { client.release(); }
  });
});

test('reopen only cancelled orders with canonical actor and selected tenant', postgresOptions, async () => {
  let factories = 0;
  const effects = { notifyEstadoFn: 0, notifyEnRutaFn: 0, awardPointsFn: 0, generateComisionesFn: 0, postEntregaFn: 0 };
  const bodies = [];
  const tools = createAgentTools({ createUpdatePedidoHandlerFn(options) {
    factories++;
    for (const key of Object.keys(effects)) {
      assert.equal(typeof options[key], 'function', `must override external default ${key}`);
      const original = options[key];
      options[key] = async (...args) => { effects[key]++; return original(...args); };
    }
    const handler = createUpdatePedidoHandler(options);
    return (req, res) => { bodies.push(req.body); return handler(req, res); };
  } });
  await withIsolatedPostgres(async pool => {
    await pool.query(`CREATE TABLE usuarios(id int, role text, empresa_id int, activo boolean);
      CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, punto_entrega_id int, estado text, monto numeric, chofer_id int);
      INSERT INTO usuarios VALUES (1,'admin',7,TRUE),(2,'super',NULL,TRUE),(3,'user',7,TRUE);
      INSERT INTO pedidos VALUES (1,7,1,'cancelado',40,4),(2,7,1,'entregado',60,4),(3,8,2,'cancelado',70,5),(4,7,1,'cancelado',80,4);`);
    const client = await pool.connect();
    const query = async (sql, values) => (await client.query(sql, values)).rows;
    const ctx = { actor: { uid: 1, role: 'admin', empresa_id: 7 }, empresaId: 7, scopes: ['orders:reopen'], query };
    try {
      await client.query('BEGIN');
      for (const pedido_id of [2,3]) await assert.rejects(tools.call('reabrir_pedido_cancelado', { pedido_id, operation_id: operation }, ctx), { statusCode: 409 });
      await assert.rejects(tools.call('reabrir_pedido_cancelado', { pedido_id: 1, operation_id: operation }, { ...ctx, actor: { uid: 3, role: 'admin', empresa_id: 7 } }), { statusCode: 403 });
      assert.deepEqual(await tools.call('reabrir_pedido_cancelado', { pedido_id: 1, operation_id: operation }, ctx), { pedido_id: 1, estado: 'pendiente' });
      await assert.rejects(tools.call('reabrir_pedido_cancelado', { pedido_id: 1, operation_id: operation }, ctx), { statusCode: 409 });
      const superCtx = { ...ctx, actor: { uid: 2, role: 'super', empresa_id: null }, empresaId: 7 };
      await assert.rejects(tools.call('reabrir_pedido_cancelado', { pedido_id: 3, operation_id: operation }, superCtx), { statusCode: 409 });
      assert.deepEqual(await tools.call('reabrir_pedido_cancelado', { pedido_id: 4, operation_id: operation }, superCtx), { pedido_id: 4, estado: 'pendiente' });
      assert.deepEqual((await client.query('SELECT estado, monto, chofer_id FROM pedidos WHERE id=1')).rows[0], { estado: 'pendiente', monto: '40', chofer_id: 4 });
      assert.equal((await client.query('SELECT estado FROM pedidos WHERE id=2')).rows[0].estado, 'entregado');
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT estado FROM pedidos WHERE id=1')).rows[0].estado, 'cancelado');
      assert.equal(factories, 2);
      assert.deepEqual(bodies, [{ estado: 'pendiente' }, { estado: 'pendiente', empresa_id: 7 }]);
      assert.deepEqual(effects, { notifyEstadoFn: 2, notifyEnRutaFn: 0, awardPointsFn: 0, generateComisionesFn: 0, postEntregaFn: 0 });
    } finally { client.release(); }
  });
});
