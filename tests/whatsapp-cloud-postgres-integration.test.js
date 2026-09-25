import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import pg from 'pg';

import { createWhatsAppCloudEventHandler } from '../src/whatsappCloud/eventRepository.js';
import {
  runTransactionOnLockedClient,
  withEmpresaWhatsappConfigLock,
} from '../src/wpp/companyConfigLock.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
const options = { skip: available ? false : 'Requires local PostgreSQL server binaries and a non-root user' };
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const start = initSql.indexOf('-- BEGIN WHATSAPP CLOUD INBOX MIGRATION');
const endMarker = '-- END WHATSAPP CLOUD INBOX MIGRATION';
const end = initSql.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start);
const migrationSql = initSql.slice(start, end + endMarker.length);
const empresasSource = readFileSync(new URL('../src/routes/empresas.js', import.meta.url), 'utf8');
const bootFunction = empresasSource.slice(
  empresasSource.indexOf('function scheduleEmpresaWppBootRecovery'),
  empresasSource.indexOf('function shouldAutoStartEmpresaWppWorker'),
);
const bootSqlMatch = bootFunction.match(/const rows = await query\(`([\s\S]*?)`\);/);
assert.ok(bootSqlMatch, 'boot recovery SQL must remain extractable for PostgreSQL policy tests');
const bootSql = bootSqlMatch[1];

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), '.whatsapp-cloud-pg-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_test', '--no-locale'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_test', database: 'postgres' });
    await work(pool);
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
}

test('config lock progresa y serializa con pool PostgreSQL de una conexión', options, async () => {
  await withDatabase(async pool => {
    await pool.query('CREATE TABLE empresa_config_lock_test (empresa_id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
    await pool.query('INSERT INTO empresa_config_lock_test VALUES (7, 0)');
    const smallPool = new pg.Pool({ ...pool.options, max: 1 });
    let connects = 0;
    let active = 0;
    let maxActive = 0;
    const instrumentedPool = {
      async connect() {
        connects += 1;
        return smallPool.connect();
      },
    };
    try {
      const update = () => withEmpresaWhatsappConfigLock(instrumentedPool, 7, async client => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await runTransactionOnLockedClient(client, async txQuery => {
            const rows = await txQuery(`
              UPDATE empresa_config_lock_test
                 SET version = version + 1
               WHERE empresa_id = 7
               RETURNING version
            `);
            await txQuery('SELECT pg_sleep(0.03)');
            return rows[0].version;
          });
        } finally {
          active -= 1;
        }
      });

      assert.deepEqual((await Promise.all([update(), update()])).sort(), [1, 2]);
      assert.equal(connects, 2, 'cada request debe adquirir exactamente un client');
      assert.equal(maxActive, 1, 'el advisory lock debe serializar callbacks');
      assert.equal((await smallPool.query('SELECT version FROM empresa_config_lock_test WHERE empresa_id = 7')).rows[0].version, 2);
    } finally {
      await smallPool.end();
    }
  });
});

