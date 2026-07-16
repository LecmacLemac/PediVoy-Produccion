import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRetornablesRouter } from '../src/routes/retornables.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function isSchemaQuery(sql) {
  return /CREATE TABLE|CREATE INDEX/i.test(sql);
}

function buildApp({ query, user = { role: 'user', empresa_id: 3, id: 9 } }) {
  const app = express();
  app.use('/api/retornables', createRetornablesRouter({
    query,
    pool: null,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    checkLicencia(_req, _res, next) {
      next();
    },
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return app;
}

test('GET /api/retornables/resumen filtra por empresa del usuario y devuelve KPIs', async () => {
  const calls = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('WITH ultimo_mov AS')) {
        assert.equal(params[0], 3);
        assert.equal(params[1], 11);
        return [{
          empresa_id: 3,
          punto_entrega_id: 20,
          cliente: 'Cliente Test',
          direccion: 'Calle 1',
          producto_id: 11,
          producto: 'Bidón 20L',
          saldo: '4.00',
          estado: 'pendiente',
        }];
      }
      if (sql.includes('total_pendiente')) {
        assert.equal(params[0], 3);
        return [{ total_pendiente: '4', total_a_favor: '0', cuentas_con_saldo: '1', clientes_deudores: '1', productos_con_saldo: '1' }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/resumen?empresa_id=999&producto_id=11`);
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.equal(json.rows[0].saldo, 4);
    assert.equal(json.kpis.total_pendiente, 4);
  });
});

test('POST /api/retornables/ajustes valida producto retornable y actualiza saldo', async () => {
  const queries = [];
  const app = buildApp({
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (/puntos_entrega/i.test(sql) && /SELECT\s+id/i.test(sql)) return [{ id: 20 }];
      if (/productos/i.test(sql) && /SELECT\s+id/i.test(sql)) return [{ id: 11, nombre: 'Bidón 20L' }];
      if (sql.includes('FOR UPDATE')) return [{ saldo: '2' }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '5' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 76, saldo_resultante: '5' }];
      if (sql.includes('INSERT INTO cliente_retornables_saldos')) return [{ saldo: '5' }];
      if (sql.includes('INSERT INTO cliente_retornables_movimientos')) return [{ id: 77, fecha: '2026-07-16T20:30:00.000Z' }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ punto_entrega_id: 20, producto_id: 11, modo: 'sumar', cantidad: 3, observacion: 'Recuento físico' }),
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.ok, true);
    assert.equal(json.saldo_anterior, 2);
    assert.equal(json.delta, 3);
    assert.equal(json.saldo_resultante, 5);
  });

  assert.ok(queries.some((q) => q.sql.includes('COALESCE(retornable, FALSE) = TRUE')));
});

test('POST /api/retornables/ajustes rechaza cantidad inválida', async () => {
  const app = buildApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      throw new Error(`No debería consultar datos: ${sql}`);
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/retornables/ajustes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ punto_entrega_id: 20, producto_id: 11, cantidad: -1, observacion: 'x' }),
    });
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /Cantidad inválida/);
  });
});
