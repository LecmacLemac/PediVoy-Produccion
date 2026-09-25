// src/transferenciasServices.js — PostgreSQL (Versión Final Completa)
import { pool, query, withTransaction as dbWithTransaction } from './db.js';
import { readFile } from 'node:fs/promises';
import { enqueueWppOutbox, enqueueWppOutboxCorrelatedReply } from './wpp/enqueue.js';

const MIGRATION_START = '-- BEGIN COMPROBANTE CONCURRENCY MIGRATION';
const MIGRATION_END = '-- END COMPROBANTE CONCURRENCY MIGRATION';

export async function readComprobanteConcurrencyMigration() {
  const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = initSql.indexOf(MIGRATION_START);
  const end = initSql.indexOf(MIGRATION_END);
  if (start < 0 || end <= start) throw new Error('Bloque de migración de comprobantes ausente en initDb.sql');
  return initSql.slice(start + MIGRATION_START.length, end).trim();
}

export async function ensureComprobantesTransferenciaSchema(queryFn = query) {
  await queryFn(`ALTER TABLE comprobantes_transferencia
    ADD COLUMN IF NOT EXISTS source_message_id TEXT,
    ADD COLUMN IF NOT EXISTS dedupe_file_hash TEXT,
    ADD COLUMN IF NOT EXISTS approval_dedupe_key TEXT,
    ADD COLUMN IF NOT EXISTS source_chat_jid TEXT,
    ADD COLUMN IF NOT EXISTS transport_origin TEXT`);
  await queryFn(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ct_source_message_new
    ON comprobantes_transferencia ((COALESCE(empresa_id, 0)), source_message_id)
    WHERE source_message_id IS NOT NULL`);
  await queryFn(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ct_file_hash_new
    ON comprobantes_transferencia ((COALESCE(empresa_id, 0)), dedupe_file_hash)
    WHERE dedupe_file_hash IS NOT NULL`);
  await queryFn(await readComprobanteConcurrencyMigration());
}

function digitsOnly(v) {
  return String(v || '').replace(/\D+/g, '');
}

function normalizeText(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function normalizeAlias(v) {
  return normalizeText(v);
}

function normalizeCbu(v) {
  return digitsOnly(v);
}

export function matchCuentaBancariaDestino(cuentas = [], data = {}) {
  const aliasDestino = normalizeAlias(data.alias_destino || data.aliasDestino);
  const cbuDestino = normalizeCbu(data.cbu_destino || data.cbuDestino);
  const titularDestino = normalizeText(data.titular_destino || data.titularDestino);
  const bancoDestino = normalizeText(data.banco_destino || data.bancoDestino);

  let best = null;

  for (const cuenta of Array.isArray(cuentas) ? cuentas : []) {
    if (cuenta?.activa === false) continue;
    const cuentaAlias = normalizeAlias(cuenta.alias);
    const cuentaCbu = normalizeCbu(cuenta.cbu);
    const cuentaTitular = normalizeText(cuenta.titular);
    const cuentaBanco = normalizeText(cuenta.banco);

    const fuentes = [];
    let score = 0;

    if (cbuDestino && cuentaCbu && cbuDestino === cuentaCbu) {
      score += 100;
      fuentes.push('cbu');
    }
    if (aliasDestino && cuentaAlias && aliasDestino === cuentaAlias) {
      score += 95;
      fuentes.push('alias');
    }
    if (titularDestino && cuentaTitular && titularDestino === cuentaTitular) {
      score += 80;
      fuentes.push('titular');
    }
    if (bancoDestino && cuentaBanco && (bancoDestino.includes(cuentaBanco) || cuentaBanco.includes(bancoDestino))) {
      score += 25;
      fuentes.push('banco');
    }

    const confianza = Math.min(score, 100);
    if (confianza <= 0) continue;

    const candidate = {
      cuenta,
      cuenta_bancaria_id: Number(cuenta.id),
      confianza,
      fuente: fuentes.join('+'),
      detalle: `Cuenta #${Number(cuenta.id)} detectada por ${fuentes.join(', ')}`
    };

    if (!best || candidate.confianza > best.confianza) best = candidate;
  }

  return best && best.confianza >= 70 ? best : null;
}

export async function resolverCuentaBancariaDestinoPg({ empresaId, banco_destino, alias_destino, cbu_destino, titular_destino }) {
  const eid = Number(empresaId || 0);
  if (!eid) return null;

  const cuentas = await query(
    `SELECT id, banco, alias, cbu, titular, prioridad
     FROM empresa_cuentas_bancarias
     WHERE empresa_id = $1
       AND COALESCE(activa, TRUE) = TRUE
     ORDER BY COALESCE(prioridad, 999), id`,
    [eid]
  );

  return matchCuentaBancariaDestino(cuentas, {
    banco_destino,
    alias_destino,
    cbu_destino,
    titular_destino
  });
}

// ============================================
// 1. CHEQUEAR DUPLICADO (Validación de Seguridad)
// ============================================
export async function verificarDuplicadoOperacionPg(nroOperacion, empresaId, queryFn = query) {
  if (!nroOperacion || !Number(empresaId || 0)) return false;

  const cleanOp = String(nroOperacion).trim();

  const rows = await queryFn(
    `SELECT id FROM comprobantes_transferencia 
     WHERE LOWER(nro_operacion) = LOWER($1)
       AND empresa_id = $2
     LIMIT 1`,
    [cleanOp, Number(empresaId)]
  );

  return rows.length > 0;
}

export class ComprobanteApprovalError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options);
    this.name = 'ComprobanteApprovalError';
    this.code = code;
  }
}

