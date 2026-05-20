import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bcrypt from 'bcryptjs';
import express from 'express';

import { createReferentePortalRouter } from '../src/routes/referentePortal.js';

async function requestWithRouter({ user, query, body }) {
  const app = express();
  app.use(express.json());
  app.use('/api/referente', createReferentePortalRouter({
    query,
    withAuth(req, _res, next) {
      req.user = user;
      next();
    },
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/referente/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('referente puede cambiar su clave validando la clave actual', async () => {
  const oldHash = await bcrypt.hash('clave-actual', 10);
  let updatedHash = null;
  const calls = [];

  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    body: {
      current_password: 'clave-actual',
      new_password: 'clave-nueva-123',
      confirm_password: 'clave-nueva-123',
    },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM usuarios')) return [{ id: 7, password: oldHash }];
      if (sql.includes('UPDATE usuarios SET password')) {
        updatedHash = params[0];
        return [];
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(calls[0].params[0], 7);
  assert.equal(calls[0].params[1], 2);
  assert.equal(calls[0].params[2], 9);
  assert.equal(await bcrypt.compare('clave-nueva-123', updatedHash), true);
});

test('referente no puede cambiar clave si la actual es incorrecta', async () => {
  const oldHash = await bcrypt.hash('clave-actual', 10);
  let updated = false;

  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    body: {
      current_password: 'otra-clave',
      new_password: 'clave-nueva-123',
      confirm_password: 'clave-nueva-123',
    },
    async query(sql) {
      if (sql.includes('FROM usuarios')) return [{ id: 7, password: oldHash }];
      if (sql.includes('UPDATE usuarios SET password')) {
        updated = true;
        return [];
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
    },
  });

  assert.equal(result.status, 400);
  assert.equal(result.json.error, 'La clave actual no es correcta.');
  assert.equal(updated, false);
});
