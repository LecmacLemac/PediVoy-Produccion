import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { resolvePostgresIntegrationGate } from './support/wpp-postgres-integration-gate.js';
import { CloudDeliveryOutcome, createWhatsAppCloudConsumer } from '../src/whatsappCloud/consumer.js';
import { createWhatsAppCloudGraphClient } from '../src/whatsappCloud/graphClient.js';
import { createCloudOps } from '../src/whatsappCloud/opsRepository.js';

const gate = resolvePostgresIntegrationGate();
const options = { skip: gate.skip };
const container = `pedivoy-cloud-ops-${randomUUID()}`;
let pool;
let ops;
let migrationSql;

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, DOCKER_HOST: gate.host },
    ...options,
  }).trim();
}

async function waitForPostgres(targetPool) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await targetPool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

before(async () => {
  if (gate.skip) return;
  const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
  const start = initSql.indexOf('-- BEGIN WHATSAPP CLOUD OPS MIGRATION');
  const end = initSql.indexOf('-- END WHATSAPP CLOUD OPS MIGRATION', start);
  assert.ok(start >= 0 && end > start, 'falta migración Cloud ops');
  migrationSql = initSql.slice(start, end);

  docker([
    'run', '--detach', '--rm', '--name', container,
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '--publish', '127.0.0.1::5432', 'postgres:16',
  ]);
  const port = Number(docker(['port', container, '5432/tcp']).split(':').at(-1));
  pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 8 });
  await waitForPostgres(pool);
  await pool.query(`
    CREATE TABLE wpp_outbox (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER,
      telefono TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      claim_owner TEXT,
      claim_epoch BIGINT,
      claim_until TIMESTAMPTZ,
      transport_origin TEXT,
      meta_message_id TEXT,
      cloud_dispatch_state TEXT,
      dispatch_started_at TIMESTAMPTZ
    )
  `);
  await pool.query(migrationSql);
  ops = createCloudOps({ pool });
});

after(async () => {
  if (pool) await pool.end();
  if (!gate.skip) {
    try { docker(['rm', '--force', container], { stdio: 'ignore' }); } catch {}
  }
});

beforeEach(async () => {
  if (gate.skip) return;
  await pool.query('TRUNCATE whatsapp_cloud_ops_audit, wpp_outbox RESTART IDENTITY');
});

async function insertCloud({
  empresaId = 7,
  status = 'sending',
  state = 'dispatch_started',
  error = null,
  metaMessageId = null,
  telefono = '5493512345678',
  mensaje = 'contenido privado',
} = {}) {
  const { rows } = await pool.query(`
    INSERT INTO wpp_outbox (
      empresa_id, telefono, mensaje, status, error, transport_origin,
      cloud_dispatch_state, dispatch_started_at, meta_message_id,
      claim_owner, claim_epoch, claim_until
    ) VALUES (
      $1, $2, $3, $4, $5, 'cloud', $6,
      CASE WHEN $6 IN ('dispatch_started', 'outcome_unknown', 'manual_retryable') THEN NOW() ELSE NULL END,
      $7, 'dead-worker', 9, NOW() - INTERVAL '1 minute'
    ) RETURNING id
  `, [empresaId, telefono, mensaje, status, error, state, metaMessageId]);
  return rows[0].id;
}

test('migración ops es idempotente y crea auditoría e índice operativo', options, async () => {
  await pool.query(migrationSql);
  const table = await pool.query("SELECT to_regclass('whatsapp_cloud_ops_audit') AS name");
  assert.equal(table.rows[0].name, 'whatsapp_cloud_ops_audit');
  const indexes = await pool.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname IN ('wpp_outbox_cloud_ops_idx', 'whatsapp_cloud_ops_audit_outbox_idx')
     ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map(row => row.indexname), [
    'whatsapp_cloud_ops_audit_outbox_idx',
    'wpp_outbox_cloud_ops_idx',
  ]);
});

test('listado filtra estados Cloud y nunca devuelve PII, payload ni errores libres', options, async () => {
  await insertCloud({ state: 'dispatch_started', error: 'token=secret teléfono 5493512345678' });
  const unknownId = await insertCloud({
    empresaId: 8, status: 'error', state: 'outcome_unknown',
    error: 'cloud_dispatch_unknown', metaMessageId: 'wamid.safe\nheader',
  });
  await insertCloud({ status: 'error', state: 'definitive_failed', error: 'meta_rejected' });
  await pool.query(`
    INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, transport_origin)
    VALUES (8, '5499999999999', 'otro secreto', 'pending', 'cloud')
  `);

  const rows = await ops.list({ empresaId: 8, state: 'outcome_unknown', limit: 10 });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: unknownId,
    empresa_id: 8,
    status: 'error',
    cloud_dispatch_state: 'outcome_unknown',
    created_at: rows[0].created_at,
    dispatch_started_at: rows[0].dispatch_started_at,
    sent_at: null,
    error_code: 'cloud_dispatch_unknown',
    meta_message_id: 'wamid.safeheader',
  });
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /telefono|mensaje|token|549351|contenido|otro secreto/i);

  const defaults = await ops.list({});
  assert.deepEqual(new Set(defaults.map(row => row.cloud_dispatch_state)), new Set(['dispatch_started', 'outcome_unknown']));
  const includingFinal = await ops.list({ includeDefinitiveFailed: true });
  assert.ok(includingFinal.some(row => row.cloud_dispatch_state === 'definitive_failed'));
});