test('migración Cloud deduplica concurrentemente por empresa y permite la misma clave entre empresas', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');

    const insert = (empresaId) => pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, event_data)
      VALUES ($1, 'message', 'message:concurrent-safe', 'concurrent-safe', '{}'::jsonb)
      ON CONFLICT (empresa_id, dedupe_key) DO NOTHING
      RETURNING id
    `, [empresaId]);
    const results = await Promise.all([insert(1), insert(1), insert(2), insert(2)]);
    assert.deepEqual(results.map(result => result.rowCount).sort(), [0, 0, 1, 1]);
    const { rows } = await pool.query(`
      SELECT empresa_id, dedupe_key, count(*)::int AS total
        FROM whatsapp_cloud_events
       GROUP BY empresa_id, dedupe_key
       ORDER BY empresa_id
    `);
    assert.deepEqual(rows, [
      { empresa_id: 1, dedupe_key: 'message:concurrent-safe', total: 1 },
      { empresa_id: 2, dedupe_key: 'message:concurrent-safe', total: 1 },
    ]);
  });
});

test('migración Cloud reemplaza una PK legacy incorrecta, agrega la FK y es reejecutable', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query('CREATE TABLE whatsapp_cloud_events (id BIGSERIAL, empresa_id INTEGER PRIMARY KEY)');
    await pool.query('CREATE UNIQUE INDEX idx_whatsapp_cloud_events_dedupe_key ON whatsapp_cloud_events ((id::text))');
    await pool.query('CREATE INDEX idx_whatsapp_cloud_events_empresa_received ON whatsapp_cloud_events (id)');
    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const { rows: columns } = await pool.query(`
      SELECT column_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'whatsapp_cloud_events'
         AND column_name IN ('id', 'empresa_id', 'event_kind', 'dedupe_key', 'message_id', 'event_data', 'received_at')
       ORDER BY column_name
    `);
    assert.deepEqual(columns, [
      { column_name: 'dedupe_key', is_nullable: 'NO' },
      { column_name: 'empresa_id', is_nullable: 'NO' },
      { column_name: 'event_data', is_nullable: 'NO' },
      { column_name: 'event_kind', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'message_id', is_nullable: 'NO' },
      { column_name: 'received_at', is_nullable: 'NO' },
    ]);
    const { rows: constraints } = await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition, convalidated
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_events'::regclass
         AND contype IN ('p', 'f')
       ORDER BY contype, conname
    `);
    assert.deepEqual(constraints, [
      {
        conname: 'whatsapp_cloud_events_empresa_id_fkey',
        contype: 'f',
        definition: 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE',
        convalidated: true,
      },
      {
        conname: 'whatsapp_cloud_events_pkey',
        contype: 'p',
        definition: 'PRIMARY KEY (id)',
        convalidated: true,
      },
    ]);
    const { rows: indexes } = await pool.query(`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'whatsapp_cloud_events'
         AND indexname IN (
           'idx_whatsapp_cloud_events_dedupe_key',
           'idx_whatsapp_cloud_events_empresa_received'
         )
       ORDER BY indexname
    `);
    assert.deepEqual(indexes.map(index => index.indexname), [
      'idx_whatsapp_cloud_events_dedupe_key',
      'idx_whatsapp_cloud_events_empresa_received',
    ]);
    assert.match(indexes[0].indexdef, /UNIQUE.*\(empresa_id, dedupe_key\)/i);
    assert.match(indexes[1].indexdef, /\(empresa_id, received_at\)/i);
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query("INSERT INTO whatsapp_cloud_events (empresa_id,event_kind,dedupe_key,message_id) VALUES (1,'message','ok','ok')");
    await assert.rejects(
      pool.query("INSERT INTO whatsapp_cloud_events (empresa_id,event_kind,dedupe_key,message_id) VALUES (999,'message','bad-fk','bad-fk')"),
      error => error?.code === '23503'
    );
    await assert.rejects(
      pool.query("INSERT INTO whatsapp_cloud_events (empresa_id,event_kind,dedupe_key,message_id) VALUES (1,'other','bad','bad')"),
      error => error?.code === '23514'
    );
  });
});

test('migración Cloud exige phone_number_id normalizado único solo para asociaciones Cloud activas', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(migrationSql);

    const cloud = (enabled, phoneNumberId, provider = 'cloud', token = 'v1:test') => ({
      whatsapp: { provider, enabled, phone_number_id: phoneNumberId, access_token_encrypted: token },
    });
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, 'phone-unique')]);
    await assert.rejects(
      pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, 'phone-unique')]),
      error => error?.code === '23505'
        && error?.constraint === 'idx_empresas_whatsapp_cloud_phone_number_id_unique'
    );
    await assert.rejects(
      pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, 'phone-unique', ' Cloud ')]),
      error => error?.code === '23505'
        && error?.constraint === 'idx_empresas_whatsapp_cloud_phone_number_id_unique'
    );
    await assert.rejects(
      pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, '  phone-unique  ', '  CLOUD  ')]),
      error => error?.code === '23505'
        && error?.constraint === 'idx_empresas_whatsapp_cloud_phone_number_id_unique'
    );
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(false, 'phone-unique')]);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud('true', 'phone-unique')]);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, 'phone-unique', 'web')]);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, 'phone-unique', 'cloud', '')]);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(true, 'phone-unique', 'cloud', '   ')]);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1), ($2)', [cloud(true, ''), cloud(true, '')]);

    const { rows: indexes } = await pool.query(`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'
    `);
    assert.equal(indexes.length, 1);
    assert.match(indexes[0].indexdef, /UNIQUE.*btrim\(COALESCE\([^)]*phone_number_id/i);
  });
});

test('webhook resuelve provider y phone_number_id normalizados sin ambigüedad', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(migrationSql);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [{
      whatsapp: {
        provider: '  ClOuD  ',
        enabled: true,
        phone_number_id: ' webhook-phone ',
        access_token_encrypted: ' v1:test ',
      },
    }]);

    const withTransaction = async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(async (sql, params = []) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const handler = createWhatsAppCloudEventHandler({ withTransaction });
    assert.deepEqual(await handler([{
      kind: 'message',
      phoneNumberId: ' webhook-phone ',
      message: { id: 'normalized-provider-message', from: 'sender', timestamp: '1', type: 'text', text: { body: 'safe' } },
    }]), { accepted: 1, duplicates: 0 });

    const { rows } = await pool.query('SELECT empresa_id, message_id FROM whatsapp_cloud_events');
    assert.deepEqual(rows, [{ empresa_id: 1, message_id: 'normalized-provider-message' }]);
  });
});

