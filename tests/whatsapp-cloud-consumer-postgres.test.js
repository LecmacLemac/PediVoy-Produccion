import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { CLOUD_DEADLINES } from '../src/whatsappCloud/deadlines.js';
import {
  claimNextCloudOutboxRow,
  finishCloudOutboxRow,
  markCloudDispatchStarted,
} from '../src/whatsappCloud/outboxRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
const options = { skip: available ? false : 'Requires local PostgreSQL binaries and a non-root user' };
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const migrationStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const migrationEnd = initSql.indexOf('CREATE TABLE IF NOT EXISTS push_subs (', migrationStart);
assert.ok(migrationStart >= 0 && migrationEnd > migrationStart);
const migrationSql = initSql.slice(migrationStart, migrationEnd);

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), '.whatsapp-cloud-consumer-pg-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_consumer_test', '--no-locale'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_consumer_test', database: 'postgres', max: 4 });
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
}

const rowsQuery = pool => async (sql, params = []) => (await pool.query(sql, params)).rows;

test('migración agrega lifecycle Cloud canónico e idempotente', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    const { rows } = await pool.query(`
      SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'wpp_outbox'
         AND column_name IN ('meta_message_id', 'cloud_dispatch_state', 'dispatch_started_at')
       ORDER BY column_name
    `);
    assert.deepEqual(rows, [
      { column_name: 'cloud_dispatch_state', data_type: 'text', character_maximum_length: null },
      { column_name: 'dispatch_started_at', data_type: 'timestamp with time zone', character_maximum_length: null },
      { column_name: 'meta_message_id', data_type: 'text', character_maximum_length: null },
    ]);
  });
});

test('migración legacy normaliza sending Cloud como dispatch_started no recuperable', options, async () => {
  await withDatabase(async pool => {
    await pool.query(`
      CREATE TABLE wpp_outbox (
        id SERIAL PRIMARY KEY, empresa_id INTEGER, telefono TEXT NOT NULL, mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT, transport_origin TEXT
      )
    `);
    await pool.query(`
      INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1, '1', 'legacy-inflight', 'sending', 'cloud')
    `);
    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const { rows } = await pool.query(`
      SELECT status, cloud_dispatch_state, dispatch_started_at IS NOT NULL AS has_started_at
        FROM wpp_outbox WHERE mensaje = 'legacy-inflight'
    `);
    assert.deepEqual(rows, [{ status: 'sending', cloud_dispatch_state: 'dispatch_started', has_started_at: true }]);
    assert.equal(await claimNextCloudOutboxRow({ query: rowsQuery(pool), owner: 'new-owner' }), null);
  });
});

test('migración legacy normaliza pre_dispatch con lease NULL y permite un solo reclaim fenced', options, async () => {
  await withDatabase(async pool => {
    await pool.query(`
      CREATE TABLE wpp_outbox (
        id SERIAL PRIMARY KEY, empresa_id INTEGER, telefono TEXT NOT NULL, mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT,
        claim_owner TEXT, claim_epoch BIGINT, claim_until TIMESTAMPTZ,
        transport_origin TEXT, cloud_dispatch_state TEXT, dispatch_started_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      INSERT INTO wpp_outbox (
        empresa_id, telefono, mensaje, status, transport_origin,
        cloud_dispatch_state, claim_owner, claim_until
      ) VALUES (1, '1', 'legacy-null-lease', 'sending', 'cloud', 'pre_dispatch', 'dead-owner', NULL)
    `);

    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const migrated = (await pool.query(`
      SELECT claim_until IS NOT NULL AS has_lease, claim_until <= NOW() AS lease_expired
        FROM wpp_outbox WHERE mensaje = 'legacy-null-lease'
    `)).rows[0];
    assert.deepEqual(migrated, { has_lease: true, lease_expired: true });

    const query = rowsQuery(pool);
    const claims = await Promise.all([
      claimNextCloudOutboxRow({ query, owner: 'owner-a' }),
      claimNextCloudOutboxRow({ query, owner: 'owner-b' }),
    ]);
    const claimed = claims.filter(Boolean);
    assert.equal(claimed.length, 1);
    const newOwner = claims[0] ? 'owner-a' : 'owner-b';
    await assert.rejects(
      markCloudDispatchStarted({ query, id: claimed[0].id, owner: 'dead-owner' }),
      error => error?.code === 'CLOUD_OUTBOX_CLAIM_LOST',
    );
    await markCloudDispatchStarted({ query, id: claimed[0].id, owner: newOwner });
    assert.equal(await claimNextCloudOutboxRow({ query, owner: 'owner-c' }), null);
  });
});

