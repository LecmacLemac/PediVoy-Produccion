import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  asociarComprobanteAutomaticamentePorMontoPg,
  insertarComprobantePg,
} from '../src/transferenciasServices.js';
import { procesarArchivoTransferenciaPg } from '../src/transferenciasPipeline.js';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE empresas (id INTEGER PRIMARY KEY);
    CREATE TABLE puntos_entrega (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      telefono_normalizado TEXT
    );
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER NOT NULL,
      punto_entrega_id INTEGER NOT NULL,
      chofer_id INTEGER,
      zona_id INTEGER,
      monto NUMERIC(10,2),
      metodo_pago TEXT,
      estado TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE pedido_pagos (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      estado TEXT,
      settlement_at TIMESTAMPTZ
    );
    CREATE TABLE comprobante_pedido_aprobado_claims (
      tenant_key BIGINT NOT NULL,
      pedido_id BIGINT NOT NULL,
      comprobante_id BIGINT,
      PRIMARY KEY (tenant_key, pedido_id)
    );
    CREATE TABLE wpp_outbox (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER,
      transport_origin TEXT,
      cloud_template_key TEXT,
      notification_correlation_id TEXT,
      meta_message_id TEXT
    );
    CREATE TABLE comprobantes_transferencia (
      id SERIAL PRIMARY KEY,
      telefono TEXT,
      archivo_path TEXT,
      comprobante_path TEXT,
      fecha TIMESTAMPTZ,
      pedido_id INTEGER,
      empresa_id INTEGER,
      chofer_id INTEGER,
      zona_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      validado INTEGER DEFAULT 0,
      procesado BOOLEAN DEFAULT FALSE,
      estado_revision TEXT DEFAULT 'pendiente',
      riesgo_score INTEGER DEFAULT 0,
      riesgo_flags TEXT,
      verified_reason TEXT,
      source_message_id TEXT,
      file_hash TEXT,
      dedupe_file_hash TEXT,
      source_chat_jid TEXT,
      transport_origin TEXT,
      archivo_binario BYTEA,
      archivo_mimetype TEXT,
      archivo_size BIGINT,
      archivo_sha256 TEXT,
      monto NUMERIC(10,2)
    );
  `);
  await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
}

async function installCanonicalPaymentTrigger(pool) {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.serializar_pedido_pago_con_comprobante()');
  const triggerEnd = 'FOR EACH ROW EXECUTE FUNCTION public.serializar_pedido_pago_con_comprobante();';
  const end = sql.indexOf(triggerEnd, start);
  assert.ok(start >= 0 && end > start, 'trigger canónico de pedido_pagos no encontrado');
  await pool.query(sql.slice(start, end + triggerEnd.length));
}

function transactionFor(pool, { onBackendPid = null } = {}) {
  return async work => {
    const client = await pool.connect();
    try {
      if (onBackendPid) {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        onBackendPid(pid);
      }
      await client.query('BEGIN');
      const query = async (sql, params = []) => (await client.query(sql, params)).rows;
      const result = await work(query);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function waitUntilBlocked(pool, backendPid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const blocked = (await pool.query(`
      SELECT pg_catalog.CARDINALITY(pg_catalog.pg_blocking_pids($1)) > 0 AS blocked
    `, [backendPid])).rows[0]?.blocked;
    if (blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`backend ${backendPid} no llegó al lock esperado`);
}

async function seedOrder(pool, {
  id, empresaId = 1, phone = '5493515550001', amount = 1500,
  createdAt = new Date(), method = 'transferencia', status = 'pendiente',
} = {}) {
  const pointId = id + 1000;
  await pool.query(
    'INSERT INTO puntos_entrega(id, empresa_id, telefono_normalizado) VALUES ($1,$2,$3)',
    [pointId, empresaId, phone],
  );
  await pool.query(`
    INSERT INTO pedidos(id, empresa_id, punto_entrega_id, monto, metodo_pago, estado, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [id, empresaId, pointId, amount, method, status, createdAt]);
}

async function seedReceipt(pool, { phone, amount }) {
  return (await pool.query(`
    INSERT INTO comprobantes_transferencia
      (empresa_id, telefono, estado_revision, validado, procesado, monto)
    VALUES (1, $1, 'pendiente', 0, FALSE, $2)
    RETURNING id
  `, [phone, amount])).rows[0];
}

