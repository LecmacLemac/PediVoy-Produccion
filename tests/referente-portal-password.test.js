import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bcrypt from 'bcryptjs';
import express from 'express';

import { createReferentePortalRouter } from '../src/routes/referentePortal.js';

async function requestWithRouter({ user, query, path = '/password', method = 'PUT', body }) {
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
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/referente${path}`, options);
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

test('referente recibe slug de empresa para armar link de invitacion', async () => {
  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/perfil',
    method: 'GET',
    async query(sql, params = []) {
      if (sql.includes('ALTER TABLE referentes')) return [];
      assert.equal(params[0], 9);
      assert.equal(params[1], 2);
      assert.match(sql, /e\.landing_slug AS empresa_slug/);
      assert.match(sql, /r\.direccion/);
      return [{
        id: 9,
        empresa_id: 2,
        nombre: 'Referente Demo',
        direccion: 'Av. Demo 123',
        codigo: 'REF9',
        empresa_nombre: 'Empresa Demo',
        empresa_slug: 'empresa-demo',
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.codigo, 'REF9');
  assert.equal(result.json.empresa_slug, 'empresa-demo');
});

test('referente puede editar datos de contacto sin tocar campos administrativos', async () => {
  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/perfil',
    method: 'PUT',
    body: {
      nombre: 'Referente Demo',
      telefono: '3515555555',
      email: 'ref@example.com',
      direccion: 'Av. Demo 123',
      notas: 'Contacto por la tarde',
      codigo: 'NO-DEBE-CAMBIAR',
      porcentaje_comision: 99,
    },
    async query(sql, params = []) {
      if (sql.includes('ALTER TABLE referentes')) return [];
      assert.match(sql, /UPDATE referentes/);
      assert.match(sql, /direccion = \$6/);
      assert.doesNotMatch(sql, /codigo =/);
      assert.doesNotMatch(sql, /porcentaje_comision =/);
      assert.deepEqual(params, [
        9,
        2,
        'Referente Demo',
        '3515555555',
        'ref@example.com',
        'Av. Demo 123',
        'Contacto por la tarde',
      ]);
      return [{
        id: 9,
        empresa_id: 2,
        nombre: 'Referente Demo',
        telefono: '3515555555',
        email: 'ref@example.com',
        direccion: 'Av. Demo 123',
        codigo: 'REF9',
        porcentaje_comision: '10',
        activo: true,
        notas: 'Contacto por la tarde',
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.direccion, 'Av. Demo 123');
  assert.equal(result.json.codigo, 'REF9');
});

test('referente puede ver resumen operativo de pedidos vinculados', async () => {
  const sqlCalls = [];

  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/resumen',
    method: 'GET',
    async query(sql, params = []) {
      sqlCalls.push({ sql, params });
      assert.equal(params[0], 2);
      assert.equal(params[1], 9);
      assert.match(sql, /FROM pedidos p/);
      assert.match(sql, /JOIN cliente_referentes cr/);
      assert.match(sql, /cr\.asociado_at/);
      assert.match(sql, /cr\.estado IN \('activo','desvinculado'\)/);
      assert.match(sql, /cr\.desvinculado_at IS NULL/);
      return [{
        clientes_activos: 3,
        productos_activos: 2,
        pedidos_total: 11,
        pedidos_30d: 4,
        pedidos_entregados: 8,
        pedidos_activos: 2,
        ventas_entregadas: '15000',
        comisiones_count: 5,
        comisiones_total: '1200',
        comisiones_liquidadas: '800',
        comisiones_pendientes: '400',
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.pedidos_total, 11);
  assert.equal(result.json.pedidos_30d, 4);
  assert.equal(result.json.ventas_entregadas, '15000');
  assert.equal(sqlCalls.length, 1);
});

test('referente puede listar pedidos vinculados a sus clientes', async () => {
  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/pedidos',
    method: 'GET',
    async query(sql, params = []) {
      assert.equal(params[0], 2);
      assert.equal(params[1], 9);
      assert.match(sql, /JOIN cliente_referentes cr/);
      assert.match(sql, /cr\.asociado_at/);
      assert.match(sql, /cr\.estado IN \('activo','desvinculado'\)/);
      assert.match(sql, /cr\.desvinculado_at IS NULL/);
      assert.match(sql, /LEFT JOIN \(/);
      return [{
        id: 101,
        fecha: '2026-05-20T12:00:00.000Z',
        fecha_entrega: null,
        estado: 'pendiente',
        monto: '7000',
        metodo_pago: 'efectivo',
        cliente: 'Cliente Demo',
        telefono: '351555555',
        direccion: 'Av. Demo 123',
        comision_total: '0',
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.length, 1);
  assert.equal(result.json[0].id, 101);
  assert.equal(result.json[0].cliente, 'Cliente Demo');
});

test('referente puede listar notificaciones internas', async () => {
  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/notificaciones',
    method: 'GET',
    async query(sql, params = []) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_notificaciones')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx')) return [];
      assert.equal(params[0], 2);
      assert.equal(params[1], 9);
      assert.equal(params[2], 50);
      assert.match(sql, /FROM referente_notificaciones/);
      return [{
        id: 88,
        tipo: 'pedido_estado',
        titulo: 'Pedido #101 entregado',
        mensaje: 'El pedido cambió de estado.',
        pedido_id: 101,
        leida_at: null,
        created_at: '2026-05-20T12:00:00.000Z',
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.length, 1);
  assert.equal(result.json[0].id, 88);
  assert.equal(result.json[0].leida_at, null);
});

test('referente marca una notificacion como leida', async () => {
  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/notificaciones/88/leida',
    method: 'POST',
    async query(sql, params = []) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_notificaciones')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx')) return [];
      assert.deepEqual(params, [88, 2, 9]);
      assert.match(sql, /UPDATE referente_notificaciones/);
      assert.match(sql, /referente_id = \$3/);
      return [{ id: 88, leida_at: '2026-05-20T13:00:00.000Z' }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.id, 88);
});

test('referente puede ver reglas comerciales del programa', async () => {
  const result = await requestWithRouter({
    user: { uid: 7, role: 'referente', empresa_id: 2, referente_id: 9 },
    path: '/reglas',
    method: 'GET',
    async query(sql, params = []) {
      assert.deepEqual(params, [9, 2]);
      assert.match(sql, /config_operativa->'referentes' AS reglas_config/);
      return [{
        codigo: 'REF9',
        porcentaje_comision: '12.5',
        vigente_desde: '2026-05-01',
        vigente_hasta: null,
        empresa_nombre: 'Empresa Demo',
        reglas_config: {
          condiciones: ['Comisiona sobre pedidos entregados.', 'No aplica a pedidos cancelados.'],
          liquidacion: 'Liquidación semanal.',
          forma_pago: 'Transferencia bancaria',
          contacto: 'Administración comercial',
        },
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.codigo, 'REF9');
  assert.equal(result.json.porcentaje_comision, 12.5);
  assert.equal(result.json.forma_pago, 'Transferencia bancaria');
  assert.deepEqual(result.json.condiciones, ['Comisiona sobre pedidos entregados.', 'No aplica a pedidos cancelados.']);
});
