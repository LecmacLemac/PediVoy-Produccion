import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateReceiptApproval,
  finalizeReceiptValidation,
} from '../src/transferenciasPipeline.js';
import {
  aprobarComprobanteAtomicoPg,
  marcarComprobanteComoProcesadoPg,
} from '../src/transferenciasServices.js';

function validContext(overrides = {}) {
  return {
    registroDB: {
      id: 10, pedido_id: 20, empresa_id: 7, pedido_monto: 1500,
      pedido_metodo_pago: 'transferencia', pedido_pago_acreditado: false,
      file_hash: 'a'.repeat(64),
    },
    monto: 1500.01,
    nroOperacion: 'OP-OK',
    fechaComprobante: '2026-09-13',
    now: new Date('2026-09-13T12:00:00Z'),
    cuentaDestinoMatch: { cuenta_bancaria_id: 4, confianza: 70, cuenta: { id: 4 } },
    ...overrides,
  };
}

test('aprueba solo con pedido, monto dentro de un centavo y cuenta activa del tenant >=70', () => {
  const decision = evaluateReceiptApproval(validContext());

  assert.equal(decision.approved, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.riskScore, 0);
});

test('rechaza monto fuera de tolerancia monetaria y deja razón/riesgo explícitos', () => {
  const decision = evaluateReceiptApproval(validContext({ monto: 1500.011 }));

  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes('monto_no_coincide'));
  assert.ok(decision.riskScore > 0);
});

test('rechaza sin pedido, monto IA válido o cuenta destino confiable', () => {
  const decision = evaluateReceiptApproval(validContext({
    registroDB: { id: 10, pedido_id: null, empresa_id: 7, pedido_monto: null },
    monto: 0,
    cuentaDestinoMatch: null,
  }));

  assert.deepEqual(decision.reasons, [
    'pedido_no_asociado',
    'monto_ia_invalido',
    'cuenta_destino_no_verificada',
    'hash_archivo_faltante',
  ]);
});

test('exige operación, hash, fecha entre -90 y +1 días, transferencia y pago pendiente', () => {
  const decision = evaluateReceiptApproval(validContext({
    registroDB: {
      ...validContext().registroDB,
      pedido_metodo_pago: 'efectivo',
      pedido_pago_acreditado: true,
      file_hash: null,
    },
    nroOperacion: ' ',
    fechaComprobante: '2026-06-14',
  }));

  assert.equal(decision.approved, false);
  assert.deepEqual(decision.reasons, [
    'numero_operacion_faltante',
    'hash_archivo_faltante',
    'fecha_comprobante_fuera_de_rango',
    'metodo_pago_no_transferencia',
    'pago_ya_acreditado',
  ]);
});

test('ventana de fecha acepta días calendario -90 y +1 y rechaza +2', () => {
  const now = new Date('2026-09-13T23:59:59Z');
  assert.equal(evaluateReceiptApproval(validContext({ fechaComprobante: '2026-06-15', now })).approved, true);
  assert.equal(evaluateReceiptApproval(validContext({ fechaComprobante: '2026-09-14', now })).approved, true);
  const future = evaluateReceiptApproval(validContext({ fechaComprobante: '2026-09-15', now }));
  assert.ok(future.reasons.includes('fecha_comprobante_fuera_de_rango'));
});

test('rechaza fechas calendario imposibles y acepta límites reales y año bisiesto', () => {
  const invalidJune = evaluateReceiptApproval(validContext({
    fechaComprobante: '2026-06-31',
    now: new Date('2026-07-01T12:00:00Z'),
  }));
  const invalidLeapDay = evaluateReceiptApproval(validContext({
    fechaComprobante: '2025-02-29',
    now: new Date('2025-03-01T12:00:00Z'),
  }));

  assert.ok(invalidJune.reasons.includes('fecha_comprobante_fuera_de_rango'));
  assert.ok(invalidLeapDay.reasons.includes('fecha_comprobante_fuera_de_rango'));
  assert.equal(evaluateReceiptApproval(validContext({
    fechaComprobante: '2026-06-30',
    now: new Date('2026-07-01T12:00:00Z'),
  })).approved, true);
  assert.equal(evaluateReceiptApproval(validContext({
    fechaComprobante: '2024-02-29',
    now: new Date('2024-03-01T12:00:00Z'),
  })).approved, true);
});

test('normaliza monto IA no finito a cero antes de persistir revisión', async () => {
  const updates = [];
  await finalizeReceiptValidation({
    registroDB: validContext().registroDB,
    datosIA: { monto: Infinity },
    telefono: '3510000000',
    deps: {
      resolverCuentaBancariaDestinoPg: async () => validContext().cuentaDestinoMatch,
      verificarDuplicadoOperacionPg: async () => false,
      actualizarComprobanteDatosPg: async (_id, patch) => updates.push(patch),
      marcarComprobanteComoProcesadoPg: async () => assert.fail('no debe aprobar'),
      enqueueWppMessagePg: async () => {},
    },
  });

  assert.equal(updates[0].monto, 0);
  assert.match(updates[0].riesgo_flags, /monto_ia_invalido/);
});

