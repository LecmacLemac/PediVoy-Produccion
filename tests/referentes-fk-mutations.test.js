import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { createReferentesRouter } from '../src/routes/referentes.js';

async function request({ path, body, query, withTransaction, user = { uid: 12, role: 'admin', empresa_id: 10 } }) {
  const app = express();
  app.use(express.json());
  app.use('/api/referentes', createReferentesRouter({
    query,
    withTransaction,
    withAuth(req, _res, next) { req.user = user; next(); },
    isSuper(req) { return req.user?.role === 'super'; },
    getEmpresaIdFromToken(req) { return req.user?.empresa_id; },
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/referentes${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('acceso de referente valida y bloquea referente activo dentro de la transacción', async () => {
  const statements = [];
  let transactionCalls = 0;
  const query = async sql => {
    if (sql.includes('ALTER TABLE usuarios')) return [];
    throw new Error(`consulta fuera de transacción: ${sql.slice(0, 80)}`);
  };
  const result = await request({
    path: '/101/acceso',
    body: { username: 'ref101', password: 'password-seguro' },
    query,
    withTransaction: async work => {
      transactionCalls += 1;
      return work(async (sql, params = []) => {
        statements.push({ sql, params });
        if (sql.includes('FROM referentes')) {
          assert.match(sql, /empresa_id = \$2/);
          assert.match(sql, /activo IS TRUE/);
          assert.match(sql, /deleted_at IS NULL/);
          assert.match(sql, /FOR UPDATE/);
          return [];
        }
        throw new Error(`SQL inesperado: ${sql.slice(0, 100)}`);
      });
    },
  });

  assert.equal(result.status, 404);
  assert.equal(transactionCalls, 1);
  assert.equal(statements.some(({ sql }) => /(?:INSERT INTO|UPDATE) usuarios/.test(sql)), false);
});

test('aprobación bloquea propuesta y valida su referente tenant-owned activo antes de crear cliente', async () => {
  const statements = [];
  const result = await request({
    path: '/clientes-propuestos/70/aprobar',
    body: {},
    query: async sql => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_clientes_propuestos')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_clientes_propuestos')) return [];
      throw new Error(`consulta fuera de transacción: ${sql.slice(0, 80)}`);
    },
    withTransaction: async work => work(async (sql, params = []) => {
      statements.push({ sql, params });
      if (sql.includes('FROM referente_clientes_propuestos')) {
        assert.match(sql, /JOIN referentes r/);
        assert.match(sql, /r\.empresa_id = rcp\.empresa_id/);
        assert.match(sql, /r\.activo IS TRUE/);
        assert.match(sql, /r\.deleted_at IS NULL/);
        assert.match(sql, /FOR UPDATE/);
        return [];
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 100)}`);
    }),
  });

  assert.equal(result.status, 404);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO puntos_entrega')), false);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO cliente_referentes')), false);
});

test('acceso responde outcome unknown sanitizado sin reintentar', async () => {
  let transactionCalls = 0;
  const unknown = new Error('detalle privado tras COMMIT');
  unknown.code = 'TRANSACTION_OUTCOME_UNKNOWN';
  const result = await request({
    path: '/101/acceso',
    body: { username: 'ref101', password: 'password-seguro' },
    query: async sql => {
      if (sql.includes('ALTER TABLE usuarios')) return [];
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
    },
    withTransaction: async () => {
      transactionCalls += 1;
      throw unknown;
    },
  });

  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: 'Resultado de acceso del referente indeterminado',
    code: 'TRANSACTION_OUTCOME_UNKNOWN',
  });
  assert.equal(transactionCalls, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /privado|commit/i);
});
