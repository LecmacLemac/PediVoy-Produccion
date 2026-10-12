import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { createWhatsAppPaymentChoiceProcessor } from '../src/whatsappCloud/paymentChoiceProcessor.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available, 'payment choice PostgreSQL gate requires local PostgreSQL');
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const start = initSql.indexOf('-- BEGIN WHATSAPP PAYMENT CHOICE MIGRATION');
const endMarker = '-- END WHATSAPP PAYMENT CHOICE MIGRATION';
assert.ok(start >= 0 && initSql.indexOf(endMarker, start) > start, 'payment choice migration marker required');
const migrationSql = initSql.slice(start, initSql.indexOf(endMarker, start) + endMarker.length);
const prefix = '.whatsapp-payment-choice-pg-';
const created = new Set();

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), prefix));
  created.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let pool;
  let started = false;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'payment_choice_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'payment_choice_test', database: 'postgres', max: 8 });
    await pool.query(`
      CREATE TABLE empresas (
        id integer PRIMARY KEY,
        nombre text,
        config_integraciones jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE puntos_entrega (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL REFERENCES empresas(id),
        cliente text,
        telefono text,
        direccion text
      );
      CREATE TABLE pedidos (
        id integer PRIMARY KEY,
        empresa_id integer NOT NULL REFERENCES empresas(id),
        punto_entrega_id integer REFERENCES puntos_entrega(id),
        estado text NOT NULL DEFAULT 'pendiente',
        metodo_pago text,
        monto numeric(10,2) DEFAULT 0
      );
      CREATE TABLE empresa_cuentas_bancarias (
        id serial PRIMARY KEY,
        empresa_id integer NOT NULL REFERENCES empresas(id),
        alias text, banco text, tipo text, cbu text, titular text,
        prioridad integer, activa boolean DEFAULT true
      );
      CREATE TABLE wpp_outbox (
        id serial PRIMARY KEY,
        empresa_id integer,
        telefono text NOT NULL,
        mensaje text NOT NULL,
        transport_origin text,
        reply_correlation_id text,
        notification_correlation_id text,
        cloud_template_key text,
        cloud_template_parameters jsonb,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        meta_message_id text
      );
    `);
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    await work(pool);
  } finally {
    await pool?.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    created.delete(directory);
  }
}

after(() => {
  assert.deepEqual(readdirSync(process.cwd()).filter(name => name.startsWith(prefix)), []);
  assert.equal(created.size, 0);
});

async function seed(pool) {
  const cloud = id => JSON.stringify({
    whatsapp: {
      provider: 'cloud', enabled: true, phone_number_id: `phone-${id}`, access_token_encrypted: 'v1:test',
      templates: {
        order_confirmation: { name: 'pedivoy_order_confirmation_v2', language: 'es_AR' },
        transfer_payment: { name: 'pedivoy_transfer_payment_v1', language: 'es_AR' },
      },
    },
  });
  await pool.query(`INSERT INTO empresas(id,nombre,config_integraciones) VALUES
    (1,'Tenant Uno',$1::jsonb),(2,'Tenant Dos',$2::jsonb)`, [cloud(1), cloud(2)]);
  await pool.query(`INSERT INTO puntos_entrega(id,empresa_id,cliente,telefono,direccion) VALUES
    (11,1,'Cliente Uno','5493515550011','Calle 1'),(22,2,'Cliente Dos','5493515550022','Calle 2')`);
  await pool.query(`INSERT INTO pedidos(id,empresa_id,punto_entrega_id,estado,metodo_pago,monto) VALUES
    (101,1,11,'pendiente',NULL,1500),(202,2,22,'pendiente',NULL,2500),(303,1,11,'entregado',NULL,3500)`);
  await pool.query(`INSERT INTO empresa_cuentas_bancarias(empresa_id,alias,banco,cbu,titular,prioridad,activa)
    VALUES (1,'tenant.uno','Banco Uno','0000000000000000000001','Tenant Uno',1,true)`);
  await pool.query(`INSERT INTO wpp_outbox
    (empresa_id,telefono,mensaje,transport_origin,notification_correlation_id,cloud_template_key,cloud_template_parameters,status,meta_message_id)
    VALUES
    (1,'5493515550011','confirmación','cloud','order_confirmation:101','order_confirmation','{}'::jsonb,'sent','wamid.confirm-101'),
    (2,'5493515550022','confirmación','cloud','order_confirmation:202','order_confirmation','{}'::jsonb,'sent','wamid.confirm-202'),
    (1,'5493515550011','otro','cloud','order_en_route:101','order_en_route','{}'::jsonb,'sent','wamid.route-101'),
    (1,'5493515550011','confirmación terminal','cloud','order_confirmation:303','order_confirmation','{}'::jsonb,'sent','wamid.confirm-303')`);
}

function choose(processor, overrides = {}) {
  return processor({
    empresaId: 1,
    messageId: 'wamid.choice-1',
    contextMessageId: 'wamid.confirm-101',
    buttonPayload: 'pedivoy_payment_cash_v1',
    assertLease: async () => {},
    ...overrides,
  });
}

