import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const schemaUrl = new URL('../src/menu/schema.sql', import.meta.url);
async function fixture(pool) {
  await pool.query(`CREATE TABLE public.empresas(id SERIAL PRIMARY KEY);
    CREATE TABLE public.productos(id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES public.empresas ON DELETE CASCADE, nombre TEXT);
    CREATE TABLE public.pedidos(id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL REFERENCES public.empresas ON DELETE CASCADE, estado TEXT DEFAULT 'pendiente');
    CREATE TABLE public.items_pedido(id SERIAL PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES public.pedidos ON DELETE CASCADE, producto_id INTEGER REFERENCES public.productos ON DELETE SET NULL, producto TEXT, cantidad NUMERIC DEFAULT 1, precio_unitario NUMERIC);`);
  const sql = await readFile(schemaUrl, 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  await pool.query(`INSERT INTO empresas(id,menu_config) VALUES (1,'{"enabled":true}'),(2,'{}');
    INSERT INTO productos(id,empresa_id,nombre,disponibilidad_config) VALUES (1,1,'Menú','{"enabled":true,"daily_capacity":2}'),(2,2,'Otro','{}');
    INSERT INTO pedidos(id,empresa_id,fecha_entrega_programada) VALUES (1,1,'2026-10-20'),(2,1,'2026-10-20');`);
}
async function reserved(pool) {
  const mismatches = await pool.query(`SELECT c.empresa_id,c.producto_id,c.fecha
    FROM public.menu_cupos_diarios c FULL JOIN (
      SELECT empresa_id,producto_id,fecha,SUM(CASE WHEN activa THEN cantidad ELSE 0 END) AS n
      FROM public.menu_reservas_items GROUP BY empresa_id,producto_id,fecha
    ) r USING (empresa_id,producto_id,fecha)
    WHERE c.reservado IS DISTINCT FROM COALESCE(r.n,0)`);
  assert.deepEqual(mismatches.rows, [], 'every counter equals the active ledger, including delivered production');
  return Number((await pool.query('SELECT COALESCE(SUM(reservado),0) AS n FROM public.menu_cupos_diarios')).rows[0].n);
}
const reject = (fn, code) => assert.rejects(fn, error => error.code === code);
async function withMenu(work) {
  await withIsolatedPostgres(async bootstrap => {
    await bootstrap.query("CREATE DATABASE menu_utf8 ENCODING 'UTF8' TEMPLATE template0");
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ ...bootstrap.options, database: 'menu_utf8' });
    try { await fixture(pool); await work(pool); } finally { await pool.end(); }
  });
}

test('server accounting discount is exempt but gifts and malformed discounts fail closed', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query("INSERT INTO items_pedido(id,pedido_id,producto,producto_id,cantidad,precio_unitario) VALUES (50,1,'🎟️ DESCUENTO PROMO: Menú',NULL,1,-10)");
    assert.equal(await reserved(pool), 0);
    for (const [name, quantity, price] of [
      ['🎟️ DESCUENTO PROMO: Menú',1,0], ['🎟️ DESCUENTO PROMO: Menú',1,null],
      ['🎟️ DESCUENTO PROMO: Menú',1,'-Infinity'], ['🎟️ DESCUENTO PROMO: Menú',1,'NaN'],
      ['🎟️ DESCUENTO PROMO: Menú',2,-1], ['🎟️ DESCUENTO PROMO: Menú',null,-1],
      ['🎟️ DESCUENTO PROMO: ',1,-1], ['Regalo Menú',1,-1], ['Menú',1,0]
    ]) await reject(() => pool.query('INSERT INTO items_pedido(pedido_id,producto,cantidad,precio_unitario) VALUES (1,$1,$2,$3)', [name,quantity,price]), '23514');
    await pool.query("INSERT INTO items_pedido(id,pedido_id,producto,producto_id,cantidad,precio_unitario) VALUES (51,1,'Regalo',1,1,0)");
    assert.equal(await reserved(pool), 1);
    await reject(() => pool.query("UPDATE items_pedido SET producto_id=NULL, producto='🎟️ DESCUENTO PROMO: Menú',precio_unitario=-1 WHERE id=51"), '23514');
    assert.equal(await reserved(pool), 1);
    await pool.query("UPDATE pedidos SET fecha_entrega_programada=NULL WHERE id=2");
    await pool.query("INSERT INTO items_pedido(id,pedido_id,producto,cantidad,precio_unitario) VALUES (52,2,'🎟️ DESCUENTO PROMO: Menú',1,-1)");
    await reject(() => pool.query('UPDATE items_pedido SET precio_unitario=0 WHERE id=52'), '23514');
    await reject(() => pool.query("UPDATE items_pedido SET producto='Regalo' WHERE id=52"), '23514');
    await pool.query("UPDATE pedidos SET estado='entregado' WHERE id=1");
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=1");
    assert.equal(await reserved(pool), 1);
  });
});

