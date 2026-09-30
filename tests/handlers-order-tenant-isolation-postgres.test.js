import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const handlersPath = path.join(root, 'src/handlers.js');

function queryTemplateLiterals(source) {
  const blocks = [];
  const calls = /\b(?:query|queryFn|txQuery)\s*\(\s*/g;
  for (const call of source.matchAll(calls)) {
    let i = call.index + call[0].length;
    while (/\s/.test(source[i] || '')) i += 1;
    if (source[i] !== '`') continue;
    let value = '';
    let escaped = false;
    for (i += 1; i < source.length; i += 1) {
      const char = source[i];
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === '\\') {
        value += char;
        escaped = true;
      } else if (char === '`') {
        blocks.push(value);
        break;
      } else {
        value += char;
      }
    }
  }
  return blocks;
}

function pedidoPuntoJoinBlocks(source) {
  return queryTemplateLiterals(source).filter(sql =>
    /\bpedidos\s+(?:AS\s+)?p\b/i.test(sql)
    && /\bpuntos_entrega\s+(?:AS\s+)?pe\d*\b/i.test(sql)
    && /\bJOIN\b/i.test(sql)
  );
}

test('inventario estructural: cada bloque pedidos-puntos de handlers cierra padre, hijo y tenant contextual', () => {
  const source = fs.readFileSync(handlersPath, 'utf8');
  const blocks = pedidoPuntoJoinBlocks(source);
  assert.equal(blocks.length, 17, `inventario inesperado: ${blocks.length}`);

  for (const [index, sql] of blocks.entries()) {
    const aliases = [...sql.matchAll(/JOIN\s+puntos_entrega\s+(pe\d*)\s+ON\s+([\s\S]*?)(?=\b(?:LEFT|RIGHT|FULL|INNER|JOIN|WHERE|GROUP|ORDER|LIMIT|RETURNING)\b|$)/gi)];
    assert.ok(aliases.length > 0, `bloque ${index + 1} sin JOIN segmentable:\n${sql}`);
    for (const match of aliases) {
      const alias = match[1];
      const on = match[2];
      const orderAlias = alias === 'pe2' ? 'p2' : 'p';
      assert.match(on, new RegExp(`(?:${alias}\\.empresa_id\\s*=\\s*${orderAlias}\\.empresa_id|${orderAlias}\\.empresa_id\\s*=\\s*${alias}\\.empresa_id)`, 'i'), `bloque ${index + 1}, ${alias} sin igualdad tenant:\n${sql}`);
    }
    assert.match(sql, /p\.empresa_id\s*=\s*\$1/i, `bloque ${index + 1} no exige tenant del pedido:\n${sql}`);
  }
});