function approvalFailure(code, message) {
  throw new ComprobanteApprovalError(code, message);
}

export async function aprobarComprobanteAtomicoPg(
  { id, empresaId, nroOperacion, patch = {} },
  { withTransaction = dbWithTransaction } = {},
) {
  const comprobanteId = Number(id);
  const cleanOp = String(nroOperacion || '').trim();
  const eid = Number(empresaId || 0);
  const amount = Number(patch.monto);
  const accountId = Number(patch.cuenta_bancaria_id || 0);
  if (!comprobanteId || !eid || !cleanOp) approvalFailure('datos_aprobacion_invalidos');
  if (!Number.isFinite(amount) || amount <= 0) approvalFailure('monto_ia_invalido');
  if (!accountId) approvalFailure('cuenta_destino_no_verificada');

  try {
    return await withTransaction(async (txQuery) => {
      const comprobantes = await txQuery(
        `SELECT id, empresa_id, pedido_id, chofer_id, fecha, comprobante_path,
                estado_revision, validado, procesado
           FROM comprobantes_transferencia
          WHERE id = $1
          FOR UPDATE`,
        [comprobanteId],
      );
      const comprobante = comprobantes[0];
      if (!comprobante) approvalFailure('comprobante_no_encontrado');
      if (Number(comprobante.empresa_id || 0) !== eid) approvalFailure('tenant_no_coincide');
      const currentState = String(comprobante.estado_revision || 'pendiente').toLowerCase();
      if (
        Number(comprobante.validado || 0) === 1
        || comprobante.procesado === true
        || !['pendiente', 'en_revision'].includes(currentState)
      ) {
        approvalFailure('estado_comprobante_no_elegible');
      }
      if (!comprobante.pedido_id) approvalFailure('pedido_no_asociado');

      const pedidos = await txQuery(
        `SELECT id, empresa_id, monto, metodo_pago
           FROM pedidos
          WHERE id = $1
          FOR UPDATE`,
        [Number(comprobante.pedido_id)],
      );
      const pedido = pedidos[0];
      if (!pedido) approvalFailure('pedido_no_asociado');
      if (Number(pedido.empresa_id || 0) !== eid) approvalFailure('tenant_no_coincide');

      const orderClaim = (await txQuery(
        `SELECT comprobante_id FROM comprobante_pedido_aprobado_claims
          WHERE tenant_key = $1 AND pedido_id = $2 FOR UPDATE`,
        [eid, Number(pedido.id)],
      ))[0];
      if (orderClaim && Number(orderClaim.comprobante_id) !== comprobanteId) {
        approvalFailure('pedido_ya_tiene_comprobante_aprobado');
      }

      const cuentas = await txQuery(
        `SELECT id, empresa_id, banco, alias, cbu, titular, activa
           FROM empresa_cuentas_bancarias
          WHERE id = $1
          FOR UPDATE`,
        [accountId],
      );
      const cuenta = cuentas[0];

      // Debe ejecutarse después de tomar todos los locks mutables.
      const pagos = await txQuery(
        `SELECT id
           FROM pedido_pagos
          WHERE pedido_id = $1
            AND empresa_id = $2
            AND (settlement_at IS NOT NULL
              OR LOWER(COALESCE(estado, '')) IN ('pagado', 'aprobado', 'acreditado'))
          LIMIT 1`,
        [Number(pedido.id), eid],
      );

      if (Math.abs(amount - Number(pedido.monto)) > 0.010000001) {
        approvalFailure('monto_no_coincide');
      }
      if (String(pedido.metodo_pago || '').trim().toLowerCase() !== 'transferencia') {
        approvalFailure('metodo_pago_no_transferencia');
      }
      if (!cuenta || Number(cuenta.empresa_id || 0) !== eid || cuenta.activa !== true) {
        approvalFailure('cuenta_destino_no_verificada');
      }
      const currentMatch = matchCuentaBancariaDestino([cuenta], {
        banco_destino: patch.banco_destino,
        alias_destino: patch.alias_destino,
        cbu_destino: patch.cbu_destino,
        titular_destino: patch.titular_destino,
      });
      if (!currentMatch || currentMatch.confianza < 70) {
        approvalFailure('cuenta_destino_no_verificada');
      }
      if (pagos.length) approvalFailure('pago_ya_acreditado');

      const rows = await txQuery(
        `UPDATE comprobantes_transferencia
            SET nro_operacion = $3,
                approval_dedupe_key = normalizar_comprobante_operacion($3),
                monto = $4, banco_origen = $5, banco_destino = $6,
                alias_destino = $7, cbu_destino = $8, titular_destino = $9,
                cuenta_bancaria_id = $10, cuenta_bancaria_confianza = $11,
                cuenta_bancaria_match_fuente = $12, cuenta_bancaria_match_detalle = $13,
                procesado = TRUE, fecha_procesado = NOW(), validado = 1,
                estado_revision = 'aprobado', riesgo_score = 0, riesgo_flags = NULL,
                verified_reason = 'validacion_automatica_transaccional',
                verified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND empresa_id = $2
          RETURNING id, pedido_id`,
        [comprobanteId, eid, cleanOp, amount, patch.banco_origen ?? null,
          patch.banco_destino ?? null, patch.alias_destino ?? null,
          patch.cbu_destino ?? null, patch.titular_destino ?? null, accountId,
          currentMatch.confianza, currentMatch.fuente, currentMatch.detalle],
      );
      if (!rows[0]) approvalFailure('estado_comprobante_no_elegible');
      await txQuery(
        `INSERT INTO transferencias (
           empresa_id, chofer_id, fecha, monto, metodo_pago, referencia,
           comprobante_path, pedido_id, notas
         )
         SELECT $1,$2,$3,$4,'transferencia',$5,$6,$7,$8
         WHERE NOT EXISTS (
           SELECT 1 FROM transferencias
            WHERE empresa_id=$1 AND pedido_id=$7
              AND metodo_pago='transferencia' AND ABS(monto-$4) < 0.01
         )`,
        [eid, comprobante.chofer_id, comprobante.fecha || new Date(), amount,
          `Transferencia verificada pedido #${pedido.id}`, comprobante.comprobante_path || null,
          Number(pedido.id), `Origen comprobantes_transferencia.id=${comprobanteId}; validación automática`],
      );
      return rows[0];
    });
  } catch (error) {
    if (error?.code === '23505' && error?.constraint === 'ct_one_approved_per_order') {
      throw new ComprobanteApprovalError('pedido_ya_tiene_comprobante_aprobado', 'El pedido ya posee otro comprobante aprobado', { cause: error });
    }
    if (error?.code === '23505' && error?.constraint === 'comprobante_operacion_claims_pkey') {
      throw new ComprobanteApprovalError('operacion_duplicada', 'Número de operación ya reclamado', { cause: error });
    }
    throw error;
  }
}