test('webhook resuelve tenant con config_integraciones JSON y omite estructuras inválidas', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSON)");
    await pool.query(migrationSql);
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1::json), ($2::json), ($3::json)', [
      JSON.stringify({ whatsapp: { provider: ' cloud ', enabled: true, phone_number_id: 'json-phone', access_token_encrypted: 'v1:test' } }),
      JSON.stringify({ whatsapp: null }),
      JSON.stringify('scalar'),
    ]);
    const withTransaction = async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(async (sql, params = []) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };
    const handler = createWhatsAppCloudEventHandler({ withTransaction });
    assert.deepEqual(await handler([{
      kind: 'message', phoneNumberId: 'json-phone',
      message: { id: 'json-message', from: 'sender', timestamp: '1', type: 'text', text: { body: 'safe' } },
    }]), { accepted: 1, duplicates: 0 });
  });
});

test('migración Cloud configura timeouts locales antes del primer LOCK', () => {
  const begin = migrationSql.indexOf('BEGIN;');
  const lockTimeout = migrationSql.indexOf("SET LOCAL lock_timeout = '30s';");
  const statementTimeout = migrationSql.indexOf("SET LOCAL statement_timeout = '5min';");
  const firstLock = migrationSql.search(/\bLOCK TABLE\b/);
  assert.ok(begin >= 0 && lockTimeout > begin && statementTimeout > lockTimeout && firstLock > statementTimeout);
});

test('boot recovery aplica fail-closed canónico con columnas JSON y JSONB', options, async () => {
  for (const dataType of ['JSON', 'JSONB']) {
    await withDatabase(async pool => {
      await pool.query(`CREATE TABLE empresas (
        id SERIAL PRIMARY KEY,
        config_integraciones ${dataType},
        wpp_status TEXT DEFAULT 'disconnected'
      )`);
      const cases = [
        [null, false],
        ['scalar', false],
        [[], false],
        [{ whatsapp: null }, false],
        [{ whatsapp: 'cloud' }, false],
        [{ whatsapp: [] }, false],
        [{}, true],
        [{ whatsapp: {} }, true],
        [{ whatsapp: { provider: 'cloud', enabled: true } }, true],
        [{ whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'boot', access_token_encrypted: 'v1:test' } }, false],
      ];
      const expected = [];
      for (const [config, eligible] of cases) {
        const value = config === null ? null : JSON.stringify(config);
        const { rows } = await pool.query(
          `INSERT INTO empresas(config_integraciones) VALUES ($1::${dataType.toLowerCase()}) RETURNING id`,
          [value],
        );
        if (eligible) expected.push(rows[0].id);
      }
      assert.deepEqual((await pool.query(bootSql)).rows.map(row => row.id), expected, dataType);
    });
  }
});

test('migración reemplaza índice Cloud previo sin guardas estructurales', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(`
      CREATE UNIQUE INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique
        ON empresas ((BTRIM(COALESCE((config_integraciones::jsonb #>> '{whatsapp,phone_number_id}'), ''))))
       WHERE LOWER(BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'provider', ''))) = 'cloud'
         AND jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
         AND CASE
               WHEN jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
                 THEN ((config_integraciones::jsonb)->'whatsapp'->>'enabled')::boolean
               ELSE FALSE
             END IS TRUE
         AND BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', '')) <> ''
         AND BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'access_token_encrypted', '')) <> ''
    `);
    const before = (await pool.query(`SELECT indexrelid::text AS oid FROM pg_index WHERE indexrelid = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'::regclass`)).rows[0];
    await pool.query(migrationSql);
    const after = (await pool.query(`SELECT indexrelid::text AS oid, pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'::regclass`)).rows[0];
    assert.notEqual(after.oid, before.oid);
    assert.match(after.definition, /jsonb_typeof\([^)]*config_integraciones[^)]*\) = 'object'/i);
    assert.match(after.definition, /\? 'whatsapp'/i);
  });
});