test('legacy orders survive payment and historical lifecycle after scheduling is enabled', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query(`ALTER TABLE pedidos ADD COLUMN pagado boolean DEFAULT false;
      UPDATE empresas SET menu_config='{}'; UPDATE productos SET disponibilidad_config='{}';
      INSERT INTO pedidos(id,empresa_id,estado) VALUES (10,1,'pendiente'),(11,1,'entregado'),(12,1,'cancelado');
      INSERT INTO items_pedido(id,pedido_id,producto_id,producto,cantidad,precio_unitario)
      VALUES (10,10,1,'Menú',2,10),(11,11,1,'Menú',2,10),(12,12,1,'Menú',2,10),(13,10,NULL,'Legacy sin id',1,5);
      UPDATE empresas SET menu_config='{"enabled":true}' WHERE id=1;
      UPDATE productos SET disponibilidad_config='{"enabled":true,"daily_capacity":2}' WHERE id=1;`);
    await pool.query('UPDATE pedidos SET pagado=true WHERE id IN (10,11,12)');
    await pool.query("UPDATE items_pedido SET precio_unitario=12 WHERE id=10");
    await pool.query("UPDATE pedidos SET estado='en camino' WHERE id=10");
    await pool.query("UPDATE pedidos SET estado='entregado' WHERE id=10");
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id IN (10,11)");
    assert.equal(await reserved(pool), 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM menu_reservas_items')).rows[0].n, 0);
    for (const sql of [
      "UPDATE pedidos SET estado='pendiente' WHERE id=10",
      "UPDATE pedidos SET estado='pendiente' WHERE id=12",
      'UPDATE items_pedido SET cantidad=3 WHERE id=10',
      'UPDATE items_pedido SET pedido_id=12 WHERE id=10',
      'INSERT INTO items_pedido(pedido_id,producto_id,cantidad) VALUES (12,1,1)',
      'INSERT INTO items_pedido(pedido_id,producto,cantidad,precio_unitario) VALUES (12,\'Menú\',1,0)',
      'UPDATE pedidos SET empresa_id=2 WHERE id=10'
    ]) await assert.rejects(() => pool.query(sql));
    assert.equal(await reserved(pool), 0);
    // Adopting a real service date is a new scheduled intent, not grandfathering.
    await pool.query("UPDATE pedidos SET fecha_entrega_programada='2026-10-21',estado='pendiente' WHERE id=12");
    assert.equal(await reserved(pool), 2);
  });
});

test('cancelled commitments remain tracked through disabled configs and reopening', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=1");
    await pool.query("UPDATE empresas SET menu_config='{}'; UPDATE productos SET disponibilidad_config='{}'");
    await pool.query("UPDATE pedidos SET estado='pendiente' WHERE id=1");
    assert.equal(await reserved(pool), 2);
  });
});