export async function aprobarComprobanteManualAtomicoPg(
  { id, empresaId, actorId, reason, nroOperacion = null, cuentaBancariaId = null },
  { withTransaction = dbWithTransaction } = {},
) {
  const comprobanteId = Number(id);
  const eid = Number(empresaId);
  const verifierId = Number(actorId);
  if (!comprobanteId || !eid || !verifierId) approvalFailure('datos_aprobacion_invalidos');

  try {
    return await withTransaction(async (txQuery) => {
      const comprobante = (await txQuery(
        `SELECT id, empresa_id, pedido_id, chofer_id, fecha, monto, metodo_pago,
                nro_operacion, cuenta_bancaria_id, comprobante_path,
                estado_revision, validado, procesado, telefono, source_chat_jid,
                transport_origin, banco_origen, banco_destino
           FROM comprobantes_transferencia WHERE id = $1 FOR UPDATE`,
        [comprobanteId],
      ))[0];
      if (!comprobante) approvalFailure('comprobante_no_encontrado');
      if (Number(comprobante.empresa_id) !== eid) approvalFailure('tenant_no_coincide');
      const currentState = String(comprobante.estado_revision || 'pendiente').toLowerCase();
      if (Number(comprobante.validado || 0) === 1 || comprobante.procesado === true
          || !['pendiente', 'en_revision'].includes(currentState)) {
        approvalFailure('estado_comprobante_no_elegible');
      }
      if (!comprobante.pedido_id) approvalFailure('pedido_no_asociado');

      const pedido = (await txQuery(
        `SELECT id, empresa_id, monto, metodo_pago, fecha
           FROM pedidos WHERE id = $1 FOR UPDATE`,
        [Number(comprobante.pedido_id)],
      ))[0];
      if (!pedido) approvalFailure('pedido_no_asociado');
      if (Number(pedido.empresa_id) !== eid) approvalFailure('tenant_no_coincide');

      const suppliedOperation = nroOperacion == null ? null : String(nroOperacion).trim();
      const suppliedAccountId = cuentaBancariaId == null ? null : Number(cuentaBancariaId);
      if (suppliedOperation != null && (!suppliedOperation || suppliedOperation.length > 200)) {
        approvalFailure('numero_operacion_invalido');
      }
      if (suppliedAccountId != null && (!Number.isInteger(suppliedAccountId) || suppliedAccountId <= 0)) {
        approvalFailure('cuenta_destino_no_verificada');
      }
      if (comprobante.nro_operacion && suppliedOperation
          && String(comprobante.nro_operacion).trim().toLowerCase() !== suppliedOperation.toLowerCase()) {
        approvalFailure('reemplazo_datos_no_permitido');
      }
      if (comprobante.cuenta_bancaria_id && suppliedAccountId
          && Number(comprobante.cuenta_bancaria_id) !== suppliedAccountId) {
        approvalFailure('reemplazo_datos_no_permitido');
      }
      const effectiveOperation = String(comprobante.nro_operacion || suppliedOperation || '').trim();
      const effectiveAccountId = Number(comprobante.cuenta_bancaria_id || suppliedAccountId || 0);
      if (!effectiveOperation) approvalFailure('numero_operacion_faltante');
      if (!effectiveAccountId) approvalFailure('cuenta_bancaria_faltante');

      const cuenta = (await txQuery(
        `SELECT id, empresa_id, activa
           FROM empresa_cuentas_bancarias WHERE id = $1 FOR UPDATE`,
        [effectiveAccountId],
      ))[0];
      if (!cuenta || Number(cuenta.empresa_id) !== eid || cuenta.activa !== true) {
        approvalFailure('cuenta_destino_no_verificada');
      }

      const orderClaim = (await txQuery(
        `SELECT comprobante_id FROM comprobante_pedido_aprobado_claims
          WHERE tenant_key = $1 AND pedido_id = $2 FOR UPDATE`,
        [eid, Number(pedido.id)],
      ))[0];
      if (orderClaim && Number(orderClaim.comprobante_id) !== comprobanteId) {
        approvalFailure('pedido_ya_tiene_comprobante_aprobado');
      }

      const claim = comprobante.nro_operacion ? (await txQuery(
        `SELECT comprobante_id FROM comprobante_operacion_claims
          WHERE tenant_key = $1
            AND operacion_key = normalizar_comprobante_operacion($2)
          FOR UPDATE`,
        [eid, effectiveOperation],
      ))[0] : null;
      if (comprobante.nro_operacion && (!claim || Number(claim.comprobante_id) !== comprobanteId)) {
        approvalFailure('operacion_duplicada');
      }

      const pagos = await txQuery(
        `SELECT id FROM pedido_pagos
          WHERE pedido_id = $1 AND empresa_id = $2
            AND (settlement_at IS NOT NULL
              OR LOWER(COALESCE(estado, '')) IN ('pagado', 'aprobado', 'acreditado'))
          LIMIT 1`,
        [Number(pedido.id), eid],
      );
      if (pagos.length) approvalFailure('pago_ya_acreditado');
      if (Math.abs(Number(comprobante.monto) - Number(pedido.monto)) > 0.010000001) {
        approvalFailure('monto_no_coincide');
      }
      if (String(pedido.metodo_pago || '').trim().toLowerCase() !== 'transferencia') {
        approvalFailure('metodo_pago_no_transferencia');
      }

      const approved = (await txQuery(
        `UPDATE comprobantes_transferencia
            SET validado = 1, procesado = TRUE, fecha_procesado = NOW(),
                estado_revision = 'aprobado', verified_by = $3,
                verified_reason = COALESCE($4, 'aprobacion_manual_explicita'),
                nro_operacion = $5, cuenta_bancaria_id = $6,
                approval_dedupe_key = normalizar_comprobante_operacion($5),
                verified_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND empresa_id = $2
          RETURNING id, pedido_id`,
        [comprobanteId, eid, verifierId, String(reason || '').trim() || null,
          effectiveOperation, effectiveAccountId],
      ))[0];
      if (!approved) approvalFailure('estado_comprobante_no_elegible');

      await txQuery(
        `INSERT INTO transferencias (
           empresa_id, chofer_id, fecha, monto, metodo_pago, referencia,
           comprobante_path, pedido_id, notas
         )
         SELECT $1,$2,$3,$4,'transferencia',$5,$6,$7,$8
         WHERE NOT EXISTS (
           SELECT 1 FROM transferencias
            WHERE empresa_id=$1 AND pedido_id=$7
              AND metodo_pago='transferencia' AND ABS(monto-$4) < 0.01
         )`,
        [eid, comprobante.chofer_id, comprobante.fecha || pedido.fecha, Number(comprobante.monto),
          `Transferencia verificada pedido #${pedido.id}`, comprobante.comprobante_path || null,
          Number(pedido.id), `Origen comprobantes_transferencia.id=${comprobanteId}`],
      );
      return { ...comprobante, nro_operacion: effectiveOperation,
        cuenta_bancaria_id: effectiveAccountId, ...approved };
    });
  } catch (error) {
    if (error?.code === '23505' && error?.constraint === 'ct_one_approved_per_order') {
      throw new ComprobanteApprovalError('pedido_ya_tiene_comprobante_aprobado', 'El pedido ya posee otro comprobante aprobado', { cause: error });
    }
    if (error?.code === '23505' && error?.constraint === 'comprobante_operacion_claims_pkey') {
      throw new ComprobanteApprovalError('operacion_duplicada', 'Número de operación ya reclamado', { cause: error });
    }
    throw error;
  }
}

