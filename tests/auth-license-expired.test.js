import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';

import { createAuthRouter, isLicenseExpired } from '../src/routes/auth.js';

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildAuthApp({ queryFn }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthRouter({ queryFn }));
  return app;
}

test('isLicenseExpired detecta estado expired y vencimiento por fecha', () => {
  const now = new Date('2026-08-28T12:00:00Z').getTime();
  assert.equal(isLicenseExpired('expired', null, now), true);
  assert.equal(isLicenseExpired('active', '2026-08-27T12:00:00Z', now), true);
  assert.equal(isLicenseExpired('active', '2026-08-29T12:00:00Z', now), false);
  assert.equal(isLicenseExpired('active', null, now), false);
});

test('login con licencia vencida crea sesion limitada y redirige a renovacion', async () => {
  const passwordHash = await bcrypt.hash('clave-segura', 4);
  const queries = [];
  const app = buildAuthApp({
    queryFn: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT u.id')) {
        return [{
          id: 12,
          username: 'cliente.expirado',
          password: passwordHash,
          role: 'admin',
          empresa_id: 7,
          chofer_id: null,
          referente_id: null,
          activo: true,
          plan_estado: 'expired',
          plan_vencimiento: null,
        }];
      }
      return [];
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cliente.expirado', password: 'clave-segura' }),
    });

    const body = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.licenseExpired, true);
    assert.equal(body.redirect, '/pedidos/inicio/licencia.html');
    assert.equal(body.user.licencia_vencida, true);
    assert.match(resp.headers.get('set-cookie') || '', /token=/);
  });

  assert.equal(queries.some((q) => q.sql.includes('UPDATE usuarios SET last_login_at')), true);
});

test('login con password incorrecta no revela que la licencia esta vencida', async () => {
  const passwordHash = await bcrypt.hash('clave-correcta', 4);
  const app = buildAuthApp({
    queryFn: async (sql) => {
      if (sql.includes('SELECT u.id')) {
        return [{
          id: 13,
          username: 'cliente.vencido',
          password: passwordHash,
          role: 'admin',
          empresa_id: 8,
          chofer_id: null,
          referente_id: null,
          activo: true,
          plan_estado: 'expired',
          plan_vencimiento: null,
        }];
      }
      return [];
    },
  });

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cliente.vencido', password: 'clave-incorrecta' }),
    });

    const body = await resp.json();
    assert.equal(resp.status, 401);
    assert.equal(body.error, 'Credenciales inválidas');
  });
});
