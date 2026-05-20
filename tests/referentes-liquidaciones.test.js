import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import { createReferentesRouter } from '../src/routes/referentes.js';

async function requestWithRouter({ user, query, path, method = 'GET', body }) {
  const app = express();
  app.use(express.json());
  app.use('/api/referentes', createReferentesRouter({
    query,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
    isSuper(req) {
      return String(req.user?.role || '').toLowerCase() === 'super';
    },
    getEmpresaIdFromToken(req) {
      return req.user?.empresa_id;
    },
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/referentes${path}`, options);
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('administracion puede liquidar comisiones pendientes seleccionadas', async () => {
  const calls = [];

  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/comisiones/liquidar',
    method: 'POST',
    body: {
      comision_ids: [10, 11, 10, 'x'],
      referencia: 'Transferencia 123',
      nota: 'Pago semanal',
    },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('ALTER TABLE referente_comisiones')) return [];
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_notificaciones')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx')) return [];
      if (sql.includes('UPDATE referente_comisiones')) {
        assert.equal(params[0], 2);
        assert.deepEqual(params[1], [10, 11]);
        assert.equal(params[2], 'Transferencia 123');
        assert.equal(params[3], 'Pago semanal');
        assert.equal(params[4], 12);
        assert.match(sql, /estado = 'validada'/);
        return [
          { id: 10, referente_id: 4, monto_comision: '300' },
          { id: 11, referente_id: 4, monto_comision: '450.50' },
        ];
      }
      if (sql.includes('INSERT INTO referente_notificaciones')) {
        assert.equal(params[0], 2);
        assert.deepEqual(params[1], [10, 11]);
        assert.match(sql, /comision_liquidada/);
        return [{ id: 90, referente_id: 4 }, { id: 91, referente_id: 4 }];
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, liquidadas: 2, total: 750.5 });
  assert.equal(calls.length, 5);
});

test('liquidacion exige al menos una comision seleccionada', async () => {
  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/comisiones/liquidar',
    method: 'POST',
    body: { comision_ids: [] },
    async query(sql) {
      if (sql.includes('ALTER TABLE referente_comisiones')) return [];
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
    },
  });

  assert.equal(result.status, 400);
  assert.equal(result.json.error, 'Seleccioná al menos una comisión pendiente.');
});