test('delivered production cannot be erased or reassigned by any writer', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
    await pool.query("UPDATE pedidos SET estado='entregado' WHERE id=1");
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=1");
    assert.equal(await reserved(pool), 2);
    for (const sql of [
      'DELETE FROM items_pedido WHERE id=1', 'DELETE FROM pedidos WHERE id=1',
      'DELETE FROM productos WHERE id=1', 'DELETE FROM empresas WHERE id=1',
      'UPDATE items_pedido SET cantidad=1 WHERE id=1',
      'UPDATE items_pedido SET producto_id=NULL WHERE id=1',
      "UPDATE pedidos SET fecha_entrega_programada='2026-10-22' WHERE id=1",
      'UPDATE productos SET empresa_id=2 WHERE id=1'
    ]) await reject(() => pool.query(sql), '23514');
    assert.equal(await reserved(pool), 2);
  });
});

test('canonical identity, tenant and finite positive quantity fail closed', postgresOptions, async () => {
  await withMenu(async pool => {
    for (const quantity of [null, '0', '-1', 'NaN', 'Infinity', '-Infinity']) {
      await reject(() => pool.query('INSERT INTO items_pedido(pedido_id,producto_id,cantidad) VALUES (1,1,$1)', [quantity]), '23514');
    }
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (99,1,1,1)');
    for (const quantity of [null, 'NaN', '-Infinity', 'Infinity']) {
      await reject(() => pool.query('UPDATE items_pedido SET cantidad=$1 WHERE id=99', [quantity]), '23514');
      assert.equal(await reserved(pool), 1);
    }
    await pool.query('DELETE FROM items_pedido WHERE id=99');
    await reject(() => pool.query("INSERT INTO items_pedido(pedido_id,producto,cantidad) VALUES (1,'Menú',1)"), '23514');
    await reject(() => pool.query('INSERT INTO items_pedido(pedido_id,producto_id,cantidad) VALUES (1,2,1)'), '23503');
    await pool.query('UPDATE pedidos SET fecha_entrega_programada=NULL WHERE id=1');
    await reject(() => pool.query('INSERT INTO items_pedido(pedido_id,producto_id,cantidad) VALUES (1,1,1)'), '23514');
    await reject(() => pool.query('INSERT INTO items_pedido(pedido_id,producto_id,cantidad) VALUES (999,1,1)'), '23503');
    await pool.query("UPDATE empresas SET menu_config='{}'; UPDATE productos SET disponibilidad_config='{}'");
    await pool.query("INSERT INTO items_pedido(pedido_id,producto,cantidad) VALUES (1,'Legacy',NULL)");
    assert.equal(await reserved(pool), 0);
  });
});

test('SQL quota bounds match the pure policy for capacities and committed quantities', postgresOptions, async () => {
  await withMenu(async pool => {
    for (const config of [
      { daily_capacity: 9007199254740992 },
      { daily_capacity: -1 },
      { daily_capacity: '2' },
      { daily_capacity: 2, exceptions: [{date:'2026-10-20',capacity:9007199254740992}] },
      { daily_capacity: 2, exceptions: [{date:'2026-10-20',capacity:0},{date:'2026-10-20',capacity:null}] }
    ]) await reject(() => pool.query('SELECT public.menu_capacity($1::jsonb,\'2026-10-20\')', [JSON.stringify(config)]), '23514');
    await pool.query(`UPDATE productos SET disponibilidad_config='{"enabled":true,"daily_capacity":null}' WHERE id=1`);
    await reject(() => pool.query('INSERT INTO items_pedido(pedido_id,producto_id,cantidad) VALUES (1,1,9007199254740992)'), '23514');
    assert.equal(await reserved(pool), 0);
  });
});