export async function asociarComprobantePedidoPg(
  { id, actorRole, actorEmpresaId, pedidoId, actorId, reason },
  { withTransaction = dbWithTransaction } = {},
) {
  const comprobanteId = Number(id);
  const pid = Number(pedidoId);
  const uid = Number(actorId);
  const role = String(actorRole || '');
  const actorTenant = Number(actorEmpresaId);
  const auditReason = String(reason || '').trim();
  if (!comprobanteId || !pid || !uid || !auditReason
      || !['admin', 'super'].includes(role)
      || (role !== 'super' && (!Number.isInteger(actorTenant) || actorTenant <= 0))) {
    approvalFailure('datos_asociacion_invalidos');
  }

  return await withTransaction(async txQuery => {
    const comprobante = (await txQuery(
      `SELECT id, empresa_id, pedido_id, estado_revision, validado, procesado, telefono,
              source_chat_jid, transport_origin
         FROM comprobantes_transferencia WHERE id = $1 FOR UPDATE`,
      [comprobanteId],
    ))[0];
    if (!comprobante) approvalFailure('comprobante_no_encontrado');
    if (comprobante.pedido_id) approvalFailure('comprobante_ya_asociado');
    if (Number(comprobante.validado || 0) === 1 || comprobante.procesado === true
        || !['pendiente', 'en_revision'].includes(String(comprobante.estado_revision || 'pendiente').toLowerCase())) {
      approvalFailure('estado_comprobante_no_elegible');
    }

    const pedido = (await txQuery(
      `SELECT p.id, p.empresa_id, p.chofer_id, p.zona_id, p.metodo_pago, p.estado,
              pe.telefono_normalizado
         FROM pedidos p
         JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
        WHERE p.id = $1 FOR UPDATE`,
      [pid],
    ))[0];
    if (!pedido) approvalFailure('pedido_no_asociado');
    const eid = Number(pedido.empresa_id);
    if (!Number.isInteger(eid) || eid <= 0) approvalFailure('tenant_no_coincide');
    if (comprobante.empresa_id == null) {
      if (role !== 'super') approvalFailure('adopcion_global_no_autorizada');
    } else if (Number(comprobante.empresa_id) !== eid) {
      approvalFailure('tenant_no_coincide');
    }
    if (role !== 'super' && actorTenant !== eid) approvalFailure('tenant_no_coincide');
    if (String(pedido.metodo_pago || '').trim().toLowerCase() !== 'transferencia') {
      approvalFailure('metodo_pago_no_transferencia');
    }
    if (String(pedido.estado || '').trim().toLowerCase() === 'cancelado') {
      approvalFailure('pedido_cancelado');
    }

    const pagos = await txQuery(
      `SELECT id FROM pedido_pagos
        WHERE pedido_id = $1 AND empresa_id = $2
          AND (settlement_at IS NOT NULL
            OR LOWER(COALESCE(estado, '')) IN ('pagado', 'aprobado', 'acreditado'))
        LIMIT 1`,
      [pid, eid],
    );
    if (pagos.length) approvalFailure('pago_ya_acreditado');

    const claim = (await txQuery(
      `SELECT comprobante_id FROM comprobante_pedido_aprobado_claims
        WHERE tenant_key = $1 AND pedido_id = $2 FOR UPDATE`,
      [eid, pid],
    ))[0];
    if (claim) approvalFailure('pedido_ya_tiene_comprobante_aprobado');

    const receiptPhone = digitsOnly(comprobante.telefono).slice(-10);
    const orderPhone = digitsOnly(pedido.telefono_normalizado).slice(-10);
    if (receiptPhone && orderPhone && receiptPhone !== orderPhone) {
      approvalFailure('telefono_pedido_no_coincide');
    }

    const rows = await txQuery(
      `UPDATE comprobantes_transferencia
          SET empresa_id = $2, pedido_id = $3, chofer_id = $4, zona_id = $5,
              estado_revision = 'pendiente',
              riesgo_flags = NULL,
              verified_by = $6,
              verified_reason = $7,
              verified_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND pedido_id IS NULL
          AND empresa_id IS NOT DISTINCT FROM $8
        RETURNING id, empresa_id, pedido_id, telefono, source_chat_jid, transport_origin`,
      [comprobanteId, eid, pid, pedido.chofer_id || null, pedido.zona_id || null,
        uid, `asociacion_manual: ${auditReason.slice(0, 300)}`, comprobante.empresa_id],
    );
    if (!rows[0]) approvalFailure('estado_comprobante_no_elegible');
    return rows[0];
  });
}

