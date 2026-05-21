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
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_liquidaciones')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_liquidaciones_empresa_created_idx')) return [];
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
        assert.match(sql, /INSERT INTO referente_liquidaciones/);
        assert.match(sql, /liquidacion_lote_id = lote\.id/);
        return [
          {
            id: 10,
            referente_id: 4,
            monto_comision: '300',
            lote_id: 77,
            lote_created_at: '2026-05-21T18:00:00.000Z',
            lote_comisiones_count: 2,
            lote_total: '750.50',
            lote_referencia: 'Transferencia 123',
            lote_nota: 'Pago semanal',
          },
          {
            id: 11,
            referente_id: 4,
            monto_comision: '450.50',
            lote_id: 77,
            lote_created_at: '2026-05-21T18:00:00.000Z',
            lote_comisiones_count: 2,
            lote_total: '750.50',
            lote_referencia: 'Transferencia 123',
            lote_nota: 'Pago semanal',
          },
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
  assert.equal(result.json.ok, true);
  assert.equal(result.json.liquidadas, 2);
  assert.equal(result.json.total, 750.5);
  assert.equal(result.json.lote.id, 77);
  assert.equal(result.json.lote.referencia, 'Transferencia 123');
  assert.equal(calls.length, 7);
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

test('administracion puede filtrar comisiones por rango de fechas', async () => {
  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/comisiones?from=2026-05-01&to=2026-05-31',
    method: 'GET',
    async query(sql, params = []) {
      if (sql.includes('ALTER TABLE referente_comisiones')) return [];
      assert.deepEqual(params, [2, '2026-05-01', '2026-05-31']);
      assert.match(sql, /rc\.validada_at >= \$2::date/);
      assert.match(sql, /rc\.validada_at < \(\$3::date \+ INTERVAL '1 day'\)/);
      return [{ id: 20, referente_nombre: 'Aliado', monto_comision: '1200' }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.length, 1);
});

test('administracion puede consultar resumen operativo de referentes', async () => {
  let summaryCalled = false;
  let liquidacionesCalled = false;

  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/resumen',
    method: 'GET',
    async query(sql, params = []) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_liquidaciones')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_liquidaciones_empresa_created_idx')) return [];
      if (sql.includes('ALTER TABLE referente_comisiones')) return [];
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_clientes_propuestos')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_clientes_propuestos')) return [];
      if (sql.includes('ALTER TABLE cliente_referentes')) return [];
      assert.deepEqual(params, [2]);
      if (sql.includes('referentes_sin_acceso')) {
        summaryCalled = true;
        assert.match(sql, /estado = 'validada'/);
        assert.match(sql, /date_trunc\('month', NOW\(\)\)/);
        return [{
          referentes_activos: 3,
          referentes_inactivos: 1,
          referentes_sin_acceso: 1,
          clientes_vinculados: 8,
          clientes_pendientes: 2,
          comisiones_pendientes_count: 4,
          comisiones_pendientes_total: '1500',
          comisiones_liquidadas_mes_count: 5,
          comisiones_liquidadas_mes_total: '2200',
        }];
      }
      if (sql.includes('FROM referente_liquidaciones rl')) {
        liquidacionesCalled = true;
        return [{
          id: 77,
          liquidada_at: '2026-05-21T18:00:00.000Z',
          comisiones_count: 2,
          total: '750.50',
          liquidacion_referencia: 'Transferencia 123',
          liquidada_por_username: 'admin',
        }];
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 120)}`);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(summaryCalled, true);
  assert.equal(liquidacionesCalled, true);
  assert.equal(result.json.resumen.referentes_activos, 3);
  assert.equal(result.json.liquidaciones.length, 1);
});

test('administracion puede consultar detalle de lote de liquidacion', async () => {
  let loteCalled = false;
  let comisionesCalled = false;

  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/liquidaciones/77',
    method: 'GET',
    async query(sql, params = []) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS referente_liquidaciones')) return [];
      if (sql.includes('CREATE INDEX IF NOT EXISTS referente_liquidaciones_empresa_created_idx')) return [];
      if (sql.includes('ALTER TABLE referente_comisiones')) return [];
      assert.deepEqual(params, [2, 77]);
      if (sql.includes('FROM referente_liquidaciones rl')) {
        loteCalled = true;
        return [{
          id: 77,
          liquidada_at: '2026-05-21T18:00:00.000Z',
          comisiones_count: 2,
          total: '750.50',
          liquidacion_referencia: 'Transferencia 123',
          liquidacion_nota: 'Pago semanal',
          liquidada_por_username: 'admin',
        }];
      }
      if (sql.includes('FROM referente_comisiones rc')) {
        comisionesCalled = true;
        assert.match(sql, /rc\.liquidacion_lote_id = \$2/);
        return [{
          id: 10,
          pedido_id: 88,
          monto_comision: '300',
          referente_nombre: 'Aliado',
          referente_codigo: 'REF4',
          cliente: 'Cliente demo',
          producto_nombre: 'Bidon 20L',
        }];
      }
      throw new Error(`SQL inesperado: ${sql.slice(0, 120)}`);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(loteCalled, true);
  assert.equal(comisionesCalled, true);
  assert.equal(result.json.liquidacion.id, 77);
  assert.equal(result.json.comisiones.length, 1);
});

test('administracion puede listar clientes vinculados activos', async () => {
  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/clientes',
    method: 'GET',
    async query(sql, params = []) {
      if (sql.includes('ALTER TABLE cliente_referentes')) return [];
      assert.deepEqual(params, [2]);
      assert.match(sql, /FROM cliente_referentes cr/);
      assert.match(sql, /cr\.estado = 'activo'/);
      assert.match(sql, /referente_nombre/);
      return [{
        id: 30,
        cliente_id: 50,
        referente_id: 4,
        codigo_referente: 'REF4',
        estado: 'activo',
        referente_nombre: 'Vendedor',
        referente_codigo: 'REF4',
        cliente: 'Cliente demo',
        pedidos_count: 2,
        comisiones_total: '150',
      }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.length, 1);
  assert.equal(result.json[0].cliente_id, 50);
  assert.equal(result.json[0].referente_codigo, 'REF4');
});

test('administracion desvincula cliente preservando historial del vinculo', async () => {
  const result = await requestWithRouter({
    user: { uid: 12, role: 'admin', empresa_id: 2 },
    path: '/clientes/50/desvincular',
    method: 'POST',
    body: { motivo: 'Cambio comercial' },
    async query(sql, params = []) {
      if (sql.includes('ALTER TABLE cliente_referentes')) return [];
      assert.deepEqual(params, [2, 50, 12, 'Cambio comercial']);
      assert.match(sql, /estado = 'desvinculado'/);
      assert.match(sql, /desvinculado_at = NOW\(\)/);
      assert.match(sql, /desvinculado_motivo = \$4/);
      assert.match(sql, /RETURNING id, punto_entrega_id, referente_id, desvinculado_at/);
      return [{ id: 30, punto_entrega_id: 50, referente_id: 4, desvinculado_at: '2026-05-20T21:35:00.000Z' }];
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.desvinculados, 1);
  assert.equal(result.json.vinculo.referente_id, 4);
});