test('capacity exceptions override base, null is unlimited, zero is sold out', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query(`UPDATE productos SET disponibilidad_config='{"enabled":true,"daily_capacity":0,"exceptions":[{"date":"2026-10-20","capacity":null}]}' WHERE id=1`);
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,10)');
    assert.equal(await reserved(pool), 10);
    await reject(() => pool.query(`UPDATE productos SET disponibilidad_config='{"enabled":false,"daily_capacity":9}' WHERE id=1`), '23514');
    await reject(() => pool.query(`UPDATE productos SET disponibilidad_config='{"enabled":true,"daily_capacity":20,"exceptions":[{"date":"2026-10-20","capacity":9}]}' WHERE id=1`), '23514');
    await pool.query('DELETE FROM items_pedido WHERE id=1');
    await pool.query("UPDATE pedidos SET fecha_entrega_programada='2026-10-21' WHERE id=1");
    await reject(() => pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,1)'), '23514');
    assert.equal(await reserved(pool), 0);
  });
});

test('original menu channel is constrained and immutable after a dated intent or reservation', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query("UPDATE pedidos SET menu_channel='landing', menu_intent_hash='committed' WHERE id=1");
    await reject(() => pool.query("UPDATE pedidos SET menu_channel='other' WHERE id=2"), '23514');
    await reject(() => pool.query("UPDATE pedidos SET menu_channel='catalog' WHERE id=1"), '23514');
    await reject(() => pool.query('UPDATE pedidos SET menu_channel=NULL WHERE id=1'), '23514');
    await pool.query("UPDATE pedidos SET menu_channel='catalog' WHERE id=2");
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (2,2,1,1)');
    for (const state of ['pendiente','cancelado','entregado']) {
      await pool.query('UPDATE pedidos SET estado=$1 WHERE id=2',[state]);
      await reject(() => pool.query("UPDATE pedidos SET menu_channel='landing' WHERE id=2"), '23514');
      assert.equal((await pool.query('SELECT menu_channel FROM pedidos WHERE id=2')).rows[0].menu_channel,'catalog');
    }
    assert.equal(await reserved(pool),1);
  });
});

async function blocked(pool, pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('second connection did not wait for the write barrier');
}

test('barrier-first application reads avoid lock inversion with a concurrent product writer', postgresOptions, async () => {
  await withMenu(async pool => {
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('UPDATE public.menu_write_barrier SET revision=revision+1 WHERE id=1');
      await a.query('SELECT * FROM empresas WHERE id=1 FOR SHARE');
      await a.query('SELECT * FROM productos WHERE id=1 FOR SHARE');
      const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const update = b.query(`UPDATE productos SET disponibilidad_config='{"enabled":true,"daily_capacity":1}' WHERE id=1`).then(() => null, error => error);
      await blocked(pool, pid);
      await a.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,1)');
      await a.query('COMMIT');
      assert.equal(await update, null);
      assert.equal(await reserved(pool), 1);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
  });
});

test('two real connections cannot consume the last slot or lower a racing cap', postgresOptions, async () => {
  await withMenu(async pool => {
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
      const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const second = b.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (2,2,1,1)').then(() => null, error => error);
      await blocked(pool, pid);
      await a.query('COMMIT');
      assert.equal((await second)?.code, '23514');
      assert.equal(await reserved(pool), 2);
      await a.query('BEGIN');
      await a.query('UPDATE items_pedido SET cantidad=1 WHERE id=1');
      const cap = b.query(`UPDATE productos SET disponibilidad_config='{"enabled":true,"daily_capacity":0}' WHERE id=1`).then(() => null, error => error);
      await blocked(pool, pid); await a.query('COMMIT');
      assert.equal((await cap)?.code, '23514');
      assert.equal(await reserved(pool), 1);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
  });
});

test('changing an item key cannot erase its disabled-but-existing commitment', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
    await pool.query("UPDATE empresas SET menu_config='{}'; UPDATE productos SET disponibilidad_config='{}'");
    await pool.query('UPDATE items_pedido SET id=50 WHERE id=1');
    assert.equal(await reserved(pool), 2);
    assert.equal((await pool.query('SELECT item_id FROM menu_reservas_items')).rows[0].item_id, 50);
  });
});

test('repeatable-read stale writers fail serialization instead of reading stale quota', postgresOptions, async () => {
  await withMenu(async pool => {
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await b.query('SELECT * FROM productos');
      await a.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
      await reject(() => b.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (2,2,1,1)'), '40001');
      await b.query('ROLLBACK');
      assert.equal(await reserved(pool), 2);
    } finally { await b.query('ROLLBACK'); a.release(); b.release(); }
  });
});

