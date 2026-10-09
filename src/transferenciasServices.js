// src/transferenciasServices.js — PostgreSQL (Versión Final Completa)
import { pool, query, withTransaction as dbWithTransaction } from './db.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { enqueueWppOutbox, enqueueWppOutboxCorrelatedReply } from './wpp/enqueue.js';

const MIGRATION_START = '-- BEGIN COMPROBANTE CONCURRENCY MIGRATION';
const MIGRATION_END = '-- END COMPROBANTE CONCURRENCY MIGRATION';
const DURABLE_MIGRATION_START = '-- BEGIN COMPROBANTE DURABLE STORAGE MIGRATION';
const DURABLE_MIGRATION_END = '-- END COMPROBANTE DURABLE STORAGE MIGRATION';
const DURABLE_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const DURABLE_RECEIPT_TENANT_QUOTA_BYTES = 1024 * 1024 * 1024;
const COMPANY_SCHEMA_ADVISORY_LOCK_KEY = '5928237161131906375';
const DURABLE_RECEIPT_COLUMNS = Object.freeze([
  ['source_message_id', 'text'],
  ['dedupe_file_hash', 'text'],
  ['approval_dedupe_key', 'text'],
  ['source_chat_jid', 'text'],
  ['transport_origin', 'text'],
  ['archivo_binario', 'bytea'],
  ['archivo_mimetype', 'text'],
  ['archivo_size', 'bigint'],
  ['archivo_sha256', 'text'],
]);
const DURABLE_RECEIPT_CONSTRAINTS = Object.freeze([
  ['ck_ct_archivo_metadata_consistente', "CHECK (archivo_binario IS NULL AND archivo_mimetype IS NULL AND archivo_size IS NULL AND archivo_sha256 IS NULL OR archivo_binario IS NOT NULL AND archivo_mimetype IS NOT NULL AND archivo_size IS NOT NULL AND archivo_sha256 IS NOT NULL AND empresa_id IS NOT NULL AND empresa_id > 0)"],
  ['ck_ct_archivo_size_real', 'CHECK (archivo_binario IS NULL OR archivo_size = octet_length(archivo_binario))'],
  ['ck_ct_archivo_size_cap', 'CHECK (archivo_binario IS NULL OR archivo_size > 0 AND archivo_size <= 10485760)'],
  ['ck_ct_archivo_mimetype', "CHECK (archivo_binario IS NULL OR (archivo_mimetype = ANY (ARRAY['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text, 'image/webp'::text])))"],
  ['ck_ct_archivo_sha256', "CHECK (archivo_binario IS NULL OR archivo_sha256 ~ '^[a-f0-9]{64}$'::text)"],
]);
const DURABLE_RECEIPT_MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);

export async function readComprobanteConcurrencyMigration() {
  const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = initSql.indexOf(MIGRATION_START);
  const end = initSql.indexOf(MIGRATION_END);
  if (start < 0 || end <= start) throw new Error('Bloque de migración de comprobantes ausente en initDb.sql');
  return initSql.slice(start + MIGRATION_START.length, end).trim();
}

async function readComprobanteDurableStorageMigration() {
  const initSql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = initSql.indexOf(DURABLE_MIGRATION_START);
  const end = initSql.indexOf(DURABLE_MIGRATION_END);
  if (start < 0 || end <= start) throw new Error('Bloque durable de comprobantes ausente en initDb.sql');
  return initSql.slice(start + DURABLE_MIGRATION_START.length, end).trim();
}