test('inventario estructural: relaciones tenant-owned auxiliares fallan cerradas', () => {
  const source = fs.readFileSync(handlersPath, 'utf8');
  const blocks = queryTemplateLiterals(source);

  const movementOrders = blocks.filter(sql => /LEFT JOIN\s+pedidos\s+p\s+ON\s+p\.id\s*=\s*m\.ref_pedido_id/i.test(sql));
  assert.equal(movementOrders.length, 3);
  for (const sql of movementOrders) {
    assert.match(sql, /p\.empresa_id\s*=\s*m\.empresa_id/i);
    assert.match(sql, /m\.ref_pedido_id\s+IS\s+NULL[\s\S]*p\.id\s+IS\s+NOT\s+NULL/i);
  }

  const zoneBlock = blocks.find(sql => /LEFT JOIN\s+zonas_geograficas\s+z/i.test(sql));
  assert.ok(zoneBlock);
  assert.match(zoneBlock, /z\.empresa_id\s*=\s*pe\.empresa_id/i);

  const identityBlock = blocks.find(sql => /FROM\s+usuarios\s+u[\s\S]*LEFT JOIN\s+choferes/i.test(sql));
  assert.ok(identityBlock);
  assert.match(identityBlock, /c\.empresa_id\s*=\s*u\.empresa_id/i);
  assert.match(identityBlock, /r\.empresa_id\s*=\s*u\.empresa_id/i);
});

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      cliente text NOT NULL,
      telefono text,
      direccion text,
      zona_id integer
    );
    CREATE TABLE pedidos (
      id serial PRIMARY KEY,
      empresa_id integer NOT NULL,
      punto_entrega_id integer,
      fecha timestamptz NOT NULL DEFAULT now(),
      fecha_entrega timestamptz,
      estado text,
      cantidad numeric,
      cantidad_entregada numeric,
      monto numeric,
      metodo_pago text,
      aviso_recibido integer,
      sats integer,
      chofer_id integer,
      zona_id integer,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE productos (
      id integer PRIMARY KEY,
      empresa_id integer NOT NULL,
      nombre text NOT NULL,
      precio numeric,
      config_activo boolean DEFAULT false,
      retornable boolean DEFAULT false
    );
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY,
      pedido_id integer NOT NULL,
      producto_id integer,
      producto text NOT NULL,
      cantidad numeric NOT NULL,
      precio_unitario numeric
    );
    CREATE TABLE zonas_geograficas (id integer PRIMARY KEY, empresa_id integer NOT NULL, nombre text);
    CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer NOT NULL);
    CREATE TABLE chofer_stock_mov (
      id serial PRIMARY KEY, empresa_id integer NOT NULL, chofer_id integer NOT NULL,
      producto_id integer NOT NULL, ref_pedido_id integer, cantidad numeric NOT NULL,
      precio_unitario numeric, monto numeric, tipo text NOT NULL, fecha timestamptz NOT NULL
    );
    CREATE TABLE chofer_costos (
      id serial PRIMARY KEY, empresa_id integer NOT NULL, chofer_id integer NOT NULL,
      producto_id integer NOT NULL, costo_unitario numeric
    );
    CREATE TABLE gastos_repartidor (
      id serial PRIMARY KEY, empresa_id integer NOT NULL, chofer_id integer, monto numeric, fecha timestamptz
    );
    CREATE TABLE chofer_escalas (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, chofer_id integer,
      vigente_desde date NOT NULL, vigente_hasta date
    );
    CREATE TABLE chofer_escala_tramos (
      id serial PRIMARY KEY, escala_id integer NOT NULL, rango_min integer,
      rango_max integer, monto numeric
    );

    INSERT INTO puntos_entrega (id, empresa_id, cliente, telefono, direccion, zona_id) VALUES
      (10, 1, 'Cliente Igual', '5493511111111', 'Dirección A', 101),
      (20, 2, 'Cliente Igual', '5493511111111', 'Dirección B', 202);
    INSERT INTO productos (id, empresa_id, nombre, precio) VALUES
      (10, 1, 'Bidón', 100),
      (20, 2, 'Bidón', 200);
    INSERT INTO zonas_geograficas VALUES (101, 1, 'Zona A'), (202, 2, 'Zona B');
    INSERT INTO choferes VALUES (10, 1), (20, 2);
    INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, fecha_entrega, estado, cantidad, monto, metodo_pago, chofer_id) VALUES
      (1, 1, 10, '2026-09-28T10:00:00Z', '2026-09-28T11:00:00Z', 'entregado', 1, 100, 'efectivo', 10),
      (2, 2, 20, '2026-09-28T10:00:00Z', '2026-09-28T11:00:00Z', 'entregado', 1, 200, 'efectivo', 20),
      (3, 2, 10, '2026-09-28T12:00:00Z', '2026-09-28T13:00:00Z', 'entregado', 9, 999, 'efectivo', 20),
      (4, 1, 20, '2026-09-28T14:00:00Z', '2026-09-28T15:00:00Z', 'entregado', 8, 888, 'efectivo', 10);
    INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario) VALUES
      (1, 10, 'Bidón', 1, 100),
      (2, 20, 'Bidón', 1, 200),
      (3, 20, 'Bidón', 9, 111),
      (4, 10, 'Bidón', 8, 111);
    SELECT setval(pg_get_serial_sequence('pedidos','id'), 100, true);
  `);
}

function fakeClient() {
  let listener;
  const replies = [];
  return {
    replies,
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage(_to, text) { replies.push(text); },
    async send(body, contextResolver) {
      replies.length = 0;
      await listener({
        from: '5493511111111@c.us',
        body,
        id: { _serialized: `${body}-${Math.random()}`, fromMe: false },
      }, contextResolver);
      return [...replies];
    },
  };
}

test('PostgreSQL real: listados, total 999 y reposición excluyen ambas corrupciones tenant', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    const { host, port, user, database } = pool.options;
    process.env.DATABASE_URL = `postgresql://${user}@${host}:${port}/${database}`;
    const handlersModule = await import(`../src/handlers.js?tenant-pg=${Date.now()}`);
    // handlers.js imports the canonical db.js URL, so close that exact pool through a separate canonical import.
    const canonicalDb = await import('../src/db.js');
    try {
      const superClient = fakeClient();
      handlersModule.default.start(superClient, {
        contextResolver: async () => ({ resolution: 'unique', role: 'super', empresa_id: 1, chofer_id: null, tenantLocked: true }),
      });
      const list = await superClient.send('ver pedidos');
      assert.equal(list.length, 1);
      assert.match(list[0], /\$100/);
      assert.doesNotMatch(list[0], /\$999|\$888|Dirección B/);

      const summary = await superClient.send('resumen 2026-09-28');
      assert.equal(summary.length, 1);
      assert.match(summary[0], /Ventas: \*\$100\*/);
      assert.doesNotMatch(summary[0], /\$1099|\$999|\$988|\$888/);
      const profitability = await superClient.send('rentabilidad 2026-09-28');
      assert.match(profitability[0], /Ingresos: \*\$100\*/);
      assert.doesNotMatch(profitability[0], /\$999|\$888|\$1099/);
      const statistics = await superClient.send('estadistica 2026-09-28');
      assert.match(statistics[0], /Pedidos entregados: \*1\*/);
      assert.match(statistics[0], /Zona A: 1 \(\$100\)/);
      assert.doesNotMatch(statistics[0], /Zona B|\$999|\$888/);

      const driverClient = fakeClient();
      handlersModule.default.start(driverClient, {
        contextResolver: async () => ({ resolution: 'unique', role: 'repartidor', empresa_id: 1, chofer_id: 10, tenantLocked: true }),
      });
      const driverSummary = await driverClient.send('resumen 2026-09-28');
      assert.match(driverSummary[0], /Ventas: \*\$100\*/);
      assert.match(driverSummary[0], /Artículos entregados: \*1\*/);
      assert.doesNotMatch(driverSummary[0], /\$999|\$888|\$1099/);

      const tenantTwoClient = fakeClient();
      handlersModule.default.start(tenantTwoClient, {
        contextResolver: async () => ({ resolution: 'unique', role: 'super', empresa_id: 2, chofer_id: null, tenantLocked: true }),
      });
      const tenantTwoList = await tenantTwoClient.send('ver pedidos');
      assert.match(tenantTwoList[0], /\$200/);
      assert.doesNotMatch(tenantTwoList[0], /\$999|\$888|Dirección A/);
      const tenantTwoSummary = await tenantTwoClient.send('resumen 2026-09-28');
      assert.match(tenantTwoSummary[0], /Ventas: \*\$200\*/);
      assert.doesNotMatch(tenantTwoSummary[0], /\$1199|\$1088|\$999|\$888/);

      await pool.query("DELETE FROM items_pedido WHERE pedido_id = 1; DELETE FROM pedidos WHERE id = 1");
      const before = Number((await pool.query('SELECT count(*) AS c FROM pedidos')).rows[0].c);
      const customerClient = fakeClient();
      handlersModule.default.start(customerClient, {
        contextResolver: async () => ({ resolution: 'unique', role: 'cliente', empresa_id: 1, chofer_id: null, tenantLocked: true }),
      });
      const replenishment = await customerClient.send('necesitas reposición');
      assert.equal(replenishment.length, 1);
      assert.match(replenishment[0], /primera vez|hace mucho no pedís/i);
      const after = Number((await pool.query('SELECT count(*) AS c FROM pedidos')).rows[0].c);
      assert.equal(after, before, 'una relación corrupta no debe crear pedidos ni efectos');

      await pool.query(`
        INSERT INTO pedidos (id, empresa_id, punto_entrega_id, fecha, fecha_entrega, estado, cantidad, monto, metodo_pago)
        VALUES (5, 1, 10, '2026-09-27T10:00:00Z', '2026-09-27T11:00:00Z', 'entregado', 2, 100, 'efectivo');
        INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario)
        VALUES (5, 10, 'Bidón', 2, 50);
      `);
      const validReplenishment = await customerClient.send('necesitas reposición');
      assert.match(validReplenishment[0], /Pedido #101 confirmado/);
      const created = await pool.query(`
        SELECT p.id, p.empresa_id, p.punto_entrega_id, p.monto, p.cantidad,
               it.producto_id, it.cantidad AS item_cantidad, it.precio_unitario
        FROM pedidos p
        JOIN items_pedido it ON it.pedido_id = p.id
        WHERE p.id = 101
      `);
      assert.deepEqual(created.rows, [{
        id: 101,
        empresa_id: 1,
        punto_entrega_id: 10,
        monto: '200',
        cantidad: '2',
        producto_id: 10,
        item_cantidad: '2',
        precio_unitario: '100',
      }]);
    } finally {
      await canonicalDb.pool.end();
    }
  });
});
