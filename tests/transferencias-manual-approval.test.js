import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireTransferApprovalRole } from '../src/routes/transferencias.js';
import { aprobarComprobanteManualAtomicoPg } from '../src/transferenciasServices.js';

function runMiddleware(user) {
  let status = 200;
  let body;
  let nextCalled = false;
  const req = { user };
  const res = {
    status(code) { status = code; return this; },
    json(value) { body = value; return this; },
  };
  requireTransferApprovalRole(req, res, () => { nextCalled = true; });
  return { status, body, nextCalled };
}

test('aprobación manual rechaza tokens cliente/repartidor y roles no administrativos', () => {
  for (const user of [
    { type: 'client', role: 'admin' },
    { type: 'repartidor', role: 'admin' },
    { type: 'unknown', role: 'admin' },
    { role: 'repartidor' },
    { role: 'user' },
    {},
  ]) {
    const result = runMiddleware(user);
    assert.equal(result.status, 403);
    assert.equal(result.nextCalled, false);
  }
  assert.equal(runMiddleware({ role: 'admin' }).nextCalled, true);
  assert.equal(runMiddleware({ role: 'super' }).nextCalled, true);
});

test('ruta de aprobación manual exige autenticación, licencia y rol administrativo', async () => {
  const source = await readFile(new URL('../src/routes/transferencias.js', import.meta.url), 'utf8');
  assert.match(source, /router\.use\(withAuth, checkLicencia, requireTransferApprovalRole\)/);
  assert.ok(source.indexOf('router.use(withAuth, checkLicencia, requireTransferApprovalRole)') < source.indexOf("router.post('/:id/verificar'"));
});

test('ruta manual delega toda la aprobación al servicio transaccional común', async () => {
  const source = await readFile(new URL('../src/routes/transferencias.js', import.meta.url), 'utf8');
  const verifyRoute = source.slice(source.indexOf("router.post('/:id/verificar'"), source.indexOf('// ELIMINAR'));
  assert.match(verifyRoute, /aprobarComprobanteManualAtomicoPg/);
  assert.doesNotMatch(verifyRoute, /UPDATE comprobantes_transferencia/);
  assert.doesNotMatch(verifyRoute, /INSERT INTO transferencias/);
  assert.doesNotMatch(verifyRoute, /\bforce\b/);
});

test('servicio manual usa una transacción, locks y revalida tenant, pedido, cuenta, claim y pagos', async () => {
  const calls = [];
  const txQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) return [{
      id: 11, empresa_id: 7, pedido_id: 20, chofer_id: 4, monto: '1500.00',
      metodo_pago: 'transferencia', nro_operacion: 'OP-MANUAL', cuenta_bancaria_id: 9,
      estado_revision: 'en_revision', validado: 0, procesado: false,
    }];
    if (sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) return [{
      id: 20, empresa_id: 7, monto: '1500.00', metodo_pago: 'transferencia', fecha: new Date(),
    }];
    if (sql.includes('FROM empresa_cuentas_bancarias') && sql.includes('FOR UPDATE')) return [{ id: 9, empresa_id: 7, activa: true }];
    if (sql.includes('FROM comprobante_pedido_aprobado_claims')) return [];
    if (sql.includes('FROM comprobante_operacion_claims')) return [{ comprobante_id: 11 }];
    if (sql.includes('FROM pedido_pagos')) return [];
    if (sql.includes('UPDATE comprobantes_transferencia')) return [{ id: 11, pedido_id: 20 }];
    if (sql.includes('INSERT INTO transferencias')) return [];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  let transactions = 0;

  const result = await aprobarComprobanteManualAtomicoPg({
    id: 11, empresaId: 7, actorId: 42, reason: 'revisado por tesorería',
  }, { withTransaction: async work => { transactions += 1; return work(txQuery); } });

  assert.equal(transactions, 1);
  assert.equal(result.id, 11);
  assert.deepEqual(calls.map(call => call.sql).slice(0, 6).map(sql =>
    ['comprobantes_transferencia', 'pedidos', 'empresa_cuentas_bancarias', 'comprobante_pedido_aprobado_claims', 'comprobante_operacion_claims', 'pedido_pagos']
      .find(name => sql.includes(`FROM ${name}`))), [
    'comprobantes_transferencia', 'pedidos', 'empresa_cuentas_bancarias', 'comprobante_pedido_aprobado_claims', 'comprobante_operacion_claims', 'pedido_pagos',
  ]);
  const update = calls.find(call => call.sql.includes('UPDATE comprobantes_transferencia'));
  assert.match(update.sql, /verified_by\s*=\s*\$3/);
  assert.equal(update.params[2], 42);
});