test('correlación exacta tenant-scoped actualiza pedido sin cambiar estado y registra auditoría', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    assert.deepEqual(await choose(processor), { handled: true, outcome: 'accepted', paymentMethod: 'efectivo', notification: 'not_required' });
    assert.deepEqual((await pool.query(`SELECT estado,metodo_pago,metodo_pago_origen,
      metodo_pago_outbound_message_id,metodo_pago_inbound_message_id,
      metodo_pago_seleccionado_at IS NOT NULL AS selected
      FROM pedidos WHERE id=101`)).rows, [{
      estado: 'pendiente', metodo_pago: 'efectivo', metodo_pago_origen: 'cliente_whatsapp',
      metodo_pago_outbound_message_id: 'wamid.confirm-101', metodo_pago_inbound_message_id: 'wamid.choice-1', selected: true,
    }]);
    assert.deepEqual((await pool.query(`SELECT metodo_pago,origen,resultado,notification_status
      FROM pedido_metodo_pago_eventos WHERE pedido_id=101`)).rows, [{
      metodo_pago: 'efectivo', origen: 'cliente_whatsapp', resultado: 'accepted', notification_status: 'not_required',
    }]);
  });
});

test('rechaza cross-tenant, contexto outbound equivocado y pedido terminal sin mutar', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    assert.equal((await choose(processor, { contextMessageId: 'wamid.confirm-202' })).outcome, 'context_not_found');
    assert.equal((await choose(processor, { messageId: 'wamid.choice-wrong', contextMessageId: 'wamid.route-101' })).outcome, 'context_not_order_confirmation');
    assert.equal((await choose(processor, { messageId: 'wamid.choice-terminal', contextMessageId: 'wamid.confirm-303' })).outcome, 'order_terminal');
    assert.deepEqual((await pool.query(`SELECT id,metodo_pago FROM pedidos ORDER BY id`)).rows, [
      { id: 101, metodo_pago: null }, { id: 202, metodo_pago: null }, { id: 303, metodo_pago: null },
    ]);
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM pedido_metodo_pago_eventos')).rows[0].count), 0);
  });
});

test('retry exacto es idempotente y primer clic gana ante selección contradictoria', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    assert.equal((await choose(processor)).outcome, 'accepted');
    assert.equal((await choose(processor)).outcome, 'idempotent');
    const contradictory = await choose(processor, {
      messageId: 'wamid.choice-2', buttonPayload: 'pedivoy_payment_transfer_v1',
    });
    assert.deepEqual(contradictory, { handled: true, outcome: 'rejected_contradictory', paymentMethod: 'efectivo', notification: 'not_required' });
    assert.deepEqual((await pool.query(`SELECT metodo_pago,metodo_pago_inbound_message_id FROM pedidos WHERE id=101`)).rows[0], {
      metodo_pago: 'efectivo', metodo_pago_inbound_message_id: 'wamid.choice-1',
    });
    assert.deepEqual((await pool.query(`SELECT inbound_message_id,metodo_pago,resultado
      FROM pedido_metodo_pago_eventos ORDER BY id`)).rows, [
      { inbound_message_id: 'wamid.choice-1', metodo_pago: 'efectivo', resultado: 'accepted' },
      { inbound_message_id: 'wamid.choice-2', metodo_pago: 'transferencia', resultado: 'rejected_contradictory' },
    ]);
  });
});

test('transferencia persiste elección y encola transfer_payment canónico en la misma transacción', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    const result = await choose(processor, {
      messageId: 'wamid.choice-transfer', buttonPayload: 'pedivoy_payment_transfer_v1',
    });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.paymentMethod, 'transferencia');
    assert.equal(result.notification, 'queued');
    assert.deepEqual((await pool.query(`SELECT metodo_pago,metodo_pago_origen FROM pedidos WHERE id=101`)).rows[0], {
      metodo_pago: 'transferencia', metodo_pago_origen: 'cliente_whatsapp',
    });
    const outbox = (await pool.query(`SELECT empresa_id,transport_origin,notification_correlation_id,cloud_template_key,status
      FROM wpp_outbox WHERE notification_correlation_id='transfer_payment:101'`)).rows;
    assert.deepEqual(outbox, [{
      empresa_id: 1, transport_origin: 'cloud', notification_correlation_id: 'transfer_payment:101',
      cloud_template_key: 'transfer_payment', status: 'pending',
    }]);
  });
});

test('transferencia usa productor canónico y crea un único outbox Cloud dentro de la transacción real', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    const result = await choose(processor, { buttonPayload: 'pedivoy_payment_transfer_v1' });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.notification, 'queued');
    const rows = (await pool.query(`
      SELECT empresa_id, transport_origin, notification_correlation_id,
             cloud_template_key, cloud_template_parameters, status
        FROM wpp_outbox
       WHERE notification_correlation_id = 'transfer_payment:101'
    `)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].empresa_id, 1);
    assert.equal(rows[0].transport_origin, 'cloud');
    assert.equal(rows[0].cloud_template_key, 'transfer_payment');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].cloud_template_parameters.alias, 'tenant.uno');
  });
});