test('finalización aprobada usa una única reserva atómica y conserva empresa en outbox', async () => {
  const calls = { updates: [], atomic: [], messages: [] };
  const result = await finalizeReceiptValidation({
    registroDB: validContext().registroDB,
    datosIA: {
      monto: 1500,
      nro_operacion: 'OP-OK',
      fecha: new Date().toISOString().slice(0, 10),
      alias_destino: 'CUENTA.EMPRESA',
    },
    telefono: '3510000000',
    deps: {
      resolverCuentaBancariaDestinoPg: async ({ empresaId }) => {
        assert.equal(empresaId, 7);
        return validContext().cuentaDestinoMatch;
      },
      actualizarComprobanteDatosPg: async (id, patch) => calls.updates.push({ id, patch }),
      aprobarComprobanteAtomicoPg: async payload => {
        calls.atomic.push(payload);
        return { id: payload.id, pedido_id: 20 };
      },
      enqueueWppMessagePg: async payload => calls.messages.push(payload),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.atomic.length, 1);
  assert.equal(calls.atomic[0].empresaId, 7);
  assert.equal(calls.atomic[0].nroOperacion, 'OP-OK');
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].empresaId, 7);
});

test('finalización rechazada persiste pendiente sin procesar y responde revisión manual', async () => {
  const updates = [];
  const messages = [];
  let marked = false;
  const result = await finalizeReceiptValidation({
    registroDB: validContext().registroDB,
    datosIA: { monto: 1499, nro_operacion: 'OP-REVIEW' },
    telefono: '3510000000',
    deps: {
      resolverCuentaBancariaDestinoPg: async () => null,
      verificarDuplicadoOperacionPg: async () => false,
      actualizarComprobanteDatosPg: async (_id, patch) => updates.push(patch),
      marcarComprobanteComoProcesadoPg: async () => { marked = true; },
      enqueueWppMessagePg: async payload => messages.push(payload),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manual_review');
  assert.equal(marked, false);
  assert.equal(updates[0].procesado, false);
  assert.equal(updates[0].validado, 0);
  assert.equal(updates[0].estado_revision, 'pendiente');
  assert.match(updates[0].verified_reason, /monto_no_coincide/);
  assert.ok(updates[0].riesgo_score > 0);
  assert.match(messages.at(-1).message, /revisión manual/i);
});

test('aprobación autoritativa bloquea y revalida comprobante, pedido, cuenta y pagos antes del UPDATE', async () => {
  const calls = [];
  const txQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) {
      return [{ id: 11, empresa_id: 7, pedido_id: 20, estado_revision: 'pendiente', validado: 0, procesado: false }];
    }
    if (sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) {
      return [{ id: 20, empresa_id: 7, monto: '1500.00', metodo_pago: 'transferencia' }];
    }
    if (sql.includes('FROM comprobante_pedido_aprobado_claims')) return [];
    if (sql.includes('FROM empresa_cuentas_bancarias') && sql.includes('FOR UPDATE')) {
      return [{ id: 4, empresa_id: 7, activa: true, alias: 'CUENTA.EMPRESA', cbu: null, titular: 'Empresa SA', banco: null }];
    }
    if (sql.includes('FROM pedido_pagos')) return [];
    if (sql.includes('UPDATE comprobantes_transferencia')) return [{ id: 11, pedido_id: 20 }];
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  let transactions = 0;

  const approved = await aprobarComprobanteAtomicoPg({
    id: 11,
    empresaId: 7,
    nroOperacion: ' OP-OK ',
    patch: {
      monto: 1500.01,
      cuenta_bancaria_id: 4,
      alias_destino: 'cuenta empresa',
    },
  }, {
    withTransaction: async fn => { transactions += 1; return fn(txQuery); },
  });

  assert.deepEqual(approved, { id: 11, pedido_id: 20 });
  assert.equal(transactions, 1);
  const sqls = calls.map(({ sql }) => sql);
  assert.ok(sqls[0].includes('FROM comprobantes_transferencia'));
  assert.ok(sqls[1].includes('FROM pedidos'));
  assert.ok(sqls[2].includes('FROM comprobante_pedido_aprobado_claims'));
  assert.ok(sqls[3].includes('FROM empresa_cuentas_bancarias'));
  assert.ok(sqls[4].includes('FROM pedido_pagos'));
  assert.ok(sqls[5].includes('UPDATE comprobantes_transferencia'));
  assert.match(sqls[5], /nro_operacion\s*=\s*\$3/);
  assert.equal(calls[5].params[2], 'OP-OK');
});

test('aprobación autoritativa tipifica cambios concurrentes y nunca ejecuta UPDATE', async () => {
  const cases = [
    {
      expected: 'estado_comprobante_no_elegible',
      comprobante: { id: 11, empresa_id: 7, pedido_id: 20, estado_revision: 'rechazado', validado: 0, procesado: false },
      pedido: { id: 20, empresa_id: 7, monto: '1500.00', metodo_pago: 'transferencia' },
      cuenta: { id: 4, empresa_id: 7, activa: true, alias: 'destino' },
      pagos: [],
    },
    {
      expected: 'monto_no_coincide',
      pedido: { id: 20, empresa_id: 7, monto: '1500.02', metodo_pago: 'transferencia' },
      cuenta: { id: 4, empresa_id: 7, activa: true, alias: 'destino' },
      pagos: [],
    },
    {
      expected: 'metodo_pago_no_transferencia',
      pedido: { id: 20, empresa_id: 7, monto: '1500.00', metodo_pago: 'efectivo' },
      cuenta: { id: 4, empresa_id: 7, activa: true, alias: 'destino' },
      pagos: [],
    },
    {
      expected: 'cuenta_destino_no_verificada',
      pedido: { id: 20, empresa_id: 7, monto: '1500.00', metodo_pago: 'transferencia' },
      cuenta: { id: 4, empresa_id: 7, activa: false, alias: 'destino' },
      pagos: [],
    },
    {
      expected: 'pago_ya_acreditado',
      pedido: { id: 20, empresa_id: 7, monto: '1500.00', metodo_pago: 'transferencia' },
      cuenta: { id: 4, empresa_id: 7, activa: true, alias: 'destino' },
      pagos: [{ id: 99 }],
    },
  ];

  for (const scenario of cases) {
    let updated = false;
    const txQuery = async (sql) => {
      if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) {
        return [scenario.comprobante || { id: 11, empresa_id: 7, pedido_id: 20, estado_revision: 'pendiente', validado: 0, procesado: false }];
      }
      if (sql.includes('FROM pedidos') && sql.includes('FOR UPDATE')) return [scenario.pedido];
      if (sql.includes('FROM comprobante_pedido_aprobado_claims')) return [];
      if (sql.includes('FROM empresa_cuentas_bancarias') && sql.includes('FOR UPDATE')) return [scenario.cuenta];
      if (sql.includes('FROM pedido_pagos')) return scenario.pagos;
      if (sql.includes('UPDATE comprobantes_transferencia')) { updated = true; return []; }
      throw new Error(`Consulta inesperada: ${sql}`);
    };

    await assert.rejects(
      aprobarComprobanteAtomicoPg({
        id: 11,
        empresaId: 7,
        nroOperacion: 'OP-FAIL',
        patch: { monto: 1500, cuenta_bancaria_id: 4, alias_destino: 'destino' },
      }, { withTransaction: fn => fn(txQuery) }),
      error => error?.code === scenario.expected,
      scenario.expected,
    );
    assert.equal(updated, false, scenario.expected);
  }
});

test('helper legacy no puede aprobar ni procesar fuera del servicio transaccional', async () => {
  await assert.rejects(
    marcarComprobanteComoProcesadoPg(10),
    error => error?.code === 'aprobacion_fuera_de_servicio',
  );
});

test('finalización convierte un fallo transaccional tipificado en revisión pendiente', async () => {
  const updates = [];
  const failure = Object.assign(new Error('pago concurrente'), { code: 'pago_ya_acreditado' });
  const result = await finalizeReceiptValidation({
    registroDB: validContext().registroDB,
    datosIA: { monto: 1500, nro_operacion: 'OP-RACE', fecha: new Date().toISOString().slice(0, 10), alias_destino: 'destino' },
    telefono: '3510000000',
    deps: {
      resolverCuentaBancariaDestinoPg: async () => validContext().cuentaDestinoMatch,
      aprobarComprobanteAtomicoPg: async () => { throw failure; },
      actualizarComprobanteDatosPg: async (_id, patch) => updates.push(patch),
      enqueueWppMessagePg: async () => {},
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('pago_ya_acreditado'));
  assert.equal(updates[0].estado_revision, 'pendiente');
  assert.equal(updates[0].procesado, false);
  assert.equal(updates[0].validado, 0);
});

test('tras 23505 persiste revisión sin reescribir la operación duplicada', async () => {
  const updates = [];
  const duplicate = Object.assign(new Error('unique violation'), { code: '23505' });
  const result = await finalizeReceiptValidation({
    registroDB: validContext().registroDB,
    datosIA: {
      monto: 1500,
      nro_operacion: 'OP-DUPLICADA',
      fecha: new Date().toISOString().slice(0, 10),
      alias_destino: 'destino',
    },
    telefono: '3510000000',
    deps: {
      resolverCuentaBancariaDestinoPg: async () => validContext().cuentaDestinoMatch,
      aprobarComprobanteAtomicoPg: async () => { throw duplicate; },
      actualizarComprobanteDatosPg: async (_id, patch) => {
        assert.equal(Object.hasOwn(patch, 'nro_operacion'), false);
        updates.push(patch);
      },
      enqueueWppMessagePg: async () => {},
    },
  });

  assert.equal(result.saved, true);
  assert.equal(result.reason, 'duplicate');
  assert.equal(updates[0].estado_revision, 'pendiente');
  assert.match(updates[0].riesgo_flags, /operacion_duplicada/);
});