// ============================================
// 2. INSERTAR NUEVO COMPROBANTE (Con Vinculación Automática)
// ============================================
export async function insertarComprobantePg({
  telefono,
  replyJid = null,
  transportOrigin = null,
  imagen_path,
  fecha,
  empresaId = null,
  sourceMessageId = null,
  fileHash = null,
  mimetype, // (por ahora no se usa, pero lo dejamos por si se loguea a futuro)
  bytes     // (idem)
}, queryFn = query) {
  const telClean = digitsOnly(telefono) || null;
  // Usamos los últimos 10 dígitos para mejorar el "match" (evita problemas con 549 vs 0)
  const telSuffix = telClean ? telClean.slice(-10) : null;

  // --- LÓGICA DE VINCULACIÓN ---
  // Buscamos el último pedido asociado a este teléfono.
  // Prioridad: El más reciente (ORDER BY id DESC).
  // Estados: Incluimos 'entregado' para clientes que pagan post-entrega.
  const explicitEmpresaId = Number(empresaId || 0) || null;
  const sqlMatch = explicitEmpresaId ? `
    SELECT 
      p.id AS pedido_id, 
      p.empresa_id, 
      p.chofer_id,
      p.monto,
      p.metodo_pago,
      EXISTS (SELECT 1 FROM pedido_pagos pp WHERE pp.pedido_id = p.id
        AND pp.empresa_id = p.empresa_id AND (pp.settlement_at IS NOT NULL
          OR LOWER(pp.estado) IN ('pagado','aprobado','acreditado'))) AS pago_acreditado
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE 
      pe.telefono_normalizado LIKE '%' || $1
      AND p.empresa_id = $2
      AND pe.empresa_id = $2
      AND LOWER(COALESCE(p.metodo_pago, '')) = 'transferencia'
      AND p.estado IN ('pendiente', 'en_ruta', 'en_camino', 'entregado')
      AND NOT EXISTS (SELECT 1 FROM pedido_pagos paid WHERE paid.pedido_id = p.id
        AND paid.empresa_id = p.empresa_id AND (paid.settlement_at IS NOT NULL
          OR LOWER(COALESCE(paid.estado, '')) IN ('pagado','aprobado','acreditado')))
      AND NOT EXISTS (SELECT 1 FROM comprobante_pedido_aprobado_claims claim
        WHERE claim.tenant_key = p.empresa_id AND claim.pedido_id = p.id)
    ORDER BY p.id DESC 
    LIMIT 2
  ` : `
    SELECT DISTINCT ON (p.empresa_id)
      p.id AS pedido_id,
      p.empresa_id,
      p.chofer_id,
      p.monto,
      p.metodo_pago,
      EXISTS (SELECT 1 FROM pedido_pagos pp WHERE pp.pedido_id = p.id
        AND pp.empresa_id = p.empresa_id AND (pp.settlement_at IS NOT NULL
          OR LOWER(pp.estado) IN ('pagado','aprobado','acreditado'))) AS pago_acreditado
    FROM pedidos p
    JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
    WHERE pe.telefono_normalizado LIKE '%' || $1
      AND p.estado IN ('pendiente', 'en_ruta', 'en_camino', 'entregado')
    ORDER BY p.empresa_id, p.id DESC
  `;

  const matchResult = telClean
    ? await queryFn(sqlMatch, explicitEmpresaId ? [telSuffix, explicitEmpresaId] : [telSuffix])
    : [];
  const eligibleMatches = explicitEmpresaId
    ? matchResult.filter(row => Number(row.empresa_id) === explicitEmpresaId)
    : matchResult;
  const tenantAmbiguous = !explicitEmpresaId
    && new Set(eligibleMatches.map(row => Number(row.empresa_id))).size > 1;
  const orderAmbiguous = !!explicitEmpresaId && eligibleMatches.length > 1;
  const ambiguous = tenantAmbiguous || orderAmbiguous;
  const pedidoEncontrado = ambiguous ? {} : (eligibleMatches[0] || {});

  // Datos para vincular (o NULL si no se encontró nada)
  const pid = pedidoEncontrado.pedido_id || null;
  const eid = explicitEmpresaId || pedidoEncontrado.empresa_id || null;
  const cid = pedidoEncontrado.chofer_id || null;

  if (pid) {
    console.log(
      `[Transferencia] ✅ Vinculado Automáticamente al Pedido #${pid} (Empresa ${eid})`
    );
  }

  const pendingReason = !telClean
    ? 'remitente_no_resuelto'
    : tenantAmbiguous
    ? 'telefono_multiempresa'
    : orderAmbiguous
    ? 'pedido_ambiguo'
    : (!pid ? 'pedido_no_asociado' : null);

  // --- INSERTAR ---
  let rows;
  try {
    rows = await queryFn(
      `
    INSERT INTO comprobantes_transferencia
      (telefono, archivo_path, comprobante_path, fecha, 
       pedido_id, empresa_id, chofer_id,
       created_at, updated_at, validado, procesado,
       estado_revision, riesgo_score, riesgo_flags, verified_reason,
       source_message_id, file_hash, dedupe_file_hash, source_chat_jid, transport_origin)
    VALUES ($1, $2, $3, $4, 
            $5, $6, $7,
            NOW(), NOW(), 0, FALSE,
            'pendiente', $8, $9, $10, $11, $12, $12, $13, $14)
    RETURNING id, empresa_id, pedido_id, source_chat_jid, transport_origin
    `,
      [
        telClean, imagen_path, imagen_path, fecha, pid, eid, cid,
        pendingReason ? (ambiguous ? 100 : 70) : 0,
        pendingReason, pendingReason,
        sourceMessageId ? String(sourceMessageId) : null,
        fileHash ? String(fileHash).toLowerCase() : null,
        /^[^\s@]+@(c\.us|lid)$/i.test(String(replyJid || '').trim()) ? String(replyJid).trim() : null,
        ['general', 'company'].includes(String(transportOrigin || '').trim())
          ? String(transportOrigin).trim()
          : null,
      ],
    );
  } catch (error) {
    const isExpectedDuplicate = error?.code === '23505'
      && ['uq_ct_source_message_new', 'uq_ct_file_hash_new'].includes(error?.constraint);
    if (!isExpectedDuplicate) throw error;
    const bySource = error.constraint === 'uq_ct_source_message_new';
    const existing = await queryFn(
      `SELECT id, empresa_id, pedido_id FROM comprobantes_transferencia
       WHERE empresa_id IS NOT DISTINCT FROM $1
         AND ${bySource ? 'source_message_id = $2' : 'dedupe_file_hash = $2'}
       ORDER BY id DESC LIMIT 1`,
      [eid, bySource ? String(sourceMessageId) : String(fileHash).toLowerCase()],
    );
    return {
      duplicate: true,
      reason: bySource ? 'duplicate_source_message' : 'duplicate_file_hash',
      existing: existing[0],
    };
  }

  return {
    ...rows[0],
    pedido_monto: pedidoEncontrado.monto == null ? null : Number(pedidoEncontrado.monto),
    pedido_metodo_pago: pedidoEncontrado.metodo_pago || null,
    pedido_pago_acreditado: pedidoEncontrado.pago_acreditado === true,
    file_hash: fileHash ? String(fileHash).toLowerCase() : null,
    ambiguous,
    association_reason: pendingReason,
  };
}