const cardinalityWriterScenarios = [
  {
    name: 'INSERT concurrente de un segundo pedido',
    seed: async () => {},
    mutate: async client => {
      await client.query(`
        INSERT INTO puntos_entrega(id, empresa_id, telefono_normalizado)
        VALUES (2202, 1, '5493515552200')
      `);
      await client.query(`
        INSERT INTO pedidos(id, empresa_id, punto_entrega_id, monto, metodo_pago, estado, created_at)
        VALUES (1202, 1, 2202, 12200, 'transferencia', 'pendiente', NOW())
      `);
    },
  },
  {
    name: 'UPDATE de monto vuelve elegible un pedido existente',
    seed: pool => seedOrder(pool, { id: 1202, phone: '5493515552200', amount: 1 }),
    mutate: client => client.query('UPDATE pedidos SET monto = 12200 WHERE id = 1202'),
  },
  {
    name: 'UPDATE de metodo_pago vuelve elegible un pedido existente',
    seed: pool => seedOrder(pool, { id: 1202, phone: '5493515552200', amount: 12200, method: 'efectivo' }),
    mutate: client => client.query("UPDATE pedidos SET metodo_pago = 'transferencia' WHERE id = 1202"),
  },
  {
    name: 'UPDATE de estado vuelve elegible un pedido existente',
    seed: pool => seedOrder(pool, { id: 1202, phone: '5493515552200', amount: 12200, status: 'cancelado' }),
    mutate: client => client.query("UPDATE pedidos SET estado = 'pendiente' WHERE id = 1202"),
  },
  {
    name: 'UPDATE del teléfono del punto vuelve elegible un pedido existente',
    seed: pool => seedOrder(pool, { id: 1202, phone: '5493515559999', amount: 12200 }),
    mutate: client => client.query(`
      UPDATE puntos_entrega SET telefono_normalizado = '5493515552200' WHERE id = 2202
    `),
  },
  {
    name: 'UPDATE de created_at cruza la ventana y vuelve elegible un pedido existente',
    seed: pool => seedOrder(pool, {
      id: 1202, phone: '5493515552200', amount: 12200,
      createdAt: new Date(Date.now() - 8 * 86400000),
    }),
    mutate: client => client.query('UPDATE pedidos SET created_at = NOW() WHERE id = 1202'),
  },
];

test('PostgreSQL real: context.id exacto vincula el pedido correlacionado sin usar históricos del teléfono', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    for (let id = 1; id <= 5; id += 1) {
      await seedOrder(pool, { id, amount: 100 + id, createdAt: new Date(Date.now() - id * 86400000) });
    }
    await seedOrder(pool, { id: 42, amount: 1500 });
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, transport_origin, cloud_template_key, notification_correlation_id, meta_message_id)
      VALUES (1, 'cloud', 'transfer_payment', 'transfer_payment:42', 'wamid.transfer-payment-42')
    `);

    const result = await insertarComprobantePg({
      telefono: '5493515550001',
      imagen_path: '/Transferencia/context.jpg',
      fecha: new Date(),
      empresaId: 1,
      transportOrigin: 'cloud',
      sourceMessageId: 'wamid.receipt-context-42',
      contextMessageId: 'wamid.transfer-payment-42',
      fileHash: 'a'.repeat(64),
    }, undefined, { withTransaction: transactionFor(pool) });

    assert.equal(result.pedido_id, 42);
    assert.equal(result.empresa_id, 1);
    assert.equal(result.pedido_monto, 1500);
    const receipt = (await pool.query(`
      SELECT pedido_id, validado, procesado, estado_revision
        FROM comprobantes_transferencia WHERE id = $1
    `, [result.id])).rows[0];
    assert.deepEqual(receipt, {
      pedido_id: 42,
      validado: 0,
      procesado: false,
      estado_revision: 'pendiente',
    });
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM pedido_pagos')).rows[0].total, 0);
  });
});

test('PostgreSQL real: correlación exacta inválida falla cerrado por tenant, cardinalidad, template y pedido', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 61, empresaId: 1, amount: 6100 });
    await seedOrder(pool, { id: 62, empresaId: 2, amount: 6200 });
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, transport_origin, cloud_template_key, notification_correlation_id, meta_message_id)
      VALUES
        (2, 'cloud', 'transfer_payment', 'transfer_payment:62', 'wamid.cross-tenant'),
        (1, 'cloud', 'order_en_route', 'order_en_route:61', 'wamid.wrong-template'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:61', 'wamid.ambiguous-outbox'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:61', 'wamid.ambiguous-outbox'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:999', 'wamid.missing-order')
    `);

    for (const contextMessageId of [
      'wamid.cross-tenant', 'wamid.wrong-template', 'wamid.ambiguous-outbox', 'wamid.missing-order',
    ]) {
      const result = await insertarComprobantePg({
        telefono: '5493515550001', imagen_path: `/Transferencia/${contextMessageId}.jpg`,
        fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
        sourceMessageId: `wamid.receipt-${contextMessageId}`, contextMessageId,
        fileHash: contextMessageId.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
      }, undefined, { withTransaction: transactionFor(pool) });
      assert.equal(result.pedido_id, null, contextMessageId);
      assert.equal(result.association_method, null, contextMessageId);
    }
  });
});