test('sin datos bancarios conserva transferencia y registra notificación unavailable sin inventar envío', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    await pool.query('DELETE FROM empresa_cuentas_bancarias WHERE empresa_id=1');
    const processor = createWhatsAppPaymentChoiceProcessor({ pool });
    const result = await choose(processor, {
      messageId: 'wamid.choice-transfer-no-bank', buttonPayload: 'pedivoy_payment_transfer_v1',
    });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.notification, 'unavailable');
    assert.equal((await pool.query('SELECT metodo_pago FROM pedidos WHERE id=101')).rows[0].metodo_pago, 'transferencia');
    assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM wpp_outbox WHERE notification_correlation_id='transfer_payment:101'`)).rows[0].count), 0);
    assert.equal((await pool.query(`SELECT notification_status FROM pedido_metodo_pago_eventos WHERE pedido_id=101`)).rows[0].notification_status, 'unavailable');
  });
});

test('notificación transfer existente en error conserva elección pero queda unavailable', async () => {
  await withDatabase(async pool => {
    await seed(pool);
    const processor = createWhatsAppPaymentChoiceProcessor({
      pool,
      notifyTransferInTransaction: async () => ({
        queued: false, skipped: true, reason: 'duplicate_notification', id: 99,
        status: 'error', transportOrigin: 'cloud',
      }),
    });
    const result = await choose(processor, { buttonPayload: 'pedivoy_payment_transfer_v1' });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.notification, 'unavailable');
    assert.equal((await pool.query(`SELECT metodo_pago FROM pedidos WHERE id=101`)).rows[0].metodo_pago, 'transferencia');
    assert.equal((await pool.query(`SELECT notification_status FROM pedido_metodo_pago_eventos WHERE pedido_id=101`)).rows[0].notification_status, 'unavailable');
  });
});

test('COMMIT ambiguo en rechazo temprano también evita rollback/retry y descarta conexión', async () => {
  const calls = [];
  const releaseArgs = [];
  const client = {
    async query(request) {
      const text = typeof request === 'string' ? request : request.text;
      calls.push(text.trim());
      if (text.trim() === 'BEGIN') return { rows: [] };
      if (/FROM wpp_outbox/.test(text)) return { rows: [] };
      if (text.trim() === 'COMMIT') throw new Error('socket private');
      if (text.trim() === 'ROLLBACK') return { rows: [] };
      throw new Error(`unexpected ${text}`);
    },
    release(error) { releaseArgs.push(error); },
  };
  const processor = createWhatsAppPaymentChoiceProcessor({ pool: { connect: async () => client } });
  await assert.rejects(choose(processor), error => {
    assert.equal(error.code, 'PAYMENT_CHOICE_OUTCOME_UNKNOWN');
    assert.doesNotMatch(error.message, /socket private/);
    return true;
  });
  assert.equal(calls.filter(call => call === 'COMMIT').length, 1);
  assert.equal(calls.includes('ROLLBACK'), false);
  assert.equal(releaseArgs.length, 1);
  assert.equal(releaseArgs[0]?.code, 'PAYMENT_CHOICE_OUTCOME_UNKNOWN');
});

test('COMMIT ambiguo no hace rollback/retry, descarta conexión y devuelve outcome_unknown sanitizado', async () => {
  const statements = [];
  let releaseError;
  const client = {
    async query(sql) {
      const text = typeof sql === 'string' ? sql : sql.text;
      statements.push(text);
      if (text === 'COMMIT') throw new Error('private commit transport detail');
      if (/FROM wpp_outbox/.test(text)) return { rows: [{ id: 1, notification_correlation_id: 'order_confirmation:101', cloud_template_key: 'order_confirmation', transport_origin: 'cloud' }] };
      if (/FROM pedidos/.test(text)) return { rows: [{ id: 101, empresa_id: 1, estado: 'pendiente', metodo_pago: null }] };
      if (/FROM pedido_metodo_pago_eventos/.test(text)) return { rows: [] };
      if (/INSERT INTO pedido_metodo_pago_eventos/.test(text)) return { rows: [{ id: 1 }] };
      if (/UPDATE pedidos/.test(text)) return { rows: [{ id: 101 }] };
      return { rows: [] };
    },
    release(error) { releaseError = error; },
  };
  const processor = createWhatsAppPaymentChoiceProcessor({ pool: { async connect() { return client; } } });
  await assert.rejects(choose(processor), error => error?.code === 'PAYMENT_CHOICE_OUTCOME_UNKNOWN'
    && !/private|transport|commit/i.test(error.message));
  assert.equal(statements.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(statements.includes('ROLLBACK'), false);
  assert.equal(releaseError?.code, 'PAYMENT_CHOICE_OUTCOME_UNKNOWN');
});