test('constraint rechaza estados Cloud incompatibles sin afectar filas Web', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await assert.rejects(
      pool.query(`
        INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state)
        VALUES (1, '1', 'bad-web', 'sending', 'company', 'pre_dispatch')
      `),
      error => error?.code === '23514',
    );
    await assert.rejects(
      pool.query(`
        INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state)
        VALUES (1, '1', 'bad-cloud', 'pending', 'cloud', 'sent')
      `),
      error => error?.code === '23514',
    );
    await pool.query(`
      INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1, '1', 'valid-web', 'sending', 'company')
    `);
  });
});

test('claims PostgreSQL concurrentes son atómicos, disjuntos y sólo Cloud', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin)
      VALUES
        (1, '1', 'cloud-a', 'cloud'),
        (2, '2', 'cloud-b', 'cloud'),
        (3, '3', 'company', 'company'),
        (NULL, '4', 'general', 'general')
    `);

    const query = rowsQuery(pool);
    const claimed = await Promise.all([
      claimNextCloudOutboxRow({ query, owner: 'worker-a' }),
      claimNextCloudOutboxRow({ query, owner: 'worker-b' }),
    ]);
    assert.deepEqual(new Set(claimed.map(row => row.mensaje)), new Set(['cloud-a', 'cloud-b']));
    assert.equal(new Set(claimed.map(row => row.id)).size, 2);

    const { rows } = await pool.query('SELECT mensaje, status, cloud_dispatch_state, claim_owner FROM wpp_outbox ORDER BY id');
    assert.deepEqual(rows.map(row => [row.mensaje, row.status, row.cloud_dispatch_state]), [
      ['cloud-a', 'sending', 'pre_dispatch'],
      ['cloud-b', 'sending', 'pre_dispatch'],
      ['company', 'pending', null],
      ['general', 'pending', null],
    ]);
    assert.ok(['worker-a', 'worker-b'].includes(rows[0].claim_owner));
    assert.ok(['worker-a', 'worker-b'].includes(rows[1].claim_owner));
    assert.notEqual(rows[0].claim_owner, rows[1].claim_owner);
  });
});

test('crash post-claim pre-dispatch se recupera tras lease vencido con nuevo owner', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(`INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin) VALUES (1, '1', 'recover', 'cloud')`);
    const query = rowsQuery(pool);
    const first = await claimNextCloudOutboxRow({ query, owner: 'owner-old' });
    await pool.query(`UPDATE wpp_outbox SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id]);

    const recovered = await claimNextCloudOutboxRow({ query, owner: 'owner-new' });

    assert.equal(recovered.id, first.id);
    const stored = (await pool.query('SELECT status, cloud_dispatch_state, claim_owner FROM wpp_outbox WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual(stored, { status: 'sending', cloud_dispatch_state: 'pre_dispatch', claim_owner: 'owner-new' });
  });
});

test('crash post-dispatch no se recupera automáticamente aunque venza lease', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(`INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin) VALUES (1, '1', 'unknown', 'cloud')`);
    const query = rowsQuery(pool);
    const row = await claimNextCloudOutboxRow({ query, owner: 'owner-old' });
    await markCloudDispatchStarted({ query, id: row.id, owner: 'owner-old' });
    await pool.query(`UPDATE wpp_outbox SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [row.id]);

    assert.equal(await claimNextCloudOutboxRow({ query, owner: 'owner-new' }), null);
    const stored = (await pool.query('SELECT status, cloud_dispatch_state, claim_owner FROM wpp_outbox WHERE id = $1', [row.id])).rows[0];
    assert.deepEqual(stored, { status: 'sending', cloud_dispatch_state: 'dispatch_started', claim_owner: 'owner-old' });
  });
});

test('owner vencido no finaliza después de reclaim fenced', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(`INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin) VALUES (1, '1', 'fenced', 'cloud')`);
    const query = rowsQuery(pool);
    const first = await claimNextCloudOutboxRow({ query, owner: 'owner-old' });
    await pool.query(`UPDATE wpp_outbox SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id]);
    await claimNextCloudOutboxRow({ query, owner: 'owner-new' });

    await assert.rejects(
      finishCloudOutboxRow({
        query,
        id: first.id,
        owner: 'owner-old',
        status: 'error',
        dispatchState: 'definitive_failed',
        errorCode: 'cloud_config_invalid',
      }),
      error => error?.code === 'CLOUD_OUTBOX_CLAIM_LOST',
    );
  });
});

test('dos consumidores sobre una fila no duplican claim ni dispatch', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(`INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin) VALUES (1, '1', 'single', 'cloud')`);
    const query = rowsQuery(pool);
    const claims = await Promise.all([
      claimNextCloudOutboxRow({ query, owner: 'owner-a' }),
      claimNextCloudOutboxRow({ query, owner: 'owner-b' }),
    ]);
    const claimed = claims.filter(Boolean);
    assert.equal(claimed.length, 1);
    await markCloudDispatchStarted({ query, id: claimed[0].id, owner: claims[0] ? 'owner-a' : 'owner-b' });
    assert.equal(await claimNextCloudOutboxRow({ query, owner: 'owner-c' }), null);
  });
});