test('listado expone todos los códigos sanitizados reales de consumer/Graph y oculta unknown', options, async () => {
  const graphCases = [
    [
      'cloud_payload_invalid',
      createWhatsAppCloudGraphClient({ fetchImpl: async () => assert.fail('payload inválido no llama Graph') }),
      { phoneNumberId: '', accessToken: 'token', to: '3515550000', text: 'hola' },
    ],
    [
      'cloud_rate_limited',
      createWhatsAppCloudGraphClient({ fetchImpl: async () => new Response('', { status: 429 }) }),
      { phoneNumberId: '123', accessToken: 'token', to: '3515550000', text: 'hola' },
    ],
    [
      'cloud_remote_rejected',
      createWhatsAppCloudGraphClient({ fetchImpl: async () => new Response('', { status: 400 }) }),
      { phoneNumberId: '123', accessToken: 'token', to: '3515550000', text: 'hola' },
    ],
    [
      'cloud_dispatch_unknown',
      createWhatsAppCloudGraphClient({ fetchImpl: async () => new Response('', { status: 503 }) }),
      { phoneNumberId: '123', accessToken: 'token', to: '3515550000', text: 'hola' },
    ],
  ];
  const produced = [];
  for (const [expectedCode, client, input] of graphCases) {
    const result = await client.sendText(input);
    assert.equal(result.errorCode, expectedCode);
    produced.push([expectedCode, result.outcome]);
  }

  for (const code of ['cloud_config_invalid', 'cloud_token_invalid']) {
    const finishes = [];
    const consumer = createWhatsAppCloudConsumer({
      owner: `producer-${code}`,
      claimNext: async () => ({ id: 900, empresa_id: 7, telefono: '3515550000', mensaje: 'hola' }),
      loadConfig: async () => code === 'cloud_config_invalid'
        ? null
        : { phoneNumberId: '123', accessTokenEncrypted: 'cipher' },
      startDispatch: async () => assert.fail('no debe iniciar dispatch'),
      finish: async update => finishes.push(update),
      decryptToken: () => { throw new Error('detalle secreto'); },
      graphClient: { sendText: async () => assert.fail('no debe llamar Graph') },
      logger: { info() {}, warn() {}, error() {} },
    });
    const result = await consumer.processOnce();
    assert.equal(result.errorCode, code);
    assert.equal(finishes[0].errorCode, code);
    produced.push([code, result.outcome]);
  }

  for (const [code, outcome] of produced) {
    const state = outcome === CloudDeliveryOutcome.RETRYABLE_REJECTED
      ? 'manual_retryable'
      : outcome === CloudDeliveryOutcome.UNKNOWN
        ? 'outcome_unknown'
        : 'definitive_failed';
    await insertCloud({ status: 'error', state, error: code });
  }
  const unknownId = await insertCloud({ status: 'error', state: 'outcome_unknown', error: 'cloud_free_form_secret=5493512345678' });

  const rows = await ops.list({ includeDefinitiveFailed: true, limit: 50 });
  const byCode = new Map(rows.map(row => [row.error_code, row]));
  for (const code of produced.map(([value]) => value)) assert.ok(byCode.has(code), `faltó ${code}`);
  assert.equal(rows.find(row => row.id === unknownId)?.error_code, null);
  assert.doesNotMatch(JSON.stringify(rows), /cloud_free_form_secret|5493512345678/);
});

test('mark-sent exige id Meta válido, resuelve sólo ambiguos y audita sin PII', options, async () => {
  const id = await insertCloud({ status: 'error', state: 'outcome_unknown', error: 'cloud_dispatch_unknown' });
  await assert.rejects(
    ops.markSent({ id, actor: 'guardia', metaMessageId: 'bad id con espacios' }),
    error => error?.code === 'OPS_INVALID_ARGUMENT',
  );

  const result = await ops.markSent({ id, actor: 'guardia', metaMessageId: 'wamid.HBgMNTQ5:abc-_42' });
  assert.deepEqual(result, { id, status: 'sent', cloud_dispatch_state: 'sent' });
  const stored = (await pool.query(`
    SELECT status, cloud_dispatch_state, sent_at IS NOT NULL AS sent, error,
           meta_message_id, claim_owner, claim_epoch, claim_until
      FROM wpp_outbox WHERE id = $1
  `, [id])).rows[0];
  assert.deepEqual(stored, {
    status: 'sent', cloud_dispatch_state: 'sent', sent: true, error: null,
    meta_message_id: 'wamid.HBgMNTQ5:abc-_42', claim_owner: null, claim_epoch: null, claim_until: null,
  });
  const audit = (await pool.query('SELECT * FROM whatsapp_cloud_ops_audit WHERE outbox_id = $1', [id])).rows[0];
  assert.equal(audit.action, 'mark_sent');
  assert.equal(audit.actor, 'guardia');
  assert.equal(audit.reason_code, 'meta_delivery_confirmed');
  assert.doesNotMatch(JSON.stringify(audit), /549351|contenido privado/i);
  await assert.rejects(
    ops.markSent({ id, actor: 'otro', metaMessageId: 'wamid.other' }),
    error => error?.code === 'OPS_STALE_STATE',
  );
});