test('pipeline Cloud: context.id presente nunca degrada a fallback por teléfono/monto', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 500, empresaId: 1, amount: 7650, phone: '5493515550500' });
    await seedOrder(pool, { id: 501, empresaId: 1, amount: 7650, phone: '5493515550501', method: 'efectivo' });
    await seedOrder(pool, { id: 502, empresaId: 1, amount: 7650, phone: '5493515550502', status: 'cancelado' });
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, transport_origin, cloud_template_key, notification_correlation_id, meta_message_id)
      VALUES
        (2, 'cloud', 'transfer_payment', 'transfer_payment:500', 'wamid.cross-tenant-pipeline'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:500', 'wamid.ambiguous-pipeline'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:500', 'wamid.ambiguous-pipeline'),
        (1, 'company', 'transfer_payment', 'transfer_payment:500', 'wamid.wrong-transport-pipeline'),
        (1, 'cloud', 'order_en_route', 'order_en_route:500', 'wamid.wrong-template-pipeline'),
        (1, 'cloud', 'transfer_payment', 'invalid-correlation', 'wamid.invalid-correlation-pipeline'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:999999', 'wamid.missing-order-pipeline'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:501', 'wamid.ineligible-method-pipeline'),
        (1, 'cloud', 'transfer_payment', 'transfer_payment:502', 'wamid.ineligible-state-pipeline')
    `);

    const scenarios = [
      ['cross_tenant_or_missing_outbox', 'wamid.cross-tenant-pipeline', 'no_matching_outbox'],
      ['ambiguous_outbox', 'wamid.ambiguous-pipeline', 'ambiguous_outbox'],
      ['wrong_transport', 'wamid.wrong-transport-pipeline', 'outbox_not_eligible'],
      ['wrong_template', 'wamid.wrong-template-pipeline', 'outbox_not_eligible'],
      ['invalid_correlation', 'wamid.invalid-correlation-pipeline', 'invalid_correlation'],
      ['missing_order', 'wamid.missing-order-pipeline', 'order_not_found'],
      ['ineligible_method', 'wamid.ineligible-method-pipeline', 'order_not_eligible'],
      ['ineligible_state', 'wamid.ineligible-state-pipeline', 'order_not_eligible'],
    ];

    for (const [name, contextMessageId, expectedOutcome] of scenarios) {
      let fallbackCalls = 0;
      let insertionResult = null;
      const result = await procesarArchivoTransferenciaPg({
        buffer: Buffer.from(`receipt-${name}`), mimetype: 'image/jpeg',
      }, '5493515550500', {
        empresaId: 1,
        sourceMessageId: `wamid.receipt-${name}`,
        contextMessageId,
        transportOrigin: 'cloud',
        enqueueReply: async () => ({ queued: true }),
        deps: {
          insertarComprobantePg: async input => {
            insertionResult = await insertarComprobantePg(
              input, undefined, { withTransaction: transactionFor(pool) },
            );
            return insertionResult;
          },
          asociarComprobanteAutomaticamentePorMontoPg: async input => {
            fallbackCalls += 1;
            return asociarComprobanteAutomaticamentePorMontoPg(
              input, { withTransaction: transactionFor(pool) },
            );
          },
          prepareImageForAI: async () => ({ base64: 'receipt', mimeType: 'image/jpeg' }),
          analyzeReceiptWithAI: async () => ({ monto: 7650 }),
          resolverCuentaBancariaDestinoPg: async () => null,
          transicionarComprobanteARevisionPg: async () => ({ outcome: 'transitioned' }),
        },
      });

      assert.equal(fallbackCalls, 0, name);
      assert.equal(result.pedido_id, null, name);
      assert.equal(insertionResult.context_id_provided, true, name);
      assert.equal(insertionResult.exact_context_outcome, expectedOutcome, name);
      const receipt = (await pool.query(`
        SELECT pedido_id FROM comprobantes_transferencia WHERE source_message_id = $1
      `, [`wamid.receipt-${name}`])).rows[0];
      assert.equal(receipt.pedido_id, null, name);
    }
  });
});

test('PostgreSQL real: fallback asocia candidato único por tenant, teléfono, monto exacto y ventana reciente', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 51, amount: 2750, createdAt: new Date() });
    await seedOrder(pool, { id: 52, amount: 9999, createdAt: new Date() });
    const inserted = (await pool.query(`
      INSERT INTO comprobantes_transferencia
        (empresa_id, telefono, estado_revision, validado, procesado, monto)
      VALUES (1, '5493515550001', 'pendiente', 0, FALSE, 2750)
      RETURNING id
    `)).rows[0];

    const result = await asociarComprobanteAutomaticamentePorMontoPg({
      id: inserted.id,
      empresaId: 1,
      telefono: '5493515550001',
      monto: 2750,
      windowHours: 72,
    }, { withTransaction: transactionFor(pool) });

    assert.equal(result.outcome, 'associated');
    assert.equal(result.pedido_id, 51);
    const receipt = (await pool.query(`
      SELECT pedido_id, validado, procesado, estado_revision
        FROM comprobantes_transferencia WHERE id = $1
    `, [inserted.id])).rows[0];
    assert.deepEqual(receipt, {
      pedido_id: 51,
      validado: 0,
      procesado: false,
      estado_revision: 'pendiente',
    });
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM pedido_pagos')).rows[0].total, 0);
  });
});

test('PostgreSQL real: fallback mantiene NULL y pedido_ambiguo ante dos candidatos equivalentes', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 71, amount: 3300, createdAt: new Date() });
    await seedOrder(pool, { id: 72, amount: 3300, createdAt: new Date() });
    const receipt = (await pool.query(`
      INSERT INTO comprobantes_transferencia
        (empresa_id, telefono, estado_revision, validado, procesado, monto)
      VALUES (1, '5493515550001', 'pendiente', 0, FALSE, 3300)
      RETURNING id
    `)).rows[0];
    const result = await asociarComprobanteAutomaticamentePorMontoPg({
      id: receipt.id, empresaId: 1, telefono: '5493515550001', monto: 3300, windowHours: 72,
    }, { withTransaction: transactionFor(pool) });
    assert.deepEqual(result, {
      outcome: 'ambiguous', pedido_id: null, association_reason: 'pedido_ambiguo',
    });
    assert.deepEqual((await pool.query(`
      SELECT pedido_id, riesgo_flags, verified_reason, validado, procesado
        FROM comprobantes_transferencia WHERE id = $1
    `, [receipt.id])).rows[0], {
      pedido_id: null, riesgo_flags: 'pedido_ambiguo', verified_reason: 'pedido_ambiguo',
      validado: 0, procesado: false,
    });
  });
});

test('PostgreSQL real: pedido histórico fuera de 72 horas no compite con candidato reciente', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 81, amount: 4400, createdAt: new Date(Date.now() - 8 * 86400000) });
    await seedOrder(pool, { id: 82, amount: 4400, createdAt: new Date() });
    const receipt = (await pool.query(`
      INSERT INTO comprobantes_transferencia
        (empresa_id, telefono, estado_revision, validado, procesado, monto)
      VALUES (1, '5493515550001', 'pendiente', 0, FALSE, 4400)
      RETURNING id
    `)).rows[0];
    const result = await asociarComprobanteAutomaticamentePorMontoPg({
      id: receipt.id, empresaId: 1, telefono: '5493515550001', monto: 4400,
    }, { withTransaction: transactionFor(pool) });
    assert.equal(result.outcome, 'associated');
    assert.equal(result.pedido_id, 82);
  });
});

test('PostgreSQL real: pago que gana el lock impide asociación exacta y fallback tras revalidar en snapshot nuevo', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await installCanonicalPaymentTrigger(pool);
    await installCanonicalPaymentTrigger(pool);
    const installedTrigger = (await pool.query(`
      SELECT pg_catalog.pg_get_triggerdef(t.oid) AS definition
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'pedido_pagos'
         AND t.tgname = 'trg_serializar_pedido_pago_comprobante'
         AND NOT t.tgisinternal
    `)).rows;
    assert.equal(installedTrigger.length, 1);
    assert.match(installedTrigger[0].definition, /BEFORE INSERT OR DELETE OR UPDATE ON .*pedido_pagos/i);

    for (const mode of ['exact', 'fallback']) {
      const orderId = mode === 'exact' ? 901 : 902;
      const phone = `5493515550${orderId}`;
      await seedOrder(pool, { id: orderId, amount: 8800, phone });
      if (mode === 'exact') {
        await pool.query(`
          INSERT INTO wpp_outbox
            (empresa_id, transport_origin, cloud_template_key, notification_correlation_id, meta_message_id)
          VALUES (1, 'cloud', 'transfer_payment', $1, $2)
        `, [`transfer_payment:${orderId}`, `wamid.payment-wins-${orderId}`]);
      }

      let receiptId = null;
      if (mode === 'fallback') {
        receiptId = (await pool.query(`
          INSERT INTO comprobantes_transferencia
            (empresa_id, telefono, estado_revision, validado, procesado, monto)
          VALUES (1, $1, 'pendiente', 0, FALSE, 8800)
          RETURNING id
        `, [phone])).rows[0].id;
        await pool.query(`
          INSERT INTO pedido_pagos (pedido_id, empresa_id, estado, settlement_at)
          VALUES ($1, 1, 'pendiente', NULL)
        `, [orderId]);
      }

      const payment = await pool.connect();
      try {
        await payment.query('BEGIN');
        if (mode === 'exact') {
          await payment.query(`
            INSERT INTO pedido_pagos (pedido_id, empresa_id, estado, settlement_at)
            VALUES ($1, 1, 'pagado', NOW())
          `, [orderId]);
        } else {
          await payment.query(`
            UPDATE pedido_pagos
               SET estado = 'pagado', settlement_at = NOW()
             WHERE pedido_id = $1 AND empresa_id = 1
          `, [orderId]);
        }

        let notifyAssociationPid;
        const associationPid = new Promise(resolve => { notifyAssociationPid = resolve; });
        const associationTransaction = transactionFor(pool, { onBackendPid: notifyAssociationPid });
        const association = mode === 'exact'
          ? insertarComprobantePg({
              telefono: phone,
              imagen_path: `/Transferencia/payment-wins-${mode}.jpg`,
              fecha: new Date(),
              empresaId: 1,
              transportOrigin: 'cloud',
              sourceMessageId: `wamid.receipt-payment-wins-${mode}`,
              contextMessageId: `wamid.payment-wins-${orderId}`,
              fileHash: (mode === 'exact' ? 'd' : 'e').repeat(64),
            }, undefined, { withTransaction: associationTransaction })
          : asociarComprobanteAutomaticamentePorMontoPg({
              id: receiptId, empresaId: 1, telefono: phone, monto: 8800, windowHours: 72,
            }, { withTransaction: associationTransaction });

        await waitUntilBlocked(pool, await associationPid);
        await payment.query('COMMIT');
        const result = await association;
        assert.equal(result.pedido_id, null, mode);
        if (mode === 'exact') assert.equal(result.exact_context_outcome, 'order_not_eligible');
        else assert.equal(result.outcome, 'no_match');
      } finally {
        try { await payment.query('ROLLBACK'); } catch {}
        payment.release();
      }

      const receipt = (await pool.query(`
        SELECT pedido_id FROM comprobantes_transferencia
         WHERE ${mode === 'exact' ? "source_message_id = 'wamid.receipt-payment-wins-exact'" : 'id = $1'}
      `, mode === 'exact' ? [] : [receiptId])).rows[0];
      assert.equal(receipt.pedido_id, null, mode);
      const paid = (await pool.query(`
        SELECT settlement_at IS NOT NULL AS settled FROM pedido_pagos WHERE pedido_id = $1
      `, [orderId])).rows[0];
      assert.equal(paid.settled, true, mode);
    }
  });
});

test('PostgreSQL real: asociación que gana permite pedido pendiente y pago posterior sin sobrescribir', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await installCanonicalPaymentTrigger(pool);

    for (const mode of ['exact', 'fallback']) {
      const orderId = mode === 'exact' ? 911 : 912;
      const phone = `5493515550${orderId}`;
      await seedOrder(pool, { id: orderId, amount: 9900, phone });
      if (mode === 'exact') {
        await pool.query(`
          INSERT INTO wpp_outbox
            (empresa_id, transport_origin, cloud_template_key, notification_correlation_id, meta_message_id)
          VALUES (1, 'cloud', 'transfer_payment', $1, $2)
        `, [`transfer_payment:${orderId}`, `wamid.association-wins-${orderId}`]);
      }
      let receiptId = null;
      if (mode === 'fallback') {
        receiptId = (await pool.query(`
          INSERT INTO comprobantes_transferencia
            (empresa_id, telefono, estado_revision, validado, procesado, monto)
          VALUES (1, $1, 'pendiente', 0, FALSE, 9900)
          RETURNING id
        `, [phone])).rows[0].id;
        await pool.query(`
          INSERT INTO pedido_pagos (pedido_id, empresa_id, estado, settlement_at)
          VALUES ($1, 1, 'pendiente', NULL)
        `, [orderId]);
      }

      let notifyLocked;
      const orderLocked = new Promise(resolve => { notifyLocked = resolve; });
      let releaseLock;
      const continueAssociation = new Promise(resolve => { releaseLock = resolve; });
      const pausedTransaction = async work => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const txQuery = async (sql, params = []) => {
            const rows = (await client.query(sql, params)).rows;
            if (/SELECT\s+id\s+FROM pedidos\s+WHERE id = \$1 AND empresa_id = \$2\s+FOR UPDATE/i.test(sql)) {
              notifyLocked();
              await continueAssociation;
            }
            return rows;
          };
          const result = await work(txQuery);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };

      const association = mode === 'exact'
        ? insertarComprobantePg({
            telefono: phone,
            imagen_path: `/Transferencia/association-wins-${mode}.jpg`,
            fecha: new Date(), empresaId: 1, transportOrigin: 'cloud',
            sourceMessageId: `wamid.receipt-association-wins-${mode}`,
            contextMessageId: `wamid.association-wins-${orderId}`,
            fileHash: (mode === 'exact' ? 'f' : 'a').repeat(64),
          }, undefined, { withTransaction: pausedTransaction })
        : asociarComprobanteAutomaticamentePorMontoPg({
            id: receiptId, empresaId: 1, telefono: phone, monto: 9900, windowHours: 72,
          }, { withTransaction: pausedTransaction });

      await orderLocked;
      const payment = await pool.connect();
      try {
        await payment.query('BEGIN');
        const paymentPid = (await payment.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const paymentInsert = mode === 'exact'
          ? payment.query(`
              INSERT INTO pedido_pagos (pedido_id, empresa_id, estado, settlement_at)
              VALUES ($1, 1, 'pagado', NOW())
            `, [orderId])
          : payment.query(`
              UPDATE pedido_pagos
                 SET estado = 'pagado', settlement_at = NOW()
               WHERE pedido_id = $1 AND empresa_id = 1
            `, [orderId]);
        await waitUntilBlocked(pool, paymentPid);
        releaseLock();
        const result = await association;
        assert.equal(result.pedido_id, orderId, mode);
        await paymentInsert;
        await payment.query('COMMIT');
      } finally {
        try { await payment.query('ROLLBACK'); } catch {}
        payment.release();
      }

      const receipt = (await pool.query(`
        SELECT pedido_id, validado, procesado, estado_revision
          FROM comprobantes_transferencia
         WHERE ${mode === 'exact' ? "source_message_id = 'wamid.receipt-association-wins-exact'" : 'id = $1'}
      `, mode === 'exact' ? [] : [receiptId])).rows[0];
      assert.deepEqual(receipt, {
        pedido_id: orderId, validado: 0, procesado: false, estado_revision: 'pendiente',
      }, mode);
      assert.equal((await pool.query(`
        SELECT count(*)::int AS total FROM pedido_pagos
         WHERE pedido_id = $1 AND settlement_at IS NOT NULL
      `, [orderId])).rows[0].total, 1, mode);
    }
  });
});

test('PostgreSQL real: lock y revalidación no sobrescriben asociación ni decisión financiera concurrente', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 91, amount: 5500, createdAt: new Date() });
    await seedOrder(pool, { id: 92, amount: 5500, createdAt: new Date(), phone: '5493515550092' });
    for (const scenario of ['association', 'financial']) {
      const receipt = (await pool.query(`
        INSERT INTO comprobantes_transferencia
          (empresa_id, telefono, estado_revision, validado, procesado, monto)
        VALUES (1, $1, 'pendiente', 0, FALSE, 5500)
        RETURNING id
      `, [scenario === 'association' ? '5493515550001' : '5493515550092'])).rows[0];
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM comprobantes_transferencia WHERE id = $1 FOR UPDATE', [receipt.id]);
        const pending = asociarComprobanteAutomaticamentePorMontoPg({
          id: receipt.id, empresaId: 1,
          telefono: scenario === 'association' ? '5493515550001' : '5493515550092',
          monto: 5500, windowHours: 72,
        }, { withTransaction: transactionFor(pool) });
        await new Promise(resolve => setTimeout(resolve, 50));
        if (scenario === 'association') {
          await blocker.query('UPDATE comprobantes_transferencia SET pedido_id = 92 WHERE id = $1', [receipt.id]);
        } else {
          await blocker.query(`
            UPDATE comprobantes_transferencia
               SET validado = 1, procesado = TRUE, estado_revision = 'aprobado'
             WHERE id = $1
          `, [receipt.id]);
        }
        await blocker.query('COMMIT');
        const result = await pending;
        assert.equal(result.outcome, scenario === 'association' ? 'already_associated' : 'not_eligible');
      } finally {
        blocker.release();
      }
      const final = (await pool.query(`
        SELECT pedido_id, validado, procesado, estado_revision
          FROM comprobantes_transferencia WHERE id = $1
      `, [receipt.id])).rows[0];
      if (scenario === 'association') assert.equal(final.pedido_id, 92);
      else assert.deepEqual(final, {
        pedido_id: null, validado: 1, procesado: true, estado_revision: 'aprobado',
      });
    }
  });
});

test('PostgreSQL real: writer que gana antes de la exclusión obliga a releer cardinalidad completa', postgresOptions, async () => {
  for (const scenario of cardinalityWriterScenarios) {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      await seedOrder(pool, { id: 1201, phone: '5493515552200', amount: 12200 });
      await scenario.seed(pool);
      const receipt = await seedReceipt(pool, { phone: '5493515552200', amount: 12200 });

      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await scenario.mutate(writer);

        let notifyAssociationPid;
        const associationPid = new Promise(resolve => { notifyAssociationPid = resolve; });
        const association = asociarComprobanteAutomaticamentePorMontoPg({
          id: receipt.id, empresaId: 1, telefono: '5493515552200', monto: 12200, windowHours: 72,
        }, { withTransaction: transactionFor(pool, { onBackendPid: notifyAssociationPid }) });
        await waitUntilBlocked(pool, await associationPid);
        await writer.query('COMMIT');

        const result = await association;
        assert.deepEqual(result, {
          outcome: 'ambiguous', pedido_id: null, association_reason: 'pedido_ambiguo',
        }, scenario.name);
      } finally {
        try { await writer.query('ROLLBACK'); } catch {}
        writer.release();
      }

      const final = (await pool.query(`
        SELECT pedido_id, riesgo_flags, verified_reason
          FROM comprobantes_transferencia WHERE id = $1
      `, [receipt.id])).rows[0];
      assert.deepEqual(final, {
        pedido_id: null, riesgo_flags: 'pedido_ambiguo', verified_reason: 'pedido_ambiguo',
      }, scenario.name);
    });
  }
});

test('PostgreSQL real: asociación que gana congela cardinalidad y el writer completa después', postgresOptions, async () => {
  for (const scenario of cardinalityWriterScenarios) {
    await withIsolatedPostgres(async pool => {
      await createFixture(pool);
      await seedOrder(pool, { id: 1201, phone: '5493515552200', amount: 12200 });
      await scenario.seed(pool);
      const receipt = await seedReceipt(pool, { phone: '5493515552200', amount: 12200 });

      let notifyTablesLocked;
      const tablesLocked = new Promise(resolve => { notifyTablesLocked = resolve; });
      let resumeAssociation;
      const canAssociate = new Promise(resolve => { resumeAssociation = resolve; });
      const pausedTransaction = async work => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const txQuery = async (sql, params = []) => {
            const rows = (await client.query(sql, params)).rows;
            if (/LOCK TABLE public\.puntos_entrega, public\.pedidos IN SHARE MODE/i.test(sql)) {
              notifyTablesLocked();
              await canAssociate;
            }
            return rows;
          };
          const result = await work(txQuery);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };

      const association = asociarComprobanteAutomaticamentePorMontoPg({
        id: receipt.id, empresaId: 1, telefono: '5493515552200', monto: 12200, windowHours: 72,
      }, { withTransaction: pausedTransaction });
      await tablesLocked;

      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const mutation = scenario.mutate(writer);
        await waitUntilBlocked(pool, writerPid);
        resumeAssociation();

        const result = await association;
        assert.equal(result.outcome, 'associated', scenario.name);
        assert.equal(result.pedido_id, 1201, scenario.name);
        await mutation;
        await writer.query('COMMIT');
      } finally {
        try { await writer.query('ROLLBACK'); } catch {}
        writer.release();
      }

      const final = (await pool.query(`
        SELECT pedido_id FROM comprobantes_transferencia WHERE id = $1
      `, [receipt.id])).rows[0];
      assert.equal(final.pedido_id, 1201, scenario.name);
      const eligible = (await pool.query(`
        SELECT count(*)::int AS total
          FROM pedidos p
          JOIN puntos_entrega pe ON pe.id = p.punto_entrega_id AND pe.empresa_id = p.empresa_id
         WHERE p.empresa_id = 1
           AND RIGHT(pg_catalog.regexp_replace(COALESCE(pe.telefono_normalizado, ''), '[^0-9]', '', 'g'), 10) = '3515552200'
           AND p.monto = 12200::numeric
           AND p.created_at >= NOW() - INTERVAL '72 hours'
           AND LOWER(COALESCE(p.metodo_pago, '')) = 'transferencia'
           AND p.estado IN ('pendiente', 'en_ruta', 'en_camino', 'entregado')
      `)).rows[0].total;
      assert.equal(eligible, 2, scenario.name);
    });
  }
});

test('PostgreSQL real: timeout de exclusión falla cerrado y deja revisión manual sin retry', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 1301, phone: '5493515552300', amount: 12300 });
    const receipt = await seedReceipt(pool, { phone: '5493515552300', amount: 12300 });
    const blocker = await pool.connect();
    const previousTimeout = process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS;
    let transactions = 0;
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE pedidos SET monto = monto WHERE id = 1301');
      process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS = '50';
      const countedTransaction = async work => {
        transactions += 1;
        return transactionFor(pool)(work);
      };
      const result = await asociarComprobanteAutomaticamentePorMontoPg({
        id: receipt.id, empresaId: 1, telefono: '5493515552300', monto: 12300, windowHours: 72,
      }, { withTransaction: countedTransaction });
      assert.deepEqual(result, {
        outcome: 'lock_contended', pedido_id: null, association_reason: 'pedido_no_asociado',
      });
      assert.equal(transactions, 2, 'una transacción fallida y una transición manual, sin retry');
    } finally {
      if (previousTimeout === undefined) delete process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS;
      else process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS = previousTimeout;
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT pedido_id, riesgo_flags, verified_reason
        FROM comprobantes_transferencia WHERE id = $1
    `, [receipt.id])).rows[0], {
      pedido_id: null, riesgo_flags: 'pedido_no_asociado', verified_reason: 'pedido_no_asociado',
    });
  });
});

