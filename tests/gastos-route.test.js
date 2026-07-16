import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGastosRouter } from '../src/routes/gastos.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function buildGastosApp({ query, user = { role: 'user', empresa_id: 3 } }) {
  const gastosDir = await mkdtemp(path.join(tmpdir(), 'pedivoy-gastos-'));
  const app = express();
  app.use('/api/gastos', createGastosRouter({
    GASTOS_DIR: gastosDir,
    query,
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
    isRepartidor(req) {
      return String(req.user?.role || '').toLowerCase() === 'repartidor';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));
  return { app, cleanup: () => rm(gastosDir, { recursive: true, force: true }) };
}

function isSchemaQuery(sql) {
  return /ALTER TABLE|CREATE TABLE|CREATE INDEX/i.test(sql);
}

test('POST /api/gastos rechaza chofer que no pertenece a la empresa del usuario', async () => {
  const calls = [];
  const { app, cleanup } = await buildGastosApp({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes') && sql.includes('empresa_id')) return [];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('fecha', '2026-06-27');
      body.append('tipo', 'combustible');
      body.append('descripcion', 'YPF');
      body.append('monto', '1000');
      body.append('chofer_id', '99');

      const resp = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(resp.status, 400);
      assert.match((await resp.json()).error, /Chofer inválido/);
    });
  } finally {
    await cleanup();
  }

  assert.ok(calls.some((c) => c.sql.includes('FROM choferes') && c.params[0] === 99 && c.params[1] === 3));
});

test('POST /api/gastos respeta permisos estrictos de depósito', async () => {
  const { app, cleanup } = await buildGastosApp({
    query: async (sql) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('FROM depositos')) return [{ id: 5 }];
      if (sql.includes('COUNT(*)::int AS c')) return [{ c: 0 }];
      if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: true }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('fecha', '2026-06-27');
      body.append('tipo', 'carga_llenos');
      body.append('descripcion', 'Carga');
      body.append('monto', '2000');
      body.append('cantidad', '2');
      body.append('producto_id', '11');
      body.append('deposito_id', '5');
      body.append('chofer_id', '7');

      const resp = await fetch(`${baseUrl}/api/gastos`, { method: 'POST', body });
      assert.equal(resp.status, 403);
      assert.match((await resp.json()).error, /depósito/);
    });
  } finally {
    await cleanup();
  }
});

test('PUT /api/gastos conserva producto y depósito existentes si el panel no los reenvía', async () => {
  const updates = [];
  const { app, cleanup } = await buildGastosApp({
    query: async (sql, params = []) => {
      if (isSchemaQuery(sql)) return [];
      if (sql.includes('FROM gastos_repartidor') && sql.includes('WHERE id = $1')) {
        return [{
          id: 55,
          empresa_id: 3,
          chofer_id: 7,
          fecha: '2026-06-26',
          tipo: 'carga_llenos',
          descripcion: 'Carga original',
          monto: '1000.00',
          comprobante_path: null,
          cantidad: '2',
          producto_id: 11,
          deposito_id: 5,
        }];
      }
      if (sql.includes('FROM choferes')) return [{ id: 7 }];
      if (sql.includes('FROM productos')) return [{ id: 11 }];
      if (sql.includes('FROM depositos')) return [{ id: 5 }];
      if (sql.includes('COUNT(*)::int AS c')) return [{ c: 0 }];
      if (sql.includes("config_operativa->>'deposito_permisos_estricto'")) return [{ estricto: false }];
      if (sql.includes('UPDATE chofer_stock')) return [];
      if (sql.includes('DELETE FROM chofer_stock_mov')) return [];
      if (sql.includes('UPDATE gastos_repartidor')) {
        updates.push(params);
        return [];
      }
      if (sql.includes('INSERT INTO chofer_stock_mov')) return [];
      if (sql.includes('INSERT INTO chofer_stock')) return [];
      if (sql.includes('SELECT saldo FROM retornables_saldos')) return [{ saldo: '2' }];
      if (sql.includes('INSERT INTO retornables_saldos')) return [{ saldo: '5' }];
      if (sql.includes('INSERT INTO retornables_movimientos')) return [{ id: 88, saldo_resultante: '5' }];
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const body = new FormData();
      body.append('fecha', '2026-06-27');
      body.append('tipo', 'carga_llenos');
      body.append('descripcion', 'Carga editada');
      body.append('monto', '1500');
      body.append('cantidad', '3');
      body.append('chofer_id', '7');

      const resp = await fetch(`${baseUrl}/api/gastos/55`, { method: 'PUT', body });
      assert.equal(resp.status, 200);
    });
  } finally {
    await cleanup();
  }

  assert.equal(updates.length, 1);
  assert.equal(updates[0][8], 11);
  assert.equal(updates[0][9], 5);
});