test('migración Cloud acota contención, revierte y permite reintento', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query("INSERT INTO empresas(config_integraciones) VALUES ('{}'::jsonb)");
    await pool.query('CREATE UNIQUE INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique ON empresas (id)');
    const before = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'`)).rows;
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE empresas IN ACCESS EXCLUSIVE MODE');
      const boundedSql = migrationSql.replace("SET LOCAL lock_timeout = '30s';", "SET LOCAL lock_timeout = '250ms';");
      const startedAt = Date.now();
      await assert.rejects(pool.query(boundedSql), error => error?.code === '55P03' && !/phone_number_id|access_token/i.test(error.message));
      assert.ok(Date.now() - startedAt < 3000, 'lock timeout must bound migration wait');
      await locker.query('ROLLBACK');
      const afterFailure = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'`)).rows;
      assert.deepEqual(afterFailure, before);
      assert.equal((await pool.query('SELECT count(*)::int AS total FROM empresas')).rows[0].total, 1);
      await pool.query(migrationSql);
      assert.match((await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'`)).rows[0].indexdef, /config_integraciones/i);
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      locker.release();
    }
  });
});

test('migración Cloud falla cerrado y sin exponer phone_number_id ante colisiones legacy normalizadas', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    const cloud = phoneNumberId => ({
      whatsapp: { provider: ' cloud ', enabled: true, phone_number_id: phoneNumberId, access_token_encrypted: 'v1:test' },
    });
    await pool.query(
      'INSERT INTO empresas(config_integraciones) VALUES ($1), ($2)',
      [cloud('legacy-sensitive-id'), cloud(' legacy-sensitive-id ')],
    );
    await pool.query(`
      CREATE UNIQUE INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique
        ON empresas ((config_integraciones #>> '{whatsapp,phone_number_id}'))
       WHERE config_integraciones #>> '{whatsapp,provider}' = ' cloud '
         AND config_integraciones #>> '{whatsapp,enabled}' = 'true'
    `);
    const { rows: beforeIndexes } = await pool.query(`
      SELECT indexrelid::text AS oid, pg_get_indexdef(indexrelid) AS definition
        FROM pg_index
       WHERE indexrelid = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'::regclass
    `);

    await assert.rejects(pool.query(migrationSql), error => {
      assert.equal(error.code, '23505');
      assert.match(error.message, /phone_number_id.*duplicad|duplicate.*phone_number_id/i);
      assert.doesNotMatch(error.message, /legacy-sensitive-id/);
      return true;
    });
    const { rows } = await pool.query('SELECT count(*)::int AS total FROM empresas');
    assert.deepEqual(rows, [{ total: 2 }]);
    const { rows: afterIndexes } = await pool.query(`
      SELECT indexrelid::text AS oid, pg_get_indexdef(indexrelid) AS definition
        FROM pg_index
       WHERE indexrelid = 'idx_empresas_whatsapp_cloud_phone_number_id_unique'::regclass
    `);
    assert.deepEqual(afterIndexes, beforeIndexes, 'la migración fallida no debe borrar el índice legacy');
  });
});

test('migración Cloud soporta config_integraciones JSON y conserva unicidad normalizada al reejecutar', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSON NOT NULL DEFAULT '{}'::json)");
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    const cloud = phoneNumberId => ({
      whatsapp: { provider: ' CLOUD ', enabled: true, phone_number_id: phoneNumberId, access_token_encrypted: 'v1:test' },
    });
    await pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud('json-phone')]);
    await assert.rejects(
      pool.query('INSERT INTO empresas(config_integraciones) VALUES ($1)', [cloud(' json-phone ')]),
      error => error?.code === '23505'
        && error?.constraint === 'idx_empresas_whatsapp_cloud_phone_number_id_unique',
    );
  });
});

test('migración Cloud agrega id BIGINT con secuencia sincronizada a tabla legacy sin id', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query('CREATE TABLE whatsapp_cloud_events (empresa_id INTEGER)');
    await pool.query(migrationSql);
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    const { rows } = await pool.query(`
      INSERT INTO whatsapp_cloud_events (empresa_id, event_kind, dedupe_key, message_id)
      VALUES (1, 'message', 'legacy-no-id', 'legacy-no-id')
      RETURNING id, pg_typeof(id)::text AS id_type
    `);
    assert.equal(rows[0].id_type, 'bigint');
    assert.ok(Number(rows[0].id) > 0);
  });
});