// ============================================
// 3. ACTUALIZAR DATOS DEL COMPROBANTE (Post GPT)
// ============================================
export async function actualizarComprobanteDatosPg(id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;

  // Construcción dinámica del UPDATE
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
  const params = [id, ...keys.map((k) => data[k])];

  await query(
    `UPDATE comprobantes_transferencia SET ${sets}, updated_at=NOW() WHERE id=$1`,
    params
  );
}

// ============================================
// 4. MARCAR COMO PROCESADO
// ============================================
export async function marcarComprobanteComoProcesadoPg() {
  throw new ComprobanteApprovalError(
    'aprobacion_fuera_de_servicio',
    'La aprobación automática requiere aprobarComprobanteAtomicoPg',
  );
}

// ============================================
// 5. ENCOLAR MENSAJE WHATSAPP (multi-tenant)
// ============================================
export async function enqueueWppMessagePg({
  phone, message, empresaId = null,
}, transactionPool = pool) {
  return enqueueWppOutbox({ empresaId, phone, message }, transactionPool);
}

export async function enqueueCorrelatedWppMessagePg({
  phone, message, empresaId = null, transportOrigin,
}, transactionPool = pool) {
  return enqueueWppOutboxCorrelatedReply({
    empresaId,
    phone,
    message,
    transportOrigin,
  }, transactionPool);
}