function migrationWork(sql) {
  return String(sql)
    .replaceAll('\r\n', '\n')
    .replace(/^COMMIT;\s*/i, '')
    .replace(/^BEGIN;\s*/i, '')
    .replace(/^SET LOCAL search_path = public;\s*/im, '')
    .replace(/^SET LOCAL lock_timeout = '[^']+';\s*/im, '')
    .replace(/^SET LOCAL statement_timeout = '[^']+';\s*/im, '')
    .replace(/^SELECT pg_catalog\.pg_advisory_xact_lock\([^;]+;\s*/im, '')
    .replace(/^LOCK TABLE comprobantes_transferencia IN ACCESS EXCLUSIVE MODE;\s*/im, '')
    .replace(/COMMIT;\s*$/i, '')
    .trim();
}

function schemaTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function checkComprobantesTransferenciaSchemaReady(queryFn = query) {
  const expectedColumns = DURABLE_RECEIPT_COLUMNS.map(([name, typeName]) => ({ name, typeName }));
  const expectedConstraints = DURABLE_RECEIPT_CONSTRAINTS.map(([name, definition]) => ({ name, definition }));
  const expectedIndexes = [
    { name: 'uq_ct_source_message_new', key1: 'COALESCE(empresa_id, 0)', key2: 'source_message_id', predicate: 'source_message_id IS NOT NULL' },
    { name: 'uq_ct_file_hash_new', key1: 'COALESCE(empresa_id, 0)', key2: 'dedupe_file_hash', predicate: 'dedupe_file_hash IS NOT NULL' },
  ];
  const rows = await queryFn(`
    WITH expected_columns(name, type_name) AS (
      SELECT expected.name, expected."typeName"
        FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS expected(name text, "typeName" text)
    ), expected_constraints(name, definition) AS (
      SELECT * FROM pg_catalog.jsonb_to_recordset($2::jsonb) AS expected(name text, definition text)
    ), expected_indexes(name, key1, key2, predicate) AS (
      SELECT * FROM pg_catalog.jsonb_to_recordset($3::jsonb)
        AS expected(name text, key1 text, key2 text, predicate text)
    )
    SELECT
      pg_catalog.to_regclass('public.comprobantes_transferencia') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM expected_columns expected
        LEFT JOIN pg_catalog.pg_attribute attribute_row
          ON attribute_row.attrelid = pg_catalog.to_regclass('public.comprobantes_transferencia')
         AND attribute_row.attname = expected.name
         AND NOT attribute_row.attisdropped
        WHERE attribute_row.attname IS NULL
           OR pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) <> expected.type_name
      )
      AND NOT EXISTS (
        SELECT 1 FROM expected_constraints expected
        LEFT JOIN pg_catalog.pg_constraint constraint_row
          ON constraint_row.conrelid = pg_catalog.to_regclass('public.comprobantes_transferencia')
         AND constraint_row.conname = expected.name
        GROUP BY expected.name, expected.definition
        HAVING pg_catalog.count(constraint_row.oid) <> 1
          OR pg_catalog.bool_and(constraint_row.contype = 'c') IS NOT TRUE
          OR pg_catalog.bool_and(constraint_row.convalidated) IS NOT TRUE
          OR pg_catalog.bool_and(
            pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(constraint_row.oid, true), '[[:space:]]+', '', 'g')
            = pg_catalog.regexp_replace(expected.definition, '[[:space:]]+', '', 'g')
          ) IS NOT TRUE
      )
      AND NOT EXISTS (
        SELECT 1
          FROM expected_indexes expected
          LEFT JOIN pg_catalog.pg_namespace index_namespace
            ON index_namespace.nspname = 'public'
          LEFT JOIN pg_catalog.pg_class index_class
            ON index_class.relnamespace = index_namespace.oid
           AND index_class.relname = expected.name
          LEFT JOIN pg_catalog.pg_index index_row
            ON index_row.indexrelid = index_class.oid
          LEFT JOIN pg_catalog.pg_class table_class
            ON table_class.oid = index_row.indrelid
          LEFT JOIN pg_catalog.pg_namespace table_namespace
            ON table_namespace.oid = table_class.relnamespace
          LEFT JOIN pg_catalog.pg_am access_method
            ON access_method.oid = index_class.relam
         GROUP BY expected.name, expected.key1, expected.key2, expected.predicate
        HAVING pg_catalog.count(index_class.oid) <> 1
          OR pg_catalog.bool_and(index_class.relkind IN ('i', 'I')) IS NOT TRUE
          OR pg_catalog.bool_and(table_namespace.nspname = 'public'
            AND table_class.relname = 'comprobantes_transferencia') IS NOT TRUE
          OR pg_catalog.bool_and(access_method.amname = 'btree') IS NOT TRUE
          OR pg_catalog.bool_and(index_row.indisunique
            AND index_row.indisvalid AND index_row.indisready AND index_row.indislive) IS NOT TRUE
          OR pg_catalog.bool_and(index_row.indnkeyatts = 2 AND index_row.indnatts = 2) IS NOT TRUE
          OR pg_catalog.bool_and(pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = expected.key1) IS NOT TRUE
          OR pg_catalog.bool_and(pg_catalog.pg_get_indexdef(index_row.indexrelid, 2, true) = expected.key2) IS NOT TRUE
          OR pg_catalog.bool_and(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, true) = expected.predicate) IS NOT TRUE
      ) AS ready
  `, [
    JSON.stringify(expectedColumns),
    JSON.stringify(expectedConstraints),
    JSON.stringify(expectedIndexes),
  ]);
  return rows.length === 1 && rows[0]?.ready === true;
}

export async function ensureComprobantesTransferenciaSchema(capability, options = {}) {
  const suppliedPool = capability?.pool;
  const suppliedClient = capability?.client;
  if ((typeof suppliedPool?.connect !== 'function') === (typeof suppliedClient?.query !== 'function')) {
    throw new TypeError('ensureComprobantesTransferenciaSchema requiere exactamente pool o client dedicado');
  }
  const lockTimeoutMs = schemaTimeout(options.lockTimeoutMs, 30_000);
  const statementTimeoutMs = schemaTimeout(options.statementTimeoutMs, 300_000);
  const ownsClient = !!suppliedPool;
  const client = suppliedClient || await suppliedPool.connect();
  let phase = 'BEGIN';
  let releaseError;
  try {
    await client.query('BEGIN');
    phase = 'WORK';
    await client.query('SET LOCAL search_path = public');
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [COMPANY_SCHEMA_ADVISORY_LOCK_KEY]);
    await client.query('LOCK TABLE public.comprobantes_transferencia IN ACCESS EXCLUSIVE MODE');
    await client.query(migrationWork(await readComprobanteDurableStorageMigration()));
    await client.query(migrationWork(await readComprobanteConcurrencyMigration()));
    const clientQuery = async (sql, params = []) => (await client.query(sql, params)).rows || [];
    if (!await checkComprobantesTransferenciaSchemaReady(clientQuery)) {
      throw new Error('Canonical comprobantes_transferencia schema verification failed');
    }
    phase = 'COMMIT';
    await client.query('COMMIT');
  } catch (error) {
    if (phase === 'COMMIT') {
      releaseError = error;
      const outcomeUnknown = new Error('No se pudo confirmar la migración de comprobantes');
      outcomeUnknown.code = 'COMPROBANTE_SCHEMA_TRANSACTION_OUTCOME_UNKNOWN';
      outcomeUnknown.discardConnection = true;
      throw outcomeUnknown;
    }
    try {
      await client.query('ROLLBACK');
      error.schemaTransactionFinalized = true;
    } catch (rollbackError) {
      releaseError = rollbackError;
      error.discardConnection = true;
    }
    throw error;
  } finally {
    if (ownsClient) client.release(releaseError);
  }
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

function isComprobanteFinalized(row) {
  return Number(row?.validado || 0) === 1
    || row?.procesado === true
    || String(row?.estado_revision || '').toLowerCase() === 'aprobado';
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
      if (isComprobanteFinalized(comprobante)) {
        return { outcome: 'already_finalized', row: comprobante };
      }
      if (!['pendiente', 'en_revision'].includes(currentState)) {
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

const REVIEW_PATCH_COLUMNS = new Set([
  'monto', 'nro_operacion', 'banco_origen', 'banco_destino', 'alias_destino',
  'cbu_destino', 'titular_destino', 'cuenta_bancaria_id', 'cuenta_bancaria_confianza',
  'cuenta_bancaria_match_fuente', 'cuenta_bancaria_match_detalle', 'procesado',
  'validado', 'estado_revision', 'riesgo_score', 'riesgo_flags', 'verified_reason',
  'verified_at',
]);

export async function transicionarComprobanteARevisionPg(
  { id, empresaId, patch = {} },
  { withTransaction = dbWithTransaction } = {},
) {
  const comprobanteId = Number(id);
  const eid = Number(empresaId);
  const entries = Object.entries(patch);
  if (!Number.isSafeInteger(comprobanteId) || comprobanteId <= 0
      || !Number.isSafeInteger(eid) || eid <= 0 || entries.length === 0
      || entries.some(([key]) => !REVIEW_PATCH_COLUMNS.has(key))) {
    approvalFailure('datos_revision_invalidos');
  }

  return withTransaction(async txQuery => {
    const current = (await txQuery(
      `SELECT id, empresa_id, pedido_id, estado_revision, validado, procesado
         FROM comprobantes_transferencia
        WHERE id=$1 AND empresa_id=$2
        FOR UPDATE`,
      [comprobanteId, eid],
    ))[0];
    if (!current) approvalFailure('comprobante_no_encontrado');
    if (isComprobanteFinalized(current)) return { outcome: 'already_finalized', row: current };
    if (!['pendiente', 'en_revision'].includes(String(current.estado_revision || 'pendiente').toLowerCase())) {
      return { outcome: 'already_handled', row: current };
    }

    const sets = entries.map(([key], index) => `${key}=$${index + 3}`).join(', ');
    const rows = await txQuery(
      `UPDATE comprobantes_transferencia
          SET ${sets}, updated_at=NOW()
        WHERE id=$1 AND empresa_id=$2
          AND COALESCE(validado, 0)=0
          AND COALESCE(procesado, FALSE)=FALSE
          AND LOWER(COALESCE(estado_revision, 'pendiente')) IN ('pendiente', 'en_revision')
        RETURNING id, empresa_id, pedido_id, estado_revision, validado, procesado`,
      [comprobanteId, eid, ...entries.map(([, value]) => value)],
    );
    if (rows[0]) return { outcome: 'transitioned', row: rows[0] };

    const observed = (await txQuery(
      `SELECT id, empresa_id, pedido_id, estado_revision, validado, procesado
         FROM comprobantes_transferencia WHERE id=$1 AND empresa_id=$2`,
      [comprobanteId, eid],
    ))[0];
    return isComprobanteFinalized(observed)
      ? { outcome: 'already_finalized', row: observed }
      : { outcome: 'already_handled', row: observed || null };
  });
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
                               AND pe.empresa_id = p.empresa_id
        WHERE p.id = $1
          AND ($2::integer IS NULL OR p.empresa_id = $2)
          AND pe.empresa_id = p.empresa_id
        FOR UPDATE OF p, pe`,
      [pid, role === 'super' ? null : actorTenant],
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
async function insertarComprobantePgWork({
  telefono,
  replyJid = null,
  transportOrigin = null,
  imagen_path,
  fecha,
  empresaId = null,
  sourceMessageId = null,
  fileHash = null,
  archivoBinario = null,
  mimetype,
  bytes
}, queryFn = query, { transactional = false } = {}) {
  const telClean = digitsOnly(telefono) || null;
  const durableBytes = archivoBinario == null ? null : archivoBinario;
  const durableMime = durableBytes == null ? null : String(mimetype || '').trim().toLowerCase();
  const durableSize = Buffer.isBuffer(durableBytes) ? durableBytes.length : null;
  const durableHash = Buffer.isBuffer(durableBytes)
    ? createHash('sha256').update(durableBytes).digest('hex')
    : null;
  const normalizedTransportOrigin = ['general', 'company', 'cloud'].includes(String(transportOrigin || '').trim())
    ? String(transportOrigin).trim()
    : null;
  const explicitEmpresaId = Number(empresaId || 0) || null;
  if (durableBytes != null && (
    !Buffer.isBuffer(durableBytes)
    || !DURABLE_RECEIPT_MIME_TYPES.has(durableMime)
    || durableSize <= 0
    || durableSize > DURABLE_RECEIPT_MAX_BYTES
  )) approvalFailure('archivo_comprobante_invalido');
  if (normalizedTransportOrigin === 'cloud' && !explicitEmpresaId) {
    approvalFailure('empresa_comprobante_invalida');
  }
  const effectiveFileHash = durableHash || (fileHash ? String(fileHash).trim().toLowerCase() : null);

  if (durableBytes != null) {
    await queryFn('SELECT pg_catalog.pg_advisory_xact_lock($1, $2)', [1129270868, explicitEmpresaId]);
    if (sourceMessageId || effectiveFileHash) {
      const normalizedSourceMessageId = sourceMessageId ? String(sourceMessageId) : null;
      const existingRows = await queryFn(
        `SELECT id, empresa_id, pedido_id, source_message_id, dedupe_file_hash
           FROM comprobantes_transferencia
          WHERE empresa_id IS NOT DISTINCT FROM $1
            AND (($2::text IS NOT NULL AND source_message_id = $2)
              OR ($3::text IS NOT NULL AND dedupe_file_hash = $3))
          ORDER BY id
          LIMIT 2`,
        [explicitEmpresaId, normalizedSourceMessageId, effectiveFileHash],
      );
      if (existingRows.length > 1) approvalFailure('comprobante_idempotencia_conflictiva');
      if (existingRows.length === 1) {
        const existing = existingRows[0];
        const sourceMatches = normalizedSourceMessageId != null
          && existing.source_message_id === normalizedSourceMessageId;
        const hashMatches = effectiveFileHash != null
          && existing.dedupe_file_hash === effectiveFileHash;
        const exactReplay = normalizedSourceMessageId != null && effectiveFileHash != null
          ? sourceMatches && hashMatches
          : sourceMatches || hashMatches;
        if (!exactReplay) approvalFailure('comprobante_idempotencia_conflictiva');
        return {
          duplicate: true,
          reason: sourceMatches ? 'duplicate_source_message' : 'duplicate_file_hash',
          existing,
        };
      }
    }
    const quotaRows = await queryFn(
      `SELECT COALESCE(SUM(archivo_size), 0)::BIGINT AS durable_bytes
         FROM comprobantes_transferencia
        WHERE empresa_id = $1
          AND archivo_binario IS NOT NULL`,
      [explicitEmpresaId],
    );
    const usedBytes = Number(quotaRows[0]?.durable_bytes || 0);
    if (!Number.isSafeInteger(usedBytes)
        || usedBytes < 0
        || usedBytes + durableSize > DURABLE_RECEIPT_TENANT_QUOTA_BYTES) {
      approvalFailure('cuota_comprobantes_durables_excedida');
    }
  }
  // Usamos los últimos 10 dígitos para mejorar el "match" (evita problemas con 549 vs 0)
  const telSuffix = telClean ? telClean.slice(-10) : null;

  // --- LÓGICA DE VINCULACIÓN ---
  // Buscamos el último pedido asociado a este teléfono.
  // Prioridad: El más reciente (ORDER BY id DESC).
  // Estados: Incluimos 'entregado' para clientes que pagan post-entrega.
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
                          AND pe.empresa_id = p.empresa_id
    WHERE 
      pe.telefono_normalizado LIKE '%' || $1
      AND p.empresa_id = $2
      AND pe.empresa_id = p.empresa_id
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
                          AND pe.empresa_id = p.empresa_id
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
  let pedidoEncontrado = ambiguous ? {} : (eligibleMatches[0] || {});

  if (pedidoEncontrado.pedido_id) {
    const lockedMatches = await queryFn(
      `SELECT p.id AS pedido_id, p.empresa_id, p.chofer_id, p.monto, p.metodo_pago,
              EXISTS (SELECT 1 FROM pedido_pagos pp
                       WHERE pp.pedido_id = p.id AND pp.empresa_id = p.empresa_id
                         AND (pp.settlement_at IS NOT NULL
                           OR LOWER(COALESCE(pp.estado, '')) IN ('pagado','aprobado','acreditado'))) AS pago_acreditado
         FROM pedidos p
         JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id
                               AND pe.empresa_id = p.empresa_id
        WHERE p.id = $1
          AND p.empresa_id = $2
          AND pe.empresa_id = $2
          AND pe.telefono_normalizado LIKE '%' || $3
          AND LOWER(COALESCE(p.metodo_pago, '')) = 'transferencia'
          AND p.estado IN ('pendiente', 'en_ruta', 'en_camino', 'entregado')
          AND NOT EXISTS (SELECT 1 FROM pedido_pagos paid
                           WHERE paid.pedido_id = p.id AND paid.empresa_id = p.empresa_id
                             AND (paid.settlement_at IS NOT NULL
                               OR LOWER(COALESCE(paid.estado, '')) IN ('pagado','aprobado','acreditado')))
          AND NOT EXISTS (SELECT 1 FROM comprobante_pedido_aprobado_claims claim
                           WHERE claim.tenant_key = p.empresa_id AND claim.pedido_id = p.id)
        FOR UPDATE OF p, pe`,
      [Number(pedidoEncontrado.pedido_id), Number(pedidoEncontrado.empresa_id), telSuffix]
    );
    pedidoEncontrado = lockedMatches.length === 1 ? lockedMatches[0] : {};
  }

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
  if (transactional) await queryFn('SAVEPOINT comprobante_insert');
  try {
    rows = await queryFn(
      `
    INSERT INTO comprobantes_transferencia
      (telefono, archivo_path, comprobante_path, fecha, 
       pedido_id, empresa_id, chofer_id,
       created_at, updated_at, validado, procesado,
       estado_revision, riesgo_score, riesgo_flags, verified_reason,
       source_message_id, file_hash, dedupe_file_hash, source_chat_jid, transport_origin,
       archivo_binario, archivo_mimetype, archivo_size, archivo_sha256)
    VALUES ($1, $2, $3, $4, 
            $5, $6, $7,
            NOW(), NOW(), 0, FALSE,
            'pendiente', $8, $9, $10, $11, $12, $12, $13, $14,
            $15, $16, $17, $18)
    RETURNING id, empresa_id, pedido_id, source_chat_jid, transport_origin
    `,
      [
        telClean, imagen_path, imagen_path, fecha, pid, eid, cid,
        pendingReason ? (ambiguous ? 100 : 70) : 0,
        pendingReason, pendingReason,
        sourceMessageId ? String(sourceMessageId) : null,
        effectiveFileHash,
        /^[^\s@]+@(c\.us|lid)$/i.test(String(replyJid || '').trim()) ? String(replyJid).trim() : null,
        normalizedTransportOrigin,
        durableBytes,
        durableMime,
        durableSize,
        durableHash,
      ],
    );
  } catch (error) {
    const isExpectedDuplicate = error?.code === '23505'
      && ['uq_ct_source_message_new', 'uq_ct_file_hash_new'].includes(error?.constraint);
    if (!isExpectedDuplicate) throw error;
    if (transactional) await queryFn('ROLLBACK TO SAVEPOINT comprobante_insert');
    const existingRows = await queryFn(
      `SELECT id, empresa_id, pedido_id, source_message_id, dedupe_file_hash
         FROM comprobantes_transferencia
        WHERE empresa_id IS NOT DISTINCT FROM $1
          AND (($2::text IS NOT NULL AND source_message_id = $2)
            OR ($3::text IS NOT NULL AND dedupe_file_hash = $3))
        ORDER BY id
        LIMIT 2`,
      [eid, sourceMessageId ? String(sourceMessageId) : null, effectiveFileHash],
    );
    if (existingRows.length !== 1) approvalFailure('comprobante_idempotencia_conflictiva');
    const existing = existingRows[0];
    const sourceMatches = sourceMessageId != null
      && existing.source_message_id === String(sourceMessageId);
    const hashMatches = effectiveFileHash != null
      && existing.dedupe_file_hash === effectiveFileHash;
    const exactReplay = sourceMessageId != null && effectiveFileHash != null
      ? sourceMatches && hashMatches
      : sourceMatches || hashMatches;
    if (!exactReplay) approvalFailure('comprobante_idempotencia_conflictiva');
    return {
      duplicate: true,
      reason: sourceMatches ? 'duplicate_source_message' : 'duplicate_file_hash',
      existing,
    };
  }
  if (rows.length !== 1) throw new Error('No se pudo insertar exactamente un comprobante');

  return {
    ...rows[0],
    pedido_monto: pedidoEncontrado.monto == null ? null : Number(pedidoEncontrado.monto),
    pedido_metodo_pago: pedidoEncontrado.metodo_pago || null,
    pedido_pago_acreditado: pedidoEncontrado.pago_acreditado === true,
    file_hash: effectiveFileHash,
    ambiguous,
    association_reason: pendingReason,
  };
}

export async function insertarComprobantePg(input, queryFn = query, {
  withTransaction = null,
} = {}) {
  const transaction = withTransaction
    || (queryFn === query ? dbWithTransaction : null);
  if (!transaction) return insertarComprobantePgWork(input, queryFn);
  return transaction(txQuery => insertarComprobantePgWork(input, txQuery, { transactional: true }));
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
  phone, message, empresaId = null, transportOrigin, correlationId = null,
}, transactionPool = pool) {
  return enqueueWppOutboxCorrelatedReply({
    empresaId,
    phone,
    message,
    transportOrigin,
    correlationId,
  }, transactionPool);
}
