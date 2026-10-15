import test from 'node:test';
import assert from 'node:assert/strict';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const toolsModule = () => import('../src/agents/tools.js');
const context = (role = 'admin', scopes = ['identity:read']) => ({
  actor: { uid: 1, role, empresa_id: 7 }, empresaId: 7, scopes,
  query: async () => { throw new Error('No SQL expected'); },
});

test('closed immutable registry lists only explicitly delegated scopes and safe identity', async () => {
  let mod;
  try { mod = await toolsModule(); } catch (err) { assert.fail(`Missing implementation: ${err.code}`); }
  const tools = mod.createAgentTools({});
  assert.ok(Object.isFrozen(tools.registry));
  assert.deepEqual(tools.list(context()).map(t => t.name), ['mi_identidad']);
  assert.deepEqual(await tools.call('mi_identidad', {}, context()), {
    rol: 'admin', empresa_id: 7, scopes: ['identity:read'],
  });
  assert.equal(tools.get('ejecutar_sql'), undefined);
  await assert.rejects(tools.call('mi_identidad', { empresa_id: 8 }, context()), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(tools.call('mi_identidad', {}, context('admin', [])), { code: 'FORBIDDEN' });
  for (const tool of tools.registry) {
    assert.ok(Object.isFrozen(tool));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Object.isFrozen(tool.inputSchema));
  }
});

test('direct tool results are bounded and database envelopes cannot masquerade as rows', async () => {
  const { createAgentTools } = await toolsModule();
  const tools = createAgentTools({});
  const ctx = { ...context('admin', ['catalog:read']), query: async () => [{ id: 1, nombre: 'x'.repeat(2 * 1024 * 1024), precio: '1' }] };
  await assert.rejects(tools.call('listar_catalogo', {}, ctx), { code: 'RESULT_TOO_LARGE' });
  await assert.rejects(tools.call('listar_catalogo', {}, { ...ctx, query: async () => ({ rows: [{ id: 1 }] }) }), { code: 'INTERNAL_ERROR' });
});

test('bounded reads enforce actual tenant and assignee restrictions in isolated PostgreSQL', postgresOptions, async () => {
  const { createAgentTools } = await toolsModule();
  const tools = createAgentTools({});
  await withIsolatedPostgres(async pool => {
    await pool.query(`
      CREATE TABLE pedidos(id int PRIMARY KEY, empresa_id int, chofer_id int, punto_entrega_id int, estado text, fecha timestamptz, fecha_entrega timestamptz, monto numeric);
      CREATE TABLE productos(id int PRIMARY KEY, empresa_id int, nombre text, precio numeric, activo boolean, deleted_at timestamptz, mostrar_en_catalogo boolean);
      CREATE TABLE referente_productos(id int, empresa_id int, referente_id int, producto_id int, activo boolean, vigente_desde date, vigente_hasta date);
      CREATE TABLE cliente_referentes(id int, empresa_id int, referente_id int, punto_entrega_id int, estado text, asociado_at timestamptz, desvinculado_at timestamptz);
      CREATE TABLE facturas(id int, empresa_id int, estado text, importe_total numeric);
      INSERT INTO pedidos VALUES (1,7,4,1,'pendiente',NOW(),NULL,20),(2,7,5,2,'pendiente',NOW(),NULL,30),(3,8,4,3,'pendiente',NOW(),NULL,40),(4,7,NULL,4,'pendiente',NOW(),NULL,50),(5,7,NULL,4,'entregado',NOW(),NOW(),50),
        (6,7,5,4,'entregado',NOW()-INTERVAL '36 hours',NOW(),60),
        (7,7,5,4,'entregado',NOW()-INTERVAL '1 day',NOW(),70),
        (8,7,5,4,'entregado',NOW()-INTERVAL '3 days',NOW(),80);
      INSERT INTO productos VALUES (1,7,'A',10,TRUE,NULL,TRUE),(2,7,'B',20,TRUE,NULL,TRUE),(3,8,'C',30,TRUE,NULL,TRUE),(4,7,'borrado',40,TRUE,NOW(),TRUE);
      INSERT INTO referente_productos VALUES (1,7,9,1,TRUE,NULL,NULL),(2,7,10,2,TRUE,NULL,NULL),(3,7,9,2,TRUE,NULL,CURRENT_DATE-1);
      INSERT INTO cliente_referentes VALUES (1,7,9,1,'activo',NOW()-INTERVAL '1 day',NULL),(2,7,10,2,'activo',NOW()-INTERVAL '1 day',NULL),(3,8,9,3,'activo',NOW()-INTERVAL '1 day',NULL),(4,7,9,4,'desvinculado',NOW()-INTERVAL '2 day',NOW()-INTERVAL '1 day');
      INSERT INTO facturas VALUES (1,7,'emitida',15),(2,8,'emitida',90);
    `);
    const query = async (sql, values) => (await pool.query(sql, values)).rows;
    const ctx = (role, scopes, extra = {}) => ({ ...context(role, scopes), query, actor: { uid: 1, role, empresa_id: 7, chofer_id: 4, referente_id: 9 }, ...extra });
    assert.deepEqual((await tools.call('listar_entregas', {}, ctx('repartidor', ['deliveries:read']))).rows.map(r => r.id), [1]);
    const available = await tools.call('listar_pedidos_disponibles', {}, ctx('repartidor', ['deliveries:read']));
    assert.deepEqual(available.rows, [{ id: 4, estado: 'pendiente' }]);
    assert.deepEqual((await tools.call('listar_pedidos_referidos', {}, ctx('referente', ['referrals:read']))).rows.map(r => r.id), [1,6]);
    assert.deepEqual((await tools.call('listar_catalogo', {}, ctx('referente', ['catalog:read']))).rows.map(r => r.id), [1]);
    assert.deepEqual((await tools.call('listar_catalogo', {}, ctx('admin', ['catalog:read']))).rows.map(r => r.id), [1,2]);
    const page = await tools.call('listar_pedidos', { limit: 2 }, ctx('admin', ['orders:read']));
    assert.deepEqual(page.rows.map(r => r.id), [1,2]);
    assert.equal(page.next_cursor, 2);
    assert.deepEqual((await tools.call('listar_pedidos', { limit: 2, after_id: 2 }, ctx('admin', ['orders:read']))).rows.map(r => r.id), [4,5]);
    assert.deepEqual(await tools.call('resumen_facturacion', {}, ctx('contable', ['billing:read'])), { rows: [{ estado: 'emitida', cantidad: '1', importe_total: '15' }] });
    await assert.rejects(tools.call('listar_pedidos', {}, ctx('repartidor', ['orders:read'])), { code: 'FORBIDDEN' });
    await assert.rejects(tools.call('listar_pedidos', {}, ctx('super', ['orders:read'], { empresaId: null })), { code: 'FORBIDDEN' });
    await assert.rejects(tools.call('listar_pedidos', {}, ctx('admin', ['orders:read'], { empresaId: 8 })), { code: 'FORBIDDEN' });
    for (const args of [{ limit: 101 }, { after_id: -1 }, { empresa_id: 8 }, { filter: { empresa_id: 8 } }, { sql: 'SELECT 1' }]) {
      await assert.rejects(tools.call('listar_pedidos', args, ctx('admin', ['orders:read'])), { code: 'INVALID_ARGUMENTS' });
    }
  });
});
