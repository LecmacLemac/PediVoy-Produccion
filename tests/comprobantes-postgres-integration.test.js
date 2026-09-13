import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { aprobarComprobanteAtomicoPg } from '../src/transferenciasServices.js';
import { withTransaction } from '../src/db.js';

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const pgUrl = process.env.PG_TEST_URL;
const migrationStart = '-- BEGIN COMPROBANTE CONCURRENCY MIGRATION';
const migrationEnd = '-- END COMPROBANTE CONCURRENCY MIGRATION';

async function migrationSql() {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = sql.indexOf(migrationStart);
  const end = sql.indexOf(migrationEnd);
  assert.ok(start >= 0 && end > start, 'initDb.sql debe exponer el bloque de migración concurrente');
  return sql.slice(start + migrationStart.length, end);
}

test('migración declara claims persistentes y triggers de comprobantes/pagos', async () => {
  const sql = await migrationSql();
  assert.match(sql, /CREATE OR REPLACE FUNCTION normalizar_comprobante_operacion/i);
  assert.match(sql, /PRIMARY KEY \(tenant_key, operacion_key\)/i);
  assert.match(sql, /LOCK TABLE comprobantes_transferencia/i);
  assert.match(sql, /ERRCODE\s*=\s*'23505'/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF nro_operacion, empresa_id/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON pedido_pagos/i);
  assert.match(sql, /FOR UPDATE/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION validar_aprobacion_comprobante/i);
  assert.match(sql, /claim\.comprobante_id\s*=\s*NEW\.id/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE\s+ON comprobantes_transferencia/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS comprobante_pedido_aprobado_claims/i);
  assert.match(sql, /PRIMARY KEY \(tenant_key, pedido_id\)/i);
  assert.match(sql, /CONSTRAINT\s*=\s*'ct_one_approved_per_order'/i);
  assert.match(sql, /COALESCE\(NEW\.procesado, FALSE\)\s*=\s*TRUE/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION serializar_pedido_pago_con_comprobante\(\)[\s\S]*COALESCE\(ct\.procesado, FALSE\)\s*=\s*TRUE/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE\s+ON comprobantes_transferencia/i);
  assert.doesNotMatch(sql, /IF NOT new_approved OR old_approved THEN/i);
  assert.doesNotMatch(sql, /OLD\.(?:estado_revision|validado|procesado)[\s\S]{0,300}RETURN NEW/i);
});

test('bloque de migración ejecutable envuelve lock, seed y triggers en transacción explícita', async () => {
  const sql = (await migrationSql()).trim();
  assert.match(sql, /^BEGIN;/i);
  assert.match(sql, /COMMIT;$/i);
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('LOCK TABLE comprobantes_transferencia'));
  assert.ok(sql.indexOf('COMMIT;') > sql.indexOf('CREATE TRIGGER trg_serializar_pedido_pago_comprobante'));
});