test('manual completa operación/cuenta NULL y rechaza reemplazar valores existentes', async () => {
  const makeTx = receipt => async (sql, params) => {
    if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) return [receipt];
    if (sql.includes('FROM pedidos')) return [{ id: 20, empresa_id: 7, monto: '1500', metodo_pago: 'transferencia' }];
    if (sql.includes('FROM empresa_cuentas_bancarias')) return [{ id: 9, empresa_id: 7, activa: true }];
    if (sql.includes('FROM comprobante_pedido_aprobado_claims')) return [];
    if (sql.includes('FROM comprobante_operacion_claims')) return [];
    if (sql.includes('FROM pedido_pagos')) return [];
    if (sql.includes('UPDATE comprobantes_transferencia')) {
      assert.match(sql, /nro_operacion\s*=\s*\$5/);
      assert.match(sql, /cuenta_bancaria_id\s*=\s*\$6/);
      assert.equal(params[4], 'OP-NUEVA');
      assert.equal(params[5], 9);
      return [{ id: 11, pedido_id: 20 }];
    }
    if (sql.includes('INSERT INTO transferencias')) return [];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  const base = {
    id: 11, empresa_id: 7, pedido_id: 20, monto: '1500', metodo_pago: 'transferencia',
    nro_operacion: null, cuenta_bancaria_id: null, estado_revision: 'pendiente', validado: 0, procesado: false,
  };
  await aprobarComprobanteManualAtomicoPg({
    id: 11, empresaId: 7, actorId: 42, nroOperacion: ' OP-NUEVA ', cuentaBancariaId: 9,
  }, { withTransaction: work => work(makeTx(base)) });

  await assert.rejects(
    aprobarComprobanteManualAtomicoPg({
      id: 11, empresaId: 7, actorId: 42, nroOperacion: 'OTRA', cuentaBancariaId: 10,
    }, { withTransaction: work => work(makeTx({ ...base, nro_operacion: 'ORIGINAL', cuenta_bancaria_id: 9 })) }),
    error => error?.code === 'reemplazo_datos_no_permitido',
  );
});

test('manual rechaza faltantes, cuenta/owner/tenant inválidos, pago, monto y método', async () => {
  const baseReceipt = {
    id: 11, empresa_id: 7, pedido_id: 20, monto: '1500', metodo_pago: 'transferencia',
    nro_operacion: 'OP-EXISTENTE', cuenta_bancaria_id: 9,
    estado_revision: 'pendiente', validado: 0, procesado: false,
  };
  const basePedido = { id: 20, empresa_id: 7, monto: '1500', metodo_pago: 'transferencia' };
  const scenarios = [
    { expected: 'numero_operacion_faltante', receipt: { ...baseReceipt, nro_operacion: null } },
    { expected: 'cuenta_bancaria_faltante', receipt: { ...baseReceipt, cuenta_bancaria_id: null } },
    { expected: 'cuenta_destino_no_verificada', account: { id: 9, empresa_id: 7, activa: false } },
    { expected: 'cuenta_destino_no_verificada', account: { id: 9, empresa_id: 8, activa: true } },
    { expected: 'pedido_ya_tiene_comprobante_aprobado', orderClaim: { comprobante_id: 99 } },
    { expected: 'operacion_duplicada', operationClaim: { comprobante_id: 99 } },
    { expected: 'pago_ya_acreditado', payments: [{ id: 5 }] },
    { expected: 'monto_no_coincide', pedido: { ...basePedido, monto: '1499' } },
    { expected: 'metodo_pago_no_transferencia', pedido: { ...basePedido, metodo_pago: 'efectivo' } },
    { expected: 'tenant_no_coincide', pedido: { ...basePedido, empresa_id: 8 } },
  ];

  for (const scenario of scenarios) {
    let updated = false;
    const txQuery = async sql => {
      if (sql.includes('FROM comprobantes_transferencia')) return [scenario.receipt || baseReceipt];
      if (sql.includes('FROM pedidos')) return [scenario.pedido || basePedido];
      if (sql.includes('FROM empresa_cuentas_bancarias')) {
        return [scenario.account || { id: 9, empresa_id: 7, activa: true }];
      }
      if (sql.includes('FROM comprobante_pedido_aprobado_claims')) {
        return scenario.orderClaim ? [scenario.orderClaim] : [];
      }
      if (sql.includes('FROM comprobante_operacion_claims')) {
        return [scenario.operationClaim || { comprobante_id: 11 }];
      }
      if (sql.includes('FROM pedido_pagos')) return scenario.payments || [];
      if (sql.includes('UPDATE comprobantes_transferencia')) { updated = true; return []; }
      throw new Error(`Consulta inesperada: ${sql}`);
    };
    await assert.rejects(
      aprobarComprobanteManualAtomicoPg({ id: 11, empresaId: 7, actorId: 42 }, {
        withTransaction: work => work(txQuery),
      }),
      error => error?.code === scenario.expected,
      scenario.expected,
    );
    assert.equal(updated, false, scenario.expected);
  }
});
