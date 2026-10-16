import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { withIsolatedPostgres, postgresOptions } from './support/isolated-postgres.js';
import { withTransaction } from '../src/db.js';
import { withEmpresaWhatsappConfigLock, runTransactionOnLockedClient } from '../src/wpp/companyConfigLock.js';
import { createWhatsAppPaymentChoiceProcessor } from '../src/whatsappCloud/paymentChoiceProcessor.js';
import { enqueueWppTransferPaymentNotificationInTransaction } from '../src/wpp/enqueue.js';

if (process.env.TMPDIR) process.chdir(process.env.TMPDIR);
test('paymentChoice real: busy revierte método/auditoría; retry conserva una notificación y los cupos exactos', postgresOptions, async t => {
  flag(t);
  await withIsolatedPostgres(cluster => fixture(cluster, async pool => {
    const cloud = { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'synthetic-9001', access_token_encrypted: 'v1:synthetic', templates: { transfer_payment: { name: 'pedivoy_transfer_payment_v1', language: 'es_AR' } } } };
    await pool.query('UPDATE empresas SET config_integraciones=$1::jsonb WHERE id=9001', [JSON.stringify(cloud)]);
    await pool.query(`INSERT INTO puntos_entrega(id,empresa_id,cliente,telefono,direccion) VALUES(9001,9001,'Fixture','5493515559001','Fixture 1');
      UPDATE pedidos SET punto_entrega_id=9001,monto=200 WHERE id=9001;
      INSERT INTO empresa_cuentas_bancarias(empresa_id,alias,banco,cbu,titular,prioridad,activa) VALUES(9001,'fixture.alias','Banco sintético','0000000000000000000001','Fixture',1,true);
      INSERT INTO wpp_outbox(empresa_id,telefono,mensaje,transport_origin,notification_correlation_id,cloud_template_key,cloud_template_parameters,status,meta_message_id)
      VALUES(9001,'5493515559001','Confirmación sintética','cloud','order_confirmation:9001','order_confirmation','{}','sent','wamid.fixture-confirm-9001');`);
    const before = await snapshot(pool);
    const audit = async () => (await pool.query('SELECT * FROM pedido_metodo_pago_eventos WHERE pedido_id=9001 ORDER BY id')).rows;
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    const choose = () => processor({ empresaId: 9001, messageId: 'wamid.fixture-choice-9001', contextMessageId: 'wamid.fixture-confirm-9001', buttonPayload: 'pedivoy_payment_transfer_v1', assertLease: async () => {} });
    const locked = deferred(), release = deferred(), configure = deferred(), configured = deferred();
    const config = withEmpresaWhatsappConfigLock(pool, 9001, async client => {
      locked.resolve();
      await configure.promise;
      await runTransactionOnLockedClient(client, q => q('UPDATE empresas SET nombre=nombre WHERE id=9001'));
      configured.resolve();
      await release.promise;
    }).then(() => ({ ok: true }), error => ({ error }));
    try {
      await locked.promise;
      await assert.rejects(choose(), { code: 'PAYMENT_CHOICE_FAILED' });
      assert.deepEqual(await snapshot(pool), before);
      assert.deepEqual(await audit(), []);
      configure.resolve();
      await configured.promise;
      await assert.rejects(choose(), { code: 'PAYMENT_CHOICE_FAILED' });
      assert.deepEqual(await snapshot(pool), before);
      assert.deepEqual(await audit(), []);
      release.resolve();
      assert.deepEqual(await config, { ok: true });
      assert.deepEqual(await choose(), { handled: true, outcome: 'accepted', paymentMethod: 'transferencia', notification: 'queued' });
      const after = await snapshot(pool), auditAfter = await audit();
      assert.deepEqual(after, { ...before, method: 'transferencia', notices: 1 });
      assert.equal(auditAfter.length, 1);
      assert.equal(auditAfter[0].notification_status, 'queued');
      assert.equal((await choose()).outcome, 'idempotent');
      assert.deepEqual(await snapshot(pool), after);
      assert.deepEqual(await audit(), auditAfter);
    } finally {
      configure.resolve(); release.resolve();
      await config;
    }
  }));
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function flag(t) {
  const previous = process.env.SCHEDULED_MENUS_ENABLED;
  process.env.SCHEDULED_MENUS_ENABLED = '1';
  t.after(() => previous === undefined ? delete process.env.SCHEDULED_MENUS_ENABLED : process.env.SCHEDULED_MENUS_ENABLED = previous);
}
const notification = { empresaId: 9001, phone: '3515559001', message: 'Transferencia sintética', notificationCorrelationId: 'transfer_payment:9001' };
async function fixture(cluster, work) {
  await cluster.query("CREATE DATABASE menu_lock_utf8 ENCODING 'UTF8' TEMPLATE template0");
  const pool = new pg.Pool({ ...cluster.options, database: 'menu_lock_utf8', options: '-c statement_timeout=5000' });
  try {
    await pool.query(readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8'));
    await pool.query(`INSERT INTO empresas(id,nombre,config_integraciones,menu_config) VALUES(9001,'Fixture advisory','{}','{"enabled":true}');
      INSERT INTO productos(id,empresa_id,nombre,precio,disponibilidad_config) VALUES(9001,9001,'Menú sintético',100,'{"enabled":true,"daily_capacity":3}');
      INSERT INTO pedidos(id,empresa_id,estado,metodo_pago,fecha_entrega_programada) VALUES(9001,9001,'pendiente','efectivo','2026-10-20');
      INSERT INTO items_pedido(id,pedido_id,producto_id,producto,cantidad,precio_unitario) VALUES(9001,9001,9001,'Menú sintético',2,100);`);
    await work(pool);
  } finally { await pool.end(); }
}
async function snapshot(pool) {
  return (await pool.query(`SELECT
    (SELECT metodo_pago FROM pedidos WHERE id=9001) AS method,
    (SELECT count(*)::integer FROM wpp_outbox WHERE notification_correlation_id='transfer_payment:9001') AS notices,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY empresa_id,producto_id,fecha) FROM menu_cupos_diarios c) AS quota,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY item_id) FROM menu_reservas_items r) AS reservations,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM items_pedido i WHERE pedido_id=9001) AS items`)).rows[0];
}
async function waitForBarrierWait(pool, pid) {
  for (let n = 0; n < 200; n++) {
    const { rows } = await pool.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock' && /menu_write_barrier/.test(rows[0].query)) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail('configuration did not wait on the payment menu barrier');
}

for (const automaticRetry of [false, true]) {
  test(`PostgreSQL real: advisory de configuración → barrera vs pago → enqueue, ${automaticRetry ? 'retry nativo' : 'rollback y retry caller'}`, postgresOptions, async t => {
    flag(t);
    await withIsolatedPostgres(cluster => fixture(cluster, async pool => {
      const before = await snapshot(pool);
      assert.equal(before.quota[0].reservado, 2);
      const configLocked = deferred(), startConfigTx = deferred(), releaseSupervisor = deferred(), enterPayment = deferred(), startEnqueue = deferred();
      let configPid, attempts = 0;
      const errors = [];
      const config = withEmpresaWhatsappConfigLock(pool, 9001, async client => {
        configPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await client.query("SET statement_timeout='5s'");
        configLocked.resolve();
        await startConfigTx.promise;
        await runTransactionOnLockedClient(client, q => q("UPDATE empresas SET config_integraciones='{\"fixture\":true}' WHERE id=9001"));
        // Supervisor work remains inside the session advisory, outside the global barrier.
        if (!automaticRetry) await releaseSupervisor.promise;
      }).then(() => ({ ok: true }), error => ({ error }));
      await configLocked.promise;
      const paymentWork = async (q, client) => {
        attempts++;
        await client.query("SET LOCAL statement_timeout='5s'");
        await q("UPDATE pedidos SET metodo_pago='transferencia' WHERE id=9001");
        if (attempts === 1) { enterPayment.resolve(); await startEnqueue.promise; }
        try {
          return await enqueueWppTransferPaymentNotificationInTransaction(notification, { client, transactionOwner: 'caller' });
        } catch (error) { errors.push(error.code); throw error; }
      };
      const payment = withTransaction(paymentWork, { pool, maxRetries: automaticRetry ? 2 : 0, retryDelayMs: 40 }).then(value => ({ value }), error => ({ error }));
      try {
        await enterPayment.promise;
        startConfigTx.resolve();
        await waitForBarrierWait(pool, configPid);
        startEnqueue.resolve();
        const result = await payment;
        if ((!automaticRetry && !result.error) || (automaticRetry && attempts === 1)) {
          releaseSupervisor.resolve();
          const configuration = await config;
          assert.fail(`lock inversion reached PostgreSQL: config=${configuration.error?.code}; payment=${result.error?.code || 'committed without retry'}`);
        }
        if (automaticRetry) {
          assert.equal(result.error, undefined, result.error?.code);
          assert.equal(result.value.queued, true);
          assert.equal(attempts, 2);
        } else {
          assert.equal(result.error?.code, '40001');
          assert.deepEqual(await snapshot(pool), before, 'failed callback must rollback method, preserve exact quota/items, and write no notice');
          // Admission also stays closed while the supervisor still owns the session namespace.
          await assert.rejects(withTransaction(paymentWork, { pool, maxRetries: 0 }), { code: '40001' });
          assert.deepEqual(await snapshot(pool), before);
          releaseSupervisor.resolve();
          assert.deepEqual(await config, { ok: true });
          const retry = await withTransaction(paymentWork, { pool });
          assert.equal(retry.queued, true);
        }
        assert.deepEqual(await config, { ok: true });
        assert.ok(errors.length > 0);
        assert.ok(errors.every(code => code === '40001'), JSON.stringify(errors));
        const after = await snapshot(pool);
        assert.deepEqual(after, { ...before, method: 'transferencia', notices: 1 });
        const replay = await withTransaction(paymentWork, { pool });
        assert.equal(replay.reason, 'duplicate_notification');
        assert.deepEqual(await snapshot(pool), after, 'retry/replay cannot duplicate WhatsApp or alter production quota');
      } finally {
        startConfigTx.resolve(); startEnqueue.resolve(); releaseSupervisor.resolve();
        await Promise.all([payment, config]);
      }
    }));
  });
}