test('PostgreSQL real: migración, claims y exclusión pago/aprobación', { skip: !pgUrl && 'PG_TEST_URL no configurado; test MVCC omitido explícitamente' }, async (t) => {
  const admin = new Pool({ connectionString: pgUrl, max: 8 });
  const schema = `ct_claims_${process.pid}_${Date.now()}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: pgUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`
      CREATE TABLE empresas (id integer PRIMARY KEY);
      CREATE TABLE pedidos (
        id integer PRIMARY KEY, empresa_id integer NOT NULL,
        monto numeric(12,2), metodo_pago text
      );
      CREATE TABLE empresa_cuentas_bancarias (
        id integer PRIMARY KEY, empresa_id integer NOT NULL, activa boolean,
        banco text, alias text, cbu text, titular text
      );
      CREATE TABLE comprobantes_transferencia (
        id bigserial PRIMARY KEY, empresa_id integer, pedido_id integer,
        nro_operacion text, approval_dedupe_key text, monto numeric(12,2),
        banco_origen text, banco_destino text, alias_destino text,
        cbu_destino text, titular_destino text, cuenta_bancaria_id integer,
        cuenta_bancaria_confianza integer, cuenta_bancaria_match_fuente text,
        cuenta_bancaria_match_detalle text, procesado boolean DEFAULT false,
        fecha_procesado timestamptz, validado integer DEFAULT 0,
        estado_revision text DEFAULT 'pendiente', riesgo_score integer DEFAULT 0,
        riesgo_flags text, verified_reason text, verified_at timestamptz,
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE pedido_pagos (
        id bigserial PRIMARY KEY, empresa_id integer NOT NULL, pedido_id integer NOT NULL,
        estado text NOT NULL DEFAULT 'pendiente', settlement_at timestamptz,
        proveedor text NOT NULL DEFAULT 'test', monto numeric(12,2) NOT NULL DEFAULT 1,
        notas text
      );
      INSERT INTO empresas VALUES (1), (2);
      INSERT INTO pedidos VALUES
        (10, 1, 100.00, 'transferencia'),
        (20, 2, 100.00, 'transferencia'),
        (30, 1, 100.00, 'transferencia'),
        (40, 1, 100.00, 'transferencia'),
        (41, 1, 100.00, 'transferencia'),
        (42, 1, 100.00, 'transferencia'),
        (43, 1, 100.00, 'transferencia'),
        (44, 1, 100.00, 'transferencia'),
        (45, 1, 100.00, 'transferencia'),
        (46, 1, 100.00, 'transferencia'),
        (47, 1, 100.00, 'transferencia'),
        (48, 1, 100.00, 'transferencia');
      INSERT INTO empresa_cuentas_bancarias VALUES
        (11, 1, true, 'Banco', 'destino.uno', '123', 'Empresa Uno'),
        (22, 2, true, 'Banco', 'destino.dos', '456', 'Empresa Dos'),
        (33, 1, true, 'Banco', 'destino.tres', '789', 'Empresa Tres');
      INSERT INTO comprobantes_transferencia (id, empresa_id, pedido_id, nro_operacion)
      VALUES (1, 1, 10, ' Legacy-OP '), (2, 1, 10, 'legacy-op');
      INSERT INTO comprobantes_transferencia
        (id, empresa_id, pedido_id, nro_operacion, validado, procesado, estado_revision)
      VALUES
        (3, 1, 46, 'legacy-approved-a', 1, false, 'pendiente'),
        (4, 1, 46, 'legacy-approved-b', 0, true, 'pendiente');
      SELECT setval(pg_get_serial_sequence('comprobantes_transferencia', 'id'), 4, true);
    `);

    const migration = await migrationSql();
    const migrationDir = await mkdtemp(path.join(tmpdir(), 'ct-psql-'));
    const migrationFile = path.join(migrationDir, 'migration.sql');
    try {
      await writeFile(migrationFile, migration);
      await execFileAsync('psql', [pgUrl, '-X', '-v', 'ON_ERROR_STOP=1',
        '-c', `SET search_path TO ${schema}`, '-f', migrationFile]);
    } finally {
      await rm(migrationDir, { recursive: true, force: true });
    }
    await pool.query(migration);

    const seeded = await pool.query(`SELECT * FROM comprobante_operacion_claims WHERE tenant_key=1 AND operacion_key='legacy-op'`);
    assert.equal(seeded.rowCount, 1);
    assert.equal(Number(seeded.rows[0].comprobante_id), 1);
    const legacyOrderClaim = await pool.query(`
      SELECT comprobante_id FROM comprobante_pedido_aprobado_claims
      WHERE tenant_key=1 AND pedido_id=46
    `);
    assert.equal(Number(legacyOrderClaim.rows[0].comprobante_id), 3);
    const legacyApprovalState = await pool.query(`
      SELECT id, validado, procesado, estado_revision, riesgo_flags
      FROM comprobantes_transferencia WHERE id IN (3,4) ORDER BY id
    `);
    assert.equal(Number(legacyApprovalState.rows[0].validado), 1);
    assert.equal(Number(legacyApprovalState.rows[1].validado), 0);
    assert.equal(legacyApprovalState.rows[1].procesado, false);
    assert.equal(legacyApprovalState.rows[1].estado_revision, 'en_revision');
    assert.match(legacyApprovalState.rows[1].riesgo_flags, /legacy_aprobado_no_canonico/);
    await pool.query(`UPDATE comprobantes_transferencia SET nro_operacion=nro_operacion WHERE id IN (1,2)`);
    await assert.rejects(
      pool.query(`UPDATE comprobantes_transferencia SET estado_revision='aprobado', validado=1 WHERE id=2`),
      error => error?.code === '23505',
    );

    const concurrentInserts = await Promise.allSettled([
      pool.query(`INSERT INTO comprobantes_transferencia (empresa_id,pedido_id,nro_operacion) VALUES (1,10,'insert-race')`),
      pool.query(`INSERT INTO comprobantes_transferencia (empresa_id,pedido_id,nro_operacion) VALUES (1,10,' INSERT-RACE ')`),
    ]);
    assert.equal(concurrentInserts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentInserts.filter(result => result.status === 'rejected' && result.reason?.code === '23505').length, 1);

    const inserted = await pool.query(`
      INSERT INTO comprobantes_transferencia (empresa_id,pedido_id)
      VALUES (1,10),(1,10),(2,20),(1,10),(1,10) RETURNING id
    `);
    const [a, b, otherTenant, rollbackA, rollbackB] = inserted.rows.map(row => Number(row.id));

    const sameTenant = await Promise.allSettled([
      pool.query(`UPDATE comprobantes_transferencia SET nro_operacion=' Race-OP ' WHERE id=$1`, [a]),
      pool.query(`UPDATE comprobantes_transferencia SET nro_operacion='race-op' WHERE id=$1`, [b]),
    ]);
    assert.equal(sameTenant.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(sameTenant.filter(result => result.status === 'rejected' && result.reason?.code === '23505').length, 1);
    const raceOwner = await pool.query(`
      SELECT comprobante_id FROM comprobante_operacion_claims
       WHERE tenant_key=1 AND operacion_key='race-op'
    `);

    await pool.query(`UPDATE comprobantes_transferencia SET nro_operacion='race-op' WHERE id=$1`, [otherTenant]);

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await rollbackClient.query(`UPDATE comprobantes_transferencia SET nro_operacion='rollback-op' WHERE id=$1`, [rollbackA]);
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }
    await pool.query(`UPDATE comprobantes_transferencia SET nro_operacion='rollback-op' WHERE id=$1`, [rollbackB]);
    await pool.query(`DELETE FROM comprobantes_transferencia WHERE id=$1`, [rollbackB]);
    await assert.rejects(
      pool.query(`UPDATE comprobantes_transferencia SET nro_operacion='rollback-op' WHERE id=$1`, [rollbackA]),
      error => error?.code === '23505',
    );

    const newReceipt = async (pedidoId = 10) => {
      const result = await pool.query(
        `INSERT INTO comprobantes_transferencia (empresa_id,pedido_id) VALUES (1,$1) RETURNING id`,
        [pedidoId],
      );
      return Number(result.rows[0].id);
    };
    const approvalPayload = (id, operation, overrides = {}) => ({
      id,
      empresaId: 1,
      nroOperacion: operation,
      patch: {
        monto: 100,
        cuenta_bancaria_id: 11,
        alias_destino: 'destino.uno',
        ...overrides,
      },
    });
    const approveAfterReceiptLock = (payload) => {
      let releaseSignal;
      const receiptLocked = new Promise(resolve => { releaseSignal = resolve; });
      const approval = aprobarComprobanteAtomicoPg(payload, {
        withTransaction: work => withTransaction(
          txQuery => work(async (sql, params) => {
            const rows = await txQuery(sql, params);
            if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) releaseSignal();
            return rows;
          }),
          { pool, maxRetries: 0 },
        ),
      });
      return { approval, receiptLocked };
    };

    for (const race of [
      { code: 'monto_no_coincide', column: 'monto', changed: 100.02, restore: 100 },
      { code: 'metodo_pago_no_transferencia', column: 'metodo_pago', changed: 'efectivo', restore: 'transferencia' },
    ]) {
      const receiptId = await newReceipt();
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT id FROM pedidos WHERE id=10 FOR UPDATE`);
        await blocker.query(`UPDATE pedidos SET ${race.column}=$1 WHERE id=10`, [race.changed]);
        const { approval, receiptLocked } = approveAfterReceiptLock(approvalPayload(receiptId, `race-${race.column}`));
        await receiptLocked;
        await blocker.query('COMMIT');
        await assert.rejects(approval, error => error?.code === race.code);
      } finally {
        try { await blocker.query('ROLLBACK'); } catch {}
        blocker.release();
      }
      await pool.query(`UPDATE pedidos SET ${race.column}=$1 WHERE id=10`, [race.restore]);
    }

    const accountReceipt = await newReceipt();
    const accountBlocker = await pool.connect();
    try {
      await accountBlocker.query('BEGIN');
      await accountBlocker.query(`UPDATE empresa_cuentas_bancarias SET activa=false WHERE id=11`);
      const { approval, receiptLocked } = approveAfterReceiptLock(approvalPayload(accountReceipt, 'race-account'));
      await receiptLocked;
      await accountBlocker.query('COMMIT');
      await assert.rejects(approval, error => error?.code === 'cuenta_destino_no_verificada');
    } finally {
      try { await accountBlocker.query('ROLLBACK'); } catch {}
      accountBlocker.release();
    }
    await pool.query(`UPDATE empresa_cuentas_bancarias SET activa=true WHERE id=11`);

    const paymentReceipt = await newReceipt();
    const paymentBlocker = await pool.connect();
    try {
      await paymentBlocker.query('BEGIN');
      await paymentBlocker.query(`SELECT id FROM pedidos WHERE id=10 FOR UPDATE`);
      await paymentBlocker.query(`INSERT INTO pedido_pagos (empresa_id,pedido_id,estado) VALUES (1,10,'pagado')`);
      const { approval, receiptLocked } = approveAfterReceiptLock(approvalPayload(paymentReceipt, 'race-payment'));
      await receiptLocked;
      await paymentBlocker.query('COMMIT');
      await assert.rejects(approval, error => error?.code === 'pago_ya_acreditado');
    } finally {
      try { await paymentBlocker.query('ROLLBACK'); } catch {}
      paymentBlocker.release();
    }
    await pool.query(`DELETE FROM pedido_pagos WHERE pedido_id=10`);

    const winningReceipt = await newReceipt(30);
    await aprobarComprobanteAtomicoPg(approvalPayload(winningReceipt, 'approval-wins', {
      cuenta_bancaria_id: 33,
      alias_destino: 'destino.tres',
    }), { withTransaction: work => withTransaction(work, { pool }) });
    await assert.rejects(
      pool.query(`INSERT INTO pedido_pagos (empresa_id,pedido_id,estado) VALUES (1,30,'pagado')`),
      error => error?.code === '23514',
    );

    await pool.query(`UPDATE comprobantes_transferencia SET estado_revision='aprobado', validado=1 WHERE id=$1`, [Number(raceOwner.rows[0].comprobante_id)]);
    await pool.query(`INSERT INTO pedido_pagos (empresa_id,pedido_id,estado) VALUES (1,10,'pendiente')`);
    await pool.query(`UPDATE pedido_pagos SET notas='sin acreditar' WHERE pedido_id=10`);
    await assert.rejects(
      pool.query(`UPDATE pedido_pagos SET estado='pagado' WHERE pedido_id=10`),
      error => error?.code === '23514',
    );
    await pool.query(`DELETE FROM pedido_pagos WHERE pedido_id=10`);

    const insertPendingReceipt = async (pedidoId, operation, empresaId = 1) => {
      const result = await pool.query(`
        INSERT INTO comprobantes_transferencia (empresa_id,pedido_id,nro_operacion)
        VALUES ($1,$2,$3) RETURNING id
      `, [empresaId, pedidoId, operation]);
      return Number(result.rows[0].id);
    };
    const expectOrderOwnerConflict = promise => assert.rejects(
      promise,
      error => error?.code === '23505' && error?.constraint === 'ct_one_approved_per_order',
    );

    for (const [pedidoId, representation, value] of [
      [40, 'validado', '1'],
      [41, 'procesado', 'TRUE'],
      [42, 'estado_revision', "'aprobado'"],
    ]) {
      const owner = await insertPendingReceipt(pedidoId, `owner-${representation}`);
      const competitor = await insertPendingReceipt(pedidoId, `competitor-${representation}`);
      await pool.query(`UPDATE comprobantes_transferencia SET ${representation}=${value} WHERE id=$1`, [owner]);
      await expectOrderOwnerConflict(
        pool.query(`UPDATE comprobantes_transferencia SET ${representation}=${value} WHERE id=$1`, [competitor]),
      );
      // Incluso una escritura que no cambia flags debe revalidar al aprobado no propietario.
      await pool.query(`UPDATE comprobantes_transferencia SET riesgo_score=riesgo_score WHERE id=$1`, [owner]);
    }

    const deletedOwner = await insertPendingReceipt(43, 'deleted-owner');
    await pool.query(`UPDATE comprobantes_transferencia SET validado=1 WHERE id=$1`, [deletedOwner]);
    await pool.query(`DELETE FROM comprobantes_transferencia WHERE id=$1`, [deletedOwner]);
    const afterDelete = await insertPendingReceipt(43, 'after-delete');
    await expectOrderOwnerConflict(
      pool.query(`UPDATE comprobantes_transferencia SET procesado=TRUE WHERE id=$1`, [afterDelete]),
    );

    const downgradedOwner = await insertPendingReceipt(44, 'downgraded-owner');
    await pool.query(`UPDATE comprobantes_transferencia SET estado_revision='aprobado' WHERE id=$1`, [downgradedOwner]);
    await pool.query(`UPDATE comprobantes_transferencia
      SET estado_revision='pendiente', validado=0, procesado=FALSE WHERE id=$1`, [downgradedOwner]);
    const afterDowngrade = await insertPendingReceipt(44, 'after-downgrade');
    await expectOrderOwnerConflict(
      pool.query(`UPDATE comprobantes_transferencia SET validado=1 WHERE id=$1`, [afterDowngrade]),
    );

    const rollbackOwner = await insertPendingReceipt(45, 'rollback-owner');
    const rollbackApproval = await pool.connect();
    try {
      await rollbackApproval.query('BEGIN');
      await rollbackApproval.query(`UPDATE comprobantes_transferencia SET procesado=TRUE WHERE id=$1`, [rollbackOwner]);
      await rollbackApproval.query('ROLLBACK');
    } finally {
      rollbackApproval.release();
    }
    const rollbackWinner = await insertPendingReceipt(45, 'rollback-winner');
    await pool.query(`UPDATE comprobantes_transferencia SET validado=1 WHERE id=$1`, [rollbackWinner]);

    const raceA = await insertPendingReceipt(47, 'order-race-a');
    const raceB = await insertPendingReceipt(47, 'order-race-b');
    const approvalRace = await Promise.allSettled([
      pool.query(`UPDATE comprobantes_transferencia SET validado=1 WHERE id=$1`, [raceA]),
      pool.query(`UPDATE comprobantes_transferencia SET procesado=TRUE WHERE id=$1`, [raceB]),
    ]);
    assert.equal(approvalRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(approvalRace.filter(result => result.status === 'rejected'
      && result.reason?.code === '23505'
      && result.reason?.constraint === 'ct_one_approved_per_order').length, 1);

    const tenantMismatch = await insertPendingReceipt(48, 'tenant-mismatch', 2);
    await assert.rejects(
      pool.query(`UPDATE comprobantes_transferencia SET estado_revision='aprobado' WHERE id=$1`, [tenantMismatch]),
      error => error?.code === '23514' && error?.constraint === 'ct_approved_order_tenant',
    );
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