test('pending tenant cascade deletes release reservations without orphan keys', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
    await pool.query('DELETE FROM empresas WHERE id=1');
    assert.equal(await reserved(pool), 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM menu_reservas_items')).rows[0].n, 0);
  });
});

test('explicit runner imports without DDL and migrates transactionally under shadow search_path', postgresOptions, async () => {
  const { applyMenuAvailabilitySchema } = await import('../scripts/init-menu-availability.js');
  await withIsolatedPostgres(async pool => {
    assert.equal((await pool.query("SELECT to_regclass('public.menu_cupos_diarios') AS t")).rows[0].t, null);
    await pool.query(`CREATE TABLE public.empresas(id SERIAL PRIMARY KEY);
      CREATE TABLE public.productos(id SERIAL PRIMARY KEY,empresa_id INTEGER REFERENCES public.empresas,nombre TEXT);
      CREATE TABLE public.pedidos(id SERIAL PRIMARY KEY,empresa_id INTEGER REFERENCES public.empresas,estado TEXT);
      CREATE SCHEMA shadow; CREATE TABLE shadow.empresas(id INTEGER);
      CREATE TABLE shadow.pedidos(menu_channel text CONSTRAINT pedidos_menu_channel_check CHECK (menu_channel IS NULL));`);
    const client = await pool.connect();
    try {
      await client.query('SET search_path = shadow,public');
      await reject(() => applyMenuAvailabilitySchema(client), '42P01');
      assert.equal((await client.query("SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='empresas' AND column_name='menu_config'")).rows[0].n, 0);
      await client.query('CREATE TABLE public.items_pedido(id SERIAL PRIMARY KEY,pedido_id INTEGER,producto_id INTEGER,cantidad NUMERIC,producto TEXT)');
      await applyMenuAvailabilitySchema(client);
      await applyMenuAvailabilitySchema(client);
      assert.equal((await client.query("SELECT COUNT(*)::int n FROM pg_catalog.pg_constraint WHERE conrelid='public.pedidos'::pg_catalog.regclass AND conname='pedidos_menu_channel_check'")).rows[0].n,1);
      await reject(() => client.query("INSERT INTO public.pedidos(menu_channel) VALUES('other')"),'23514');
      assert.equal((await client.query("SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_schema='shadow' AND column_name='menu_config'")).rows[0].n, 0);
      assert.equal((await client.query("SELECT to_regclass('public.menu_cupos_diarios')::text t")).rows[0].t, 'menu_cupos_diarios');
    } finally { client.release(); }
  });
});

