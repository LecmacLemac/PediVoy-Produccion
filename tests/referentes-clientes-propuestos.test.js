import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import { createReferentePortalRouter } from '../src/routes/referentePortal.js';
import { createReferentesRouter } from '../src/routes/referentes.js';

async function requestWithApp({ mountPath, router, path, method = 'GET', body }) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}${mountPath}${path}`, options);
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('referente puede proponer un cliente pendiente de validacion', async () => {
  const calls = [];
  const result = await requestWithApp({
    mountPath: '/api/referente',
    path: '/clientes-propuestos',
    method: 'POST',
    body: {
      cliente: 'Kiosco Norte',
      telefono: '3515551111',
      direccion: 'Av Siempre Viva 123',
      ciudad: 'Cordoba',
      notas: 'Cliente interesado en bidones semanales',
    },
    router: createReferentePortalRouter({
      withAuth(req, _res, next) {
        req.user = { uid: 44, role: 'referente', empresa_id: 2, referente_id: 9 };
        next();
      },
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('CREATE TABLE IF NOT EXISTS referente_clientes_propuestos')) return [];
        if (sql.includes('CREATE INDEX IF NOT EXISTS referente_clientes_propuestos')) return [];
        if (sql.includes('INSERT INTO referente_clientes_propuestos')) {
          assert.equal(params[0], 2);
          assert.equal(params[1], 9);
          assert.equal(params[2], 'Kiosco Norte');
          assert.equal(params[3], '3515551111');
          assert.equal(params[5], 'Cordoba');
          return [{ id: 70, cliente: 'Kiosco Norte', estado: 'pendiente' }];
        }
        throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
      },
    }),
  });

  assert.equal(result.status, 201);
  assert.deepEqual(result.json, { id: 70, cliente: 'Kiosco Norte', estado: 'pendiente' });
  assert.equal(calls.length, 4);
});

test('administracion aprueba cliente propuesto y crea vinculo formal', async () => {
  const result = await requestWithApp({
    mountPath: '/api/referentes',
    path: '/clientes-propuestos/70/aprobar',
    method: 'POST',
    router: createReferentesRouter({
      withAuth(req, _res, next) {
        req.user = { uid: 12, role: 'admin', empresa_id: 2 };
        next();
      },
      isSuper() {
        return false;
      },
      getEmpresaIdFromToken(req) {
        return req.user?.empresa_id;
      },
      async query(sql, params = []) {
        if (sql.includes('CREATE TABLE IF NOT EXISTS referente_clientes_propuestos')) return [];
        if (sql.includes('CREATE INDEX IF NOT EXISTS referente_clientes_propuestos')) return [];
        if (sql.includes('FROM referente_clientes_propuestos') && sql.includes("estado = 'pendiente'")) {
          assert.deepEqual(params, [70, 2]);
          return [{
            id: 70, empresa_id: 2, referente_id: 9, cliente: 'Kiosco Norte',
            telefono: '3515550000', direccion: 'Calle 10', ciudad: null, provincia: null,
            pais: 'Argentina', email: null, notas: null, estado: 'pendiente',
          }];
        }
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FROM puntos_entrega') && sql.includes('RIGHT(REGEXP_REPLACE')) return [];
        if (sql.includes('INSERT INTO puntos_entrega')) return [{ id: 101 }];
        if (sql.includes('SELECT codigo FROM referentes')) return [{ codigo: 'REF-9' }];
        if (sql.includes('INSERT INTO cliente_referentes')) return [{ id: 55 }];
        if (sql.includes('UPDATE referente_clientes_propuestos')) {
          assert.deepEqual(params, [101, 12, 70, 2]);
          return [{ id: 70, estado: 'aprobado' }];
        }
        throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
      },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.estado, 'aprobado');
  assert.equal(result.json.cliente_id, 101);
  assert.equal(result.json.vinculo_id, 55);
});

test('super aprueba cliente propuesto sólo en la empresa seleccionada explícitamente', async () => {
  const tenantParams = [];
  const result = await requestWithApp({
    mountPath: '/api/referentes',
    path: '/clientes-propuestos/70/aprobar',
    method: 'POST',
    body: { empresa_id: 7 },
    router: createReferentesRouter({
      withAuth(req, _res, next) {
        req.user = { uid: 12, role: 'super', empresa_id: 2 };
        next();
      },
      isSuper(req) {
        return req.user?.role === 'super';
      },
      getEmpresaIdFromToken(req) {
        return req.user?.empresa_id;
      },
      async query(sql, params = []) {
        if (sql.includes('CREATE TABLE IF NOT EXISTS referente_clientes_propuestos')) return [];
        if (sql.includes('CREATE INDEX IF NOT EXISTS referente_clientes_propuestos')) return [];
        if (sql.includes('FROM referente_clientes_propuestos') && sql.includes("estado = 'pendiente'")) {
          tenantParams.push(params[1]);
          return [{
            id: 70, empresa_id: 7, referente_id: 9, cliente: 'Kiosco Norte',
            telefono: '3515550000', direccion: 'Calle 10', ciudad: null, provincia: null,
            pais: 'Argentina', email: null, notas: null, estado: 'pendiente',
          }];
        }
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FROM puntos_entrega') && sql.includes('RIGHT(REGEXP_REPLACE')) {
          tenantParams.push(params[0]);
          return [];
        }
        if (sql.includes('INSERT INTO puntos_entrega')) {
          tenantParams.push(params[0]);
          return [{ id: 101 }];
        }
        if (sql.includes('SELECT codigo FROM referentes')) {
          tenantParams.push(params[1]);
          return [{ codigo: 'REF-9' }];
        }
        if (sql.includes('INSERT INTO cliente_referentes')) {
          tenantParams.push(params[0]);
          return [{ id: 55 }];
        }
        if (sql.includes('UPDATE referente_clientes_propuestos')) {
          tenantParams.push(params[3]);
          return [{ id: 70, estado: 'aprobado' }];
        }
        throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
      },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.estado, 'aprobado');
  assert.ok(tenantParams.length >= 5);
  assert.deepEqual([...new Set(tenantParams)], [7]);
});

test('administracion rechaza cliente propuesto pendiente', async () => {
  const result = await requestWithApp({
    mountPath: '/api/referentes',
    path: '/clientes-propuestos/71/rechazar',
    method: 'POST',
    body: { motivo: 'Datos insuficientes' },
    router: createReferentesRouter({
      withAuth(req, _res, next) {
        req.user = { uid: 12, role: 'admin', empresa_id: 2 };
        next();
      },
      isSuper() {
        return false;
      },
      getEmpresaIdFromToken(req) {
        return req.user?.empresa_id;
      },
      async query(sql, params = []) {
        if (sql.includes('UPDATE referente_clientes_propuestos')) {
          assert.equal(params[0], 71);
          assert.equal(params[1], 2);
          assert.equal(params[2], 12);
          assert.equal(params[3], 'Datos insuficientes');
          return [{ id: 71, estado: 'rechazado', rechazo_motivo: 'Datos insuficientes' }];
        }
        throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
      },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.estado, 'rechazado');
});
