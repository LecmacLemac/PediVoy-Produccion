import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createReportesRouter } from '../src/routes/reportes.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY, nombre text);
    CREATE TABLE choferes (id integer PRIMARY KEY, empresa_id integer, nombre text);
    CREATE TABLE puntos_entrega (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, cliente text, telefono text,
      direccion text, zona_id integer
    );
    CREATE TABLE pedidos (
      id integer PRIMARY KEY, empresa_id integer NOT NULL, punto_entrega_id integer,
      fecha timestamptz, fecha_entrega timestamptz, estado text, metodo_pago text,
      monto numeric, cantidad_entregada numeric, chofer_id integer, motivo_cancelacion text
    );
    CREATE TABLE transferencias (id serial PRIMARY KEY, empresa_id integer, pedido_id integer);
    CREATE TABLE empresa_cuentas_bancarias (
      id serial PRIMARY KEY, empresa_id integer, activa boolean, prioridad integer,
      alias text, titular text, cbu text, banco text
    );
    CREATE TABLE comprobantes_transferencia (
      id serial PRIMARY KEY, empresa_id integer, pedido_id integer, fecha timestamptz,
      validado integer, procesado boolean, estado_revision text, verified_reason text, verified_at timestamptz
    );
    CREATE TABLE productos (id integer PRIMARY KEY, empresa_id integer, nombre text);
    CREATE TABLE items_pedido (
      id serial PRIMARY KEY, pedido_id integer, producto_id integer, producto text,
      cantidad numeric, precio_unitario numeric
    );

    INSERT INTO empresas VALUES (1, 'Uno'), (2, 'Dos');
    INSERT INTO choferes VALUES (11, 1, 'Chofer Uno'), (22, 2, 'Chofer Dos');
    INSERT INTO puntos_entrega VALUES
      (10, 1, 'Cliente Uno', '111', 'Calle Uno', 101),
      (20, 2, 'Cliente Dos', '222', 'Calle Dos', 202);
    INSERT INTO productos VALUES (101, 1, 'Bidón Uno'), (202, 2, 'Bidón Dos');
    INSERT INTO pedidos VALUES
      (1, 1, 10, '2026-09-27 10:00Z', '2026-09-27 11:00Z', 'entregado', 'efectivo', 100, 1, 11, NULL),
      (2, 2, 20, '2026-09-27 10:00Z', '2026-09-27 12:00Z', 'entregado', 'transferencia', 200, 2, 22, NULL),
      (3, 2, 10, '2026-09-27 10:00Z', '2026-09-27 20:00Z', 'entregado', 'efectivo', 900, 9, 22, NULL),
      (4, 1, 20, '2026-09-27 10:00Z', '2026-09-27 21:00Z', 'entregado', 'efectivo', 800, 8, 11, NULL),
      (5, 1, 10, '2026-09-27 10:00Z', NULL, 'cancelado', 'efectivo', 50, 0, 11, 'Sin stock'),
      (6, 2, 10, '2026-09-27 10:00Z', NULL, 'cancelado', 'efectivo', 600, 0, 22, 'Ajeno B-A'),
      (7, 1, 20, '2026-09-27 10:00Z', NULL, 'cancelado', 'efectivo', 700, 0, 11, 'Ajeno A-B');
    INSERT INTO items_pedido (pedido_id, producto_id, producto, cantidad, precio_unitario) VALUES
      (1, 101, 'Bidón Uno', 1, 100),
      (2, 202, 'Bidón Dos', 2, 100),
      (3, 202, 'Bidón Dos', 9, 100),
      (4, 101, 'Bidón Uno', 8, 100);
  `);
}

function appFor(pool, empresaId) {
  const app = express();
  app.use(express.json());
  app.use('/api/reportes', createReportesRouter({
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    withAuth(req, _res, next) { req.user = { role: 'admin', empresa_id: empresaId }; next(); },
    isSuper: () => false,
    getEmpresaIdFromToken: req => req.user.empresa_id,
    enqueueWppMessage: async () => null,
  }));
  return app;
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}/api/reportes${path}`);
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text);
}

test('PostgreSQL real: todos los reportes pedido-punto excluyen corrupción en ambas direcciones', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withServer(appFor(pool, 1), async baseUrl => {
      const entregados = await getJson(baseUrl, '/entregados?from=2026-09-27&to=2026-09-27');
      assert.deepEqual(entregados.map(row => Number(row.id)), [1]);
      assert.equal(Number(entregados[0].monto), 100);

      const medios = await getJson(baseUrl, '/medios-pago?from=2026-09-27&to=2026-09-27');
      assert.deepEqual(medios.pedidos, [{
        metodo_pago: 'efectivo', cantidad: 1, total: 100,
        pagado_pedido: 0, pagado_transferencia: 0,
      }]);

      const sla = await getJson(baseUrl, '/sla-entrega?from=2026-09-27&to=2026-09-27&sla_horas=2');
      assert.equal(sla.total, 1);
      assert.equal(sla.en_sla, 1);
      assert.equal(sla.demora_prom_min, 60);

      const cancelaciones = await getJson(baseUrl, '/cancelaciones-motivo?from=2026-09-27&to=2026-09-27');
      assert.deepEqual(cancelaciones, { total: 1, motivos: [{ motivo: 'Sin stock', cantidad: 1 }] });

      const margen = await getJson(baseUrl, '/productos-margen?from=2026-09-27&to=2026-09-27');
      assert.equal(margen.total_productos, 1);
      assert.equal(margen.top[0].producto, 'Bidón Uno');
      assert.equal(margen.top[0].unidades, 1);
      assert.equal(margen.top[0].ventas, 100);
    });

    await withServer(appFor(pool, 2), async baseUrl => {
      const entregados = await getJson(baseUrl, '/entregados?from=2026-09-27&to=2026-09-27');
      assert.deepEqual(entregados.map(row => Number(row.id)), [2]);
      const sla = await getJson(baseUrl, '/sla-entrega?from=2026-09-27&to=2026-09-27&sla_horas=3');
      assert.equal(sla.total, 1);
      assert.equal(sla.demora_prom_min, 120);
    });
  });
});