test('migration advisory lock serializes two explicit runners', postgresOptions, async () => {
  const { applyMenuAvailabilitySchema, MENU_MIGRATION_LOCK } = await import('../scripts/init-menu-availability.js');
  await withMenu(async pool => {
    const a = await pool.connect(); const b = await pool.connect();
    try {
      const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await a.query('BEGIN');
      await a.query('SELECT pg_advisory_xact_lock($1)', [MENU_MIGRATION_LOCK]);
      const migration = applyMenuAvailabilitySchema(b).then(() => null, error => error);
      await blocked(pool, pid);
      await a.query('COMMIT');
      assert.equal(await migration, null);
      const results = await Promise.all([applyMenuAvailabilitySchema(a), applyMenuAvailabilitySchema(b)]);
      assert.equal(results.length, 2);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
  });
});

test('reopen, quantity and date edits reject overbooking and roll back the entire mutation', postgresOptions, async () => {
  await withMenu(async pool => {
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=1");
    await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (2,2,1,2)');
    await reject(() => pool.query("UPDATE pedidos SET estado='pendiente' WHERE id=1"), '23514');
    assert.equal((await pool.query('SELECT estado FROM pedidos WHERE id=1')).rows[0].estado, 'cancelado');
    await reject(() => pool.query('UPDATE items_pedido SET cantidad=3 WHERE id=2'), '23514');
    assert.equal((await pool.query('SELECT cantidad FROM items_pedido WHERE id=2')).rows[0].cantidad, '2');
    await pool.query("UPDATE pedidos SET fecha_entrega_programada='2026-10-21', estado='pendiente' WHERE id=1");
    await reject(() => pool.query("UPDATE pedidos SET fecha_entrega_programada='2026-10-20' WHERE id=1"), '23514');
    assert.equal((await pool.query('SELECT fecha::text FROM menu_reservas_items WHERE item_id=1')).rows[0].fecha, '2026-10-21');
    await pool.query('DELETE FROM items_pedido WHERE id=2');
    assert.equal(await reserved(pool), 2);
    await pool.query('DELETE FROM pedidos WHERE id=1');
    assert.equal(await reserved(pool), 0);
    await reject(() => pool.query("INSERT INTO menu_reservas_items(item_id,pedido_id,empresa_id,producto_id,fecha,cantidad) VALUES (999,1,1,1,'2026-10-20',1)"), '23503');
  });
});

test('initDb embeds the identical menu migration in a separate transaction with CRLF intact', postgresOptions, async () => {
  const bytes = await readFile(new URL('../initDb.sql', import.meta.url));
  const text = bytes.toString('utf8');
  assert.equal(text.replaceAll('\r\n', '').includes('\n'), false);
  const marker = '-- BEGIN SCHEDULED MENU AVAILABILITY (explicit schema, no backfill)';
  const suffix = text.slice(text.indexOf(marker));
  assert.ok(suffix.includes('BEGIN;\r\nSET LOCAL search_path = public;\r\nSELECT pg_catalog.pg_advisory_xact_lock(684230158);'));
  assert.match(suffix, /-- END SCHEDULED MENU AVAILABILITY\r\nCOMMIT;\s*$/);
  assert.ok(suffix.includes((await readFile(schemaUrl, 'utf8')).replaceAll('\n', '\r\n')));
  await withIsolatedPostgres(async pool => {
    await pool.query(text);
    assert.equal((await pool.query("SELECT to_regclass('public.menu_reservas_items')::text t")).rows[0].t, 'menu_reservas_items');
    const { applyMenuAvailabilitySchema } = await import('../scripts/init-menu-availability.js');
    const client = await pool.connect();
    try { await applyMenuAvailabilitySchema(client); } finally { client.release(); }
  });
});

test('migration is explicit, repeatable and accounts every item writer', postgresOptions, async () => {
  await withIsolatedPostgres(async bootstrap => {
    await bootstrap.query("CREATE DATABASE menu_utf8 ENCODING 'UTF8' TEMPLATE template0");
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ ...bootstrap.options, database: 'menu_utf8' });
    try {
      assert.equal((await pool.query('SHOW server_encoding')).rows[0].server_encoding, 'UTF8');
      await fixture(pool);
      await pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (1,1,1,2)');
      assert.equal(await reserved(pool), 2);
      await reject(() => pool.query('INSERT INTO items_pedido(id,pedido_id,producto_id,cantidad) VALUES (2,2,1,1)'), '23514');
      await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=1");
      assert.equal(await reserved(pool), 0);
      await pool.query("UPDATE pedidos SET estado='pendiente' WHERE id=1");
      assert.equal(await reserved(pool), 2);
      await pool.query('UPDATE items_pedido SET cantidad=1 WHERE id=1');
      assert.equal(await reserved(pool), 1);
      await pool.query("UPDATE pedidos SET fecha_entrega_programada='2026-10-21' WHERE id=1");
      assert.equal((await pool.query('SELECT fecha::text FROM menu_reservas_items')).rows[0].fecha, '2026-10-21');
      await pool.query('DELETE FROM pedidos WHERE id=1');
      assert.equal(await reserved(pool), 0);
    } finally { await pool.end(); }
  });
});
