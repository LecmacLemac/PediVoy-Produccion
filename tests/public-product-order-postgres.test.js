import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync } from 'node:fs';
import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';
import { createPublicLandingRouter } from '../src/routes/publicLanding.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function fixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id integer PRIMARY KEY, landing_slug text, plan_estado text, plan_vencimiento timestamptz);
    INSERT INTO empresas VALUES (1, 'agua', 'active', NULL), (2, 'otra', 'active', NULL);
    CREATE TABLE productos (
      id integer PRIMARY KEY, empresa_id integer, nombre text, descripcion text,
      precio numeric, imagen text, imagen_promo text, etiqueta text, categoria text,
      destacado boolean DEFAULT false, activo boolean DEFAULT true,
      mostrar_en_landing boolean DEFAULT true, mostrar_en_catalogo boolean DEFAULT true, orden integer
    );
    INSERT INTO productos (id, empresa_id, nombre, categoria, etiqueta, precio, orden) VALUES
      (1, 1, 'Bidón', 'Z Bidones', 'Z', 8000, 1),
      (2, 1, 'Base', 'A Dispenser', 'A', 1000, 2),
      (3, 1, 'Sin orden primero', 'A', NULL, 1, NULL),
      (4, 1, 'Sin orden segundo', 'A', NULL, 1, NULL),
      (5, 1, 'Empate nombre Z', 'Z', 'Z', 9000, 3),
      (6, 1, 'Empate nombre A', 'A', 'A', 1, 3),
      (7, 2, 'Otra empresa', 'A', 'A', 1, 0),
      (8, 1, 'Inactivo', 'A', 'A', 1, 0),
      (9, 1, 'Solo catálogo', 'A', 'A', 1, 4),
      (10, 1, 'Solo landing', 'A', 'A', 1, 5),
      (11, 1, 'Orden cero', 'Z', 'Z', 10000, 0);
    UPDATE productos SET activo = false WHERE id = 8;
    UPDATE productos SET mostrar_en_landing = false WHERE id = 9;
    UPDATE productos SET mostrar_en_catalogo = false WHERE id = 10;
  `);
}

async function withApp(pool, work) {
  const query = async (sql, params) => (await pool.query(sql, params)).rows;
  const withTransaction = fn => fn(query);
  const app = express();
  app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction }));
  app.use('/api/public', createPublicLandingRouter({ query, withTransaction }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function checkOrder(base, route, expected) {
  const response = await fetch(`${base}${route}`);
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.deepEqual(rows.map(row => row.id), expected, route);
}

// The helper's disposable cluster must live in the managed scratch workspace.
const scratch = process.env.TMPDIR;
if (scratch) { mkdirSync(scratch, { recursive: true }); process.chdir(scratch); }

test('public web landing and catalog prioritize configured order across categories with stable ID ties', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withApp(pool, async base => {
      await checkOrder(base, '/public/productos?empresa_id=1&scope=landing', [11, 1, 2, 5, 6, 10, 3, 4]);
      await checkOrder(base, '/public/productos?empresa_id=1&scope=catalog', [11, 1, 2, 5, 6, 9, 3, 4]);
      await checkOrder(base, '/public/productos?empresa_id=1', [11, 1, 2, 5, 6, 9, 10, 3, 4]);
      await checkOrder(base, '/public/productos?empresa_id=2&scope=landing', [7]);
    });
  });
});

test('public API uses configured order and ascending ID for equal or missing order', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await fixture(pool);
    await withApp(pool, async base => {
      await checkOrder(base, '/api/public/productos?empresa_id=1&scope=landing', [11, 1, 2, 5, 6, 10, 3, 4]);
      await checkOrder(base, '/api/public/productos?empresa_id=1', [11, 1, 2, 5, 6, 9, 10, 3, 4]);
      await checkOrder(base, '/api/public/productos?empresa_id=2&scope=landing', [7]);
    });
  });
});