test('migración Cloud repara default de id y FK legacy RESTRICT sin reconstruir objetos correctos', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      CREATE TABLE whatsapp_cloud_events (
        id BIGINT,
        empresa_id INTEGER,
        event_kind TEXT,
        dedupe_key TEXT,
        message_id TEXT,
        CONSTRAINT legacy_empresa_restrict FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE RESTRICT
      )
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events(id, empresa_id, event_kind, dedupe_key, message_id)
      VALUES (41, 1, 'message', 'legacy-existing', 'legacy-existing')
    `);
    await pool.query(migrationSql);

    const { rows: inserted } = await pool.query(`
      INSERT INTO whatsapp_cloud_events (empresa_id, event_kind, dedupe_key, message_id)
      VALUES (1, 'message', 'after-sync', 'after-sync')
      RETURNING id
    `);
    assert.ok(Number(inserted[0].id) > 41);

    const objectSnapshot = async () => (await pool.query(`
      SELECT 'constraint' AS object_type, conname AS name, oid, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_events'::regclass
         AND conname IN (
           'whatsapp_cloud_events_pkey',
           'whatsapp_cloud_events_empresa_id_fkey',
           'whatsapp_cloud_events_kind_check'
         )
      UNION ALL
      SELECT 'index', indexrelid::regclass::text, indexrelid, pg_get_indexdef(indexrelid)
        FROM pg_index
       WHERE indexrelid IN (
         'idx_whatsapp_cloud_events_dedupe_key'::regclass,
         'idx_whatsapp_cloud_events_empresa_received'::regclass,
         'idx_empresas_whatsapp_cloud_phone_number_id_unique'::regclass
       )
      UNION ALL
      SELECT 'sequence', relname, oid, NULL
        FROM pg_class
       WHERE oid = 'whatsapp_cloud_events_id_seq'::regclass
      ORDER BY object_type, name
    `)).rows;

    const before = await objectSnapshot();
    await pool.query(migrationSql);
    const after = await objectSnapshot();
    assert.deepEqual(after, before);

    const { rows: foreignKeys } = await pool.query(`
      SELECT conname, pg_get_constraintdef(oid) AS definition, convalidated
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_events'::regclass AND contype = 'f'
    `);
    assert.deepEqual(foreignKeys, [{
      conname: 'whatsapp_cloud_events_empresa_id_fkey',
      definition: 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE',
      convalidated: true,
    }]);
  });
});

test('lock de atribución serializa la reasignación antes de persistir el evento', options, async () => {
  await withDatabase(async pool => {
    await pool.query("CREATE TABLE empresas (id SERIAL PRIMARY KEY, config_integraciones JSONB NOT NULL DEFAULT '{}'::jsonb)");
    await pool.query(migrationSql);
    const cloudConfig = phoneNumberId => ({
      whatsapp: {
        provider: 'cloud',
        enabled: true,
        phone_number_id: phoneNumberId,
        access_token_encrypted: 'v1:test',
      },
    });
    await pool.query(
      'INSERT INTO empresas(id, config_integraciones) VALUES (1, $1), (2, $2)',
      [cloudConfig('phone-lock'), {}]
    );

    let resolveLocked;
    const locked = new Promise(resolve => { resolveLocked = resolve; });
    let releaseInsert;
    const insertGate = new Promise(resolve => { releaseInsert = resolve; });
    const withTransaction = async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(async (sql, params = []) => {
          const queryResult = await client.query(sql, params);
          if (sql.includes('FROM empresas')) resolveLocked();
          if (sql.includes('INSERT INTO whatsapp_cloud_events')) await insertGate;
          return queryResult.rows;
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const handler = createWhatsAppCloudEventHandler({ withTransaction });
    const handling = handler([{
      kind: 'message',
      phoneNumberId: 'phone-lock',
      message: { id: 'locked-message', from: 'sender', timestamp: '1', type: 'text', text: { body: 'safe' } },
    }]);
    await locked;

    let reassignmentFinished = false;
    const reassignment = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE empresas SET config_integraciones = '{}'::jsonb WHERE id = 1");
        await client.query('UPDATE empresas SET config_integraciones = $1 WHERE id = 2', [cloudConfig('phone-lock')]);
        await client.query('COMMIT');
        reassignmentFinished = true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(reassignmentFinished, false, 'la reasignación debe esperar el FOR SHARE');
    releaseInsert();
    await handling;
    await reassignment;

    const { rows: events } = await pool.query(
      'SELECT empresa_id FROM whatsapp_cloud_events WHERE message_id = $1',
      ['locked-message']
    );
    assert.deepEqual(events, [{ empresa_id: 1 }]);
    const { rows: currentTenant } = await pool.query(`
      SELECT id
        FROM empresas
       WHERE config_integraciones #>> '{whatsapp,phone_number_id}' = 'phone-lock'
    `);
    assert.deepEqual(currentTenant, [{ id: 2 }]);
  });
});