test('PostgreSQL real: ciclo receipt→tablas versus pedido→receipt no reintenta y queda serial', postgresOptions, async () => {
  await withIsolatedPostgres(async pool => {
    await createFixture(pool);
    await seedOrder(pool, { id: 1401, phone: '5493515552400', amount: 12400 });
    const receipt = await seedReceipt(pool, { phone: '5493515552400', amount: 12400 });
    const writer = await pool.connect();
    const previousTimeout = process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS;
    let transactions = 0;
    try {
      process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS = '5000';
      await writer.query('BEGIN');
      await writer.query('UPDATE pedidos SET monto = monto WHERE id = 1401');

      let notifyAssociationPid;
      const associationPid = new Promise(resolve => { notifyAssociationPid = resolve; });
      const countedTransaction = async work => {
        transactions += 1;
        return transactionFor(pool, { onBackendPid: transactions === 1 ? notifyAssociationPid : null })(work);
      };
      const association = asociarComprobanteAutomaticamentePorMontoPg({
        id: receipt.id, empresaId: 1, telefono: '5493515552400', monto: 12400, windowHours: 72,
      }, { withTransaction: countedTransaction });
      await waitUntilBlocked(pool, await associationPid);

      let writerOutcome = 'locked_receipt';
      try {
        await writer.query(`
          SELECT id FROM comprobantes_transferencia WHERE id = $1 FOR UPDATE
        `, [receipt.id]);
        await writer.query('COMMIT');
      } catch (error) {
        assert.equal(error.code, '40P01');
        writerOutcome = 'deadlock_victim';
        await writer.query('ROLLBACK');
      }

      const result = await association;
      if (writerOutcome === 'deadlock_victim') {
        assert.equal(result.outcome, 'associated');
        assert.equal(transactions, 1, 'el fallback no reintenta tras ganar el ciclo');
      } else {
        assert.deepEqual(result, {
          outcome: 'lock_contended', pedido_id: null, association_reason: 'pedido_no_asociado',
        });
        assert.equal(transactions, 2, 'rollback y transición manual, nunca retry del trabajo');
      }
    } finally {
      if (previousTimeout === undefined) delete process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS;
      else process.env.TRANSFERENCIA_ASSOCIATION_LOCK_TIMEOUT_MS = previousTimeout;
      try { await writer.query('ROLLBACK'); } catch {}
      writer.release();
    }

    const final = (await pool.query(`
      SELECT pedido_id, riesgo_flags FROM comprobantes_transferencia WHERE id = $1
    `, [receipt.id])).rows[0];
    assert.ok(
      (final.pedido_id === 1401 && final.riesgo_flags === null)
      || (final.pedido_id === null && final.riesgo_flags === 'pedido_no_asociado'),
    );
  });
});