test('mark-failed y confirm-not-sent aceptan sólo reasons allowlisted', options, async () => {
  const failedId = await insertCloud();
  await assert.rejects(
    ops.markFailed({ id: failedId, actor: 'ops', reason: 'texto libre con teléfono 5493512345678' }),
    error => error?.code === 'OPS_INVALID_ARGUMENT',
  );
  await ops.markFailed({ id: failedId, actor: 'ops', reason: 'meta_rejected' });

  const retryId = await insertCloud({ status: 'error', state: 'outcome_unknown' });
  await ops.confirmNotSent({ id: retryId, actor: 'ops', reason: 'meta_confirmed_not_sent' });

  const { rows } = await pool.query(`
    SELECT id, status, cloud_dispatch_state, error, claim_owner, meta_message_id
      FROM wpp_outbox ORDER BY id
  `);
  assert.deepEqual(rows, [
    { id: failedId, status: 'error', cloud_dispatch_state: 'definitive_failed', error: 'meta_rejected', claim_owner: null, meta_message_id: null },
    { id: retryId, status: 'error', cloud_dispatch_state: 'manual_retryable', error: 'meta_confirmed_not_sent', claim_owner: null, meta_message_id: null },
  ]);
});

test('replay sólo manual_retryable reutiliza la fila y limpia lifecycle sin bypass de dedupe', options, async () => {
  const ambiguousId = await insertCloud();
  await assert.rejects(
    ops.replay({ id: ambiguousId, actor: 'ops', reason: 'manual_replay' }),
    error => error?.code === 'OPS_STALE_STATE',
  );

  const id = await insertCloud({ status: 'error', state: 'manual_retryable', error: 'cloud_rate_limited', metaMessageId: 'wamid.old' });
  const beforeCount = Number((await pool.query('SELECT count(*) AS total FROM wpp_outbox')).rows[0].total);
  const result = await ops.replay({ id, actor: 'ops', reason: 'manual_replay' });
  const afterCount = Number((await pool.query('SELECT count(*) AS total FROM wpp_outbox')).rows[0].total);
  assert.equal(afterCount, beforeCount);
  assert.deepEqual(result, { id, status: 'pending', cloud_dispatch_state: null });
  const stored = (await pool.query(`
    SELECT status, cloud_dispatch_state, dispatch_started_at, sent_at, error,
           meta_message_id, claim_owner, claim_epoch, claim_until, transport_origin
      FROM wpp_outbox WHERE id = $1
  `, [id])).rows[0];
  assert.deepEqual(stored, {
    status: 'pending', cloud_dispatch_state: null, dispatch_started_at: null,
    sent_at: null, error: null, meta_message_id: null, claim_owner: null,
    claim_epoch: null, claim_until: null, transport_origin: 'cloud',
  });
  const audit = (await pool.query(`
    SELECT actor, reason_code, action, from_cloud_dispatch_state, to_status
      FROM whatsapp_cloud_ops_audit WHERE outbox_id = $1
  `, [id])).rows[0];
  assert.deepEqual(audit, {
    actor: 'ops', reason_code: 'manual_replay', action: 'replay',
    from_cloud_dispatch_state: 'manual_retryable', to_status: 'pending',
  });
});

test('dos operadores sobre la misma fila quedan serializados y el segundo falla cerrado', options, async () => {
  const id = await insertCloud({ status: 'error', state: 'outcome_unknown' });
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM wpp_outbox WHERE id = $1 FOR UPDATE', [id]);

  let settled = false;
  const competing = ops.confirmNotSent({ id, actor: 'operador-b', reason: 'meta_confirmed_not_sent' })
    .finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false, 'el segundo operador no esperó el row lock');

  await blocker.query(`
    UPDATE wpp_outbox
       SET status = 'sent', cloud_dispatch_state = 'sent', sent_at = NOW(),
           error = NULL, meta_message_id = 'wamid.operator-a',
           claim_owner = NULL, claim_epoch = NULL, claim_until = NULL
     WHERE id = $1
  `, [id]);
  await blocker.query('COMMIT');
  blocker.release();

  await assert.rejects(competing, error => error?.code === 'OPS_STALE_STATE');
  const audits = await pool.query('SELECT count(*)::int AS total FROM whatsapp_cloud_ops_audit WHERE outbox_id = $1', [id]);
  assert.equal(audits.rows[0].total, 0);
});