test('PostgreSQL normaliza matriz hostil de leases, respeta límites y conserva fencing', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    const query = rowsQuery(pool);
    const cases = [
      ['nan', NaN, CLOUD_DEADLINES.lease.default],
      ['infinity', Infinity, CLOUD_DEADLINES.lease.default],
      ['negative-infinity', -Infinity, CLOUD_DEADLINES.lease.default],
      ['fraction-number', 1.5, CLOUD_DEADLINES.lease.default],
      ['exponent-string', '1e3', CLOUD_DEADLINES.lease.default],
      ['fraction-string', '1000.5', CLOUD_DEADLINES.lease.default],
      ['garbage', '10ms', CLOUD_DEADLINES.lease.default],
      ['overflow-string', '9007199254740992', CLOUD_DEADLINES.lease.default],
      ['overflow-number', 2 ** 40, CLOUD_DEADLINES.lease.default],
      ['zero', 0, CLOUD_DEADLINES.lease.default],
      ['negative', -1, CLOUD_DEADLINES.lease.default],
      ['below-min', String(CLOUD_DEADLINES.lease.min - 1), CLOUD_DEADLINES.lease.default],
      ['above-max', String(CLOUD_DEADLINES.lease.max + 1), CLOUD_DEADLINES.lease.default],
      ['min-string', String(CLOUD_DEADLINES.lease.min), CLOUD_DEADLINES.lease.min],
      ['max-string', String(CLOUD_DEADLINES.lease.max), CLOUD_DEADLINES.lease.max],
    ];

    for (const [label, leaseMs, expectedLeaseMs] of cases) {
      const message = `lease-${label}`;
      await pool.query(
        `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin) VALUES (1, '1', $1, 'cloud')`,
        [message],
      );
      const before = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
      const first = await claimNextCloudOutboxRow({ query, owner: `old-${label}`, leaseMs });
      const stored = (await pool.query(
        'SELECT claim_until, clock_timestamp() AS checked_at FROM wpp_outbox WHERE id = $1',
        [first.id],
      )).rows[0];
      const claimUntil = stored.claim_until.getTime();
      const checkedAt = stored.checked_at.getTime();
      assert.ok(claimUntil >= before + expectedLeaseMs, `${label}: lease menor al esperado`);
      assert.ok(claimUntil <= checkedAt + expectedLeaseMs, `${label}: lease mayor al esperado`);

      assert.equal(
        await claimNextCloudOutboxRow({ query, owner: `early-${label}`, leaseMs }),
        null,
        `${label}: segundo owner reclamó antes del vencimiento`,
      );

      await pool.query(`UPDATE wpp_outbox SET claim_until = NOW() - INTERVAL '1 millisecond' WHERE id = $1`, [first.id]);
      const reclaimed = await claimNextCloudOutboxRow({ query, owner: `new-${label}`, leaseMs });
      assert.equal(reclaimed.id, first.id, `${label}: no reclamó después del vencimiento`);
      await assert.rejects(
        markCloudDispatchStarted({ query, id: first.id, owner: `old-${label}` }),
        error => error?.code === 'CLOUD_OUTBOX_CLAIM_LOST',
      );
      await markCloudDispatchStarted({ query, id: first.id, owner: `new-${label}` });
    }
  });
});

test('fila sent registra id Meta sanitizado y no puede finalizarse por otro owner', options, async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    const { rows: inserted } = await pool.query(`
      INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, transport_origin)
      VALUES (1, '1', 'cloud', 'cloud') RETURNING id
    `);
    const query = rowsQuery(pool);
    const row = await claimNextCloudOutboxRow({ query, owner: 'owner-real' });
    assert.equal(row.id, inserted[0].id);
    await markCloudDispatchStarted({ query, id: row.id, owner: 'owner-real' });
    await assert.rejects(
      finishCloudOutboxRow({ query, id: row.id, owner: 'owner-ajeno', status: 'sent', dispatchState: 'sent', messageId: 'wamid.bad' }),
      error => error?.code === 'CLOUD_OUTBOX_CLAIM_LOST',
    );
    await finishCloudOutboxRow({
      query,
      id: row.id,
      owner: 'owner-real',
      status: 'sent',
      dispatchState: 'sent',
      messageId: 'wamid.safe\nheader',
    });
    const stored = (await pool.query('SELECT status, cloud_dispatch_state, meta_message_id, claim_owner FROM wpp_outbox WHERE id = $1', [row.id])).rows[0];
    assert.deepEqual(stored, { status: 'sent', cloud_dispatch_state: 'sent', meta_message_id: 'wamid.safeheader', claim_owner: null });
  });
});
