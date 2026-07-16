// src/services/retornablesLedger.js
// Ledger genérico para cuenta corriente de productos retornables.

const SUJETOS_VALIDOS = new Set(['cliente', 'chofer', 'proveedor', 'deposito']);

function normalizeSujetoTipo(value) {
  const tipo = String(value || 'cliente').trim().toLowerCase();
  return SUJETOS_VALIDOS.has(tipo) ? tipo : null;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function ensureRetornablesLedgerSchema(queryFn) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS retornables_saldos (
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      sujeto_tipo TEXT NOT NULL CHECK (sujeto_tipo IN ('cliente', 'chofer', 'proveedor', 'deposito')),
      sujeto_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      saldo NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (empresa_id, sujeto_tipo, sujeto_id, producto_id)
    )
  `);
  await queryFn(`
    CREATE TABLE IF NOT EXISTS retornables_movimientos (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
      sujeto_tipo TEXT NOT NULL CHECK (sujeto_tipo IN ('cliente', 'chofer', 'proveedor', 'deposito')),
      sujeto_id INTEGER NOT NULL,
      contraparte_tipo TEXT,
      contraparte_id INTEGER,
      pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
      gasto_id INTEGER REFERENCES gastos_repartidor(id) ON DELETE SET NULL,
      chofer_id INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
      proveedor_id INTEGER,
      deposito_id INTEGER,
      tipo TEXT NOT NULL,
      cantidad_llenos NUMERIC(12,2) NOT NULL DEFAULT 0,
      cantidad_vacios NUMERIC(12,2) NOT NULL DEFAULT 0,
      delta_saldo NUMERIC(12,2) NOT NULL DEFAULT 0,
      saldo_resultante NUMERIC(12,2),
      observacion TEXT,
      origen TEXT NOT NULL DEFAULT 'admin',
      referencia TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS idx_retornables_saldos_empresa_sujeto ON retornables_saldos (empresa_id, sujeto_tipo, sujeto_id, producto_id)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS idx_retornables_saldos_empresa_producto ON retornables_saldos (empresa_id, producto_id, saldo)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS idx_retornables_movimientos_sujeto ON retornables_movimientos (empresa_id, sujeto_tipo, sujeto_id, producto_id, fecha DESC)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS idx_retornables_movimientos_origen ON retornables_movimientos (empresa_id, origen, tipo, fecha DESC)`);
}

export async function registrarRetornableMovimiento(queryFn, input = {}) {
  const empresaId = toNum(input.empresaId || input.empresa_id);
  const productoId = toNum(input.productoId || input.producto_id);
  const sujetoTipo = normalizeSujetoTipo(input.sujetoTipo || input.sujeto_tipo);
  const sujetoId = toNum(input.sujetoId || input.sujeto_id);
  const delta = toNum(input.deltaSaldo ?? input.delta_saldo);

  if (!empresaId || !productoId || !sujetoTipo || !sujetoId) {
    const err = new Error('Movimiento retornable inválido: empresa, sujeto y producto son requeridos');
    err.statusCode = 400;
    throw err;
  }

  const saldoRows = await queryFn(
    `
    INSERT INTO retornables_saldos
      (empresa_id, sujeto_tipo, sujeto_id, producto_id, saldo, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (empresa_id, sujeto_tipo, sujeto_id, producto_id)
    DO UPDATE SET saldo = retornables_saldos.saldo + EXCLUDED.saldo, updated_at = NOW()
    RETURNING saldo
    `,
    [empresaId, sujetoTipo, sujetoId, productoId, delta]
  );
  const saldoResultante = Number(saldoRows?.[0]?.saldo || 0);

  const movRows = await queryFn(
    `
    INSERT INTO retornables_movimientos
      (empresa_id, fecha, producto_id, sujeto_tipo, sujeto_id, contraparte_tipo, contraparte_id,
       pedido_id, gasto_id, chofer_id, proveedor_id, deposito_id, tipo,
       cantidad_llenos, cantidad_vacios, delta_saldo, saldo_resultante, observacion, origen, referencia, created_by)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20, $21)
    RETURNING id, saldo_resultante
    `,
    [
      empresaId,
      input.fecha || new Date().toISOString(),
      productoId,
      sujetoTipo,
      sujetoId,
      input.contraparteTipo || input.contraparte_tipo || null,
      input.contraparteId || input.contraparte_id || null,
      input.pedidoId || input.pedido_id || null,
      input.gastoId || input.gasto_id || null,
      input.choferId || input.chofer_id || null,
      input.proveedorId || input.proveedor_id || null,
      input.depositoId || input.deposito_id || null,
      String(input.tipo || 'ajuste'),
      toNum(input.cantidadLlenos ?? input.cantidad_llenos),
      toNum(input.cantidadVacios ?? input.cantidad_vacios),
      delta,
      saldoResultante,
      input.observacion || null,
      String(input.origen || 'admin'),
      input.referencia || null,
      input.createdBy || input.created_by || null,
    ]
  );

  return {
    movimiento: movRows?.[0] || null,
    saldo_resultante: saldoResultante,
  };
}

export function normalizeRetornableSujetoTipo(value) {
  return normalizeSujetoTipo(value);
}
