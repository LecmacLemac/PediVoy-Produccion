import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { basename, join } from 'node:path';
import pg from 'pg';
import { createCloudOps } from '../src/whatsappCloud/opsRepository.js';
import { updateCloudConversationState } from '../src/whatsappCloud/inboxRepository.js';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL focal gate requires local initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');
const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const outboxStart = initSql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox (');
const outboxEndMarker = '-- END WPP OUTBOX MIGRATION';
const outboxEnd = initSql.indexOf(outboxEndMarker, outboxStart);
const projectionStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION');
const projectionEndMarker = '-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION';
const projectionEnd = initSql.indexOf(projectionEndMarker, projectionStart);
assert.ok(outboxStart >= 0 && outboxEnd > outboxStart, 'initDb.sql must expose the outbox migration');
assert.ok(projectionStart >= 0 && projectionEnd > projectionStart, 'initDb.sql must expose the inbox projection migration');
const outboxSql = initSql.slice(outboxStart, outboxEnd + outboxEndMarker.length);
const projectionSql = initSql.slice(projectionStart, projectionEnd + projectionEndMarker.length);
const migrationSql = `${outboxSql}\n${projectionSql}`;
const opsStart = initSql.indexOf('-- BEGIN WHATSAPP CLOUD OPS MIGRATION');
const opsEndMarker = '-- END WHATSAPP CLOUD OPS MIGRATION';
const opsEnd = initSql.indexOf(opsEndMarker, opsStart);
assert.ok(opsStart >= 0 && opsEnd > opsStart, 'initDb.sql must expose the Cloud ops migration');
const opsSql = initSql.slice(opsStart, opsEnd + opsEndMarker.length);
const projectionStructureFixture = JSON.parse(readFileSync(
  new URL('./fixtures/whatsapp-cloud-message-projection-structure.json', import.meta.url),
  'utf8',
));
const tempPrefix = '.whatsapp-cloud-inbox-pg-';
const createdDirectories = new Set();

async function withDatabase(work, { bootstrap = true } = {}) {
  const directory = mkdtempSync(join(process.cwd(), tempPrefix));
  createdDirectories.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', directory, '-A', 'trust', '-U', 'cloud_inbox_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'cloud_inbox_test', database: 'postgres' });
    if (bootstrap) {
      await pool.query('CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
      await pool.query(`
        CREATE TABLE whatsapp_cloud_events (
          id BIGSERIAL PRIMARY KEY,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          event_kind TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          message_id TEXT NOT NULL,
          sender_id TEXT,
          recipient_id TEXT,
          message_type TEXT,
          status TEXT,
          source_timestamp TEXT,
          event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (empresa_id, dedupe_key)
        )
      `);
    }
    await work(pool, { directory, port });
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', directory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
}

function runPsqlFile({ port, file }) {
  return new Promise(resolve => {
    const child = spawn(join(bin, 'psql'), [
      '-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'cloud_inbox_test',
      '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', file,
    ], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

async function waitUntil(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function indexShape(pool, indexName) {
  return (await pool.query(`
    SELECT index_row.indisunique,
           index_row.indnkeyatts,
           index_row.indnatts,
           index_row.indexprs IS NOT NULL AS has_expressions,
           index_row.indoption::TEXT AS sort_options,
           COALESCE(array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
             FILTER (WHERE key_column.ordinality <= index_row.indnkeyatts), ARRAY[]::TEXT[]) AS key_columns,
           pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_index AS index_row
      CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      LEFT JOIN pg_attribute AS attribute_row
        ON attribute_row.attrelid = index_row.indrelid
       AND attribute_row.attnum = key_column.attnum
     WHERE index_row.indexrelid = $1::regclass
     GROUP BY index_row.indisunique, index_row.indnkeyatts, index_row.indnatts,
              index_row.indexprs, index_row.indoption, index_row.indpred, index_row.indrelid
  `, [indexName])).rows[0];
}

function assertSanitizedProviderIdentityDuplicate(error, forbiddenValues = []) {
  assert.equal(error?.code, 'P0001');
  assert.equal(error?.message, 'whatsapp_cloud_messages_provider_identity_duplicates');
  for (const property of ['detail', 'hint']) assert.equal(error?.[property], undefined);
  for (const property of Object.getOwnPropertyNames(error ?? {})) {
    const exposed = String(error?.[property] ?? '');
    for (const value of forbiddenValues) {
      assert.equal(exposed.includes(value), false, `${property} must not expose ${value}`);
    }
  }
  return true;
}

async function triggerShape(pool, tableName, triggerName = 'whatsapp_cloud_messages_capture_insert') {
  return (await pool.query(`
    SELECT table_namespace.nspname AS table_schema,
           table_row.relname AS table_name,
           trigger_row.tgenabled,
           trigger_row.tgtype,
           trigger_row.tgisinternal,
           trigger_row.tgfoid::pg_catalog.regprocedure::text AS function_name,
           pg_catalog.encode(trigger_row.tgargs, 'escape') AS arguments,
           pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
      JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_row.relnamespace
     WHERE trigger_row.tgrelid = $1::pg_catalog.regclass
       AND trigger_row.tgname = $2
  `, [tableName, triggerName])).rows[0];
}

function projectionCutoverPhases() {
  const scanBoundary = projectionSql.indexOf('-- CUTOVER CAPTURE COMMITTED; SOURCE SCANS FOLLOW');
  const backfillBegin = projectionSql.lastIndexOf('BEGIN;', scanBoundary);
  assert.ok(scanBoundary > 0 && backfillBegin > 0,
    'projection migration must expose separate committed install and backfill transactions');
  return {
    installSql: projectionSql.slice(0, backfillBegin),
    backfillSql: projectionSql.slice(backfillBegin),
  };
}

test('migración de conversaciones rechaza triggers ajenos antes de ejecutar DML', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      CREATE TABLE whatsapp_cloud_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        participant_wa_id TEXT NOT NULL UNIQUE,
        workflow_status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query("INSERT INTO whatsapp_cloud_conversations(empresa_id, participant_wa_id) VALUES (1, '5493515550001')");
    await pool.query('CREATE SEQUENCE destructive_trigger_probe');
    await pool.query(`
      CREATE FUNCTION destructive_conversation_trigger() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM nextval('destructive_trigger_probe');
        DELETE FROM whatsapp_cloud_conversations WHERE id = NEW.id;
        RETURN NULL;
      END
      $fn$;
      CREATE TRIGGER destructive_conversation_update
        AFTER UPDATE ON whatsapp_cloud_conversations
        FOR EACH ROW EXECUTE FUNCTION destructive_conversation_trigger()
    `);
    const snapshot = () => pool.query(`
      SELECT table_row.id::text, table_row.participant_wa_id, table_row.xmin::text,
             table_class.oid::text AS table_oid,
             trigger_row.oid::text AS trigger_oid,
             procedure_row.oid::text AS procedure_oid
        FROM whatsapp_cloud_conversations AS table_row
        CROSS JOIN pg_class AS table_class
        CROSS JOIN pg_trigger AS trigger_row
        CROSS JOIN pg_proc AS procedure_row
       WHERE table_class.oid = 'whatsapp_cloud_conversations'::regclass
         AND trigger_row.tgrelid = table_class.oid
         AND trigger_row.tgname = 'destructive_conversation_update'
         AND procedure_row.oid = trigger_row.tgfoid
    `);
    const before = (await snapshot()).rows;

    await assert.rejects(pool.query(projectionSql), error => {
      assert.equal(error.code, 'P0001');
      assert.equal(error.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error.detail, undefined);
      assert.equal(error.hint, undefined);
      return true;
    });

    assert.deepEqual((await snapshot()).rows, before);
    assert.deepEqual(
      (await pool.query('SELECT last_value::text, is_called FROM destructive_trigger_probe')).rows,
      [{ last_value: '1', is_called: false }],
      'el trigger destructivo no debe llegar a dispararse',
    );
  });
});

test('migración de conversaciones rechaza vistas dependientes antes de DDL y sin mutar objetos', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      CREATE TABLE whatsapp_cloud_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
        participant_wa_id TEXT NOT NULL,
        workflow_status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO whatsapp_cloud_conversations(empresa_id, participant_wa_id)
      VALUES (1, '5493515550002');
      CREATE VIEW legacy_conversation_participants AS
      SELECT id, participant_wa_id FROM whatsapp_cloud_conversations
    `);
    const snapshot = () => pool.query(`
      SELECT conversation.id::text, conversation.participant_wa_id, conversation.xmin::text,
             table_row.oid::text AS table_oid,
             view_row.oid::text AS view_oid,
             pg_get_viewdef(view_row.oid, true) AS view_definition
        FROM whatsapp_cloud_conversations AS conversation
        CROSS JOIN pg_class AS table_row
        CROSS JOIN pg_class AS view_row
       WHERE table_row.oid = 'whatsapp_cloud_conversations'::regclass
         AND view_row.oid = 'legacy_conversation_participants'::regclass
    `);
    const before = (await snapshot()).rows;

    await assert.rejects(pool.query(projectionSql), error => {
      assert.equal(error.code, 'P0001');
      assert.equal(error.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error.detail, undefined);
      assert.equal(error.hint, undefined);
      return true;
    });
    assert.deepEqual((await snapshot()).rows, before);
  });
});

for (const dependency of [
  {
    name: 'rules',
    install: `CREATE RULE legacy_conversation_update_rule AS
      ON UPDATE TO whatsapp_cloud_conversations DO ALSO SELECT 1`,
    snapshot: `SELECT oid::text, rulename, pg_get_ruledef(oid, true) AS definition
      FROM pg_rewrite
      WHERE ev_class = 'whatsapp_cloud_conversations'::regclass
        AND rulename = 'legacy_conversation_update_rule'`,
  },
  {
    name: 'materialized views',
    install: `CREATE MATERIALIZED VIEW legacy_conversation_priorities AS
      SELECT id, priority FROM whatsapp_cloud_conversations`,
    snapshot: `SELECT oid::text, relname, relkind
      FROM pg_class
      WHERE oid = 'legacy_conversation_priorities'::regclass`,
  },
  {
    name: 'inheritance',
    install: `CREATE TABLE legacy_conversation_child ()
      INHERITS (whatsapp_cloud_conversations)`,
    snapshot: `SELECT inhrelid::regclass::text AS child, inhparent::regclass::text AS parent
      FROM pg_inherits
      WHERE inhparent = 'whatsapp_cloud_conversations'::regclass`,
  },
]) {
  test(`migración de conversaciones rechaza ${dependency.name} antes de DDL`, async () => {
    await withDatabase(async pool => {
      await pool.query('INSERT INTO empresas(id) VALUES (1)');
      await pool.query(migrationSql);
      await pool.query(`
        INSERT INTO whatsapp_cloud_conversations(empresa_id, participant_wa_id)
        VALUES (1, '5493515550007');
        ${dependency.install}
      `);
      const beforeRow = (await pool.query(`
        SELECT id::text, xmin::text FROM whatsapp_cloud_conversations
      `)).rows;
      const beforeDependency = (await pool.query(dependency.snapshot)).rows;

      await assert.rejects(pool.query(projectionSql), error => {
        assert.equal(error?.code, 'P0001');
        assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
        assert.equal(error?.detail, undefined);
        assert.equal(error?.hint, undefined);
        return true;
      });
      assert.deepEqual((await pool.query(`
        SELECT id::text, xmin::text FROM whatsapp_cloud_conversations
      `)).rows, beforeRow);
      assert.deepEqual((await pool.query(dependency.snapshot)).rows, beforeDependency);
    });
  });
}

test('migración de conversaciones rechaza policies RLS antes de reparar columnas o filas', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations
        (empresa_id, participant_wa_id, workflow_status, priority, version)
      VALUES (1, '5493515550005', 'resolved', 'urgent', 9);
      ALTER TABLE whatsapp_cloud_conversations ALTER COLUMN priority DROP DEFAULT;
      ALTER TABLE whatsapp_cloud_conversations ENABLE ROW LEVEL SECURITY;
      CREATE POLICY legacy_priority_visibility ON whatsapp_cloud_conversations
        USING (priority = 'urgent')
    `);
    const snapshot = () => pool.query(`
      SELECT conversation.id::text, conversation.xmin::text, conversation.priority,
             table_row.oid::text AS table_oid,
             policy_row.oid::text AS policy_oid,
             pg_get_expr(policy_row.polqual, policy_row.polrelid) AS policy_using,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS priority_default
        FROM whatsapp_cloud_conversations AS conversation
        CROSS JOIN pg_class AS table_row
        CROSS JOIN pg_policy AS policy_row
        JOIN pg_attribute AS priority_column
          ON priority_column.attrelid = table_row.oid AND priority_column.attname = 'priority'
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = priority_column.attrelid
         AND default_row.adnum = priority_column.attnum
       WHERE table_row.oid = 'whatsapp_cloud_conversations'::regclass
         AND policy_row.polrelid = table_row.oid
         AND policy_row.polname = 'legacy_priority_visibility'
    `);
    const before = (await snapshot()).rows;

    await assert.rejects(pool.query(projectionSql), error => {
      assert.equal(error?.code, 'P0001');
      assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error?.detail, undefined);
      assert.equal(error?.hint, undefined);
      assert.doesNotMatch(JSON.stringify(error), /urgent|priority_visibility/i);
      return true;
    });
    assert.deepEqual((await snapshot()).rows, before);
  });
});

async function conversationRlsSnapshot(pool) {
  const [relation, columns, rows] = await Promise.all([
    pool.query(`
      SELECT oid::text AS table_oid, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE oid = 'whatsapp_cloud_conversations'::regclass
    `),
    pool.query(`
      SELECT attribute_row.attnum,
             attribute_row.attname,
             attribute_row.atttypid::regtype::text AS data_type,
             attribute_row.attnotnull,
             attribute_row.atthasdef,
             default_row.oid::text AS default_oid,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
        FROM pg_attribute AS attribute_row
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = attribute_row.attrelid
         AND default_row.adnum = attribute_row.attnum
       WHERE attribute_row.attrelid = 'whatsapp_cloud_conversations'::regclass
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
       ORDER BY attribute_row.attnum
    `),
    pool.query(`
      SELECT id::text, empresa_id, participant_wa_id, workflow_status, priority, version,
             created_at::text, updated_at::text, xmin::text
        FROM whatsapp_cloud_conversations
       ORDER BY id
    `),
  ]);
  return { relation: relation.rows, columns: columns.rows, rows: rows.rows };
}

async function assertRlsWithoutPoliciesRejected(pool, { force }) {
  await pool.query('INSERT INTO empresas(id) VALUES (1)');
  await pool.query(migrationSql);
  await pool.query(`
    INSERT INTO whatsapp_cloud_conversations
      (empresa_id, participant_wa_id, workflow_status, priority, version)
    VALUES (1, '5493515550008', 'resolved', 'high', 17);
    ALTER TABLE whatsapp_cloud_conversations ALTER COLUMN priority DROP DEFAULT;
    ALTER TABLE whatsapp_cloud_conversations ENABLE ROW LEVEL SECURITY;
    ${force ? 'ALTER TABLE whatsapp_cloud_conversations FORCE ROW LEVEL SECURITY;' : ''}
  `);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count
      FROM pg_policy
     WHERE polrelid = 'whatsapp_cloud_conversations'::regclass
  `)).rows[0].count, 0);

  const before = await conversationRlsSnapshot(pool);
  assert.deepEqual(before.relation, [{
    table_oid: before.relation[0].table_oid,
    relrowsecurity: true,
    relforcerowsecurity: force,
  }]);

  await assert.rejects(pool.query(projectionSql), error => {
    assert.equal(error?.code, 'P0001');
    assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
    assert.equal(error?.detail, undefined);
    assert.equal(error?.hint, undefined);
    assert.doesNotMatch(JSON.stringify(error), /5493515550008|resolved|high/i);
    return true;
  });
  assert.deepEqual(await conversationRlsSnapshot(pool), before);
}

test('migración de conversaciones rechaza ENABLE RLS sin policies antes de DDL o DML', async () => {
  await withDatabase(pool => assertRlsWithoutPoliciesRejected(pool, { force: false }));
});

test('migración de conversaciones rechaza FORCE RLS sin policies y preserva ambos flags', async () => {
  await withDatabase(pool => assertRlsWithoutPoliciesRejected(pool, { force: true }));
});

test('migración de conversaciones retiene lock de tabla desde el inventario hasta canonicalizar', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      CREATE FUNCTION concurrent_conversation_trigger() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RETURN NEW;
      END
      $fn$
    `);
    const pauseMarker = 'END $conversation_relation_guard$;';
    assert.ok(projectionSql.includes(pauseMarker));
    const controlledMigrationSql = projectionSql.replace(
      pauseMarker,
      `${pauseMarker}\nSELECT pg_catalog.pg_sleep(1);`,
    );
    const migrationClient = await pool.connect();
    const triggerClient = await pool.connect();
    try {
      const migration = migrationClient.query(controlledMigrationSql);
      await waitUntil(async () => (await pool.query(`
        SELECT wait_event
          FROM pg_stat_activity
         WHERE pid = $1
      `, [migrationClient.processID])).rows[0]?.wait_event === 'PgSleep',
      'la migración debe alcanzar la pausa controlada después del inventario');

      await triggerClient.query("SET lock_timeout = '200ms'");
      await assert.rejects(triggerClient.query(`
        CREATE TRIGGER concurrent_conversation_update
          BEFORE UPDATE ON whatsapp_cloud_conversations
          FOR EACH ROW EXECUTE FUNCTION concurrent_conversation_trigger()
      `), error => {
        assert.equal(error?.code, '55P03');
        return true;
      });
      await migration;
      assert.equal((await pool.query(`
        SELECT count(*)::integer AS count
          FROM pg_trigger
         WHERE tgrelid = 'whatsapp_cloud_conversations'::regclass
           AND tgname = 'concurrent_conversation_update'
      `)).rows[0].count, 0);
    } finally {
      await migrationClient.query('ROLLBACK').catch(() => {});
      migrationClient.release();
      triggerClient.release();
    }
  });
});

test('migración de conversaciones rechaza constraints ajenas sin eliminarlas ni mutar filas', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations
        (empresa_id, participant_wa_id, workflow_status, priority, version)
      VALUES (1, '5493515550006', 'resolved', 'high', 12);
      ALTER TABLE whatsapp_cloud_conversations ALTER COLUMN priority DROP DEFAULT;
      ALTER TABLE whatsapp_cloud_conversations
        ADD CONSTRAINT legacy_conversation_version_ceiling CHECK (version < 100)
    `);
    const snapshot = () => pool.query(`
      SELECT conversation.id::text, conversation.xmin::text, conversation.version,
             table_row.oid::text AS table_oid,
             constraint_row.oid::text AS constraint_oid,
             pg_get_constraintdef(constraint_row.oid, true) AS constraint_definition,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS priority_default
        FROM whatsapp_cloud_conversations AS conversation
        CROSS JOIN pg_class AS table_row
        CROSS JOIN pg_constraint AS constraint_row
        JOIN pg_attribute AS priority_column
          ON priority_column.attrelid = table_row.oid AND priority_column.attname = 'priority'
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = priority_column.attrelid
         AND default_row.adnum = priority_column.attnum
       WHERE table_row.oid = 'whatsapp_cloud_conversations'::regclass
         AND constraint_row.conrelid = table_row.oid
         AND constraint_row.conname = 'legacy_conversation_version_ceiling'
    `);
    const before = (await snapshot()).rows;

    await assert.rejects(pool.query(projectionSql), error => {
      assert.equal(error?.code, 'P0001');
      assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error?.detail, undefined);
      assert.equal(error?.hint, undefined);
      assert.doesNotMatch(JSON.stringify(error), /version_ceiling|version < 100/i);
      return true;
    });
    assert.deepEqual((await snapshot()).rows, before);
  });
});

test('migración de conversaciones rechaza EXCLUDE ajena antes de reparar defaults u objetos', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations
        (empresa_id, participant_wa_id, workflow_status, priority, version)
      VALUES (1, '5493515550009', 'resolved', 'high', 23);
      ALTER TABLE whatsapp_cloud_conversations ALTER COLUMN priority DROP DEFAULT;
      ALTER TABLE whatsapp_cloud_conversations
        ADD CONSTRAINT legacy_conversation_empresa_exclude
        EXCLUDE USING hash (empresa_id WITH =)
    `);

    const snapshot = async () => {
      const [relation, constraints, indexes, columns, rows] = await Promise.all([
        pool.query(`
          SELECT oid::text AS table_oid
            FROM pg_class
           WHERE oid = 'whatsapp_cloud_conversations'::regclass
        `),
        pool.query(`
          SELECT oid::text AS constraint_oid, conname, contype,
                 conindid::text AS index_oid,
                 pg_get_constraintdef(oid, true) AS definition
            FROM pg_constraint
           WHERE conrelid = 'whatsapp_cloud_conversations'::regclass
           ORDER BY conname
        `),
        pool.query(`
          SELECT index_row.indexrelid::text AS index_oid,
                 index_class.relname,
                 pg_get_indexdef(index_row.indexrelid) AS definition
            FROM pg_index AS index_row
            JOIN pg_class AS index_class ON index_class.oid = index_row.indexrelid
           WHERE index_row.indrelid = 'whatsapp_cloud_conversations'::regclass
           ORDER BY index_class.relname
        `),
        pool.query(`
          SELECT attribute_row.attname,
                 attribute_row.atthasdef,
                 default_row.oid::text AS default_oid,
                 pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
            FROM pg_attribute AS attribute_row
            LEFT JOIN pg_attrdef AS default_row
              ON default_row.adrelid = attribute_row.attrelid
             AND default_row.adnum = attribute_row.attnum
           WHERE attribute_row.attrelid = 'whatsapp_cloud_conversations'::regclass
             AND attribute_row.attnum > 0
             AND NOT attribute_row.attisdropped
           ORDER BY attribute_row.attnum
        `),
        pool.query(`
          SELECT id::text, empresa_id, participant_wa_id, workflow_status, priority, version,
                 created_at::text, updated_at::text, xmin::text
            FROM whatsapp_cloud_conversations
           ORDER BY id
        `),
      ]);
      return {
        relation: relation.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
        columns: columns.rows,
        rows: rows.rows,
      };
    };

    const before = await snapshot();
    const alien = before.constraints.find(row => row.conname === 'legacy_conversation_empresa_exclude');
    assert.equal(alien?.contype, 'x');
    assert.equal(alien?.definition, 'EXCLUDE USING hash (empresa_id WITH =)');
    assert.equal(
      before.columns.find(row => row.attname === 'priority')?.default_expression,
      null,
    );

    await assert.rejects(pool.query(projectionSql), error => {
      assert.equal(error?.code, 'P0001');
      assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error?.detail, undefined);
      assert.equal(error?.hint, undefined);
      assert.doesNotMatch(JSON.stringify(error), /5493515550009|empresa_exclude|empresa_id/i);
      return true;
    });
    assert.deepEqual(await snapshot(), before);
  });
});

test('migración de conversaciones es estructuralmente idempotente en esquema canónico', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      INSERT INTO whatsapp_cloud_conversations
        (empresa_id, participant_wa_id, workflow_status, priority, version, created_at, updated_at)
      VALUES
        (1, '5493515550003', 'resolved', 'urgent', 7,
         '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')
    `);
    const snapshot = () => pool.query(`
      SELECT object_type, name, oid, definition
        FROM (
          SELECT 'constraint'::text AS object_type,
                 constraint_row.conname AS name,
                 constraint_row.oid::text AS oid,
                 pg_get_constraintdef(constraint_row.oid, true) AS definition
            FROM pg_constraint AS constraint_row
           WHERE constraint_row.conrelid = 'whatsapp_cloud_conversations'::regclass
          UNION ALL
          SELECT 'index', index_row.indexrelid::regclass::text,
                 index_row.indexrelid::text, pg_get_indexdef(index_row.indexrelid)
            FROM pg_index AS index_row
           WHERE index_row.indrelid = 'whatsapp_cloud_conversations'::regclass
          UNION ALL
          SELECT 'column', attribute_row.attname, attribute_row.attnum::text,
                 concat_ws('|', attribute_row.atttypid::regtype::text,
                   attribute_row.attnotnull::text,
                   COALESCE(pg_get_expr(default_row.adbin, default_row.adrelid), '<none>'))
            FROM pg_attribute AS attribute_row
            LEFT JOIN pg_attrdef AS default_row
              ON default_row.adrelid = attribute_row.attrelid
             AND default_row.adnum = attribute_row.attnum
           WHERE attribute_row.attrelid = 'whatsapp_cloud_conversations'::regclass
             AND attribute_row.attnum > 0
             AND NOT attribute_row.attisdropped
          UNION ALL
          SELECT 'row', conversation.id::text, conversation.xmin::text,
                 concat_ws('|', conversation.empresa_id::text, conversation.participant_wa_id,
                   conversation.workflow_status, conversation.priority, conversation.version::text,
                   conversation.created_at::text, conversation.updated_at::text)
            FROM whatsapp_cloud_conversations AS conversation
        ) AS snapshot_rows
       ORDER BY object_type, name
    `);
    const before = (await snapshot()).rows;

    await pool.query(projectionSql);

    assert.deepEqual((await snapshot()).rows, before,
      'segunda ejecución no debe reescribir filas ni reconstruir estructura canónica');
  });
});

test('migración de conversaciones repara sólo estructura divergente', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query("INSERT INTO whatsapp_cloud_conversations(empresa_id, participant_wa_id) VALUES (1, '5493515550004')");
    const stableSnapshot = () => pool.query(`
      SELECT conname AS name, oid::text, pg_get_constraintdef(oid, true) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_conversations'::regclass
         AND conname IN (
           'whatsapp_cloud_conversations_pkey',
           'whatsapp_cloud_conversations_empresa_id_fkey',
           'whatsapp_cloud_conversations_empresa_participant_key',
           'whatsapp_cloud_conversations_participant_check',
           'whatsapp_cloud_conversations_workflow_status_check',
           'whatsapp_cloud_conversations_version_check',
           'whatsapp_cloud_conversations_timestamps_check'
         )
       ORDER BY conname
    `);
    const beforeStable = (await stableSnapshot()).rows;
    const beforeRow = (await pool.query(`
      SELECT id::text, xmin::text, workflow_status, priority, version, updated_at::text
        FROM whatsapp_cloud_conversations
    `)).rows;

    await pool.query(`
      ALTER TABLE whatsapp_cloud_conversations ALTER COLUMN priority DROP DEFAULT;
      ALTER TABLE whatsapp_cloud_conversations DROP CONSTRAINT whatsapp_cloud_conversations_priority_check;
      DROP INDEX idx_whatsapp_cloud_conversations_queue
    `);
    await pool.query(projectionSql);

    assert.deepEqual((await stableSnapshot()).rows, beforeStable,
      'objetos correctos no deben reconstruirse durante una reparación parcial');
    assert.deepEqual((await pool.query(`
      SELECT id::text, xmin::text, workflow_status, priority, version, updated_at::text
        FROM whatsapp_cloud_conversations
    `)).rows, beforeRow, 'la reparación estructural no debe versionar filas');
    assert.equal((await pool.query(`
      SELECT pg_get_expr(default_row.adbin, default_row.adrelid) AS expression
        FROM pg_attribute AS column_row
        JOIN pg_attrdef AS default_row
          ON default_row.adrelid = column_row.attrelid AND default_row.adnum = column_row.attnum
       WHERE column_row.attrelid = 'whatsapp_cloud_conversations'::regclass
         AND column_row.attname = 'priority'
    `)).rows[0].expression, "'normal'::text");
    assert.equal((await pool.query(`
      SELECT pg_get_constraintdef(oid, true) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_conversations'::regclass
         AND conname = 'whatsapp_cloud_conversations_priority_check'
    `)).rows[0].definition,
    "CHECK (priority = ANY (ARRAY['normal'::text, 'high'::text, 'urgent'::text]))");
    assert.match((await pool.query(`
      SELECT pg_get_indexdef('idx_whatsapp_cloud_conversations_queue'::regclass) AS definition
    `)).rows[0].definition, /\(empresa_id, workflow_status, priority, updated_at DESC, id\)$/);
  });
});

test('gate estructural fija captura DELETE statement-level antes del commit de instalación', () => {
  const installCommit = projectionSql.indexOf(projectionStructureFixture.installCommitMarker);
  const backfill = projectionSql.indexOf(projectionStructureFixture.backfillMarker);
  assert.ok(installCommit > 0 && backfill > installCommit);

  const cleanupLockFunction = projectionSql.match(
    /CREATE OR REPLACE FUNCTION public\.whatsapp_cloud_messages_lock_projection_cleanup\([\s\S]*?END \$\$;/,
  )?.[0];
  assert.ok(cleanupLockFunction, 'shared cleanup lock protocol must be installed');
  assert.ok(projectionSql.indexOf(cleanupLockFunction) < installCommit,
    'shared cleanup lock protocol must commit before backfill');
  const runtimeBinding = cleanupLockFunction.indexOf("'pedivoy.whatsapp_cloud_projection_empresa_id'");
  const cleanupMaximum = cleanupLockFunction.indexOf(
    "'pedivoy.whatsapp_cloud_projection_cleanup_max_empresa_id'",
  );
  const descendingRejection = cleanupLockFunction.indexOf(
    "MESSAGE = 'whatsapp_cloud_projection_cleanup_lock_order'",
  );
  const tenantLock = cleanupLockFunction.indexOf(
    'PERFORM public.whatsapp_cloud_messages_lock_projection_migration(target_empresa_id);',
  );
  const maximumWrite = cleanupLockFunction.indexOf('PERFORM pg_catalog.set_config(');
  assert.ok(runtimeBinding >= 0 && cleanupMaximum > runtimeBinding
    && descendingRejection > cleanupMaximum && tenantLock > descendingRejection
    && maximumWrite > tenantLock,
  'binding/order validation must precede every cleanup advisory and the max advances after locks');
  assert.match(cleanupLockFunction,
    /array_agg\(distinct_tenant\.empresa_id ORDER BY distinct_tenant\.empresa_id\)[\s\S]*SELECT DISTINCT requested\.empresa_id/i,
    'shared protocol must normalize unique tenants in ascending order');
  assert.match(cleanupLockFunction,
    /requested\.empresa_id < cleanup_max_empresa_id[\s\S]*whatsapp_cloud_projection_cleanup_lock_order/i,
    'shared protocol must reject every tenant below the retained maximum');
  assert.match(cleanupLockFunction,
    /whatsapp_cloud_projection_cross_tenant_transaction/i,
    'shared protocol must preserve the runtime transaction binding');
  const runtimeLockFunction = projectionSql.match(
    /CREATE OR REPLACE FUNCTION public\.whatsapp_cloud_messages_lock_projection\([\s\S]*?END \$\$;/,
  )?.[0];
  assert.ok(runtimeLockFunction, 'runtime tenant lock protocol must be installed');
  const runtimeCleanupMaximum = runtimeLockFunction.indexOf(
    "'pedivoy.whatsapp_cloud_projection_cleanup_max_empresa_id'",
  );
  const runtimeDescendingRejection = runtimeLockFunction.indexOf(
    "MESSAGE = 'whatsapp_cloud_projection_cleanup_lock_order'",
  );
  const runtimeAdvisory = runtimeLockFunction.indexOf(
    'PERFORM pg_catalog.pg_advisory_xact_lock(1464550735, target_empresa_id);',
  );
  assert.ok(runtimeCleanupMaximum >= 0 && runtimeDescendingRejection > runtimeCleanupMaximum
    && runtimeAdvisory > runtimeDescendingRejection,
  'runtime binding after cleanup must reject descending tenants before its advisory');

  for (const spec of projectionStructureFixture.deleteTriggers) {
    const functionBlock = projectionSql.match(new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${spec.function}\\(\\)[\\s\\S]*?END \\$\\$;`,
    ))?.[0];
    assert.ok(functionBlock, `${spec.function} must be installed by the DDL phase`);
    assert.ok(projectionSql.indexOf(functionBlock) < installCommit,
      `${spec.function} must commit before backfill`);
    assert.match(functionBlock,
      new RegExp(`whatsapp_cloud_messages_lock_projection_cleanup\\(ARRAY\\([\\s\\S]*SELECT DISTINCT deleted\\.empresa_id[\\s\\S]*FROM ${spec.transition} AS deleted[\\s\\S]*ORDER BY deleted\\.empresa_id[\\s\\S]*\\)\\)`),
      `${spec.function} must collect ordered OLD tenants before the shared lock protocol`);
    const cleanupGuard = functionBlock.indexOf(
      'PERFORM public.whatsapp_cloud_messages_lock_projection_cleanup(ARRAY(',
    );
    const firstProjectionLockOrWrite = functionBlock.search(
      /(?:INSERT INTO public\.whatsapp_cloud_messages|whatsapp_cloud_messages_upsert_outbox_locked|FOR UPDATE OF message)/,
    );
    assert.ok(cleanupGuard >= 0 && firstProjectionLockOrWrite > cleanupGuard,
      `${spec.function} must finish cleanup order validation/locking before projection work`);
    assert.doesNotMatch(functionBlock,
      /whatsapp_cloud_messages_lock_projection(?:_migration)?\(target_empresa_id\)/,
      `${spec.function} must not bypass the shared cleanup protocol`);
    assert.match(projectionSql, new RegExp(
      `CREATE TRIGGER ${spec.trigger} AFTER DELETE ON public\\.${spec.table.split('.')[1]} REFERENCING OLD TABLE AS ${spec.transition} FOR EACH STATEMENT EXECUTE FUNCTION public\\.${spec.function}\\(\\)`,
    ));
  }
});

async function seedBackfillSources(pool) {
  await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
  await pool.query(`
    INSERT INTO whatsapp_cloud_events
      (empresa_id, event_kind, dedupe_key, message_id, sender_id, recipient_id,
       message_type, status, source_timestamp, event_data, received_at)
    VALUES
      (1, 'message', 'message:in-text', 'in-text', '549351555001', NULL,
       'text', NULL, '1760000000',
       '{"text":{"body":"hola"},"opaque":"no-copy"}'::jsonb, '2026-10-01T10:00:00Z'),
      (1, 'message', 'message:in-image', 'in-image', '549351555001', NULL,
       'image', NULL, '1760000001',
       '{"image":{"id":"secret-media-image","sha256":"secret-sha","mime_type":"image/jpeg","caption":"foto"}}'::jsonb, '2026-10-01T10:00:01Z'),
      (1, 'message', 'message:in-document', 'in-document', '549351555001', NULL,
       'document', NULL, 'invalid-timestamp',
       '{"document":{"id":"secret-media-document","sha256":"secret-doc-sha","mime_type":"application/pdf","caption":"factura","filename":"factura.pdf"}}'::jsonb, '2026-10-01T10:00:02Z'),
      (1, 'message', 'message:unsupported', 'unsupported', '549351555001', NULL,
       'audio', NULL, '1760000002', '{"audio":{"id":"must-not-copy"}}'::jsonb, NOW()),
      (1, 'message', 'message:bad-sender', 'bad-sender', '+54 9 351 555 001', NULL,
       'text', NULL, '1760000003', '{"text":{"body":"ambiguous"}}'::jsonb, NOW()),
      (2, 'message', 'message:tenant-two', 'tenant-two', '549351555001', NULL,
       'text', NULL, '1760000004', '{"text":{"body":"otro tenant"}}'::jsonb, NOW()),
      (1, 'status', 'status:out-sent:delivered:1760000010', 'out-sent', NULL, '549351555002',
       NULL, 'delivered', '1760000010', '{"opaque":"status-payload"}'::jsonb, NOW()),
      (1, 'status', 'status:out-sent:read:1760000020', 'out-sent', NULL, '549351555002',
       NULL, 'read', '1760000020', '{"opaque":"status-payload"}'::jsonb, NOW())
  `);
  await pool.query(migrationSql);
  await pool.query(`
    INSERT INTO wpp_outbox
      (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
       meta_message_id, cloud_dispatch_state)
    VALUES
      (1, '549351555002', 'respuesta', '2026-10-01T11:00:00Z', '2026-10-01T11:00:01Z',
       'sent', 'cloud', 'out-sent', 'sent'),
      (1, '549351555003', 'pendiente', '2026-10-01T12:00:00Z', NULL,
       'pending', 'cloud', NULL, NULL),
      (1, '549351555004', 'reintentar', '2026-10-01T13:00:00Z', NULL,
       'error', 'cloud', NULL, 'manual_retryable'),
      (1, '549351555005', 'incierto', '2026-10-01T14:00:00Z', NULL,
       'error', 'cloud', NULL, 'outcome_unknown'),
      (1, '549351555006@c.us', 'legacy jid', NOW(), NULL,
       'pending', 'cloud', NULL, NULL),
      (1, '+54 9 351 555 007', 'legacy formatted', NOW(), NULL,
       'pending', 'cloud', NULL, NULL),
      (1, '549351555008', 'web only', NOW(), NULL,
       'pending', 'company', NULL, NULL),
      (NULL, '549351555009', 'general only', NOW(), NULL,
       'pending', 'general', NULL, NULL)
  `);
}

async function assertMixedTenantRuntimeTransactionRejected(pool, tenantOrder) {
  const client = await pool.connect();
  let rejection;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
    await client.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
      VALUES ($1, 'message', $2, $3, '549351555081', 'text',
              '{"text":{"body":"primer tenant"}}'::jsonb)
    `, [tenantOrder[0], `mixed:${tenantOrder.join('-')}:first`, `mixed-${tenantOrder.join('-')}-first`]);

    await assert.rejects(client.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
      VALUES ($1, 'message', $2, $3, '549351555082', 'text',
              '{"text":{"body":"segundo tenant"}}'::jsonb)
    `, [tenantOrder[1], `mixed:${tenantOrder.join('-')}:second`, `mixed-${tenantOrder.join('-')}-second`]),
    error => {
      rejection = error;
      return error?.code === 'P0001'
        && error?.message === 'whatsapp_cloud_projection_cross_tenant_transaction'
        && error?.code !== '40P01';
    });
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  assert.ok(rejection, 'cross-tenant insert must expose one sanitized PostgreSQL error');
  assert.equal(rejection.message, 'whatsapp_cloud_projection_cross_tenant_transaction');
  for (const property of ['detail', 'hint', 'schema', 'table', 'constraint']) {
    assert.equal(rejection[property], undefined, `${property} must not expose tenant context`);
  }
  for (const property of ['message', 'detail', 'hint', 'where', 'schema', 'table', 'constraint']) {
    const exposed = String(rejection[property] ?? '');
    for (const tenantId of tenantOrder) {
      assert.equal(exposed.includes(String(tenantId)), false,
        `${property} must not contain tenant id ${tenantId}`);
    }
  }

  assert.deepEqual((await pool.query(`
    SELECT
      (SELECT count(*)::int FROM public.whatsapp_cloud_events
        WHERE dedupe_key LIKE $1) AS source_total,
      (SELECT count(*)::int FROM public.whatsapp_cloud_messages
        WHERE provider_message_id LIKE $2) AS projection_total
  `, [`mixed:${tenantOrder.join('-')}:%`, `mixed-${tenantOrder.join('-')}-%`])).rows[0], {
    source_total: 0,
    projection_total: 0,
  });
}

test('migración crea proyección tenant-scoped, constraints e índices exactos y es reejecutable', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(migrationSql);

    const columns = (await pool.query(`
      SELECT attname, format_type(atttypid, atttypmod) AS data_type, attnotnull
        FROM pg_attribute
       WHERE attrelid = 'whatsapp_cloud_messages'::regclass
         AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum
    `)).rows;
    assert.deepEqual(columns.map(row => row.attname), [
      'id', 'empresa_id', 'direction', 'participant_wa_id', 'source_event_id', 'outbox_id', 'source_outbox_id',
      'provider_message_id', 'message_type', 'text_body', 'media_mime_type', 'media_caption',
      'document_filename', 'delivery_status', 'state_rank', 'message_at', 'sent_at', 'delivered_at',
      'read_at', 'failed_at', 'created_at', 'updated_at',
    ]);
    assert.equal(columns.find(row => row.attname === 'empresa_id').attnotnull, true);
    assert.equal(columns.find(row => row.attname === 'participant_wa_id').attnotnull, true);

    const constraints = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
       ORDER BY conname
    `)).rows;
    const definitions = new Map(constraints.map(row => [row.conname, row.definition]));
    assert.match(definitions.get('whatsapp_cloud_messages_direction_check'), /inbound.*outbound/i);
    assert.match(definitions.get('whatsapp_cloud_messages_participant_check'), /\^\[0-9\]\{6,15\}\$/);
    assert.match(definitions.get('whatsapp_cloud_messages_type_check'), /text.*image.*document/i);
    assert.match(definitions.get('whatsapp_cloud_messages_content_check'), /text_body/i);
    assert.match(definitions.get('whatsapp_cloud_messages_content_length_check'), /4096.*255.*1024.*255/i);
    assert.match(definitions.get('whatsapp_cloud_messages_delivery_status_check'), /received.*queued.*sending.*sent.*delivered.*read.*failed.*manual_retry.*outcome_unknown/i);
    assert.match(definitions.get('whatsapp_cloud_messages_direction_status_check'), /inbound.*received.*outbound/i);
    assert.match(definitions.get('whatsapp_cloud_messages_state_rank_check'), /state_rank/i);
    assert.match(definitions.get('whatsapp_cloud_messages_timestamps_check'), /sent_at.*delivered_at.*read_at.*failed_at/i);
    assert.match(definitions.get('whatsapp_cloud_messages_source_direction_check'), /source_event_id/i);
    assert.match(definitions.get('whatsapp_cloud_messages_outbox_direction_check'), /outbox_id/i);
    assert.match(definitions.get('whatsapp_cloud_messages_source_outbox_direction_check'), /source_outbox_id/i);
    assert.match(definitions.get('whatsapp_cloud_messages_empresa_id_fkey'), /FOREIGN KEY \(empresa_id\) REFERENCES empresas\(id\) ON DELETE CASCADE/i);
    assert.match(definitions.get('whatsapp_cloud_messages_source_event_fkey'), /FOREIGN KEY \(empresa_id, source_event_id\).*whatsapp_cloud_events\(empresa_id, id\).*ON DELETE SET NULL \(source_event_id\)/i);
    assert.match(definitions.get('whatsapp_cloud_messages_outbox_fkey'), /FOREIGN KEY \(empresa_id, outbox_id\).*wpp_outbox\(empresa_id, id\).*ON DELETE SET NULL \(outbox_id\)/i);

    for (const [indexName, linkColumn, unique] of [
      ['whatsapp_cloud_messages_source_event_uidx', 'source_event_id', true],
      ['whatsapp_cloud_messages_outbox_uidx', 'outbox_id', true],
      ['whatsapp_cloud_messages_source_outbox_uidx', 'source_outbox_id', true],
      ['whatsapp_cloud_messages_provider_message_idx', 'provider_message_id', true],
    ]) {
      const shape = await indexShape(pool, indexName);
      assert.equal(shape.indisunique, unique);
      assert.equal(shape.indnkeyatts, 2);
      assert.equal(shape.indnatts, 2);
      assert.equal(shape.has_expressions, false);
      assert.equal(shape.sort_options, '0 0');
      assert.deepEqual(shape.key_columns, ['empresa_id', linkColumn]);
      assert.match(shape.predicate, new RegExp(`${linkColumn} IS NOT NULL`, 'i'));
      if (indexName === 'whatsapp_cloud_messages_provider_message_idx') {
        assert.match(shape.predicate, /direction = 'outbound'/i);
      }
    }

    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_messages_conversations'), {
      indisunique: false,
      indnkeyatts: 4,
      indnatts: 4,
      has_expressions: false,
      sort_options: '0 3 3 0',
      key_columns: ['empresa_id', 'message_at', 'id', 'participant_wa_id'],
      predicate: null,
    });
    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline'), {
      indisunique: false,
      indnkeyatts: 4,
      indnatts: 4,
      has_expressions: false,
      sort_options: '0 0 3 3',
      key_columns: ['empresa_id', 'participant_wa_id', 'message_at', 'id'],
      predicate: null,
    });
  });
});

test('migración repara índice canónico de identidad provider outbound con catálogo exacto', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      DROP INDEX public.whatsapp_cloud_messages_provider_message_idx;
      CREATE INDEX whatsapp_cloud_messages_provider_message_idx
        ON public.whatsapp_cloud_messages (empresa_id, provider_message_id)
        WHERE provider_message_id IS NOT NULL
    `);
    await pool.query(projectionSql);
    const shape = await indexShape(pool, 'whatsapp_cloud_messages_provider_message_idx');
    assert.equal(shape.indisunique, true);
    assert.equal(shape.indnkeyatts, 2);
    assert.equal(shape.indnatts, 2);
    assert.equal(shape.has_expressions, false);
    assert.equal(shape.sort_options, '0 0');
    assert.deepEqual(shape.key_columns, ['empresa_id', 'provider_message_id']);
    assert.match(shape.predicate, /provider_message_id IS NOT NULL/i);
    assert.match(shape.predicate, /direction = 'outbound'/i);
  });
});

test('migración detecta cardinalidad duplicada en proyección aunque ambas filas enlacen el mismo outbox', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    const outboxId = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,meta_message_id,created_at)
      VALUES (1,'549351555001','source outbox','sent','cloud','wamid.projection-duplicate',
              '2026-10-06T09:59:00Z')
      RETURNING id
    `)).rows[0].id;
    await pool.query(`
      DROP INDEX public.whatsapp_cloud_messages_provider_message_idx;
      DROP INDEX public.whatsapp_cloud_messages_source_outbox_uidx;
      DROP INDEX public.whatsapp_cloud_messages_outbox_uidx
    `);
    await pool.query('DELETE FROM public.whatsapp_cloud_messages WHERE source_outbox_id = $1', [outboxId]);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,outbox_id,source_outbox_id,
         provider_message_id,message_type,text_body,
         delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES
        (1,'outbound','549351555001',$1,$1,' wamid.projection-duplicate ','text','uno',
         'queued',10,'2026-10-06T10:00:00Z','2026-10-06T10:00:00Z','2026-10-06T10:00:00Z'),
        (1,'outbound','549351555002',$1,$1,'wamid.projection-duplicate','text','dos',
         'queued',10,'2026-10-06T10:01:00Z','2026-10-06T10:01:00Z','2026-10-06T10:01:00Z')
    `, [outboxId]);
    const before = (await pool.query(`SELECT id::text, outbox_id::text, source_outbox_id::text,
      provider_message_id, participant_wa_id, text_body
      FROM public.whatsapp_cloud_messages ORDER BY id`)).rows;
    await assert.rejects(pool.query(projectionSql), error => assertSanitizedProviderIdentityDuplicate(
      error, ['wamid.projection-duplicate', '549351', 'uno', 'dos'],
    ));
    assert.deepEqual((await pool.query(`SELECT id::text, outbox_id::text, source_outbox_id::text,
      provider_message_id, participant_wa_id, text_body
      FROM public.whatsapp_cloud_messages ORDER BY id`)).rows, before);
    assert.equal(await pool.query(`SELECT to_regclass('public.whatsapp_cloud_messages_provider_message_idx') AS index_name`)
      .then(result => result.rows[0].index_name), null);
  });
});

test('migración rechaza identidad provider combinada entre proyección y outbox y revierte intacta', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query('DROP INDEX public.whatsapp_cloud_messages_provider_message_idx');
    await pool.query(`
      DROP TRIGGER whatsapp_cloud_messages_capture_insert ON public.wpp_outbox;
      DROP TRIGGER whatsapp_cloud_messages_capture_update ON public.wpp_outbox
    `);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,provider_message_id,message_type,text_body,
         delivery_status,state_rank,message_at,created_at,updated_at)
      VALUES (1,'outbound','549351555010',' wamid.combined-duplicate ','text','projection secret',
              'queued',10,'2026-10-06T10:00:00Z','2026-10-06T10:00:00Z','2026-10-06T10:00:00Z');
      INSERT INTO public.wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,meta_message_id,created_at)
      VALUES (1,'549351555011','outbox secret','sent','cloud','wamid.combined-duplicate',
              '2026-10-06T10:01:00Z')
    `);
    const beforeProjection = (await pool.query(`SELECT id::text,provider_message_id,text_body
      FROM public.whatsapp_cloud_messages ORDER BY id`)).rows;
    const beforeOutbox = (await pool.query(`SELECT id::text,meta_message_id,mensaje
      FROM public.wpp_outbox ORDER BY id`)).rows;
    await assert.rejects(pool.query(projectionSql), error => assertSanitizedProviderIdentityDuplicate(
      error, ['wamid.combined-duplicate', '549351', 'projection secret', 'outbox secret'],
    ));
    assert.deepEqual((await pool.query(`SELECT id::text,provider_message_id,text_body
      FROM public.whatsapp_cloud_messages ORDER BY id`)).rows, beforeProjection);
    assert.deepEqual((await pool.query(`SELECT id::text,meta_message_id,mensaje
      FROM public.wpp_outbox ORDER BY id`)).rows, beforeOutbox);
  });
});

test('precheck rechaza la identidad provider efectiva posterior al backfill antes de mutar filas', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      DROP INDEX public.whatsapp_cloud_messages_provider_message_idx;
      DROP TRIGGER whatsapp_cloud_messages_capture_insert ON public.wpp_outbox;
      DROP TRIGGER whatsapp_cloud_messages_capture_update ON public.wpp_outbox
    `);
    const outboxId = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,meta_message_id,created_at)
      VALUES (1,'549351555020','linked source secret','sent','cloud',
              '  wamid.target-owned  ','2026-10-06T10:00:00Z')
      RETURNING id
    `)).rows[0].id;
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,outbox_id,source_outbox_id,
         provider_message_id,message_type,text_body,delivery_status,state_rank,
         message_at,sent_at,created_at,updated_at)
      VALUES
        (1,'outbound','549351555020',$1,$1,'wamid.old-provider','text',
         'projection A secret','sent',30,'2026-10-06T10:00:00Z','2026-10-06T10:00:00Z',
         '2026-10-06T10:00:00Z','2026-10-06T10:00:00Z'),
        (1,'outbound','549351555021',NULL,NULL,'wamid.target-owned','text',
         'projection B secret','sent',30,'2026-10-06T10:01:00Z','2026-10-06T10:01:00Z',
         '2026-10-06T10:01:00Z','2026-10-06T10:01:00Z')
    `, [outboxId]);
    const beforeProjection = (await pool.query(`
      SELECT id::text,outbox_id::text,source_outbox_id::text,provider_message_id,text_body
        FROM public.whatsapp_cloud_messages ORDER BY id
    `)).rows;
    const beforeOutbox = (await pool.query(`
      SELECT id::text,meta_message_id,mensaje FROM public.wpp_outbox ORDER BY id
    `)).rows;

    await assert.rejects(pool.query(projectionSql), error => assertSanitizedProviderIdentityDuplicate(
      error,
      ['wamid.target-owned', 'wamid.old-provider', '549351', 'linked source secret',
        'projection A secret', 'projection B secret'],
    ));

    assert.deepEqual((await pool.query(`
      SELECT id::text,outbox_id::text,source_outbox_id::text,provider_message_id,text_body
        FROM public.whatsapp_cloud_messages ORDER BY id
    `)).rows, beforeProjection);
    assert.deepEqual((await pool.query(`
      SELECT id::text,meta_message_id,mensaje FROM public.wpp_outbox ORDER BY id
    `)).rows, beforeOutbox);
    assert.equal(await pool.query(`
      SELECT to_regclass('public.whatsapp_cloud_messages_provider_message_idx') AS index_name
    `).then(result => result.rows[0].index_name), null);
  });
});

test('precheck cuenta cada fuente outbound efectiva una vez y respeta elegibilidad y nulos', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      DROP INDEX public.whatsapp_cloud_messages_provider_message_idx;
      DROP TRIGGER whatsapp_cloud_messages_capture_insert ON public.wpp_outbox;
      DROP TRIGGER whatsapp_cloud_messages_capture_update ON public.wpp_outbox
    `);
    const outboxes = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,meta_message_id,created_at)
      VALUES
        (1,'549351555030','same source','pending','cloud','  wamid.same-source  ',
         '2026-10-06T11:00:00Z'),
        (1,'549351555031','replacement source','pending','cloud','  wamid.replaced  ',
         '2026-10-06T11:01:00Z'),
        (1,'549351555032','fallback source','pending','cloud','   ',
         '2026-10-06T11:02:00Z'),
        (1,'549351555033','outbox only','pending','cloud',' wamid.outbox-only ',
         '2026-10-06T11:03:00Z'),
        (1,'bad phone','ineligible source','pending','cloud','wamid.ignored-source',
         '2026-10-06T11:04:00Z'),
        (1,'549351555034','noncloud source','pending','company','wamid.ignored-source',
         '2026-10-06T11:05:00Z'),
        (1,'549351555035','null source','pending','cloud',NULL,
         '2026-10-06T11:06:00Z')
      RETURNING id,mensaje
    `)).rows;
    const idByMessage = new Map(outboxes.map(row => [row.mensaje, row.id]));
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,outbox_id,source_outbox_id,
         provider_message_id,message_type,text_body,delivery_status,state_rank,
         message_at,created_at,updated_at)
      VALUES
        (1,'outbound','549351555030',$1,$1,'wamid.same-source','text','same projection',
         'queued',10,'2026-10-06T11:00:00Z','2026-10-06T11:00:00Z','2026-10-06T11:00:00Z'),
        (1,'outbound','549351555031',$2,$2,'  wamid.old-replaced  ','text','replacement projection',
         'queued',10,'2026-10-06T11:01:00Z','2026-10-06T11:01:00Z','2026-10-06T11:01:00Z'),
        (1,'outbound','549351555032',$3,$3,'  wamid.fallback  ','text','fallback projection',
         'queued',10,'2026-10-06T11:02:00Z','2026-10-06T11:02:00Z','2026-10-06T11:02:00Z'),
        (1,'outbound','549351555036',NULL,NULL,'wamid.ignored-source','text','standalone projection',
         'queued',10,'2026-10-06T11:07:00Z','2026-10-06T11:07:00Z','2026-10-06T11:07:00Z'),
        (1,'outbound','549351555037',NULL,NULL,'   ','text','null projection',
         'queued',10,'2026-10-06T11:08:00Z','2026-10-06T11:08:00Z','2026-10-06T11:08:00Z')
    `, [
      idByMessage.get('same source'),
      idByMessage.get('replacement source'),
      idByMessage.get('fallback source'),
    ]);

    await pool.query(projectionSql);

    const projectedSources = (await pool.query(`
      SELECT source_outbox_id::text,provider_message_id
        FROM public.whatsapp_cloud_messages
       WHERE source_outbox_id = ANY($1::bigint[])
       ORDER BY source_outbox_id
    `, [[
      idByMessage.get('same source'),
      idByMessage.get('replacement source'),
      idByMessage.get('fallback source'),
      idByMessage.get('outbox only'),
      idByMessage.get('null source'),
    ]])).rows;
    assert.deepEqual(projectedSources, [
      { source_outbox_id: String(idByMessage.get('same source')), provider_message_id: 'wamid.same-source' },
      { source_outbox_id: String(idByMessage.get('replacement source')), provider_message_id: 'wamid.replaced' },
      { source_outbox_id: String(idByMessage.get('fallback source')), provider_message_id: 'wamid.fallback' },
      { source_outbox_id: String(idByMessage.get('outbox only')), provider_message_id: 'wamid.outbox-only' },
      { source_outbox_id: String(idByMessage.get('null source')), provider_message_id: null },
    ]);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM public.whatsapp_cloud_messages
       WHERE source_outbox_id = ANY($1::bigint[])
    `, [[idByMessage.get('ineligible source'), idByMessage.get('noncloud source')]])).rows[0].total, 0);
    assert.deepEqual((await pool.query(`
      SELECT provider_message_id,count(*)::int AS total
        FROM public.whatsapp_cloud_messages
       WHERE text_body IN ('standalone projection','null projection')
       GROUP BY provider_message_id ORDER BY provider_message_id NULLS LAST
    `)).rows, [
      { provider_message_id: 'wamid.ignored-source', total: 1 },
      { provider_message_id: null, total: 1 },
    ]);
  });
});

test('migración repara definición completa de triggers canónicos y preserva triggers ajenos', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_unrelated_capture()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER whatsapp_cloud_messages_unrelated_insert
        AFTER INSERT ON public.whatsapp_cloud_events
        FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_unrelated_capture()
    `);
    const unrelatedBefore = (await pool.query(`
      SELECT trigger_row.oid::text AS oid,
             pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.whatsapp_cloud_events'::pg_catalog.regclass
         AND trigger_row.tgname = 'whatsapp_cloud_messages_unrelated_insert'
    `)).rows[0];

    const canonical = new Map();
    for (const [tableName, functionName] of [
      ['public.whatsapp_cloud_events', 'whatsapp_cloud_messages_capture_event_insert'],
      ['public.wpp_outbox', 'whatsapp_cloud_messages_capture_outbox_insert'],
    ]) {
      const shape = await triggerShape(pool, tableName);
      assert.deepEqual({
        table_schema: shape.table_schema,
        table_name: shape.table_name,
        tgenabled: shape.tgenabled,
        tgtype: shape.tgtype,
        tgisinternal: shape.tgisinternal,
        arguments: shape.arguments,
      }, {
        table_schema: 'public',
        table_name: tableName.split('.')[1],
        tgenabled: 'O',
        tgtype: 5,
        tgisinternal: false,
        arguments: '',
      });
      assert.match(shape.function_name, new RegExp(`${functionName}\\(\\)$`));
      assert.match(shape.definition,
        new RegExp(`^CREATE TRIGGER whatsapp_cloud_messages_capture_insert AFTER INSERT ON (?:public\\.)?${tableName.split('.')[1]} FOR EACH ROW EXECUTE FUNCTION (?:public\\.)?${functionName}\\(\\)$`));
      canonical.set(tableName, shape);
    }

    for (const [tableName, functionName] of [
      ['public.whatsapp_cloud_events', 'whatsapp_cloud_messages_capture_event_delete'],
      ['public.wpp_outbox', 'whatsapp_cloud_messages_capture_outbox_delete'],
    ]) {
      const shape = await triggerShape(pool, tableName, 'whatsapp_cloud_messages_capture_delete');
      assert.deepEqual({
        table_schema: shape.table_schema,
        table_name: shape.table_name,
        tgenabled: shape.tgenabled,
        tgtype: shape.tgtype,
        tgisinternal: shape.tgisinternal,
        arguments: shape.arguments,
      }, {
        table_schema: 'public',
        table_name: tableName.split('.')[1],
        tgenabled: 'O',
        tgtype: 8,
        tgisinternal: false,
        arguments: '',
      });
      assert.match(shape.function_name, new RegExp(`${functionName}\\(\\)$`));
      assert.match(shape.definition,
        new RegExp(`^CREATE TRIGGER whatsapp_cloud_messages_capture_delete AFTER DELETE ON (?:public\\.)?${tableName.split('.')[1]} REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION (?:public\\.)?${functionName}\\(\\)$`));
      canonical.set(`${tableName}:delete`, shape);
    }

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_wrong_capture()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
    `);
    const variants = [
      tableName => `ALTER TABLE ${tableName} DISABLE TRIGGER whatsapp_cloud_messages_capture_insert`,
      (tableName, functionName) => `
        DROP TRIGGER whatsapp_cloud_messages_capture_insert ON ${tableName};
        CREATE TRIGGER whatsapp_cloud_messages_capture_insert
          BEFORE INSERT ON ${tableName}
          FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
      (tableName, functionName) => `
        DROP TRIGGER whatsapp_cloud_messages_capture_insert ON ${tableName};
        CREATE TRIGGER whatsapp_cloud_messages_capture_insert
          AFTER UPDATE ON ${tableName}
          FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`,
      (tableName, functionName) => `
        DROP TRIGGER whatsapp_cloud_messages_capture_insert ON ${tableName};
        CREATE TRIGGER whatsapp_cloud_messages_capture_insert
          AFTER INSERT ON ${tableName}
          FOR EACH STATEMENT EXECUTE FUNCTION public.${functionName}()`,
      tableName => `
        DROP TRIGGER whatsapp_cloud_messages_capture_insert ON ${tableName};
        CREATE TRIGGER whatsapp_cloud_messages_capture_insert
          AFTER INSERT ON ${tableName}
          FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_wrong_capture('unexpected')`,
    ];

    for (const [tableName, functionName] of [
      ['public.whatsapp_cloud_events', 'whatsapp_cloud_messages_capture_event_insert'],
      ['public.wpp_outbox', 'whatsapp_cloud_messages_capture_outbox_insert'],
    ]) {
      for (const variant of variants) {
        await pool.query(variant(tableName, functionName));
        await pool.query(projectionSql);
        assert.deepEqual(await triggerShape(pool, tableName), canonical.get(tableName),
          `${tableName} canonical trigger must be restored exactly`);
      }
    }

    for (const [tableName, functionName] of [
      ['public.whatsapp_cloud_events', 'whatsapp_cloud_messages_capture_event_delete'],
      ['public.wpp_outbox', 'whatsapp_cloud_messages_capture_outbox_delete'],
    ]) {
      await pool.query(`
        DROP TRIGGER whatsapp_cloud_messages_capture_delete ON ${tableName};
        CREATE TRIGGER whatsapp_cloud_messages_capture_delete
          AFTER DELETE ON ${tableName}
          FOR EACH ROW EXECUTE FUNCTION public.${functionName}()
      `);
      await pool.query(projectionSql);
      assert.deepEqual(
        await triggerShape(pool, tableName, 'whatsapp_cloud_messages_capture_delete'),
        canonical.get(`${tableName}:delete`),
        `${tableName} canonical delete trigger must be restored exactly`,
      );
    }

    assert.deepEqual((await pool.query(`
      SELECT trigger_row.oid::text AS oid,
             pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.whatsapp_cloud_events'::pg_catalog.regclass
         AND trigger_row.tgname = 'whatsapp_cloud_messages_unrelated_insert'
    `)).rows[0], unrelatedBefore);

    await pool.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
      VALUES (1, 'message', 'trigger-repair:inbound', 'trigger-repair-inbound',
              '549351555077', 'text', '{"text":{"body":"capturado después de reparar"}}'::jsonb)
    `);
    assert.deepEqual((await pool.query(`
      SELECT direction, participant_wa_id, provider_message_id, text_body, delivery_status
        FROM public.whatsapp_cloud_messages
       WHERE provider_message_id = 'trigger-repair-inbound'
    `)).rows[0], {
      direction: 'inbound',
      participant_wa_id: '549351555077',
      provider_message_id: 'trigger-repair-inbound',
      text_body: 'capturado después de reparar',
      delivery_status: 'received',
    });
  });
});

async function seedCleanupRaceSources(pool, suffix) {
  const params = [
    `cleanup:${suffix}:in-one`, `cleanup-${suffix}-in-one`,
    `cleanup:${suffix}:in-two`, `cleanup-${suffix}-in-two`,
    `cleanup:${suffix}:status-one`, `cleanup-${suffix}-out-one`,
    `cleanup:${suffix}:status-two`, `cleanup-${suffix}-out-two`,
    `cleanup:${suffix}:status-downgrade`,
  ];
  await pool.query(`
    INSERT INTO public.whatsapp_cloud_events
      (empresa_id, event_kind, dedupe_key, message_id, sender_id, recipient_id,
       message_type, status, source_timestamp, event_data, received_at)
    VALUES
      (1, 'message', $1, $2, '549351555101', NULL, 'text', NULL, '1760000000',
       '{"text":{"body":"cleanup inbound one"},"opaque":"must-not-copy-one"}'::jsonb,
       '2026-10-01T10:00:00Z'),
      (2, 'message', $3, $4, '549351555102', NULL, 'document', NULL, '1760000001',
       '{"document":{"id":"opaque-document-id","mime_type":"application/pdf","caption":"cleanup doc","filename":"cleanup.pdf"},"opaque":"must-not-copy-two"}'::jsonb,
       '2026-10-01T10:00:01Z'),
      (1, 'status', $5, $6, NULL, '549351555111', NULL, 'read', '1760000030',
       '{"opaque":"must-not-copy-status-one"}'::jsonb, '2026-10-01T10:00:31Z'),
      (2, 'status', $7, $8, NULL, '549351555112', NULL, 'delivered', '1760000020',
       '{"opaque":"must-not-copy-status-two"}'::jsonb, '2026-10-01T10:00:21Z'),
      (1, 'status', $9, $6, NULL, '549351555111', NULL, 'failed', '1760000040',
       '{"opaque":"must-not-copy-status-downgrade"}'::jsonb, '2026-10-01T10:00:41Z')
  `, params);
  await pool.query(`
    INSERT INTO public.wpp_outbox
      (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
       meta_message_id, cloud_dispatch_state)
    VALUES
      (1, '549351555111', 'cleanup outbound one', '2026-10-01T10:00:00Z',
       '2026-10-01T10:00:10Z', 'sent', 'cloud', $1, 'sent'),
      (2, '549351555112', 'cleanup outbound two', '2026-10-01T10:00:00Z',
       '2026-10-01T10:00:10Z', 'sent', 'cloud', $2, 'sent')
  `, [params[5], params[7]]);
}

async function assertCleanupProjection(pool, suffix, { detached = true } = {}) {
  const rows = (await pool.query(`
    SELECT empresa_id, direction, provider_message_id, participant_wa_id, message_type,
           text_body, media_mime_type, media_caption, document_filename,
           delivery_status, state_rank, source_event_id, outbox_id
      FROM public.whatsapp_cloud_messages
     WHERE provider_message_id = ANY($1::text[])
     ORDER BY empresa_id, direction
  `, [[
    `cleanup-${suffix}-in-one`, `cleanup-${suffix}-out-one`,
    `cleanup-${suffix}-in-two`, `cleanup-${suffix}-out-two`,
  ]])).rows;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => [row.empresa_id, row.direction, row.delivery_status, row.state_rank]), [
    [1, 'inbound', 'received', 0],
    [1, 'outbound', 'read', 50],
    [2, 'inbound', 'received', 0],
    [2, 'outbound', 'delivered', 40],
  ]);
  assert.equal(rows.find(row => row.provider_message_id === `cleanup-${suffix}-in-one`).text_body,
    'cleanup inbound one');
  assert.deepEqual(rows.find(row => row.provider_message_id === `cleanup-${suffix}-in-two`), {
    empresa_id: 2,
    direction: 'inbound',
    provider_message_id: `cleanup-${suffix}-in-two`,
    participant_wa_id: '549351555102',
    message_type: 'document',
    text_body: null,
    media_mime_type: 'application/pdf',
    media_caption: 'cleanup doc',
    document_filename: 'cleanup.pdf',
    delivery_status: 'received',
    state_rank: 0,
    source_event_id: detached ? null : rows.find(row => row.provider_message_id === `cleanup-${suffix}-in-two`).source_event_id,
    outbox_id: null,
  });
  if (!detached) {
    assert.match(rows.find(row => row.provider_message_id === `cleanup-${suffix}-in-two`).source_event_id, /^\d+$/);
  }
  assert.doesNotMatch(JSON.stringify(rows), /must-not-copy|opaque-document-id/);
}

test('cleanup DELETE multi-tenant entre commit DDL y backfill conserva inbound/status/outbound durable', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'before');
    const { installSql, backfillSql } = projectionCutoverPhases();

    await pool.query(installSql);
    await pool.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id IN (2, 1)');
    await pool.query("DELETE FROM public.wpp_outbox WHERE empresa_id IN (2, 1) AND transport_origin = 'cloud'");
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox) AS outbox
    `)).rows[0], { events: 0, outbox: 0 });
    await assertCleanupProjection(pool, 'before');

    await pool.query(backfillSql);
    await assertCleanupProjection(pool, 'before');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS total FROM public.whatsapp_cloud_messages',
    )).rows[0].total, 4);
  });
});

test('cleanup después del backfill es idempotente, monotónico y no restaura fuentes', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'after');
    await pool.query(projectionSql);
    await assertCleanupProjection(pool, 'after', { detached: false });

    await pool.query("DELETE FROM public.wpp_outbox WHERE empresa_id IN (2, 1) AND transport_origin = 'cloud'");
    await pool.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id IN (2, 1)');
    await assertCleanupProjection(pool, 'after');
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox) AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0], { events: 0, outbox: 0, projection: 4 });
  });
});

test('rollback del cleanup DELETE revierte captura y deja fuentes intactas', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'rollback');
    const { installSql } = projectionCutoverPhases();
    await pool.query(installSql);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id IN (1, 2)');
      await client.query("DELETE FROM public.wpp_outbox WHERE empresa_id IN (1, 2) AND transport_origin = 'cloud'");
      assert.equal((await client.query(
        'SELECT count(*)::int AS total FROM public.whatsapp_cloud_messages',
      )).rows[0].total, 4);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox) AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0], { events: 5, outbox: 2, projection: 0 });
  });
});

test('tenant teardown no recaptura PII, revierte completo y no afecta cleanup ordinario ni otro tenant', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,recipient_id,message_type,status,event_data)
      VALUES
        (1,'message','teardown:in','teardown-in','5493515999001',NULL,'document',NULL,
         '{"document":{"mime_type":"application/pdf","caption":"PII teardown caption","filename":"pii-teardown.pdf"}}'),
        (1,'status','teardown:status','wamid.teardown',NULL,'5493515999001',NULL,'delivered','{}');
      INSERT INTO wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,cloud_dispatch_state,meta_message_id,sent_at)
      VALUES (1,'5493515999001','PII teardown text','sent','cloud','sent','wamid.teardown',NOW())
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,recipient_id,message_type,status,event_data)
      VALUES
        (2,'message','retained:in','retained-in','5493515999002',NULL,'text',NULL,
         '{"text":{"body":"retained tenant"}}'),
        (2,'status','retained:status','wamid.retained',NULL,'5493515999002',NULL,'read','{}');
      INSERT INTO wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,cloud_dispatch_state,meta_message_id,sent_at)
      VALUES (2,'5493515999002','retained outbound','sent','cloud','sent','wamid.retained',NOW())
    `);
    const before = (await pool.query(`SELECT
      (SELECT count(*)::int FROM empresas) empresas,
      (SELECT count(*)::int FROM whatsapp_cloud_events) events,
      (SELECT count(*)::int FROM wpp_outbox) outbox,
      (SELECT count(*)::int FROM whatsapp_cloud_messages) projection`)).rows[0];
    assert.deepEqual(before, { empresas: 2, events: 4, outbox: 2, projection: 4 });

    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('DELETE FROM empresas WHERE id = 1');
      assert.deepEqual((await tx.query(`SELECT
        (SELECT count(*)::int FROM empresas WHERE id=1) empresa,
        (SELECT count(*)::int FROM whatsapp_cloud_events WHERE empresa_id=1) events,
        (SELECT count(*)::int FROM wpp_outbox WHERE empresa_id=1) outbox,
        (SELECT count(*)::int FROM whatsapp_cloud_messages WHERE empresa_id=1) projection`)).rows[0],
      { empresa: 0, events: 0, outbox: 0, projection: 0 });
      await tx.query('ROLLBACK');
    } finally {
      await tx.query('ROLLBACK').catch(() => {});
      tx.release();
    }
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM empresas) empresas,
      (SELECT count(*)::int FROM whatsapp_cloud_events) events,
      (SELECT count(*)::int FROM wpp_outbox) outbox,
      (SELECT count(*)::int FROM whatsapp_cloud_messages) projection`)).rows[0], before);

    const ordinary = (await pool.query(`INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data)
      VALUES (1,'message','teardown:ordinary','ordinary-cleanup','5493515999003','text',
              '{"text":{"body":"ordinary cleanup projection"}}') RETURNING id`)).rows[0].id;
    await pool.query('DELETE FROM whatsapp_cloud_events WHERE id=$1', [ordinary]);
    assert.deepEqual((await pool.query(`SELECT source_event_id,text_body FROM whatsapp_cloud_messages
      WHERE provider_message_id='ordinary-cleanup'`)).rows[0],
    { source_event_id: null, text_body: 'ordinary cleanup projection' });

    await pool.query('DELETE FROM empresas WHERE id = ANY($1::int[])', [[1]]);
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*)::int FROM empresas WHERE id=2) empresa,
      (SELECT count(*)::int FROM whatsapp_cloud_events WHERE empresa_id=2) events,
      (SELECT count(*)::int FROM wpp_outbox WHERE empresa_id=2) outbox,
      (SELECT count(*)::int FROM whatsapp_cloud_messages WHERE empresa_id=2) projection,
      (SELECT count(*)::int FROM whatsapp_cloud_messages WHERE empresa_id=1) deleted_projection`)).rows[0],
    { empresa: 1, events: 2, outbox: 1, projection: 2, deleted_projection: 0 });
    const residual = JSON.stringify((await pool.query(`SELECT * FROM whatsapp_cloud_messages
      UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,mensaje,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
      FROM wpp_outbox`)).rows);
    assert.doesNotMatch(residual,
      /5493515999001|5493515999003|PII teardown text|PII teardown caption|pii-teardown\.pdf|ordinary cleanup projection/);
  });
});

test('cleanup simultáneo de events/outbox serializa tenants y preserva la proyección', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'simultaneous');
    const { installSql, backfillSql } = projectionCutoverPhases();
    await pool.query(installSql);

    const blocker = await pool.connect();
    const eventCleanup = await pool.connect();
    const outboxCleanup = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_catalog.pg_advisory_xact_lock(1464550735, 1)');
      await eventCleanup.query('BEGIN');
      await outboxCleanup.query('BEGIN');
      const eventPromise = eventCleanup.query(
        'DELETE FROM public.whatsapp_cloud_events WHERE empresa_id IN (2, 1)',
      ).then(() => 'event');
      const outboxPromise = outboxCleanup.query(
        "DELETE FROM public.wpp_outbox WHERE empresa_id IN (2, 1) AND transport_origin = 'cloud'",
      ).then(() => 'outbox');
      await waitUntil(async () => {
        const waits = (await pool.query(`
          SELECT count(*)::int AS total
            FROM pg_catalog.pg_stat_activity
           WHERE pid = ANY($1::int[])
             AND wait_event_type = 'Lock'
             AND wait_event = 'advisory'
        `, [[eventCleanup.processID, outboxCleanup.processID]])).rows[0].total;
        return waits === 2;
      }, 'both cleanup statements must reach the tenant advisory barrier');
      await blocker.query('COMMIT');

      const winner = await Promise.race([eventPromise, outboxPromise]);
      if (winner === 'event') await eventCleanup.query('COMMIT');
      else await outboxCleanup.query('COMMIT');
      await Promise.all([eventPromise, outboxPromise]);
      if (winner === 'event') await outboxCleanup.query('COMMIT');
      else await eventCleanup.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await eventCleanup.query('ROLLBACK').catch(() => {});
      await outboxCleanup.query('ROLLBACK').catch(() => {});
      blocker.release();
      eventCleanup.release();
      outboxCleanup.release();
    }

    await pool.query(backfillSql);
    await assertCleanupProjection(pool, 'simultaneous');
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox) AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0], { events: 0, outbox: 0, projection: 4 });
  });
});

function cleanupDeleteSql(source, tenantOrder) {
  if (source === 'whatsapp_cloud_events') {
    return {
      text: 'DELETE FROM public.whatsapp_cloud_events WHERE empresa_id IN ($1, $2)',
      values: tenantOrder,
    };
  }
  return {
    text: "DELETE FROM public.wpp_outbox WHERE empresa_id IN ($1, $2) AND transport_origin = 'cloud'",
    values: tenantOrder,
  };
}

async function assertNoAdvisoryLocks(pool, processIds, message) {
  assert.equal((await pool.query(`
    SELECT count(*)::int AS total
      FROM pg_catalog.pg_locks
     WHERE locktype = 'advisory'
       AND pid = ANY($1::integer[])
  `, [processIds])).rows[0].total, 0, message);
}

async function assertRuntimeBoundMixedCleanupRace({ source, tenantOrder, winner }) {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    const suffix = `${source}:${tenantOrder.join('-')}:${winner}`;
    await seedCleanupRaceSources(pool, suffix);
    await pool.query(projectionSql);

    const runtime = await pool.connect();
    const cleanup = await pool.connect();
    const blocker = winner === 'runtime-guard-first' ? await pool.connect() : null;
    const trackedPids = [runtime.processID, cleanup.processID, blocker?.processID].filter(Boolean);
    let cleanupDone = false;
    let blockerDone = false;
    let rejection;
    const runtimeDelete = cleanupDeleteSql(source, tenantOrder);
    const pureCleanupSource = source === 'whatsapp_cloud_events'
      ? 'wpp_outbox'
      : 'whatsapp_cloud_events';
    const pureDelete = cleanupDeleteSql(pureCleanupSource, tenantOrder);
    try {
      await runtime.query('BEGIN');
      await cleanup.query('BEGIN');
      await runtime.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await cleanup.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await runtime.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (2, 'message', $1, $2, '549351555188', 'text',
                '{"text":{"body":"runtime-bound tenant two"}}'::jsonb)
      `, [`runtime-bound:${suffix}`, `runtime-bound-${suffix}`]);

      if (blocker) {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_catalog.pg_advisory_xact_lock(1464550735, 1)');
      }

      const cleanupPromise = cleanup.query(pureDelete).then(
        value => ({ value }),
        error => ({ error }),
      );
      await waitUntil(async () => {
        const wait = (await pool.query(`
          SELECT wait_event_type, wait_event
            FROM pg_catalog.pg_stat_activity
           WHERE pid = $1
        `, [cleanup.processID])).rows[0];
        return wait?.wait_event_type === 'Lock' && wait?.wait_event === 'advisory';
      }, `${suffix}: pure cleanup did not reach its ordered advisory wait`);

      if (winner === 'cleanup-first') {
        const locks = (await pool.query(`
          SELECT granted
            FROM pg_catalog.pg_locks
           WHERE locktype = 'advisory' AND pid = $1
           ORDER BY granted DESC
        `, [cleanup.processID])).rows.map(row => row.granted);
        assert.deepEqual(locks, [true, false],
          `${suffix}: pure cleanup must hold tenant 1 before waiting for tenant 2`);
      }

      const runtimeOutcome = await runtime.query(runtimeDelete).then(
        value => ({ value }),
        error => ({ error }),
      );
      rejection = runtimeOutcome.error;
      await runtime.query('ROLLBACK').catch(() => {});

      if (blocker) {
        await blocker.query('COMMIT');
        blockerDone = true;
      }
      const cleanupOutcome = await cleanupPromise;
      assert.equal(cleanupOutcome.error, undefined,
        `${suffix}: pure cleanup must never lose with ${cleanupOutcome.error?.code || 'unknown error'}`);
      await cleanup.query('COMMIT');
      cleanupDone = true;

      assert.ok(rejection, `${suffix}: mixed runtime cleanup must reject`);
      assert.equal(rejection.code, 'P0001');
      assert.equal(rejection.message, 'whatsapp_cloud_projection_cross_tenant_transaction');
      assert.notEqual(rejection.code, '40P01');
    } finally {
      await runtime.query('ROLLBACK').catch(() => {});
      if (!cleanupDone) await cleanup.query('ROLLBACK').catch(() => {});
      if (blocker && !blockerDone) await blocker.query('ROLLBACK').catch(() => {});
      runtime.release();
      cleanup.release();
      blocker?.release();
    }

    assert.ok(rejection, `${suffix}: mixed cleanup must expose one sanitized error`);
    for (const property of ['message', 'detail', 'hint', 'schema', 'table', 'constraint']) {
      const exposed = String(rejection[property] ?? '');
      assert.equal(exposed.includes('1'), false, `${suffix}: ${property} must not expose tenant 1`);
      assert.equal(exposed.includes('2'), false, `${suffix}: ${property} must not expose tenant 2`);
    }
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.${source}
          WHERE empresa_id IN (1, 2)) AS restored_source_rows,
        (SELECT count(*)::int FROM public.whatsapp_cloud_events
          WHERE dedupe_key = $1) AS rolled_back_insert,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages
          WHERE provider_message_id = $2) AS rolled_back_projection
    `, [`runtime-bound:${suffix}`, `runtime-bound-${suffix}`])).rows[0], {
      restored_source_rows: source === 'whatsapp_cloud_events' ? 5 : 2,
      rolled_back_insert: 0,
      rolled_back_projection: 0,
    });
    await assertNoAdvisoryLocks(pool, trackedPids,
      `${suffix}: commit/rollback must release every transaction advisory`);
  });
}

for (const source of ['whatsapp_cloud_events', 'wpp_outbox']) {
  for (const tenantOrder of [[1, 2], [2, 1]]) {
    for (const winner of ['cleanup-first', 'runtime-guard-first']) {
      test(`runtime-bound ${source} ${tenantOrder.join('→')} ${winner} aborta antes del segundo lock`, async () => {
        await assertRuntimeBoundMixedCleanupRace({ source, tenantOrder, winner });
      });
    }
  }
}

for (const source of ['whatsapp_cloud_events', 'wpp_outbox']) {
  test(`runtime-bound ${source} reutiliza el lock del mismo tenant sin namespace nuevo`, async () => {
    await withDatabase(async pool => {
      await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
      await pool.query(outboxSql);
      await seedCleanupRaceSources(pool, `same-tenant:${source}`);
      await pool.query(projectionSql);
      const client = await pool.connect();
      const processId = client.processID;
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO public.whatsapp_cloud_events
            (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
          VALUES (2, 'message', $1, $2, '549351555189', 'text',
                  '{"text":{"body":"same bound tenant"}}'::jsonb)
        `, [`same-bound:${source}`, `same-bound-${source}`]);
        await client.query(source === 'whatsapp_cloud_events'
          ? 'DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 2'
          : "DELETE FROM public.wpp_outbox WHERE empresa_id = 2 AND transport_origin = 'cloud'");
        assert.equal((await pool.query(`
          SELECT count(*)::int AS total
            FROM pg_catalog.pg_locks
           WHERE locktype = 'advisory' AND pid = $1 AND granted
        `, [processId])).rows[0].total, 1,
        'same-tenant cleanup must retain only the runtime tenant advisory');
        await client.query('ROLLBACK');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      await assertNoAdvisoryLocks(pool, [processId],
        `${source}: same-tenant rollback must release the reused advisory`);
      assert.equal((await pool.query(`
        SELECT count(*)::int AS total FROM public.${source} WHERE empresa_id = 2
      `)).rows[0].total, source === 'whatsapp_cloud_events' ? 2 : 1,
      'same-tenant rollback must restore deleted source rows and remove the runtime insert');
    });
  });
}

test('binding runtime conserva rechazo de cleanup outbox sin tenant', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO public.wpp_outbox (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (NULL, '549351555190', 'general cleanup', 'pending', 'general')
    `);
    await pool.query(projectionSql);
    const client = await pool.connect();
    const processId = client.processID;
    let rejection;
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (1, 'message', 'runtime-null:bind', 'runtime-null-bind', '549351555191',
                'text', '{"text":{"body":"bound"}}'::jsonb)
      `);
      await assert.rejects(
        client.query("DELETE FROM public.wpp_outbox WHERE empresa_id IS NULL AND transport_origin = 'general'"),
        error => {
          rejection = error;
          return error?.code === 'P0001'
            && error?.message === 'whatsapp_cloud_projection_cross_tenant_transaction';
        },
      );
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    assert.ok(rejection);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS total FROM public.wpp_outbox WHERE empresa_id IS NULL AND transport_origin = 'general'",
    )).rows[0].total, 1);
    await assertNoAdvisoryLocks(pool, [processId],
      'runtime-bound null cleanup rejection must release its advisory on rollback');
  });
});

test('cleanups puros de tenants disjuntos siguen paralelos y liberan advisories', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'pure-parallel');
    await pool.query(projectionSql);
    const tenantOne = await pool.connect();
    const tenantTwo = await pool.connect();
    const trackedPids = [tenantOne.processID, tenantTwo.processID];
    try {
      await tenantOne.query('BEGIN');
      await tenantTwo.query('BEGIN');
      await tenantOne.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 1');
      await Promise.race([
        tenantTwo.query("DELETE FROM public.wpp_outbox WHERE empresa_id = 2 AND transport_origin = 'cloud'"),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('pure cleanup for tenant 2 was blocked by tenant 1')), 500,
        )),
      ]);
      await tenantTwo.query('COMMIT');
      await tenantOne.query('ROLLBACK');
    } finally {
      await tenantOne.query('ROLLBACK').catch(() => {});
      await tenantTwo.query('ROLLBACK').catch(() => {});
      tenantOne.release();
      tenantTwo.release();
    }
    await assertNoAdvisoryLocks(pool, trackedPids,
      'parallel pure cleanup commit/rollback must not leak advisories');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS total FROM public.whatsapp_cloud_events WHERE empresa_id = 1',
    )).rows[0].total, 3, 'rolled-back pure cleanup must restore tenant 1 events');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS total FROM public.wpp_outbox WHERE empresa_id = 2',
    )).rows[0].total, 0, 'committed pure cleanup must remove tenant 2 outbox');
  });
});

test('cleanup puro multi-sentencia rechaza 2→1 antes del advisory y evita el 40P01 exacto entre fuentes', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'global-order-red');
    await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1, '549351555199', 'global order B', 'pending', 'cloud')
    `);
    await pool.query(projectionSql);
    const baseline = (await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox WHERE transport_origin = 'cloud') AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages
          WHERE source_event_id IS NOT NULL OR outbox_id IS NOT NULL) AS linked_projection
    `)).rows[0];

    const transactionA = await pool.connect();
    const transactionB = await pool.connect();
    const trackedPids = [transactionA.processID, transactionB.processID];
    let descendingError;
    try {
      await transactionA.query('BEGIN');
      await transactionB.query('BEGIN');
      await transactionA.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await transactionB.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");

      await transactionA.query(`
        DELETE FROM public.whatsapp_cloud_events
         WHERE empresa_id = 2 AND event_kind = 'message'
      `);
      await transactionB.query(`
        DELETE FROM public.wpp_outbox
         WHERE empresa_id = 1 AND transport_origin = 'cloud' AND mensaje = 'global order B'
      `);

      const ascendingPromise = transactionB.query(`
        DELETE FROM public.whatsapp_cloud_events
         WHERE empresa_id = 2 AND event_kind = 'status'
      `);
      await waitUntil(async () => (await pool.query(`
        SELECT wait_event_type
          FROM pg_catalog.pg_stat_activity
         WHERE pid = $1
      `, [transactionB.processID])).rows[0]?.wait_event_type === 'Lock',
      'transaction B did not reach the exact cross-source advisory wait');

      await assert.rejects(
        transactionA.query(`
          DELETE FROM public.wpp_outbox
           WHERE empresa_id = 1 AND transport_origin = 'cloud' AND mensaje = 'cleanup outbound one'
        `),
        error => {
          descendingError = error;
          return error?.code === 'P0001'
            && error?.message === 'whatsapp_cloud_projection_cleanup_lock_order'
            && error?.code !== '40P01';
        },
      );
      await ascendingPromise;
      await transactionA.query('ROLLBACK');
      await transactionB.query('ROLLBACK').catch(() => {});
    } finally {
      await transactionA.query('ROLLBACK').catch(() => {});
      await transactionB.query('ROLLBACK').catch(() => {});
      transactionA.release();
      transactionB.release();
    }

    assert.ok(descendingError, 'descending cleanup must expose one deterministic sanitized error');
    for (const property of ['message', 'detail', 'hint', 'where', 'schema', 'table', 'constraint']) {
      const exposed = String(descendingError[property] ?? '');
      assert.equal(exposed.includes('1'), false, `${property} must not expose tenant 1`);
      assert.equal(exposed.includes('2'), false, `${property} must not expose tenant 2`);
    }
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox WHERE transport_origin = 'cloud') AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages
          WHERE source_event_id IS NOT NULL OR outbox_id IS NOT NULL) AS linked_projection
    `)).rows[0], baseline);
    await assertNoAdvisoryLocks(pool, trackedPids,
      'descending rejection plus rollback must release all transaction advisories');
  });
});

test('cleanup puro cross-source con outbox 2→events 1 también deja ganar 1→2 sin 40P01', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'global-order-reverse');
    await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (2, '549351555298', 'global order tenant two B', 'pending', 'cloud')
    `);
    await pool.query(projectionSql);
    const baseline = (await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox WHERE transport_origin = 'cloud') AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0];

    const descending = await pool.connect();
    const ascending = await pool.connect();
    const trackedPids = [descending.processID, ascending.processID];
    let descendingError;
    try {
      await descending.query('BEGIN');
      await ascending.query('BEGIN');
      await descending.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await ascending.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await descending.query(`
        DELETE FROM public.wpp_outbox
         WHERE empresa_id = 2 AND transport_origin = 'cloud' AND mensaje = 'cleanup outbound two'
      `);
      await ascending.query(`
        DELETE FROM public.whatsapp_cloud_events
         WHERE empresa_id = 1 AND event_kind = 'message'
      `);

      const ascendingPromise = ascending.query(`
        DELETE FROM public.wpp_outbox
         WHERE empresa_id = 2 AND transport_origin = 'cloud'
           AND mensaje = 'global order tenant two B'
      `);
      await waitUntil(async () => (await pool.query(`
        SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1
      `, [ascending.processID])).rows[0]?.wait_event_type === 'Lock',
      'ascending reverse transaction did not wait on tenant 2');

      await assert.rejects(descending.query(`
        DELETE FROM public.whatsapp_cloud_events
         WHERE empresa_id = 1 AND event_kind = 'status'
      `), error => {
        descendingError = error;
        return error?.code === 'P0001'
          && error?.message === 'whatsapp_cloud_projection_cleanup_lock_order'
          && error?.code !== '40P01';
      });
      await ascendingPromise;
      await ascending.query('ROLLBACK');
      await descending.query('ROLLBACK').catch(() => {});
    } finally {
      await descending.query('ROLLBACK').catch(() => {});
      await ascending.query('ROLLBACK').catch(() => {});
      descending.release();
      ascending.release();
    }

    assert.ok(descendingError);
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.wpp_outbox WHERE transport_origin = 'cloud') AS outbox,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0], baseline);
    await assertNoAdvisoryLocks(pool, trackedPids,
      'reverse cross-source winner must release advisories after rollback');
  });
});

for (const source of ['whatsapp_cloud_events', 'wpp_outbox']) {
  test(`cleanup puro ${source} acepta 1→1→2 y multi-tenant, rechaza 2→1 sin leaks`, async () => {
    await withDatabase(async pool => {
      await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
      await pool.query(outboxSql);
      await seedCleanupRaceSources(pool, `monotonic:${source}`);
      await pool.query(`
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin)
        VALUES
          (1, '549351555391', 'monotonic tenant one extra', 'pending', 'cloud'),
          (2, '549351555392', 'monotonic tenant two extra', 'pending', 'cloud')
      `);
      await pool.query(projectionSql);
      const baseline = (await pool.query(`
        SELECT
          (SELECT count(*)::int FROM public.${source}) AS source_rows,
          (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection_rows
      `)).rows[0];
      const client = await pool.connect();
      const processId = client.processID;
      let descendingError;
      try {
        await client.query('BEGIN');
        if (source === 'whatsapp_cloud_events') {
          await client.query("DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 1 AND event_kind = 'message'");
          await client.query("DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 1 AND event_kind = 'status'");
          await client.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 2');
        } else {
          await client.query("DELETE FROM public.wpp_outbox WHERE empresa_id = 1 AND mensaje = 'cleanup outbound one'");
          await client.query("DELETE FROM public.wpp_outbox WHERE empresa_id = 1 AND mensaje = 'monotonic tenant one extra'");
          await client.query('DELETE FROM public.wpp_outbox WHERE empresa_id = 2');
        }
        assert.equal((await pool.query(`
          SELECT count(*)::int AS total
            FROM pg_catalog.pg_locks
           WHERE locktype = 'advisory' AND pid = $1 AND granted
        `, [processId])).rows[0].total, 2, '1→1→2 must retain exactly tenant advisories 1 and 2');
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        await client.query(source === 'whatsapp_cloud_events'
          ? 'DELETE FROM public.whatsapp_cloud_events WHERE empresa_id IN (2, 1)'
          : "DELETE FROM public.wpp_outbox WHERE empresa_id IN (2, 1) AND transport_origin = 'cloud'");
        assert.equal((await pool.query(`
          SELECT count(*)::int AS total
            FROM pg_catalog.pg_locks
           WHERE locktype = 'advisory' AND pid = $1 AND granted
        `, [processId])).rows[0].total, 2,
        'one multi-tenant statement must deduplicate and retain both ordered advisories');
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        await client.query(`DELETE FROM public.${source} WHERE empresa_id = 2`);
        await assert.rejects(
          client.query(`DELETE FROM public.${source} WHERE empresa_id = 1`),
          error => {
            descendingError = error;
            return error?.code === 'P0001'
              && error?.message === 'whatsapp_cloud_projection_cleanup_lock_order'
              && error?.code !== '40P01';
          },
        );
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }

      assert.ok(descendingError);
      for (const property of ['message', 'detail', 'hint', 'where', 'schema', 'table', 'constraint']) {
        const exposed = String(descendingError[property] ?? '');
        assert.equal(exposed.includes('1'), false, `${source} ${property} must not expose tenant 1`);
        assert.equal(exposed.includes('2'), false, `${source} ${property} must not expose tenant 2`);
      }
      assert.deepEqual((await pool.query(`
        SELECT
          (SELECT count(*)::int FROM public.${source}) AS source_rows,
          (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection_rows
      `)).rows[0], baseline);
      await assertNoAdvisoryLocks(pool, [processId],
        `${source}: every monotonic commit/rollback path must release advisories`);
    });
  });
}

test('binding runtime posterior respeta el máximo de cleanup sin afectar el orden ascendente', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'cleanup-then-runtime');
    await pool.query(projectionSql);
    const baseline = (await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0];
    const client = await pool.connect();
    const processId = client.processID;
    let rejection;
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 2');
      await assert.rejects(client.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (1, 'message', 'cleanup-runtime:descending', 'cleanup-runtime-descending',
                '549351555499', 'text', '{"text":{"body":"descending runtime"}}'::jsonb)
      `), error => {
        rejection = error;
        return error?.code === 'P0001'
          && error?.message === 'whatsapp_cloud_projection_cleanup_lock_order'
          && error?.code !== '40P01';
      });
      await client.query('ROLLBACK').catch(() => {});

      await client.query('BEGIN');
      await client.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 1');
      await client.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (2, 'message', 'cleanup-runtime:ascending', 'cleanup-runtime-ascending',
                '549351555498', 'text', '{"text":{"body":"ascending runtime"}}'::jsonb)
      `);
      assert.equal((await pool.query(`
        SELECT count(*)::int AS total
          FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND pid = $1 AND granted
      `, [processId])).rows[0].total, 2,
      'cleanup 1 then runtime 2 must retain only the two ascending tenant advisories');
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    assert.ok(rejection);
    assert.deepEqual((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM public.whatsapp_cloud_events) AS events,
        (SELECT count(*)::int FROM public.whatsapp_cloud_messages) AS projection
    `)).rows[0], baseline);
    await assertNoAdvisoryLocks(pool, [processId],
      'cleanup/runtime binding integration must not leak advisories');
  });
});

test('cleanup puro tenant 1 no serializa writer runtime normal tenant 2', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await seedCleanupRaceSources(pool, 'normal-writer-parallel');
    await pool.query(projectionSql);
    const cleanup = await pool.connect();
    const writer = await pool.connect();
    const trackedPids = [cleanup.processID, writer.processID];
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('DELETE FROM public.whatsapp_cloud_events WHERE empresa_id = 1');
      await writer.query('BEGIN');
      await Promise.race([
        writer.query(`
          INSERT INTO public.whatsapp_cloud_events
            (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
          VALUES (2, 'message', 'normal-writer:parallel', 'normal-writer-parallel',
                  '549351555497', 'text', '{"text":{"body":"parallel writer"}}'::jsonb)
        `),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('normal tenant 2 writer was serialized behind cleanup tenant 1')), 500,
        )),
      ]);
      await writer.query('ROLLBACK');
      await cleanup.query('ROLLBACK');
    } finally {
      await cleanup.query('ROLLBACK').catch(() => {});
      await writer.query('ROLLBACK').catch(() => {});
      cleanup.release();
      writer.release();
    }
    await assertNoAdvisoryLocks(pool, trackedPids,
      'parallel normal writer and cleanup rollbacks must release advisories');
  });
});

test('DDL de reparación de trigger fuente no deadlockea con writer operativo y soporta disabled rollback/retry', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (710001)');
    await pool.query(outboxSql);
    await pool.query(projectionSql);

    const installOperationalWrongTrigger = async () => pool.query(`
      DROP TRIGGER whatsapp_cloud_messages_capture_insert ON public.whatsapp_cloud_events;
      CREATE TRIGGER whatsapp_cloud_messages_capture_insert
        AFTER INSERT ON public.whatsapp_cloud_events
        FOR EACH ROW WHEN (NEW.empresa_id IS NOT NULL)
        EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_event_insert()
    `);
    const insertInbound = (client, suffix) => client.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
      VALUES (710001, 'message', $1, $2, '549351555091', 'text',
              jsonb_build_object('text', jsonb_build_object('body', $3::text)))
    `, [`trigger-ddl:${suffix}`, `trigger-ddl-${suffix}`, suffix]);

    await installOperationalWrongTrigger();
    await insertInbound(pool, 'seed');

    const writerFirstMigration = projectionSql.replace(
      'LOCK TABLE public.whatsapp_cloud_events, public.wpp_outbox IN SHARE ROW EXCLUSIVE MODE;',
      'SELECT pg_catalog.pg_sleep(0.35);\nLOCK TABLE public.whatsapp_cloud_events, public.wpp_outbox IN SHARE ROW EXCLUSIVE MODE;',
    );
    assert.notEqual(writerFirstMigration, projectionSql, 'pre-source-lock phase must be injectable');
    const migrationSecond = await pool.connect();
    const writerFirst = await pool.connect();
    try {
      const migrationPromise = migrationSecond.query(writerFirstMigration);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [migrationSecond.processID],
      )).rows[0]?.wait_event === 'PgSleep', 'migration did not reach pre-trigger-repair hold');
      await writerFirst.query('BEGIN');
      await Promise.race([
        insertInbound(writerFirst, 'writer-first'),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('writer blocked before migration acquired the ordered source locks')),
          250,
        )),
      ]);
      await writerFirst.query('COMMIT');
      await migrationPromise;
    } finally {
      await writerFirst.query('ROLLBACK').catch(() => {});
      writerFirst.release();
      migrationSecond.release();
    }
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total FROM public.whatsapp_cloud_messages
       WHERE provider_message_id = 'trigger-ddl-writer-first'
    `)).rows[0].total, 1, 'writer that commits before repair must remain projected');

    await installOperationalWrongTrigger();
    const migrationFirstSql = projectionSql.replace(
      '      EXECUTE trigger_spec.create_sql;',
      '      EXECUTE trigger_spec.create_sql;\n      PERFORM pg_catalog.pg_sleep(0.35);',
    );
    assert.notEqual(migrationFirstSql, projectionSql, 'post-trigger-DDL hold must be injectable');
    const migrationFirst = await pool.connect();
    const writerSecond = await pool.connect();
    try {
      const migrationPromise = migrationFirst.query(migrationFirstSql);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [migrationFirst.processID],
      )).rows[0]?.wait_event === 'PgSleep', 'migration did not hold repaired trigger DDL first');
      const writerPromise = insertInbound(writerSecond, 'migration-first');
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [writerSecond.processID],
      )).rows[0]?.wait_event_type === 'Lock', 'writer did not wait for trigger DDL transaction');
      await migrationPromise;
      await writerPromise;
    } finally {
      migrationFirst.release();
      writerSecond.release();
    }
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total FROM public.whatsapp_cloud_messages
       WHERE provider_message_id = 'trigger-ddl-migration-first'
    `)).rows[0].total, 1, 'writer that loses trigger DDL lock must use repaired capture after commit');

    await pool.query(`
      ALTER TABLE public.whatsapp_cloud_events
        DISABLE TRIGGER whatsapp_cloud_messages_capture_insert
    `);
    const failingRepair = projectionSql.replace(
      '-- CLOUD PROJECTION DDL COMPLETE; COMMIT BEFORE TENANT DML',
      'SELECT 1 / 0;\n-- CLOUD PROJECTION DDL COMPLETE; COMMIT BEFORE TENANT DML',
    );
    assert.notEqual(failingRepair, projectionSql, 'pre-commit DDL failure must be injectable');
    const retrying = await pool.connect();
    try {
      await assert.rejects(retrying.query(failingRepair), /division by zero/);
      await retrying.query('ROLLBACK');
      assert.equal((await triggerShape(pool, 'public.whatsapp_cloud_events')).tgenabled, 'D',
        'failed repair must roll back to the previously disabled trigger');
      await retrying.query(projectionSql);
    } finally {
      await retrying.query('ROLLBACK').catch(() => {});
      retrying.release();
    }
    assert.equal((await triggerShape(pool, 'public.whatsapp_cloud_events')).tgenabled, 'O',
      'clean retry must restore the canonical enabled trigger');
  });
});

test('migración toma lock advisory transaccional estable antes del primer DDL y dos ejecuciones completas frescas terminan exit 0', async () => {
  const begin = projectionSql.indexOf('BEGIN;');
  const safePath = projectionSql.indexOf('SET LOCAL search_path = public;');
  const lockTimeout = projectionSql.indexOf("SET LOCAL lock_timeout = '30s';");
  const statementTimeout = projectionSql.indexOf("SET LOCAL statement_timeout = '5min';");
  const advisoryLock = projectionSql.indexOf('SELECT pg_catalog.pg_advisory_xact_lock(1464550724, 1229867347);');
  const sourceLock = projectionSql.indexOf(
    'LOCK TABLE public.whatsapp_cloud_events, public.wpp_outbox IN SHARE ROW EXCLUSIVE MODE;',
  );
  const firstDdl = projectionSql.search(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|SEQUENCE|INDEX)\b/i);
  assert.ok(begin >= 0 && safePath > begin && lockTimeout > safePath && statementTimeout > lockTimeout
    && advisoryLock > statementTimeout && sourceLock > advisoryLock && firstDdl > sourceLock,
  'safe search_path, timeouts, migration advisory and ordered source locks must precede projection DDL');

  await withDatabase(async (pool, { directory, port }) => {
    await pool.query(outboxSql);
    const delayedMigration = projectionSql.replace(
      'SELECT pg_catalog.pg_advisory_xact_lock(1464550724, 1229867347);',
      "SELECT pg_catalog.pg_advisory_xact_lock(1464550724, 1229867347);\nSELECT pg_catalog.pg_sleep(0.35);",
    );
    const file = join(directory, 'cloud-inbox-projection.sql');
    writeFileSync(file, delayedMigration);
    const startedAt = Date.now();
    const results = await Promise.all([
      runPsqlFile({ port, file }),
      runPsqlFile({ port, file }),
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(results.map(result => result.code), [0, 0],
      results.map(result => result.stderr).join('\n'));
    assert.ok(elapsedMs >= 600,
      `advisory lock must serialize both 350ms critical sections (elapsed ${elapsedMs}ms)`);
    assert.equal((await pool.query("SELECT to_regclass('whatsapp_cloud_messages') IS NOT NULL AS present")).rows[0].present, true);
  });
});

test('backfill copia sólo contenido allowlisted, estados/timestamps y vínculos Cloud inequívocos', async () => {
  await withDatabase(async pool => {
    await seedBackfillSources(pool);
    await pool.query(migrationSql);

    const rows = (await pool.query(`
      SELECT empresa_id, direction, participant_wa_id, provider_message_id, message_type,
             text_body, media_mime_type, media_caption, document_filename, delivery_status,
             source_event_id IS NOT NULL AS has_source_event,
             outbox_id IS NOT NULL AS has_outbox,
             sent_at IS NOT NULL AS has_sent_at,
             delivered_at IS NOT NULL AS has_delivered_at,
             read_at IS NOT NULL AS has_read_at
        FROM whatsapp_cloud_messages
       ORDER BY empresa_id, direction, provider_message_id NULLS LAST, text_body NULLS LAST
    `)).rows;
    assert.deepEqual(rows, [
      {
        empresa_id: 1, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'in-document', message_type: 'document', text_body: null,
        media_mime_type: 'application/pdf', media_caption: 'factura', document_filename: 'factura.pdf',
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'in-image', message_type: 'image', text_body: null,
        media_mime_type: 'image/jpeg', media_caption: 'foto', document_filename: null,
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'in-text', message_type: 'text', text_body: 'hola',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555002',
        provider_message_id: 'out-sent', message_type: 'text', text_body: 'respuesta',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'read', has_source_event: false, has_outbox: true,
        has_sent_at: true, has_delivered_at: true, has_read_at: true,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555005',
        provider_message_id: null, message_type: 'text', text_body: 'incierto',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'outcome_unknown', has_source_event: false, has_outbox: true,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555003',
        provider_message_id: null, message_type: 'text', text_body: 'pendiente',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'queued', has_source_event: false, has_outbox: true,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 1, direction: 'outbound', participant_wa_id: '549351555004',
        provider_message_id: null, message_type: 'text', text_body: 'reintentar',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'manual_retry', has_source_event: false, has_outbox: true,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
      {
        empresa_id: 2, direction: 'inbound', participant_wa_id: '549351555001',
        provider_message_id: 'tenant-two', message_type: 'text', text_body: 'otro tenant',
        media_mime_type: null, media_caption: null, document_filename: null,
        delivery_status: 'received', has_source_event: true, has_outbox: false,
        has_sent_at: false, has_delivered_at: false, has_read_at: false,
      },
    ]);

    const serialized = JSON.stringify((await pool.query('SELECT * FROM whatsapp_cloud_messages')).rows);
    for (const forbidden of ['secret-media-image', 'secret-media-document', 'secret-sha', 'secret-doc-sha', 'opaque', '+54 9', '@c.us']) {
      assert.equal(serialized.includes(forbidden), false, `must not copy ${forbidden}`);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM whatsapp_cloud_messages')).rows[0].total, 8);
  });
});

test('backfill limita texto outbound legacy largo por caracteres sin abortar y converge idempotentemente', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES
        (1, '549351555040', repeat('a', 4096), 'pending', 'cloud'),
        (1, '549351555041', repeat('b', 4097), 'pending', 'cloud'),
        (1, '549351555042', repeat('🙂', 5001), 'pending', 'cloud')
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const rows = (await pool.query(`
      SELECT participant_wa_id, text_body, length(text_body)::int AS character_length,
             octet_length(text_body)::int AS byte_length
        FROM whatsapp_cloud_messages
       WHERE participant_wa_id IN ('549351555040', '549351555041', '549351555042')
       ORDER BY participant_wa_id
    `)).rows;

    assert.equal(rows.length, 3, 'rerunning the migration must not duplicate projected outbox rows');
    assert.deepEqual(rows.map(row => ({
      participant_wa_id: row.participant_wa_id,
      character_length: row.character_length,
      byte_length: row.byte_length,
    })), [
      { participant_wa_id: '549351555040', character_length: 4096, byte_length: 4096 },
      { participant_wa_id: '549351555041', character_length: 4096, byte_length: 4096 },
      { participant_wa_id: '549351555042', character_length: 4096, byte_length: 16384 },
    ]);
    assert.equal(rows[0].text_body, 'a'.repeat(4096));
    assert.equal(rows[1].text_body, 'b'.repeat(4096));
    assert.equal(rows[2].text_body, '🙂'.repeat(4096));
  });
});

test('backfill conserva status sent legacy sin sent_at usando created_at sólo como timestamp mínimo de envío', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES
        (1, '549351555010', 'sent legacy sin timestamp', '2026-10-01T15:00:00Z', NULL,
         'sent', 'cloud', 'out-sent-without-timestamp', 'sent')
    `);

    await pool.query(projectionSql);

    const row = (await pool.query(`
      SELECT delivery_status, state_rank, message_at, sent_at, delivered_at, read_at, failed_at
        FROM whatsapp_cloud_messages
       WHERE provider_message_id = 'out-sent-without-timestamp'
    `)).rows[0];
    assert.equal(row.delivery_status, 'sent');
    assert.equal(row.state_rank, 30);
    assert.equal(row.message_at.toISOString(), '2026-10-01T15:00:00.000Z');
    // El status fuente prueba envío, pero no delivery: created_at es sólo el fallback conservador
    // necesario para mantener el estado sent coherente con el constraint temporal.
    assert.equal(row.sent_at.toISOString(), '2026-10-01T15:00:00.000Z');
    assert.equal(row.delivered_at, null);
    assert.equal(row.read_at, null);
    assert.equal(row.failed_at, null);
  });
});

test('backfill canoniza cronologías irregulares sin abortar ni violar constraints', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES
        (1, '549351555020', 'delivered sin sent', '2026-10-01T10:00:00Z', NULL,
         'sending', 'cloud', 'irregular-delivered-only', 'pre_dispatch'),
        (1, '549351555021', 'reloj desalineado', '2026-10-01T11:00:00Z', NULL,
         'sending', 'cloud', 'irregular-clock-skew', 'pre_dispatch'),
        (1, '549351555022', 'sent y failed', '2026-10-01T12:00:00Z', NULL,
         'sending', 'cloud', 'irregular-sent-failed', 'pre_dispatch'),
        (1, '549351555023', 'failed legacy con sent_at', '2026-10-01T13:00:00Z',
         '2026-10-01T13:02:00Z', 'error', 'cloud', 'irregular-failed', 'definitive_failed')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'irregular:delivered-only', 'irregular-delivered-only', '549351555020',
         'delivered', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:05:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T10:05:01Z'),
        (1, 'status', 'irregular:clock:delivered', 'irregular-clock-skew', '549351555021',
         'delivered', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T11:01:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T11:01:01Z'),
        (1, 'status', 'irregular:clock:sent', 'irregular-clock-skew', '549351555021',
         'sent', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T11:03:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T11:03:01Z'),
        (1, 'status', 'irregular:mixed:failed', 'irregular-sent-failed', '549351555022',
         'failed', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:04:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T12:04:01Z'),
        (1, 'status', 'irregular:mixed:sent', 'irregular-sent-failed', '549351555022',
         'sent', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:02:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T12:02:01Z')
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const rows = (await pool.query(`
      SELECT provider_message_id, delivery_status, state_rank,
             to_char(message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS message_at,
             to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
             to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at,
             to_char(failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS failed_at
        FROM whatsapp_cloud_messages
       WHERE provider_message_id LIKE 'irregular-%'
       ORDER BY provider_message_id
    `)).rows;
    assert.deepEqual(rows, [
      {
        provider_message_id: 'irregular-clock-skew', delivery_status: 'delivered', state_rank: 40,
        message_at: '2026-10-01T11:00:00Z', sent_at: '2026-10-01T11:01:00Z',
        delivered_at: '2026-10-01T11:01:00Z', read_at: null, failed_at: null,
      },
      {
        provider_message_id: 'irregular-delivered-only', delivery_status: 'delivered', state_rank: 40,
        message_at: '2026-10-01T10:00:00Z', sent_at: '2026-10-01T10:05:00Z',
        delivered_at: '2026-10-01T10:05:00Z', read_at: null, failed_at: null,
      },
      {
        provider_message_id: 'irregular-failed', delivery_status: 'failed', state_rank: 25,
        message_at: '2026-10-01T13:00:00Z', sent_at: null, delivered_at: null,
        read_at: null, failed_at: '2026-10-01T13:02:00Z',
      },
      {
        provider_message_id: 'irregular-sent-failed', delivery_status: 'sent', state_rank: 30,
        message_at: '2026-10-01T12:00:00Z', sent_at: '2026-10-01T12:02:00Z',
        delivered_at: null, read_at: null, failed_at: null,
      },
    ]);
  });
});

test('backfill converge timestamps inferidos cuando llega después el evento real más temprano', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES
        (1, '549351555030', 'convergencia temporal', '2026-10-01T10:00:00Z', NULL,
         'sending', 'cloud', 'convergent-timestamps', 'pre_dispatch')
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'convergent:delivered', 'convergent-timestamps', '549351555030',
         'delivered', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:05:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T10:05:01Z')
    `);

    await pool.query(projectionSql);

    const inferred = (await pool.query(`
      SELECT delivery_status, state_rank, message_at, sent_at, delivered_at, read_at, failed_at
        FROM whatsapp_cloud_messages
       WHERE provider_message_id = 'convergent-timestamps'
    `)).rows[0];
    assert.equal(inferred.delivery_status, 'delivered');
    assert.equal(inferred.state_rank, 40);
    assert.equal(inferred.sent_at.toISOString(), '2026-10-01T10:05:00.000Z');
    assert.equal(inferred.delivered_at.toISOString(), '2026-10-01T10:05:00.000Z');
    assert.equal(inferred.read_at, null);
    assert.equal(inferred.failed_at, null);

    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'convergent:sent', 'convergent-timestamps', '549351555030',
         'sent', EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:02:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-01T10:06:00Z')
    `);

    await pool.query(projectionSql);

    const converged = (await pool.query(`
      SELECT delivery_status, state_rank, message_at, sent_at, delivered_at, read_at, failed_at,
             message_at <= sent_at AS message_before_sent,
             sent_at <= delivered_at AS sent_before_delivered,
             delivered_at <= COALESCE(read_at, delivered_at) AS delivered_before_read
        FROM whatsapp_cloud_messages
       WHERE provider_message_id = 'convergent-timestamps'
    `)).rows[0];
    assert.equal(converged.delivery_status, 'delivered');
    assert.equal(converged.state_rank, 40);
    assert.equal(converged.message_at.toISOString(), '2026-10-01T10:00:00.000Z');
    assert.equal(converged.sent_at.toISOString(), '2026-10-01T10:02:00.000Z');
    assert.equal(converged.delivered_at.toISOString(), '2026-10-01T10:05:00.000Z');
    assert.equal(converged.read_at, null);
    assert.equal(converged.failed_at, null);
    assert.equal(converged.message_before_sent, true);
    assert.equal(converged.sent_before_delivered, true);
    assert.equal(converged.delivered_before_read, true);
  });
});

test('constraints aíslan tenant, dirección/estado/rank/timestamps y rechazan enlaces cruzados', async () => {
  await withDatabase(async pool => {
    await seedBackfillSources(pool);
    const eventId = (await pool.query("SELECT id FROM whatsapp_cloud_events WHERE message_id = 'tenant-two'")).rows[0].id;
    const outboxId = (await pool.query("SELECT id FROM wpp_outbox WHERE mensaje = 'pendiente'")).rows[0].id;

    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'sideways', '549351555001', 'text', 'x', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '+549****5001', 'text', 'x', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, media_mime_type, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555001', 'text', 'x', 'image/jpeg', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, source_event_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555001', $1, 'text', 'x', 'received', 0, NOW())
    `, [eventId]), error => error?.code === '23503');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, outbox_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (2, 'outbound', '549351555003', $1, 'text', 'x', 'queued', 10, NOW())
    `, [outboxId]), error => error?.code === '23503');

    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555001', 'text', 'x', 'sent', 30, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'outbound', '549351555001', 'text', 'x', 'received', 0, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank, message_at)
      VALUES (1, 'outbound', '549351555001', 'text', 'x', 'delivered', 30, NOW())
    `), error => error?.code === '23514');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body, delivery_status, state_rank,
         message_at, delivered_at)
      VALUES (1, 'outbound', '549351555001', 'text', 'x', 'queued', 10, NOW(), NOW())
    `), error => error?.code === '23514');
  });
});

test('cleanup de fuentes conserva la proyección y sólo anula el vínculo borrado', async () => {
  await withDatabase(async pool => {
    await seedBackfillSources(pool);
    await pool.query(migrationSql);
    const inbound = (await pool.query("SELECT id, source_event_id FROM whatsapp_cloud_messages WHERE provider_message_id = 'in-text'")).rows[0];
    const outbound = (await pool.query("SELECT id, outbox_id FROM whatsapp_cloud_messages WHERE provider_message_id = 'out-sent'")).rows[0];

    await pool.query('DELETE FROM whatsapp_cloud_events WHERE id = $1', [inbound.source_event_id]);
    await pool.query('DELETE FROM wpp_outbox WHERE id = $1', [outbound.outbox_id]);

    assert.deepEqual((await pool.query(
      'SELECT empresa_id, source_event_id, provider_message_id, text_body FROM whatsapp_cloud_messages WHERE id = $1',
      [inbound.id],
    )).rows[0], { empresa_id: 1, source_event_id: null, provider_message_id: 'in-text', text_body: 'hola' });
    assert.deepEqual((await pool.query(
      'SELECT empresa_id, outbox_id, provider_message_id, text_body FROM whatsapp_cloud_messages WHERE id = $1',
      [outbound.id],
    )).rows[0], { empresa_id: 1, outbox_id: null, provider_message_id: 'out-sent', text_body: 'respuesta' });
  });
});

test('source_timestamp usa límites explícitos contra received_at y fallback fuera de tolerancia', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'message', 'message:epoch-zero', 'epoch-zero', '549351555001', 'text', '0',
         '{"text":{"body":"zero"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:past-boundary', 'past-boundary', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-09-01T12:00:00Z')::bigint::text,
         '{"text":{"body":"past-boundary"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:past-outside', 'past-outside', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-09-01T11:59:59Z')::bigint::text,
         '{"text":{"body":"past-outside"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:future-boundary', 'future-boundary', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:05:00Z')::bigint::text,
         '{"text":{"body":"future-boundary"}}', '2026-10-01T12:00:00Z'),
        (1, 'message', 'message:future-outside', 'future-outside', '549351555001', 'text',
         EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T12:05:01Z')::bigint::text,
         '{"text":{"body":"future-outside"}}', '2026-10-01T12:00:00Z')
    `);

    await pool.query(migrationSql);
    const rows = (await pool.query(`
      SELECT provider_message_id, message_at
        FROM whatsapp_cloud_messages
       ORDER BY provider_message_id
    `)).rows.map(row => ({ ...row, message_at: row.message_at.toISOString() }));
    assert.deepEqual(rows, [
      { provider_message_id: 'epoch-zero', message_at: '2026-10-01T12:00:00.000Z' },
      { provider_message_id: 'future-boundary', message_at: '2026-10-01T12:05:00.000Z' },
      { provider_message_id: 'future-outside', message_at: '2026-10-01T12:00:00.000Z' },
      { provider_message_id: 'past-boundary', message_at: '2026-09-01T12:00:00.000Z' },
      { provider_message_id: 'past-outside', message_at: '2026-10-01T12:00:00.000Z' },
    ]);
  });
});

test('migración repara secuencia propia para id BIGINT legacy sin default y la sincroniza sobre MAX(id)', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      CREATE TABLE whatsapp_cloud_messages (
        id BIGINT NOT NULL,
        empresa_id INTEGER,
        direction TEXT,
        participant_wa_id TEXT,
        message_type TEXT,
        text_body TEXT,
        delivery_status TEXT,
        state_rank SMALLINT,
        message_at TIMESTAMPTZ
      );
      CREATE SEQUENCE public.whatsapp_cloud_messages_id_seq AS BIGINT
    `);
    await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (id, empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES
        (9001, 1, 'outbound', '549351555011', 'text', 'legacy explícito',
         'queued', 10, '2026-10-01T16:00:00Z')
    `);

    const legacyId = (await pool.query(`
      SELECT column_row.attnotnull,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression,
             pg_get_serial_sequence('whatsapp_cloud_messages', 'id') AS sequence_name
        FROM pg_attribute AS column_row
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = column_row.attrelid
         AND default_row.adnum = column_row.attnum
       WHERE column_row.attrelid = 'whatsapp_cloud_messages'::regclass
         AND column_row.attname = 'id'
    `)).rows[0];
    assert.deepEqual(legacyId, {
      attnotnull: true,
      default_expression: null,
      sequence_name: null,
    });
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM pg_depend
       WHERE classid = 'pg_class'::regclass
         AND objid = 'public.whatsapp_cloud_messages_id_seq'::regclass
         AND refclassid = 'pg_class'::regclass
         AND deptype = 'a'
    `)).rows[0].total, 0, 'legacy canonical BIGINT sequence starts without an owner');

    await pool.query(projectionSql);

    const sequence = (await pool.query(`
      SELECT pg_get_serial_sequence('whatsapp_cloud_messages', 'id') AS name,
             pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
        FROM pg_attribute AS column_row
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid = column_row.attrelid
         AND default_row.adnum = column_row.attnum
       WHERE column_row.attrelid = 'whatsapp_cloud_messages'::regclass
         AND column_row.attname = 'id'
    `)).rows[0];
    assert.equal(sequence.name, 'public.whatsapp_cloud_messages_id_seq');
    assert.match(sequence.default_expression, /^nextval\('whatsapp_cloud_messages_id_seq'::regclass\)$/);

    const ownership = (await pool.query(`
      SELECT count(*)::int AS total
        FROM pg_depend
       WHERE classid = 'pg_class'::regclass
         AND objid = $1::regclass
         AND refclassid = 'pg_class'::regclass
         AND refobjid = 'whatsapp_cloud_messages'::regclass
         AND refobjsubid = (
           SELECT attnum
             FROM pg_attribute
            WHERE attrelid = 'whatsapp_cloud_messages'::regclass
              AND attname = 'id'
         )
         AND deptype = 'a'
    `, [sequence.name])).rows[0];
    assert.equal(ownership.total, 1);

    const inserted = (await pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES
        (1, 'outbound', '549351555012', 'text', 'id automático',
         'queued', 10, '2026-10-01T16:01:00Z')
      RETURNING id
    `)).rows[0];
    assert.ok(Number(inserted.id) > 9001);

    await pool.query(projectionSql);

    assert.deepEqual((await pool.query(`
      SELECT id::text, text_body
        FROM whatsapp_cloud_messages
       ORDER BY id
    `)).rows, [
      { id: '9001', text_body: 'legacy explícito' },
      { id: inserted.id, text_body: 'id automático' },
    ]);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM pg_depend
       WHERE classid = 'pg_class'::regclass
         AND objid = 'whatsapp_cloud_messages_id_seq'::regclass
         AND refclassid = 'pg_class'::regclass
         AND refobjid = 'whatsapp_cloud_messages'::regclass
         AND deptype = 'a'
    `)).rows[0].total, 1);
  });
});

test('migración repara fixture legacy incompleto, constraints, uniques e índices parentales engañosos', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query(`
      CREATE UNIQUE INDEX whatsapp_cloud_events_empresa_id_id_uidx
        ON whatsapp_cloud_events (empresa_id) INCLUDE (id)
       WHERE id IS NOT NULL;
      CREATE UNIQUE INDEX wpp_outbox_empresa_id_id_uidx
        ON wpp_outbox (empresa_id) INCLUDE (id)
       WHERE id IS NOT NULL;
      CREATE TABLE whatsapp_cloud_messages (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INTEGER,
        direction TEXT,
        participant_wa_id TEXT,
        message_at TIMESTAMP WITHOUT TIME ZONE
      );
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_direction_check CHECK (direction <> 'sideways');
      CREATE UNIQUE INDEX whatsapp_cloud_messages_source_event_uidx
        ON whatsapp_cloud_messages (empresa_id) INCLUDE (id);
      CREATE INDEX idx_whatsapp_cloud_messages_timeline
        ON whatsapp_cloud_messages (empresa_id, message_at, id)
        INCLUDE (participant_wa_id)
       WHERE participant_wa_id IS NOT NULL;
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const columns = (await pool.query(`
      SELECT attname, format_type(atttypid, atttypmod) AS data_type, attnotnull
        FROM pg_attribute
       WHERE attrelid = 'whatsapp_cloud_messages'::regclass
         AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum
    `)).rows;
    assert.deepEqual(new Set(columns.map(row => row.attname)), new Set([
      'id', 'empresa_id', 'direction', 'participant_wa_id', 'delivery_status', 'message_at',
      'source_event_id', 'outbox_id', 'source_outbox_id', 'provider_message_id', 'message_type', 'text_body',
      'media_mime_type', 'media_caption', 'document_filename', 'state_rank', 'sent_at',
      'delivered_at', 'read_at', 'failed_at', 'created_at', 'updated_at',
    ]));
    for (const required of ['empresa_id', 'direction', 'participant_wa_id', 'delivery_status',
      'message_at', 'message_type', 'state_rank', 'created_at', 'updated_at']) {
      assert.equal(columns.find(row => row.attname === required).attnotnull, true, `${required} repaired NOT NULL`);
    }
    assert.equal(columns.find(row => row.attname === 'message_at').data_type, 'timestamp with time zone');

    assert.deepEqual((await indexShape(pool, 'whatsapp_cloud_events_empresa_id_id_uidx')).key_columns,
      ['empresa_id', 'id']);
    assert.deepEqual((await indexShape(pool, 'wpp_outbox_empresa_id_id_uidx')).key_columns,
      ['empresa_id', 'id']);
    assert.deepEqual((await indexShape(pool, 'whatsapp_cloud_messages_source_event_uidx')).key_columns,
      ['empresa_id', 'source_event_id']);
    assert.deepEqual((await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline')).key_columns,
      ['empresa_id', 'participant_wa_id', 'message_at', 'id']);
  });
});

test('reparación canónica reemplaza sólo timestamps legacy y sanea filas antes de validar', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      ALTER TABLE whatsapp_cloud_messages
        DROP CONSTRAINT whatsapp_cloud_messages_timestamps_check;
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_timestamps_check
        CHECK (
          direction = 'inbound'
          OR (direction = 'outbound'
            AND (sent_at IS NULL OR sent_at >= message_at)
            AND (failed_at IS NULL OR failed_at >= message_at)
            AND CASE delivery_status
              WHEN 'failed' THEN delivered_at IS NULL AND read_at IS NULL AND failed_at IS NOT NULL
              ELSE TRUE
            END)
        );
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at, sent_at, failed_at)
      VALUES
        (1, 'outbound', '549351555024', 'text', 'legacy permitido',
         'failed', 25, '2026-10-01T14:00:00Z', '2026-10-01T14:01:00Z',
         '2026-10-01T14:02:00Z')
    `);

    await pool.query(projectionSql);

    assert.deepEqual((await pool.query(`
      SELECT sent_at, delivered_at, read_at, failed_at IS NOT NULL AS has_failed_at
        FROM whatsapp_cloud_messages
       WHERE text_body = 'legacy permitido'
    `)).rows[0], {
      sent_at: null, delivered_at: null, read_at: null, has_failed_at: true,
    });
    const definition = (await pool.query(`
      SELECT lower(pg_get_constraintdef(oid)) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = 'whatsapp_cloud_messages_timestamps_check'
    `)).rows[0].definition;
    assert.match(definition, /when 'failed'::text then .*sent_at is null.*failed_at is not null/i);
  });
});

test('reparación canónica exacta corrige variantes engañosas de todas las constraints y conserva constraints ajenos', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    const canonicalNames = [
      'whatsapp_cloud_messages_empresa_id_fkey',
      'whatsapp_cloud_messages_source_event_fkey',
      'whatsapp_cloud_messages_outbox_fkey',
      'whatsapp_cloud_messages_direction_check',
      'whatsapp_cloud_messages_participant_check',
      'whatsapp_cloud_messages_type_check',
      'whatsapp_cloud_messages_content_check',
      'whatsapp_cloud_messages_content_length_check',
      'whatsapp_cloud_messages_delivery_status_check',
      'whatsapp_cloud_messages_direction_status_check',
      'whatsapp_cloud_messages_state_rank_check',
      'whatsapp_cloud_messages_timestamps_check',
      'whatsapp_cloud_messages_source_direction_check',
      'whatsapp_cloud_messages_outbox_direction_check',
    ];
    const canonicalBefore = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [canonicalNames])).rows;
    assert.equal(canonicalBefore.length, canonicalNames.length);

    await pool.query(`
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_unrelated_check
        CHECK (char_length(participant_wa_id) >= 6)
    `);
    const unrelatedBefore = (await pool.query(`
      SELECT oid::text, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = 'whatsapp_cloud_messages_unrelated_check'
    `)).rows[0];

    for (const constraint of canonicalBefore) {
      await pool.query(`ALTER TABLE whatsapp_cloud_messages DROP CONSTRAINT ${constraint.conname}`);
      if (constraint.contype === 'c') {
        assert.match(constraint.definition, /^CHECK \([\s\S]*\)$/);
        const expression = constraint.definition.slice('CHECK ('.length, -1);
        await pool.query(`
          ALTER TABLE whatsapp_cloud_messages
            ADD CONSTRAINT ${constraint.conname}
            CHECK ((${expression}) OR participant_wa_id = 'not-a-wa-id')
        `);
      } else {
        assert.equal(constraint.contype, 'f');
        await pool.query(`
          ALTER TABLE whatsapp_cloud_messages
            ADD CONSTRAINT ${constraint.conname}
            ${constraint.definition} DEFERRABLE INITIALLY DEFERRED
        `);
      }
    }

    await pool.query(projectionSql);

    const canonicalAfter = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = ANY($1::text[])
       ORDER BY conname
    `, [canonicalNames])).rows;
    assert.deepEqual(canonicalAfter, canonicalBefore,
      'every canonical constraint must be repaired to its exact PostgreSQL definition');
    assert.deepEqual((await pool.query(`
      SELECT oid::text, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname = 'whatsapp_cloud_messages_unrelated_check'
    `)).rows[0], unrelatedBefore, 'unrelated constraints must retain identity and definition');
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', 'not-a-wa-id', 'text', 'rechazar', 'received', 0, NOW())
    `), error => error?.code === '23514'
      && error?.constraint === 'whatsapp_cloud_messages_participant_check');
  });
});

test('reparación legacy conserva constraints ajenos durante doble migración', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(projectionSql);
    await pool.query(`
      ALTER TABLE whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_independent_check
        CHECK (char_length(participant_wa_id) >= 6),
        ADD CONSTRAINT whatsapp_cloud_messages_independent_unique
        UNIQUE (empresa_id, id, participant_wa_id)
    `);

    await pool.query(projectionSql);
    await pool.query(projectionSql);

    const constraints = (await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname LIKE 'whatsapp_cloud_messages_independent_%'
       ORDER BY conname
    `)).rows;
    assert.deepEqual(constraints.map(row => ({ conname: row.conname, contype: row.contype })), [
      { conname: 'whatsapp_cloud_messages_independent_check', contype: 'c' },
      { conname: 'whatsapp_cloud_messages_independent_unique', contype: 'u' },
    ]);
    assert.match(constraints[0].definition, /char_length\(participant_wa_id\) >= 6/i);
    assert.match(constraints[1].definition, /UNIQUE \(empresa_id, id, participant_wa_id\)/i);
  });
});

test('reejecución normal espera al writer en el lock fuente ordenado sin reconstruir objetos', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    assert.doesNotMatch(projectionSql,
      /LOCK\s+TABLE\s+[^;]*(?:whatsapp_cloud_events|wpp_outbox)[^;]*ACCESS\s+EXCLUSIVE/is);
    const canonicalObjectsBefore = (await pool.query(`
      SELECT 'constraint' AS kind, conname AS name, oid::text
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname LIKE 'whatsapp_cloud_messages_%'
      UNION ALL
      SELECT 'index', relname, oid::text
        FROM pg_class
       WHERE relname IN (
         'whatsapp_cloud_events_empresa_id_id_uidx',
         'wpp_outbox_empresa_id_id_uidx',
         'whatsapp_cloud_messages_source_event_uidx',
         'whatsapp_cloud_messages_outbox_uidx',
         'whatsapp_cloud_messages_provider_message_uidx',
         'idx_whatsapp_cloud_messages_conversations',
         'idx_whatsapp_cloud_messages_timeline'
       )
       ORDER BY kind, name
    `)).rows;

    const writer = await pool.connect();
    let committed = false;
    try {
      await writer.query('BEGIN');
      await writer.query(`
        INSERT INTO whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (1, 'message', 'concurrent:event', 'concurrent-event', '549351555030', 'text',
                '{"text":{"body":"concurrente"}}'::jsonb)
      `);
      await writer.query(`
        INSERT INTO wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin)
        VALUES (1, '549351555031', 'concurrente', 'pending', 'cloud')
      `);

      const migrator = await pool.connect();
      try {
        const migrationPromise = migrator.query(projectionSql);
        await waitUntil(async () => {
          const wait = (await pool.query(`
            SELECT wait_event_type, wait_event
              FROM pg_catalog.pg_stat_activity
             WHERE pid = $1
          `, [migrator.processID])).rows[0];
          return wait?.wait_event_type === 'Lock' && wait?.wait_event === 'relation';
        }, 'rerun did not wait on the active writer source relation lock');
        await writer.query('COMMIT');
        committed = true;
        await migrationPromise;
      } finally {
        migrator.release();
      }
    } finally {
      if (!committed) await writer.query('ROLLBACK').catch(() => {});
      writer.release();
    }

    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM whatsapp_cloud_events
       WHERE dedupe_key = 'concurrent:event'
    `)).rows[0].total, 1);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM wpp_outbox
       WHERE mensaje = 'concurrente'
    `)).rows[0].total, 1);
    const canonicalObjectsAfter = (await pool.query(`
      SELECT 'constraint' AS kind, conname AS name, oid::text
        FROM pg_constraint
       WHERE conrelid = 'whatsapp_cloud_messages'::regclass
         AND conname LIKE 'whatsapp_cloud_messages_%'
      UNION ALL
      SELECT 'index', relname, oid::text
        FROM pg_class
       WHERE relname IN (
         'whatsapp_cloud_events_empresa_id_id_uidx',
         'wpp_outbox_empresa_id_id_uidx',
         'whatsapp_cloud_messages_source_event_uidx',
         'whatsapp_cloud_messages_outbox_uidx',
         'whatsapp_cloud_messages_provider_message_uidx',
         'idx_whatsapp_cloud_messages_conversations',
         'idx_whatsapp_cloud_messages_timeline'
       )
       ORDER BY kind, name
    `)).rows;
    assert.deepEqual(canonicalObjectsAfter, canonicalObjectsBefore,
      'canonical constraints and indexes must not be rebuilt on a normal rerun');
  });
});

test('migración reemplaza índice legacy engañoso aunque contenga columnas sólo en INCLUDE/predicado', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query('DROP INDEX idx_whatsapp_cloud_messages_timeline');
    await pool.query(`
      CREATE INDEX idx_whatsapp_cloud_messages_timeline
        ON whatsapp_cloud_messages (empresa_id, message_at, id)
        INCLUDE (participant_wa_id)
       WHERE participant_wa_id IS NOT NULL
    `);

    await pool.query(migrationSql);
    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline'), {
      indisunique: false,
      indnkeyatts: 4,
      indnatts: 4,
      has_expressions: false,
      sort_options: '0 0 3 3',
      key_columns: ['empresa_id', 'participant_wa_id', 'message_at', 'id'],
      predicate: null,
    });
    await pool.query(migrationSql);
    assert.deepEqual((await indexShape(pool, 'idx_whatsapp_cloud_messages_timeline')).key_columns,
      ['empresa_id', 'participant_wa_id', 'message_at', 'id']);
  });
});

test('backfill de contenido sólo acepta strings JSON y limita texto, MIME, caption y filename', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'message', 'json-types:image', 'json-types-image', '549351555041', 'image',
         '1760000000',
         '{"image":{"mime_type":{"opaque":"image/jpeg"},"caption":["opaque"]}}'::jsonb,
         '2026-10-01T10:00:00Z'),
        (1, 'message', 'json-types:document', 'json-types-document', '549351555042', 'document',
         '1760000001',
         jsonb_build_object('document', jsonb_build_object(
           'mime_type', repeat('m', 300), 'caption', repeat('c', 1100),
           'filename', repeat('f', 300))),
         '2026-10-01T10:00:01Z'),
        (1, 'message', 'json-types:text', 'json-types-text', '549351555043', 'text',
         '1760000002', jsonb_build_object('text', jsonb_build_object('body', repeat('t', 5000))),
         '2026-10-01T10:00:02Z')
    `);

    await pool.query(migrationSql);

    const rows = (await pool.query(`
      SELECT provider_message_id, media_mime_type, media_caption, document_filename,
             length(text_body) AS text_length, length(media_mime_type) AS mime_length,
             length(media_caption) AS caption_length, length(document_filename) AS filename_length
        FROM whatsapp_cloud_messages
       ORDER BY provider_message_id
    `)).rows;
    assert.deepEqual(rows, [
      {
        provider_message_id: 'json-types-document', media_mime_type: 'm'.repeat(255),
        media_caption: 'c'.repeat(1024), document_filename: 'f'.repeat(255),
        text_length: null, mime_length: 255, caption_length: 1024, filename_length: 255,
      },
      {
        provider_message_id: 'json-types-image', media_mime_type: null,
        media_caption: null, document_filename: null,
        text_length: null, mime_length: null, caption_length: null, filename_length: null,
      },
      {
        provider_message_id: 'json-types-text', media_mime_type: null,
        media_caption: null, document_filename: null,
        text_length: 4096, mime_length: null, caption_length: null, filename_length: null,
      },
    ]);
    await assert.rejects(pool.query(`
      INSERT INTO whatsapp_cloud_messages
        (empresa_id, direction, participant_wa_id, message_type, text_body,
         delivery_status, state_rank, message_at)
      VALUES (1, 'inbound', '549351555044', 'text', repeat('x', 4097), 'received', 0, NOW())
    `), error => error?.code === '23514'
      && error?.constraint === 'whatsapp_cloud_messages_content_length_check');
  });
});

test('colisiones cross-table de todos los índices canónicos abortan sin tocar objetos ajenos', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query(`
      CREATE TABLE foreign_index_owner (
        empresa_id INTEGER NOT NULL, id BIGINT NOT NULL, source_event_id BIGINT,
        outbox_id BIGINT, source_outbox_id BIGINT, provider_message_id TEXT, message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        participant_wa_id TEXT NOT NULL DEFAULT '549351555099'
      )
    `);
    const canonicalIndexes = [
      'whatsapp_cloud_events_empresa_id_id_uidx',
      'wpp_outbox_empresa_id_id_uidx',
      'whatsapp_cloud_messages_source_event_uidx',
      'whatsapp_cloud_messages_outbox_uidx',
      'whatsapp_cloud_messages_source_outbox_uidx',
      'whatsapp_cloud_messages_provider_message_idx',
      'idx_whatsapp_cloud_messages_conversations',
      'idx_whatsapp_cloud_messages_timeline',
    ];
    for (const indexName of canonicalIndexes) {
      await pool.query(`CREATE UNIQUE INDEX ${indexName} ON foreign_index_owner (empresa_id, id)`);
      await pool.query(`ALTER TABLE foreign_index_owner ADD CONSTRAINT ${indexName} UNIQUE USING INDEX ${indexName}`);
      const before = (await pool.query(`
        SELECT constraint_row.oid::text AS constraint_oid, index_row.oid::text AS index_oid,
               constraint_row.conrelid::regclass::text AS table_name
          FROM pg_constraint AS constraint_row
          JOIN pg_class AS index_row ON index_row.oid = constraint_row.conindid
         WHERE constraint_row.conname = $1
      `, [indexName])).rows[0];
      await assert.rejects(pool.query(projectionSql), error => error?.code === 'P0001'
        && /canonical index name collision/i.test(error.message));
      await pool.query('ROLLBACK');
      assert.deepEqual((await pool.query(`
        SELECT constraint_row.oid::text AS constraint_oid, index_row.oid::text AS index_oid,
               constraint_row.conrelid::regclass::text AS table_name
          FROM pg_constraint AS constraint_row
          JOIN pg_class AS index_row ON index_row.oid = constraint_row.conindid
         WHERE constraint_row.conname = $1
      `, [indexName])).rows[0], before, `${indexName} must remain untouched`);
      assert.equal((await pool.query("SELECT to_regclass('whatsapp_cloud_messages') AS relation")).rows[0].relation, null);
      await pool.query(`ALTER TABLE foreign_index_owner DROP CONSTRAINT ${indexName}`);
    }
  });
});

test('status backfill usa compare-and-set monotónico en ambos ganadores del row lock', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO wpp_outbox
        (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
         meta_message_id, cloud_dispatch_state)
      VALUES (1, '549351555050', 'race monotónica', '2026-10-01T10:00:00Z',
              '2026-10-01T10:01:00Z', 'sent', 'cloud', 'race-monotonic', 'sent');
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES (1, 'status', 'race:sent', 'race-monotonic', '549351555050', 'sent',
              EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:01:00Z')::bigint::text,
              '{}'::jsonb, '2026-10-01T10:01:01Z')
    `);
    await pool.query(projectionSql);

    const writer = await pool.connect();
    const migrator = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT id FROM whatsapp_cloud_messages WHERE provider_message_id = 'race-monotonic' FOR UPDATE");
      const migrationPromise = migrator.query(projectionSql);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [migrator.processID],
      )).rows[0]?.wait_event_type === 'Lock', 'migration did not wait on the writer row lock');
      await writer.query(`
        UPDATE whatsapp_cloud_messages
           SET delivery_status = 'read', state_rank = 50,
               delivered_at = '2026-10-01T10:02:00Z', read_at = '2026-10-01T10:03:00Z',
               updated_at = '2026-10-01T10:03:00Z'
         WHERE provider_message_id = 'race-monotonic'
      `);
      await writer.query('COMMIT');
      await migrationPromise;
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      writer.release();
      migrator.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT delivery_status, state_rank,
             to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
             to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at
        FROM whatsapp_cloud_messages WHERE provider_message_id = 'race-monotonic'
    `)).rows[0], {
      delivery_status: 'read', state_rank: 50,
      sent_at: '2026-10-01T10:01:00Z', delivered_at: '2026-10-01T10:02:00Z',
      read_at: '2026-10-01T10:03:00Z',
    });

    await pool.query(`
      UPDATE whatsapp_cloud_messages
         SET delivery_status = 'sent', state_rank = 30,
             sent_at = '2026-10-01T10:01:00Z', delivered_at = NULL, read_at = NULL,
             updated_at = '2026-10-01T10:01:00Z'
       WHERE provider_message_id = 'race-monotonic';
      INSERT INTO whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES (1, 'status', 'race:sent-earlier', 'race-monotonic', '549351555050', 'sent',
              EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:00:30Z')::bigint::text,
              '{}'::jsonb, '2026-10-01T10:04:00Z')
    `);
    const delayedProjection = projectionSql.replace(
      /\r?\nCOMMIT;\r?\n-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION/,
      '\nSELECT pg_sleep(0.4);\nCOMMIT;\n-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION',
    );
    assert.notEqual(delayedProjection, projectionSql);
    const migratorFirst = await pool.connect();
    const writerSecond = await pool.connect();
    try {
      const migrationPromise = migratorFirst.query(delayedProjection);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [migratorFirst.processID],
      )).rows[0]?.wait_event === 'PgSleep', 'migration did not reach its post-update hold');
      const writerPromise = writerSecond.query(`
        UPDATE whatsapp_cloud_messages
           SET delivery_status = 'read', state_rank = 50,
               delivered_at = '2026-10-01T10:02:00Z', read_at = '2026-10-01T10:03:00Z',
               updated_at = '2026-10-01T10:03:00Z'
         WHERE provider_message_id = 'race-monotonic'
      `);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [writerSecond.processID],
      )).rows[0]?.wait_event_type === 'Lock', 'writer did not wait on the migration row lock');
      await migrationPromise;
      await writerPromise;
    } finally {
      migratorFirst.release();
      writerSecond.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT delivery_status, state_rank,
             to_char(sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
             to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS delivered_at,
             to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS read_at
        FROM whatsapp_cloud_messages WHERE provider_message_id = 'race-monotonic'
    `)).rows[0], {
      delivery_status: 'read', state_rank: 50,
      sent_at: '2026-10-01T10:00:30Z', delivered_at: '2026-10-01T10:02:00Z',
      read_at: '2026-10-01T10:03:00Z',
    });
  });
});

test('cutover captura inserts concurrentes con ambos ganadores y converge sin bloquear durante scans', async () => {
  const installBoundary = '-- CUTOVER CAPTURE INSTALL COMPLETE; DDL/REPAIRS STILL PRECEDE TENANT DML';
  const scanBoundary = '-- CUTOVER CAPTURE COMMITTED; SOURCE SCANS FOLLOW';
  assert.ok(projectionSql.indexOf(installBoundary) >= 0
    && projectionSql.indexOf('COMMIT;', projectionSql.indexOf(installBoundary))
      < projectionSql.indexOf(scanBoundary),
  'capture installation must commit before source scans start');
  assert.doesNotMatch(projectionSql.slice(projectionSql.indexOf(scanBoundary)),
    /LOCK\s+TABLE\s+public\.(?:whatsapp_cloud_events|wpp_outbox)[^;]*(?:SHARE|EXCLUSIVE)/is,
    'source scans must not run under an explicit heavyweight table lock');

  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);

    const writerFirst = await pool.connect();
    const migratorSecond = await pool.connect();
    try {
      await writerFirst.query('BEGIN');
      await writerFirst.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (1, 'message', 'cutover:writer-first:event', 'cutover-writer-first-event',
                '549351555060', 'text', '{"text":{"body":"writer first inbound"}}'::jsonb)
      `);
      await writerFirst.query(`
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin)
        VALUES (1, '549351555061', 'writer first outbound', 'pending', 'cloud')
      `);

      const migrationPromise = migratorSecond.query(projectionSql);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [migratorSecond.processID],
      )).rows[0]?.wait_event_type === 'Lock',
      'migration did not wait for the pre-existing source writer before installing capture');
      await writerFirst.query('COMMIT');
      await migrationPromise;
    } finally {
      await writerFirst.query('ROLLBACK').catch(() => {});
      writerFirst.release();
      migratorSecond.release();
    }

    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM public.whatsapp_cloud_messages
       WHERE provider_message_id = 'cutover-writer-first-event'
          OR text_body = 'writer first outbound'
    `)).rows[0].total, 2);

    // Recreate a first-install cutover for the opposite winner; normal reruns intentionally
    // keep the already-installed capture triggers and therefore do not exclude writers.
    await pool.query(`
      DROP TRIGGER whatsapp_cloud_messages_capture_insert
        ON public.whatsapp_cloud_events;
      DROP TRIGGER whatsapp_cloud_messages_capture_insert
        ON public.wpp_outbox
    `);
    const delayedProjection = projectionSql
      .replace(installBoundary,
        `${installBoundary}\nSELECT pg_catalog.pg_sleep(0.25);`)
      .replace(scanBoundary,
        `${scanBoundary}\nSELECT pg_catalog.pg_sleep(0.45);`);
    assert.notEqual(delayedProjection, projectionSql);
    const migratorFirst = await pool.connect();
    const writerSecond = await pool.connect();
    try {
      const migrationPromise = migratorFirst.query(delayedProjection);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [migratorFirst.processID],
      )).rows[0]?.wait_event === 'PgSleep',
      'migration did not reach the short trigger-install hold');

      const installWriterStartedAt = Date.now();
      const installWriterPromise = writerSecond.query(`
        WITH inbound AS (
          INSERT INTO public.whatsapp_cloud_events
            (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
          VALUES (1, 'message', 'cutover:migrator-first:event', 'cutover-migrator-first-event',
                  '549351555062', 'text', '{"text":{"body":"migrator first inbound"}}'::jsonb)
          RETURNING id
        )
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin)
        SELECT 1, '549351555063', 'migrator first outbound', 'pending', 'cloud'
          FROM inbound
      `);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [writerSecond.processID],
      )).rows[0]?.wait_event_type === 'Lock',
      'writer did not wait for the short trigger-install transaction to commit');
      await installWriterPromise;
      const installWriterElapsedMs = Date.now() - installWriterStartedAt;
      assert.ok(installWriterElapsedMs >= 120 && installWriterElapsedMs < 1500,
        `short cutover exclusion should be bounded (writer waited ${installWriterElapsedMs}ms)`);

      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [migratorFirst.processID],
      )).rows[0]?.wait_event === 'PgSleep',
      'migration did not reach the post-commit source-scan hold');
      const scanWriterStartedAt = Date.now();
      await writerSecond.query(`
        WITH inbound AS (
          INSERT INTO public.whatsapp_cloud_events
            (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
          VALUES (1, 'message', 'cutover:scan:event', 'cutover-scan-event',
                  '549351555064', 'text', '{"text":{"body":"scan inbound"}}'::jsonb)
          RETURNING id
        )
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin)
        SELECT 1, '549351555065', 'scan outbound', 'pending', 'cloud'
          FROM inbound
      `);
      const scanWriterElapsedMs = Date.now() - scanWriterStartedAt;
      assert.ok(scanWriterElapsedMs < 250,
        `source writer must not wait for the 450ms scan hold (elapsed ${scanWriterElapsedMs}ms)`);
      await migrationPromise;
    } finally {
      migratorFirst.release();
      writerSecond.release();
    }

    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM public.whatsapp_cloud_messages
       WHERE provider_message_id = 'cutover-migrator-first-event'
          OR text_body = 'migrator first outbound'
    `)).rows[0].total, 2);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM public.whatsapp_cloud_messages
       WHERE provider_message_id = 'cutover-scan-event'
          OR text_body = 'scan outbound'
    `)).rows[0].total, 2);
    assert.equal((await pool.query(`
      SELECT
        (SELECT count(*) FROM public.whatsapp_cloud_events
          WHERE dedupe_key LIKE 'cutover:%:event')
        + (SELECT count(*) FROM public.wpp_outbox
          WHERE mensaje IN ('writer first outbound', 'migrator first outbound', 'scan outbound')) AS source_total,
        (SELECT count(*) FROM public.whatsapp_cloud_messages
          WHERE provider_message_id IN (
            'cutover-writer-first-event', 'cutover-migrator-first-event', 'cutover-scan-event')
             OR text_body IN ('writer first outbound', 'migrator first outbound', 'scan outbound')) AS projection_total
    `)).rows[0].source_total, '6');
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total FROM public.whatsapp_cloud_messages
       WHERE provider_message_id IN (
         'cutover-writer-first-event', 'cutover-migrator-first-event', 'cutover-scan-event')
          OR text_body IN ('writer first outbound', 'migrator first outbound', 'scan outbound')
    `)).rows[0].total, 6);
  });
});

test('secuencia canónica owned por tabla ajena aborta explícitamente y rollback preserva ownership/default', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query(`
      CREATE TABLE public.foreign_sequence_owner (
        id BIGINT NOT NULL DEFAULT 1,
        payload TEXT
      );
      CREATE SEQUENCE public.whatsapp_cloud_messages_id_seq AS BIGINT
        OWNED BY public.foreign_sequence_owner.id;
      ALTER TABLE public.foreign_sequence_owner
        ALTER COLUMN id SET DEFAULT pg_catalog.nextval('public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass)
    `);
    const before = (await pool.query(`
      SELECT sequence_row.oid::text AS sequence_oid,
             dependency.refobjid::pg_catalog.regclass::text AS owner_table,
             owner_column.attname AS owner_column,
             pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
        FROM pg_catalog.pg_class AS sequence_row
        JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = sequence_row.relnamespace
        JOIN pg_catalog.pg_depend AS dependency
          ON dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.objid = sequence_row.oid
         AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.deptype = 'a'
        JOIN pg_catalog.pg_attribute AS owner_column
          ON owner_column.attrelid = dependency.refobjid
         AND owner_column.attnum = dependency.refobjsubid
        LEFT JOIN pg_catalog.pg_attrdef AS default_row
          ON default_row.adrelid = owner_column.attrelid
         AND default_row.adnum = owner_column.attnum
       WHERE namespace_row.nspname = 'public'
         AND sequence_row.relname = 'whatsapp_cloud_messages_id_seq'
    `)).rows[0];

    await assert.rejects(pool.query(projectionSql), error => error?.code === 'P0001'
      && /canonical sequence ownership collision/i.test(error.message));
    await pool.query('ROLLBACK');

    assert.deepEqual((await pool.query(`
      SELECT sequence_row.oid::text AS sequence_oid,
             dependency.refobjid::pg_catalog.regclass::text AS owner_table,
             owner_column.attname AS owner_column,
             pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) AS default_expression
        FROM pg_catalog.pg_class AS sequence_row
        JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = sequence_row.relnamespace
        JOIN pg_catalog.pg_depend AS dependency
          ON dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.objid = sequence_row.oid
         AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.deptype = 'a'
        JOIN pg_catalog.pg_attribute AS owner_column
          ON owner_column.attrelid = dependency.refobjid
         AND owner_column.attnum = dependency.refobjsubid
        LEFT JOIN pg_catalog.pg_attrdef AS default_row
          ON default_row.adrelid = owner_column.attrelid
         AND default_row.adnum = owner_column.attnum
       WHERE namespace_row.nspname = 'public'
         AND sequence_row.relname = 'whatsapp_cloud_messages_id_seq'
    `)).rows[0], before);
    assert.equal((await pool.query(
      "SELECT pg_catalog.to_regclass('public.whatsapp_cloud_messages') AS relation",
    )).rows[0].relation, null);
  });
});

test('secuencia canónica preexistente valida relkind y tipo exactos antes de reutilizar', async () => {
  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query('CREATE TABLE public.whatsapp_cloud_messages_id_seq(id BIGINT)');
    await assert.rejects(pool.query(projectionSql), error => error?.code === 'P0001'
      && /canonical sequence relation kind collision/i.test(error.message));
    await pool.query('ROLLBACK');
    assert.equal((await pool.query(`
      SELECT relkind FROM pg_catalog.pg_class
       WHERE oid = 'public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass
    `)).rows[0].relkind, 'r');

    await pool.query('DROP TABLE public.whatsapp_cloud_messages_id_seq');
    await pool.query('CREATE SEQUENCE public.whatsapp_cloud_messages_id_seq AS INTEGER');
    await assert.rejects(pool.query(projectionSql), error => error?.code === 'P0001'
      && /canonical sequence type collision/i.test(error.message));
    await pool.query('ROLLBACK');
    assert.equal((await pool.query(`
      SELECT seqtypid = 'pg_catalog.int4'::pg_catalog.regtype AS is_integer
        FROM pg_catalog.pg_sequence
       WHERE seqrelid = 'public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass
    `)).rows[0].is_integer, true);
  });
});

test('search_path shadow,public sólo crea y repara objetos canónicos en public sin tocar homónimos', async () => {
  const begin = projectionSql.indexOf('BEGIN;');
  const safePath = projectionSql.indexOf('SET LOCAL search_path = public;');
  const firstObjectReference = projectionSql.search(/(?:pg_advisory|to_regclass|CREATE\s+(?:TABLE|SEQUENCE|FUNCTION|TRIGGER)|pg_class)/i);
  assert.ok(begin >= 0 && safePath > begin && firstObjectReference > safePath,
    'safe transaction-local search_path must precede every object lookup or DDL');

  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query(`
      CREATE SCHEMA shadow;
      CREATE TABLE shadow.empresas(id INTEGER PRIMARY KEY);
      CREATE TABLE shadow.whatsapp_cloud_events(
        id BIGINT PRIMARY KEY, empresa_id INTEGER, event_kind TEXT, message_id TEXT
      );
      CREATE TABLE shadow.wpp_outbox(
        id BIGINT PRIMARY KEY, empresa_id INTEGER, telefono TEXT, mensaje TEXT
      );
      CREATE TABLE shadow.whatsapp_cloud_messages(
        id BIGINT PRIMARY KEY, marker TEXT NOT NULL DEFAULT 'shadow'
      );
      CREATE SEQUENCE shadow.whatsapp_cloud_messages_id_seq AS INTEGER;
      CREATE INDEX whatsapp_cloud_messages_source_event_uidx
        ON shadow.whatsapp_cloud_messages(marker);
      ALTER TABLE shadow.whatsapp_cloud_messages
        ADD CONSTRAINT whatsapp_cloud_messages_direction_check CHECK (marker = 'shadow');
    `);
    const shadowBefore = (await pool.query(`
      SELECT class_row.oid::text, class_row.relkind, class_row.relname
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
       WHERE namespace_row.nspname = 'shadow'
       ORDER BY class_row.relname, class_row.relkind
    `)).rows;
    const shadowConstraintBefore = (await pool.query(`
      SELECT oid::text, pg_catalog.pg_get_constraintdef(oid) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'shadow.whatsapp_cloud_messages'::pg_catalog.regclass
    `)).rows;

    const client = await pool.connect();
    try {
      await client.query('SET search_path TO shadow, public');
      await client.query(projectionSql);
    } finally {
      client.release();
    }

    assert.equal((await pool.query(
      "SELECT pg_catalog.to_regclass('public.whatsapp_cloud_messages') IS NOT NULL AS present",
    )).rows[0].present, true);
    assert.equal((await pool.query(`
      SELECT namespace_row.nspname
        FROM pg_catalog.pg_class AS sequence_row
        JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = sequence_row.relnamespace
       WHERE sequence_row.oid = pg_catalog.pg_get_serial_sequence(
         'public.whatsapp_cloud_messages', 'id')::pg_catalog.regclass
    `)).rows[0].nspname, 'public');
    const foreignSchemas = (await pool.query(`
      SELECT DISTINCT target_namespace.nspname
        FROM pg_catalog.pg_constraint AS constraint_row
        JOIN pg_catalog.pg_class AS target_table ON target_table.oid = constraint_row.confrelid
        JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_table.relnamespace
       WHERE constraint_row.conrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
         AND constraint_row.contype = 'f'
       ORDER BY target_namespace.nspname
    `)).rows.map(row => row.nspname);
    assert.deepEqual(foreignSchemas, ['public']);
    const publicIndexOwners = (await pool.query(`
      SELECT index_namespace.nspname AS index_schema,
             table_namespace.nspname AS table_schema,
             index_row.relname
        FROM pg_catalog.pg_class AS index_row
        JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_row.relnamespace
        JOIN pg_catalog.pg_index AS index_meta ON index_meta.indexrelid = index_row.oid
        JOIN pg_catalog.pg_class AS table_row ON table_row.oid = index_meta.indrelid
        JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_row.relnamespace
       WHERE index_row.relname IN (
         'whatsapp_cloud_messages_source_event_uidx',
         'whatsapp_cloud_messages_outbox_uidx',
         'whatsapp_cloud_messages_source_outbox_uidx',
         'whatsapp_cloud_messages_provider_message_idx',
         'idx_whatsapp_cloud_messages_conversations',
         'idx_whatsapp_cloud_messages_timeline'
       ) AND index_namespace.nspname = 'public'
       ORDER BY index_row.relname
    `)).rows;
    assert.equal(publicIndexOwners.length, 6);
    assert.ok(publicIndexOwners.every(row => row.index_schema === 'public' && row.table_schema === 'public'));
    assert.deepEqual((await pool.query(`
      SELECT class_row.oid::text, class_row.relkind, class_row.relname
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
       WHERE namespace_row.nspname = 'shadow'
       ORDER BY class_row.relname, class_row.relkind
    `)).rows, shadowBefore);
    assert.deepEqual((await pool.query(`
      SELECT oid::text, pg_catalog.pg_get_constraintdef(oid) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid = 'shadow.whatsapp_cloud_messages'::pg_catalog.regclass
    `)).rows, shadowConstraintBefore);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS total FROM shadow.whatsapp_cloud_messages",
    )).rows[0].total, 0);
  });
});

test('initDb completo repara sólo la FK pública de outbox bajo search_path hostil y conserva shadow', async () => {
  const migrationBegin = outboxSql.indexOf('BEGIN;');
  const safePath = outboxSql.indexOf('SET LOCAL search_path = public;', migrationBegin);
  const firstRepairLookupOrDdl = outboxSql.slice(migrationBegin).search(
    /(?:LOCK TABLE|ALTER TABLE|FROM pg_catalog\.pg_|'public\.wpp_outbox'::regclass)/,
  );
  assert.ok(migrationBegin >= 0 && safePath > migrationBegin
    && firstRepairLookupOrDdl > safePath - migrationBegin,
  'transaction-local safe search_path must precede the first outbox repair lookup or DDL');

  await withDatabase(async pool => {
    await pool.query(initSql);
    await pool.query(`
      INSERT INTO public.empresas(nombre) VALUES ('tenant público') RETURNING id
    `);
    const publicTenantId = (await pool.query(
      "SELECT id FROM public.empresas WHERE nombre = 'tenant público'",
    )).rows[0].id;
    await pool.query(`
      INSERT INTO public.wpp_outbox(empresa_id, telefono, mensaje)
      VALUES ($1, '549351555099', 'public teardown')
    `, [publicTenantId]);
    await pool.query(`
      ALTER TABLE public.wpp_outbox DROP CONSTRAINT wpp_outbox_empresa_id_fkey;
      ALTER TABLE public.wpp_outbox
        ADD CONSTRAINT wpp_outbox_empresa_id_fkey
        FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE RESTRICT;

      CREATE SCHEMA shadow;
      CREATE TABLE shadow.empresas (LIKE public.empresas INCLUDING ALL);
      CREATE TABLE shadow.wpp_outbox (LIKE public.wpp_outbox INCLUDING ALL);
      ALTER TABLE shadow.wpp_outbox DROP CONSTRAINT IF EXISTS wpp_outbox_empresa_id_fkey;
      ALTER TABLE shadow.wpp_outbox
        ADD CONSTRAINT wpp_outbox_empresa_id_fkey
        FOREIGN KEY (empresa_id) REFERENCES shadow.empresas(id) ON DELETE RESTRICT;
      DROP INDEX IF EXISTS shadow.wpp_outbox_pending_claim_idx;
      CREATE INDEX wpp_outbox_pending_claim_idx ON shadow.wpp_outbox(id)
        WHERE status = 'error';
      INSERT INTO shadow.empresas(id, nombre) VALUES (910001, 'tenant shadow');
      INSERT INTO shadow.wpp_outbox(id, empresa_id, telefono, mensaje, status)
      VALUES (920001, 910001, 'shadow-phone', 'shadow-message', 'pending');
    `);

    const shadowBefore = (await pool.query(`
      SELECT class_row.oid::text AS oid,
             namespace_row.nspname AS schema_name,
             class_row.relname,
             class_row.relkind,
             CASE WHEN class_row.relkind = 'i'
               THEN pg_catalog.pg_get_indexdef(class_row.oid)
               ELSE NULL
             END AS definition
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_namespace AS namespace_row
          ON namespace_row.oid = class_row.relnamespace
       WHERE namespace_row.nspname = 'shadow'
         AND (
           class_row.relname IN ('empresas', 'wpp_outbox')
           OR class_row.oid IN (
             SELECT index_row.indexrelid
               FROM pg_catalog.pg_index AS index_row
              WHERE index_row.indrelid = 'shadow.wpp_outbox'::pg_catalog.regclass
           )
         )
       ORDER BY class_row.oid
    `)).rows;
    const shadowConstraintsBefore = (await pool.query(`
      SELECT oid::text AS oid, conname, contype,
             pg_catalog.pg_get_constraintdef(oid, true) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid IN (
         'shadow.empresas'::pg_catalog.regclass,
         'shadow.wpp_outbox'::pg_catalog.regclass
       )
       ORDER BY oid
    `)).rows;

    const client = await pool.connect();
    try {
      await client.query('SET search_path TO shadow, public');
      await client.query(initSql);
      await client.query(initSql);
    } finally {
      await client.query('RESET search_path').catch(() => {});
      client.release();
    }

    const publicForeignKey = (await pool.query(`
      SELECT constraint_row.confrelid::oid = 'public.empresas'::pg_catalog.regclass::oid AS targets_public,
             constraint_row.confdeltype,
             pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'public.wpp_outbox'::pg_catalog.regclass
         AND constraint_row.conname = 'wpp_outbox_empresa_id_fkey'
         AND constraint_row.contype = 'f'
    `)).rows;
    assert.deepEqual(publicForeignKey, [{
      targets_public: true,
      confdeltype: 'c',
      definition: 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE',
    }]);
    assert.deepEqual((await pool.query(`
      SELECT class_row.oid::text AS oid,
             namespace_row.nspname AS schema_name,
             class_row.relname,
             class_row.relkind,
             CASE WHEN class_row.relkind = 'i'
               THEN pg_catalog.pg_get_indexdef(class_row.oid)
               ELSE NULL
             END AS definition
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_namespace AS namespace_row
          ON namespace_row.oid = class_row.relnamespace
       WHERE namespace_row.nspname = 'shadow'
         AND (
           class_row.relname IN ('empresas', 'wpp_outbox')
           OR class_row.oid IN (
             SELECT index_row.indexrelid
               FROM pg_catalog.pg_index AS index_row
              WHERE index_row.indrelid = 'shadow.wpp_outbox'::pg_catalog.regclass
           )
         )
       ORDER BY class_row.oid
    `)).rows, shadowBefore);
    assert.deepEqual((await pool.query(`
      SELECT oid::text AS oid, conname, contype,
             pg_catalog.pg_get_constraintdef(oid, true) AS definition
        FROM pg_catalog.pg_constraint
       WHERE conrelid IN (
         'shadow.empresas'::pg_catalog.regclass,
         'shadow.wpp_outbox'::pg_catalog.regclass
       )
       ORDER BY oid
    `)).rows, shadowConstraintsBefore);

    await pool.query('DELETE FROM public.empresas WHERE id = $1', [publicTenantId]);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS total FROM public.wpp_outbox WHERE mensaje = 'public teardown'",
    )).rows[0].total, 0);
    assert.deepEqual((await pool.query(`
      SELECT empresa_id, telefono, mensaje, status
        FROM shadow.wpp_outbox WHERE id = 920001
    `)).rows, [{
      empresa_id: 910001,
      telefono: 'shadow-phone',
      mensaje: 'shadow-message',
      status: 'pending',
    }]);
  }, { bootstrap: false });
});

test('backfill recorre empresas en orden y toma el advisory tenant antes de tocar filas de proyección', () => {
  const tenantLoop = projectionSql.match(/DO \$backfill\$[\s\S]*?END \$backfill\$;/)?.[0];
  assert.ok(tenantLoop, 'migration must expose one explicit tenant-ordered backfill loop');
  assert.match(tenantLoop, /SELECT empresa\.id[\s\S]*FROM public\.empresas AS empresa[\s\S]*ORDER BY empresa\.id/i);
  const tenantLock = tenantLoop.indexOf('PERFORM public.whatsapp_cloud_messages_lock_projection_migration(target_empresa_id);');
  const firstProjectionRowLock = tenantLoop.search(/FOR UPDATE OF message/i);
  const firstProjectionWrite = tenantLoop.search(/INSERT INTO public\.whatsapp_cloud_messages/i);
  assert.ok(tenantLock >= 0 && firstProjectionWrite > tenantLock && firstProjectionRowLock > tenantLock,
    'every tenant advisory lock must precede projection inserts and row locks');
  assert.match(tenantLoop, /ORDER BY event\.id[\s\S]*ON CONFLICT DO NOTHING/i);
  assert.match(tenantLoop,
    /ORDER BY outbox\.id[\s\S]*whatsapp_cloud_messages_upsert_outbox_locked\([\s\S]*END LOOP/i);
  assert.match(tenantLoop, /ORDER BY message\.id[\s\S]*FOR UPDATE OF message/i);
  assert.doesNotMatch(projectionSql.slice(projectionSql.indexOf('-- CUTOVER CAPTURE COMMITTED; SOURCE SCANS FOLLOW')),
    /SELECT message\.id[\s\S]*ORDER BY message\.id[\s\S]*FOR UPDATE OF message;[\s\S]*WITH status_events/i,
    'global status row locking must be replaced by tenant-scoped reconciliation');
});

test('todo DDL termina confirmado antes del primer advisory tenant retenido', () => {
  const ddlCommit = projectionSql.indexOf('-- CLOUD PROJECTION DDL COMPLETE; COMMIT BEFORE TENANT DML');
  const scanBoundary = projectionSql.indexOf('-- CUTOVER CAPTURE COMMITTED; SOURCE SCANS FOLLOW');
  const firstTenantAdvisory = projectionSql.indexOf(
    'PERFORM public.whatsapp_cloud_messages_lock_projection_migration(target_empresa_id);',
    scanBoundary,
  );
  assert.ok(ddlCommit >= 0 && firstTenantAdvisory > ddlCommit,
    'all source/projection DDL must commit before any retained tenant advisory is acquired');
  const postAdvisorySql = projectionSql.slice(firstTenantAdvisory)
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(postAdvisorySql,
    /\b(?:CREATE|DROP|ALTER|TRUNCATE|LOCK)\b/i,
    'after the first retained tenant advisory only DML/reconciliation and non-blocking checks are allowed');
});

async function assertDeceptiveParentIndexRace(pool, source) {
  const isEvent = source === 'whatsapp_cloud_events';
  const indexName = isEvent
    ? 'whatsapp_cloud_events_empresa_id_id_uidx'
    : 'wpp_outbox_empresa_id_id_uidx';
  const includeColumn = isEvent ? 'dedupe_key' : 'telefono';
  const writerSql = isEvent ? `
    INSERT INTO public.whatsapp_cloud_events
      (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
    VALUES (1, 'message', $1, $2, '549351555093', 'text',
            jsonb_build_object('text', jsonb_build_object('body', $3::text)))
  ` : `
    INSERT INTO public.wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin)
    VALUES (1, '549351555094', $1, 'pending', 'cloud')
  `;
  const writerParams = suffix => isEvent
    ? [`parent-index:${source}:${suffix}`, `parent-index-${source}-${suffix}`, suffix]
    : [`parent index ${source} ${suffix}`];

  async function installDeceptiveIndex() {
    const foreignKeyName = isEvent
      ? 'whatsapp_cloud_messages_source_event_fkey'
      : 'whatsapp_cloud_messages_outbox_fkey';
    await pool.query(`
      ALTER TABLE public.whatsapp_cloud_messages
        DROP CONSTRAINT IF EXISTS ${foreignKeyName};
      DROP INDEX public.${indexName};
      CREATE UNIQUE INDEX ${indexName}
        ON public.${source} (empresa_id, id)
        INCLUDE (${includeColumn})
       WHERE id IS NOT NULL
    `);
  }

  await installDeceptiveIndex();
  const writerFirst = await pool.connect();
  const migrationSecond = await pool.connect();
  try {
    await writerFirst.query('BEGIN');
    await writerFirst.query(writerSql, writerParams('writer-first'));
    const migrationPromise = migrationSecond.query(projectionSql);
    await waitUntil(async () => {
      const wait = (await pool.query(`
        SELECT wait_event_type, wait_event
          FROM pg_catalog.pg_stat_activity
         WHERE pid = $1
      `, [migrationSecond.processID])).rows[0];
      return wait?.wait_event_type === 'Lock';
    }, `${source}: migration did not wait behind writer-first`);
    await writerFirst.query('COMMIT');
    await migrationPromise;
  } finally {
    await writerFirst.query('ROLLBACK').catch(() => {});
    writerFirst.release();
    migrationSecond.release();
  }

  await installDeceptiveIndex();
  const delayedMigration = projectionSql.replace(
    '-- PRE-DDL REPAIR STATE START',
    "-- PRE-DDL REPAIR STATE START\n    PERFORM pg_catalog.set_config('deadlock_timeout', '100ms', TRUE);\n    PERFORM pg_catalog.pg_sleep(0.35);",
  );
  assert.notEqual(delayedMigration, projectionSql, 'repair hold must be injectable');
  const migrationFirst = await pool.connect();
  const writerSecond = await pool.connect();
  try {
    const migrationPromise = migrationFirst.query(delayedMigration);
    await waitUntil(async () => (await pool.query(
      'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1',
      [migrationFirst.processID],
    )).rows[0]?.wait_event === 'PgSleep', `${source}: migration did not reach repair hold`);
    await writerSecond.query('BEGIN');
    await writerSecond.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '4s'");
    const writerPromise = writerSecond.query(writerSql, writerParams('migration-first'));
    await waitUntil(async () => (await pool.query(
      'SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1',
      [writerSecond.processID],
    )).rows[0]?.wait_event_type === 'Lock', `${source}: writer did not wait behind migration-first`);
    const outcomes = await Promise.allSettled([migrationPromise, writerPromise]);
    assert.ok(outcomes.every(result => result.status === 'fulfilled'),
      `${source}: both lock winners must finish without deadlock: ${outcomes.map(result => result.reason?.code || result.status).join(',')}`);
    await writerSecond.query('COMMIT');
  } finally {
    await migrationFirst.query('ROLLBACK').catch(() => {});
    await writerSecond.query('ROLLBACK').catch(() => {});
    migrationFirst.release();
    writerSecond.release();
  }

  assert.deepEqual((await indexShape(pool, indexName)).key_columns, ['empresa_id', 'id']);
}

test('índice parental engañoso en whatsapp_cloud_events no deadlockea con writer en ambos ganadores', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(projectionSql);
    await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1, '549351555095', 'proyección existente events', 'pending', 'cloud')
    `);
    await assertDeceptiveParentIndexRace(pool, 'whatsapp_cloud_events');
  });
});

test('índice parental engañoso en wpp_outbox no deadlockea con writer en ambos ganadores', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(projectionSql);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
      VALUES (1, 'message', 'projection-existing-outbox', 'projection-existing-outbox',
              '549351555096', 'text', '{"text":{"body":"proyección existente outbox"}}'::jsonb)
    `);
    await assertDeceptiveParentIndexRace(pool, 'wpp_outbox');
  });
});

test('las tres reparaciones globales terminan dentro de la fase DDL previa a advisories tenant', () => {
  const ddlCommit = projectionSql.indexOf('-- CLOUD PROJECTION DDL COMPLETE; COMMIT BEFORE TENANT DML');
  for (const [tag, marker] of [
    ['repair_state_rank', '-- PRE-DDL REPAIR STATE START'],
    ['repair_content_lengths', '-- PRE-DDL REPAIR CONTENT START'],
    ['repair_timeline', '-- PRE-DDL REPAIR TIMELINE START'],
  ]) {
    const phase = projectionSql.match(new RegExp(`DO \\$${tag}\\$[\\s\\S]*?END \\$${tag}\\$;`))?.[0];
    assert.ok(phase, `${tag} must be an explicit tenant repair phase`);
    assert.match(phase,
      /SELECT DISTINCT message\.empresa_id[\s\S]*FROM public\.whatsapp_cloud_messages AS message[\s\S]*ORDER BY message\.empresa_id/i);
    const instrumented = phase.indexOf(marker);
    const firstUpdate = phase.search(/UPDATE public\.whatsapp_cloud_messages/i);
    assert.ok(instrumented >= 0 && firstUpdate > instrumented
      && projectionSql.indexOf(phase) < ddlCommit,
    `${tag} must repair legacy rows before DDL commits and before tenant advisories begin`);
    assert.doesNotMatch(phase,
      /whatsapp_cloud_messages_lock_projection_migration\(target_empresa_id\)/,
      `${tag} must rely on the ordered source/projection DDL transaction, not retain a tenant advisory`);
  }
});

test('runtime rechaza transacción cross-tenant 720002→710001 antes del segundo advisory y revierte todo', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (710001), (720002)');
    await pool.query(migrationSql);
    await assertMixedTenantRuntimeTransactionRejected(pool, [720002, 710001]);
  });
});

test('runtime rechaza transacción cross-tenant 710001→720002 antes del segundo advisory y revierte todo', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (710001), (720002)');
    await pool.query(migrationSql);
    await assertMixedTenantRuntimeTransactionRejected(pool, [710001, 720002]);
  });
});

test('cada reparación pre-DDL excluye writers por lock fuente sin adquirir advisory tenant', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1, '549351555083', 'repair race seed', 'pending', 'cloud')
    `);

    const phases = [
      {
        marker: '-- PRE-DDL REPAIR STATE START',
        prepare: `
          ALTER TABLE public.whatsapp_cloud_messages
            DROP CONSTRAINT whatsapp_cloud_messages_state_rank_check;
          UPDATE public.whatsapp_cloud_messages SET state_rank = 0
           WHERE text_body = 'repair race seed'
        `,
      },
      {
        marker: '-- PRE-DDL REPAIR CONTENT START',
        prepare: `
          ALTER TABLE public.whatsapp_cloud_messages
            DROP CONSTRAINT whatsapp_cloud_messages_content_length_check;
          UPDATE public.whatsapp_cloud_messages SET text_body = repeat('x', 5000)
           WHERE participant_wa_id = '549351555083'
        `,
      },
      {
        marker: '-- PRE-DDL REPAIR TIMELINE START',
        prepare: `
          ALTER TABLE public.whatsapp_cloud_messages
            DROP CONSTRAINT whatsapp_cloud_messages_timestamps_check;
          UPDATE public.whatsapp_cloud_messages
             SET delivery_status = 'read', state_rank = 50,
                 sent_at = NULL, delivered_at = NULL, read_at = NULL, failed_at = NULL
           WHERE participant_wa_id = '549351555083'
        `,
      },
    ];

    for (const [index, phase] of phases.entries()) {
      await pool.query(phase.prepare);
      const delayedMigration = projectionSql.replace(
        phase.marker,
        `${phase.marker}\n    PERFORM pg_catalog.pg_sleep(0.3);`,
      );
      assert.notEqual(delayedMigration, projectionSql);
      const migrator = await pool.connect();
      const runtime = await pool.connect();
      try {
        const migrationPromise = migrator.query(delayedMigration);
        await waitUntil(async () => (await pool.query(
          'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1', [migrator.processID],
        )).rows[0]?.wait_event === 'PgSleep', `${phase.marker} was not reached`);
        const runtimePromise = runtime.query(`
          INSERT INTO public.whatsapp_cloud_events
            (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
          VALUES (1, 'message', $1, $2, '549351555084', 'text',
                  '{"text":{"body":"runtime espera repair"}}'::jsonb)
        `, [`repair-race:${index}`, `repair-race-${index}`]);
        await waitUntil(async () => {
          const wait = (await pool.query(`
            SELECT wait_event_type, wait_event
              FROM pg_catalog.pg_stat_activity
             WHERE pid = $1
          `, [runtime.processID])).rows[0];
          return wait?.wait_event_type === 'Lock' && wait?.wait_event === 'relation';
        }, `runtime did not wait on the ordered source lock during ${phase.marker}`);
        await migrationPromise;
        await runtimePromise;
      } finally {
        migrator.release();
        runtime.release();
      }
    }
  });
});

test('RED controlado reproduce 40P01 legacy y migración/runtime terminan con ambos ganadores', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2), (3)');
    await pool.query(outboxSql);
    await pool.query(projectionSql);

    async function createPair(prefix, empresaId) {
      const rows = (await pool.query(`
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
           meta_message_id, cloud_dispatch_state)
        VALUES
          ($1, $2, $3, '2026-10-01T10:00:00Z', '2026-10-01T10:01:00Z',
           'sent', 'cloud', $4, 'sent'),
          ($1, $5, $6, '2026-10-01T10:00:00Z', '2026-10-01T10:01:00Z',
           'sent', 'cloud', $7, 'sent')
        RETURNING meta_message_id
      `, [
        empresaId,
        `549351${String(empresaId).padStart(3, '0')}201`, `${prefix} one`, `${prefix}-one`,
        `549351${String(empresaId).padStart(3, '0')}202`, `${prefix} two`, `${prefix}-two`,
      ])).rows;
      return rows.map(row => row.meta_message_id);
    }

    async function insertStatus(client, { empresaId, dedupeKey, messageId, status = 'delivered' }) {
      return client.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
           source_timestamp, event_data, received_at)
        VALUES ($1, 'status', $2, $3, '549351555299', $4,
                EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01T10:02:00Z')::bigint::text,
                '{}'::jsonb, '2026-10-01T10:02:01Z')
      `, [empresaId, dedupeKey, messageId, status]);
    }

    const legacyMessages = await createPair('legacy-deadlock', 1);
    const legacyRuntime = await pool.connect();
    const legacyMigrator = await pool.connect();
    try {
      await legacyRuntime.query('BEGIN');
      await legacyMigrator.query('BEGIN');
      await legacyRuntime.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await legacyMigrator.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL statement_timeout = '3s'");
      await insertStatus(legacyRuntime, {
        empresaId: 1, dedupeKey: 'legacy-deadlock:two', messageId: legacyMessages[1],
      });
      const legacyBackfill = legacyMigrator.query(`
        SELECT message.id
          FROM public.whatsapp_cloud_messages AS message
         WHERE message.empresa_id = 1
           AND message.provider_message_id = ANY($1::text[])
         ORDER BY message.id
         FOR UPDATE OF message
      `, [legacyMessages]);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [legacyMigrator.processID],
      )).rows[0]?.wait_event_type === 'Lock', 'legacy backfill did not hold row one and wait on row two');
      const outcomes = await Promise.allSettled([
        legacyBackfill,
        insertStatus(legacyRuntime, {
          empresaId: 1, dedupeKey: 'legacy-deadlock:one', messageId: legacyMessages[0], status: 'read',
        }),
      ]);
      assert.equal(outcomes.filter(result => result.status === 'rejected'
        && result.reason?.code === '40P01').length, 1,
      `legacy inverse order must reproduce one 40P01: ${outcomes.map(result => result.reason?.code || result.status).join(',')}`);
    } finally {
      await legacyRuntime.query('ROLLBACK').catch(() => {});
      await legacyMigrator.query('ROLLBACK').catch(() => {});
      legacyRuntime.release();
      legacyMigrator.release();
    }

    const runtimeFirstMessages = await createPair('runtime-first', 1);
    const runtimeFirst = await pool.connect();
    const migrationSecond = await pool.connect();
    try {
      await runtimeFirst.query('BEGIN');
      await insertStatus(runtimeFirst, {
        empresaId: 1, dedupeKey: 'runtime-first:two', messageId: runtimeFirstMessages[1],
      });
      const migrationPromise = migrationSecond.query(projectionSql);
      await waitUntil(async () => {
        const wait = (await pool.query(`
          SELECT wait_event_type, wait_event
            FROM pg_catalog.pg_stat_activity
           WHERE pid = $1
        `, [migrationSecond.processID])).rows[0];
        return wait?.wait_event_type === 'Lock' && wait?.wait_event === 'relation';
      }, 'migration did not wait on the runtime source relation before taking projection locks');
      await insertStatus(runtimeFirst, {
        empresaId: 1, dedupeKey: 'runtime-first:one', messageId: runtimeFirstMessages[0], status: 'read',
      });
      await runtimeFirst.query('COMMIT');
      await migrationPromise;
    } finally {
      await runtimeFirst.query('ROLLBACK').catch(() => {});
      runtimeFirst.release();
      migrationSecond.release();
    }

    const migrationFirstMessages = await createPair('migration-first', 1);
    const delayedMigration = projectionSql.replace(
      '-- TENANT BACKFILL LOCK ACQUIRED',
      "-- TENANT BACKFILL LOCK ACQUIRED\n    IF target_empresa_id = 1 THEN PERFORM pg_catalog.pg_sleep(0.35); END IF;",
    );
    assert.notEqual(delayedMigration, projectionSql, 'tenant backfill lock marker must be injectable');
    const migrationFirst = await pool.connect();
    const runtimeSecond = await pool.connect();
    try {
      const migrationPromise = migrationFirst.query(delayedMigration);
      await waitUntil(async () => (await pool.query(
        'SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1',
        [migrationFirst.processID],
      )).rows[0]?.wait_event === 'PgSleep', 'migration did not hold the tenant advisory first');
      await runtimeSecond.query('BEGIN');
      let runtimeSettled = false;
      const runtimePromise = insertStatus(runtimeSecond, {
        empresaId: 1, dedupeKey: 'migration-first:two', messageId: migrationFirstMessages[1],
      }).then(value => { runtimeSettled = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(runtimeSettled, false, 'runtime must wait on migration advisory before touching its row');
      await migrationPromise;
      await runtimePromise;
      await insertStatus(runtimeSecond, {
        empresaId: 1, dedupeKey: 'migration-first:one', messageId: migrationFirstMessages[0], status: 'read',
      });
      await runtimeSecond.query('COMMIT');
    } finally {
      await runtimeSecond.query('ROLLBACK').catch(() => {});
      migrationFirst.release();
      runtimeSecond.release();
    }

    const tenantOne = await pool.connect();
    const tenantTwo = await pool.connect();
    try {
      await tenantOne.query('BEGIN');
      await tenantOne.query('SELECT public.whatsapp_cloud_messages_lock_projection(1)');
      const startedAt = Date.now();
      await tenantTwo.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, sender_id, message_type, event_data)
        VALUES (2, 'message', 'new-candidate:tenant-two', 'new-candidate-tenant-two',
                '549351555298', 'text', '{"text":{"body":"capturado por trigger"}}'::jsonb)
      `);
      assert.ok(Date.now() - startedAt < 500, 'different tenant trigger capture must remain parallel');
      await tenantOne.query('ROLLBACK');
    } finally {
      await tenantOne.query('ROLLBACK').catch(() => {});
      tenantOne.release();
      tenantTwo.release();
    }
    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM public.whatsapp_cloud_messages
       WHERE empresa_id = 2 AND provider_message_id = 'new-candidate-tenant-two'
    `)).rows[0].total, 1);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS total FROM public.whatsapp_cloud_messages WHERE empresa_id = 3',
    )).rows[0].total, 0, 'tenant without candidates must remain a clean no-op');
  });
});

test('backfill advisory transaccional se libera en commit y rollback y permite retry limpio', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    const failingMigration = projectionSql.replace(
      '-- TENANT BACKFILL LOCK ACQUIRED',
      "-- TENANT BACKFILL LOCK ACQUIRED\n    IF target_empresa_id = 1 THEN RAISE EXCEPTION 'controlled backfill rollback'; END IF;",
    );
    assert.notEqual(failingMigration, projectionSql);
    const migrator = await pool.connect();
    try {
      await assert.rejects(migrator.query(failingMigration), /controlled backfill rollback/);
      await migrator.query('ROLLBACK');
      assert.equal((await pool.query(`
        SELECT count(*)::int AS total FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND pid = $1
      `, [migrator.processID])).rows[0].total, 0);
      await migrator.query(projectionSql);
      assert.equal((await pool.query(`
        SELECT count(*)::int AS total FROM pg_catalog.pg_locks
         WHERE locktype = 'advisory' AND pid = $1
      `, [migrator.processID])).rows[0].total, 0);
      await migrator.query(projectionSql);
    } finally {
      await migrator.query('ROLLBACK').catch(() => {});
      migrator.release();
    }
  });
});

test('locks tenant-scoped serializan estados inversos sin deadlock, aíslan tenants y no se filtran', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(migrationSql);

    const functionDefinitions = (await pool.query(`
      SELECT procedure_row.proname,
             pg_catalog.pg_get_functiondef(procedure_row.oid) AS definition
        FROM pg_catalog.pg_proc AS procedure_row
        JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
       WHERE namespace_row.nspname = 'public'
         AND procedure_row.proname = ANY($1::text[])
       ORDER BY procedure_row.proname
    `, [[
      'whatsapp_cloud_messages_lock_projection',
      'whatsapp_cloud_messages_reconcile_status',
      'whatsapp_cloud_messages_capture_event_insert',
      'whatsapp_cloud_messages_capture_outbox_insert',
    ]])).rows;
    assert.equal(functionDefinitions.length, 4);
    const definitions = new Map(functionDefinitions.map(row => [row.proname, row.definition]));
    assert.match(definitions.get('whatsapp_cloud_messages_lock_projection'),
      /current_setting\([\s\S]*set_config\([\s\S]*whatsapp_cloud_projection_cross_tenant_transaction[\s\S]*pg_advisory_xact_lock\(1464550735, target_empresa_id\)/i,
      'runtime tenant guard must record/reject before attempting the advisory lock');
    for (const functionName of [
      'whatsapp_cloud_messages_reconcile_status',
      'whatsapp_cloud_messages_capture_event_insert',
      'whatsapp_cloud_messages_capture_outbox_insert',
    ]) {
      assert.match(definitions.get(functionName),
        /BEGIN\s+PERFORM public\.whatsapp_cloud_messages_lock_projection\(/i,
        `${functionName} must acquire the shared tenant lock before projection work`);
    }

    async function createMessages(label, empresaId) {
      await pool.query(`
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, created_at, sent_at, status, transport_origin,
           meta_message_id, cloud_dispatch_state)
        VALUES
          ($1, $2, $3, '2026-10-01T10:00:00Z', '2026-10-01T10:01:00Z',
           'sent', 'cloud', $4, 'sent'),
          ($1, $5, $6, '2026-10-01T10:00:00Z', '2026-10-01T10:01:00Z',
           'sent', 'cloud', $7, 'sent')
      `, [
        empresaId,
        `549351${String(empresaId).padStart(3, '0')}101`, `${label} one`, `${label}-one`,
        `549351${String(empresaId).padStart(3, '0')}102`, `${label} two`, `${label}-two`,
      ]);
      return [`${label}-one`, `${label}-two`];
    }

    async function insertStatus(client, { empresaId = 1, dedupeKey, messageId, status, at }) {
      return client.query(`
        INSERT INTO public.whatsapp_cloud_events
          (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
           source_timestamp, event_data, received_at)
        VALUES ($1, 'status', $2, $3, '549351555099', $4,
                EXTRACT(EPOCH FROM $5::timestamptz)::bigint::text, '{}'::jsonb,
                $5::timestamptz + interval '1 second')
      `, [empresaId, dedupeKey, messageId, status, at]);
    }

    for (const leaderName of ['lower-first', 'higher-first']) {
      const [messageOne, messageTwo] = await createMessages(`deadlock-${leaderName}`, 1);
      const lower = [
        { dedupeKey: `${leaderName}:lower:one`, messageId: messageOne, status: 'delivered', at: '2026-10-01T10:02:00Z' },
        { dedupeKey: `${leaderName}:lower:two`, messageId: messageTwo, status: 'sent', at: '2026-10-01T10:02:30Z' },
      ];
      const higher = [
        { dedupeKey: `${leaderName}:higher:two`, messageId: messageTwo, status: 'read', at: '2026-10-01T10:04:00Z' },
        { dedupeKey: `${leaderName}:higher:one`, messageId: messageOne, status: 'read', at: '2026-10-01T10:03:30Z' },
      ];
      const leaderPlan = leaderName === 'lower-first' ? lower : higher;
      const followerPlan = leaderName === 'lower-first' ? higher : lower;
      const leader = await pool.connect();
      const follower = await pool.connect();
      let leaderDone = false;
      let followerDone = false;
      try {
        await leader.query('BEGIN');
        await follower.query('BEGIN');
        await leader.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '3s'");
        await follower.query("SET LOCAL deadlock_timeout = '100ms'; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '3s'");
        await insertStatus(leader, leaderPlan[0]);

        let followerFirstSettled = false;
        const followerFirst = insertStatus(follower, followerPlan[0]).then(
          value => { followerFirstSettled = true; return value; },
          error => { followerFirstSettled = true; throw error; },
        );
        await new Promise(resolve => setTimeout(resolve, 150));

        if (followerFirstSettled) {
          const inverse = await Promise.allSettled([
            insertStatus(leader, leaderPlan[1]),
            insertStatus(follower, followerPlan[1]),
          ]);
          assert.ok(inverse.every(result => result.status === 'fulfilled'),
            `inverse status order must not deadlock: ${inverse.map(result => result.reason?.code || result.status).join(',')}`);
        } else {
          const wait = (await pool.query(`
            SELECT wait_event_type, wait_event
              FROM pg_catalog.pg_stat_activity
             WHERE pid = $1
          `, [follower.processID])).rows[0];
          assert.deepEqual(wait, { wait_event_type: 'Lock', wait_event: 'advisory' });
          await insertStatus(leader, leaderPlan[1]);
          await leader.query('COMMIT');
          leaderDone = true;
          await followerFirst;
          await insertStatus(follower, followerPlan[1]);
        }
        if (!leaderDone) {
          await leader.query('COMMIT');
          leaderDone = true;
        }
        await follower.query('COMMIT');
        followerDone = true;
      } finally {
        if (!leaderDone) await leader.query('ROLLBACK').catch(() => {});
        if (!followerDone) await follower.query('ROLLBACK').catch(() => {});
        leader.release();
        follower.release();
      }

      assert.deepEqual((await pool.query(`
        SELECT provider_message_id, delivery_status, state_rank
          FROM public.whatsapp_cloud_messages
         WHERE provider_message_id = ANY($1::text[])
         ORDER BY provider_message_id
      `, [[messageOne, messageTwo]])).rows, [
        { provider_message_id: messageOne, delivery_status: 'read', state_rank: 50 },
        { provider_message_id: messageTwo, delivery_status: 'read', state_rank: 50 },
      ]);
    }

    const [tenantOneMessage] = await createMessages('parallel-tenant-one', 1);
    const [tenantTwoMessage] = await createMessages('parallel-tenant-two', 2);
    const tenantOne = await pool.connect();
    const tenantTwo = await pool.connect();
    const trackedPids = [tenantOne.processID, tenantTwo.processID];
    let tenantOneDone = false;
    let tenantTwoDone = false;
    try {
      await tenantOne.query('BEGIN');
      await tenantTwo.query('BEGIN');
      await insertStatus(tenantOne, {
        empresaId: 1, dedupeKey: 'parallel:tenant-one', messageId: tenantOneMessage,
        status: 'delivered', at: '2026-10-01T10:05:00Z',
      });
      const startedAt = Date.now();
      await Promise.race([
        insertStatus(tenantTwo, {
          empresaId: 2, dedupeKey: 'parallel:tenant-two', messageId: tenantTwoMessage,
          status: 'delivered', at: '2026-10-01T10:05:00Z',
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('different tenant was blocked by tenant 1 projection lock')), 500,
        )),
      ]);
      assert.ok(Date.now() - startedAt < 500);
      await tenantTwo.query('COMMIT');
      tenantTwoDone = true;
      await tenantOne.query('COMMIT');
      tenantOneDone = true;
    } finally {
      if (!tenantOneDone) await tenantOne.query('ROLLBACK').catch(() => {});
      if (!tenantTwoDone) await tenantTwo.query('ROLLBACK').catch(() => {});
      tenantOne.release();
      tenantTwo.release();
    }

    const rollbackWriter = await pool.connect();
    trackedPids.push(rollbackWriter.processID);
    try {
      await rollbackWriter.query('BEGIN');
      await insertStatus(rollbackWriter, {
        empresaId: 1, dedupeKey: 'lock-leak:rollback', messageId: tenantOneMessage,
        status: 'read', at: '2026-10-01T10:06:00Z',
      });
      await rollbackWriter.query('ROLLBACK');
    } finally {
      await rollbackWriter.query('ROLLBACK').catch(() => {});
      rollbackWriter.release();
    }

    assert.equal((await pool.query(`
      SELECT count(*)::int AS total
        FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory'
         AND pid = ANY($1::integer[])
    `, [trackedPids])).rows[0].total, 0, 'transaction advisory locks must be released at commit/rollback');
  });
});

test('cutover captura UPDATE outbox antes y después del backfill y cleanup no duplica', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    const { installSql, backfillSql } = projectionCutoverPhases();
    await pool.query(installSql);

    const beforeId = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin, created_at)
      VALUES (1, '549351555601', 'cutover before', 'pending', 'cloud', '2026-10-06T10:00:00Z')
      RETURNING id
    `)).rows[0].id;
    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'sending', cloud_dispatch_state = 'pre_dispatch'
       WHERE empresa_id = 1 AND id = $1
    `, [beforeId]);
    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'sent', cloud_dispatch_state = 'sent',
             meta_message_id = 'wamid.cutover-before', sent_at = '2026-10-06T10:01:00Z'
       WHERE empresa_id = 1 AND id = $1
    `, [beforeId]);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'cutover-before:delivered', 'wamid.cutover-before', '549351555601',
         'delivered', extract(epoch from timestamptz '2026-10-06T10:02:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-06T10:02:01Z'),
        (1, 'status', 'cutover-before:read', 'wamid.cutover-before', '549351555601',
         'read', extract(epoch from timestamptz '2026-10-06T10:03:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-06T10:03:01Z')
    `);
    await pool.query(backfillSql);

    const afterId = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin, created_at)
      VALUES (1, '549351555602', 'cutover after', 'pending', 'cloud', '2026-10-06T11:00:00Z')
      RETURNING id
    `)).rows[0].id;
    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'sent', cloud_dispatch_state = 'sent',
             meta_message_id = 'wamid.cutover-after', sent_at = '2026-10-06T11:01:00Z'
       WHERE empresa_id = 1 AND id = $1
    `, [afterId]);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, recipient_id, status,
         source_timestamp, event_data, received_at)
      VALUES
        (1, 'status', 'cutover-after:delivered', 'wamid.cutover-after', '549351555602',
         'delivered', extract(epoch from timestamptz '2026-10-06T11:02:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-06T11:02:01Z'),
        (1, 'status', 'cutover-after:read', 'wamid.cutover-after', '549351555602',
         'read', extract(epoch from timestamptz '2026-10-06T11:03:00Z')::bigint::text,
         '{}'::jsonb, '2026-10-06T11:03:01Z')
    `);

    const rows = (await pool.query(`
      SELECT outbox_id, provider_message_id, delivery_status, state_rank,
             message_at <= sent_at AS message_before_sent,
             sent_at <= delivered_at AS sent_before_delivered,
             delivered_at <= read_at AS delivered_before_read
        FROM public.whatsapp_cloud_messages
       WHERE empresa_id = 1 AND outbox_id = ANY($1::bigint[])
       ORDER BY outbox_id
    `, [[beforeId, afterId]])).rows;
    assert.deepEqual(rows, [
      { outbox_id: String(beforeId), provider_message_id: 'wamid.cutover-before',
        delivery_status: 'read', state_rank: 50, message_before_sent: true,
        sent_before_delivered: true, delivered_before_read: true },
      { outbox_id: String(afterId), provider_message_id: 'wamid.cutover-after',
        delivery_status: 'read', state_rank: 50, message_before_sent: true,
        sent_before_delivered: true, delivered_before_read: true },
    ]);

    await pool.query('DELETE FROM public.wpp_outbox WHERE empresa_id = 1 AND id = ANY($1::bigint[])', [[beforeId, afterId]]);
    await pool.query(projectionSql);
    assert.deepEqual((await pool.query(`
      SELECT provider_message_id, count(*)::int AS total, bool_and(outbox_id IS NULL) AS detached
        FROM public.whatsapp_cloud_messages
       WHERE empresa_id = 1 AND provider_message_id LIKE 'wamid.cutover-%'
       GROUP BY provider_message_id ORDER BY provider_message_id
    `)).rows, [
      { provider_message_id: 'wamid.cutover-after', total: 1, detached: true },
      { provider_message_id: 'wamid.cutover-before', total: 1, detached: true },
    ]);
  });
});

test('UPDATE outbox converge failed/success, ignora columnas ajenas y retries son idempotentes', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    const id = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin, created_at)
      VALUES (1, '549351555610', 'retry exacto', 'pending', 'cloud', '2026-10-06T12:00:00Z')
      RETURNING id
    `)).rows[0].id;
    const initialUpdatedAt = (await pool.query(
      'SELECT updated_at FROM public.whatsapp_cloud_messages WHERE empresa_id = 1 AND outbox_id = $1', [id],
    )).rows[0].updated_at;
    await pool.query("UPDATE public.wpp_outbox SET claim_owner = 'irrelevant' WHERE empresa_id = 1 AND id = $1", [id]);
    assert.equal((await pool.query(
      'SELECT updated_at FROM public.whatsapp_cloud_messages WHERE empresa_id = 1 AND outbox_id = $1', [id],
    )).rows[0].updated_at.getTime(), initialUpdatedAt.getTime());

    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'error', cloud_dispatch_state = 'definitive_failed', sent_at = '2026-10-06T12:01:00Z'
       WHERE empresa_id = 1 AND id = $1
    `, [id]);
    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'sent', cloud_dispatch_state = 'sent', meta_message_id = 'wamid.retry-exacto',
             sent_at = '2026-10-06T12:02:00Z'
       WHERE empresa_id = 1 AND id = $1
    `, [id]);
    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'error', cloud_dispatch_state = 'definitive_failed', sent_at = '2026-10-06T12:03:00Z'
       WHERE empresa_id = 1 AND id = $1
    `, [id]);
    await pool.query(`
      UPDATE public.wpp_outbox
         SET status = 'sending', cloud_dispatch_state = 'pre_dispatch'
       WHERE empresa_id = 1 AND id = $1
    `, [id]);
    await pool.query(projectionSql);

    assert.deepEqual((await pool.query(`
      SELECT count(*)::int AS total, min(provider_message_id) AS provider_message_id,
             min(delivery_status) AS delivery_status, min(state_rank)::int AS state_rank,
             bool_and(sent_at IS NOT NULL) AS has_sent_at, bool_and(failed_at IS NULL) AS no_failed_at
        FROM public.whatsapp_cloud_messages
       WHERE empresa_id = 1 AND outbox_id = $1
    `, [id])).rows[0], {
      total: 1, provider_message_id: 'wamid.retry-exacto', delivery_status: 'sent',
      state_rank: 30, has_sent_at: true, no_failed_at: true,
    });
  });
});

test('trigger UPDATE e índice status canónicos se reparan exactos y preservan objetos ajenos', async () => {
  await withDatabase(async pool => {
    await pool.query(migrationSql);
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.outbox_unrelated_update()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER outbox_unrelated_update AFTER UPDATE ON public.wpp_outbox
      FOR EACH ROW EXECUTE FUNCTION public.outbox_unrelated_update()
    `);
    const unrelatedBefore = await triggerShape(pool, 'public.wpp_outbox', 'outbox_unrelated_update');
    const canonicalUpdate = await triggerShape(pool, 'public.wpp_outbox', 'whatsapp_cloud_messages_capture_update');
    assert.equal(canonicalUpdate.tgenabled, 'O');
    assert.equal(canonicalUpdate.tgtype, 17);
    assert.match(canonicalUpdate.function_name, /whatsapp_cloud_messages_capture_outbox_update\(\)$/);
    assert.match(canonicalUpdate.definition,
      /^CREATE TRIGGER whatsapp_cloud_messages_capture_update AFTER UPDATE OF empresa_id, telefono, mensaje, status, sent_at, transport_origin, meta_message_id, cloud_dispatch_state ON (?:public\.)?wpp_outbox FOR EACH ROW EXECUTE FUNCTION (?:public\.)?whatsapp_cloud_messages_capture_outbox_update\(\)$/);

    await pool.query(`
      DROP TRIGGER whatsapp_cloud_messages_capture_update ON public.wpp_outbox;
      CREATE TRIGGER whatsapp_cloud_messages_capture_update BEFORE UPDATE ON public.wpp_outbox
      FOR EACH STATEMENT EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_outbox_update();
      DROP INDEX public.whatsapp_cloud_events_status_message_idx;
      CREATE INDEX whatsapp_cloud_events_status_message_idx
        ON public.whatsapp_cloud_events (empresa_id, message_id)
        INCLUDE (status, source_timestamp, received_at)
        WHERE event_kind = 'status'
          AND status IN ('sent', 'delivered', 'read', 'failed')
          AND NULLIF(BTRIM(message_id), '') IS NOT NULL
    `);
    await pool.query(projectionSql);
    assert.deepEqual(await triggerShape(pool, 'public.wpp_outbox', 'whatsapp_cloud_messages_capture_update'), canonicalUpdate);
    assert.deepEqual(await triggerShape(pool, 'public.wpp_outbox', 'outbox_unrelated_update'), unrelatedBefore);

    const repairedIndexOid = (await pool.query(`
      SELECT indexrelid::text AS oid
        FROM pg_catalog.pg_index
       WHERE indexrelid = 'public.whatsapp_cloud_events_status_message_idx'::regclass
    `)).rows[0].oid;
    await pool.query(`
      UPDATE pg_catalog.pg_index
         SET indisvalid = FALSE, indisready = FALSE
       WHERE indexrelid = 'public.whatsapp_cloud_events_status_message_idx'::regclass
    `);
    await pool.query(projectionSql);
    assert.notEqual((await pool.query(`
      SELECT indexrelid::text AS oid
        FROM pg_catalog.pg_index
       WHERE indexrelid = 'public.whatsapp_cloud_events_status_message_idx'::regclass
    `)).rows[0].oid, repairedIndexOid, 'invalid/unready canonical indexes must be rebuilt');

    const index = (await pool.query(`
      SELECT index_namespace.nspname AS index_schema,
             table_namespace.nspname AS table_schema, table_row.relname AS table_name,
             access_method.amname, index_row.indisvalid, index_row.indisready,
             index_row.indisunique, index_row.indnkeyatts, index_row.indnatts,
             index_row.indexprs IS NOT NULL AS has_expressions,
             pg_get_expr(index_row.indexprs, index_row.indrelid) AS expressions,
             index_row.indoption::text AS sort_options,
             array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
               FILTER (WHERE key_column.ordinality <= index_row.indnkeyatts) AS key_columns,
             array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
               FILTER (WHERE key_column.ordinality > index_row.indnkeyatts) AS include_columns,
             pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_class ON index_class.oid = index_row.indexrelid
        JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
        JOIN pg_catalog.pg_class AS table_row ON table_row.oid = index_row.indrelid
        JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_row.relnamespace
        JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_class.relam
        CROSS JOIN LATERAL unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        LEFT JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = index_row.indrelid AND attribute_row.attnum = key_column.attnum
       WHERE index_row.indexrelid = 'public.whatsapp_cloud_events_status_message_idx'::regclass
       GROUP BY index_namespace.nspname, table_namespace.nspname, table_row.relname, access_method.amname,
                index_row.indisvalid, index_row.indisready, index_row.indisunique,
                index_row.indnkeyatts, index_row.indnatts, index_row.indexprs,
                index_row.indoption, index_row.indpred, index_row.indrelid
    `)).rows[0];
    assert.deepEqual(index, {
      index_schema: 'public', table_schema: 'public', table_name: 'whatsapp_cloud_events', amname: 'btree',
      indisvalid: true, indisready: true, indisunique: false, indnkeyatts: 2, indnatts: 5,
      has_expressions: true, expressions: 'btrim(message_id)', sort_options: '0 0',
      key_columns: ['empresa_id', null],
      include_columns: ['status', 'source_timestamp', 'received_at'],
      predicate: "((event_kind = 'status'::text) AND (status = ANY (ARRAY['sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])) AND (NULLIF(btrim(message_id), ''::text) IS NOT NULL))",
    });
  });

  await withDatabase(async pool => {
    await pool.query(outboxSql);
    await pool.query('CREATE TABLE public.index_collision (empresa_id integer, message_id text)');
    await pool.query('CREATE INDEX whatsapp_cloud_events_status_message_idx ON public.index_collision (empresa_id, message_id)');
    const before = (await pool.query(`SELECT oid::text, relfilenode::text FROM pg_class WHERE oid = 'public.whatsapp_cloud_events_status_message_idx'::regclass`)).rows[0];
    await assert.rejects(pool.query(projectionSql), /canonical index name collision/);
    assert.deepEqual((await pool.query(`SELECT oid::text, relfilenode::text FROM pg_class WHERE oid = 'public.whatsapp_cloud_events_status_message_idx'::regclass`)).rows[0], before);
  });
});

test('backfill y UPDATE outbox serializan ambos ganadores y convergen una sola fila', async () => {
  for (const winner of ['update-first', 'backfill-first']) {
    await withDatabase(async pool => {
      await pool.query('INSERT INTO empresas(id) VALUES (1)');
      await pool.query(outboxSql);
      const id = (await pool.query(`
        INSERT INTO public.wpp_outbox
          (empresa_id, telefono, mensaje, status, transport_origin, created_at)
        VALUES (1, '549351555620', $1, 'pending', 'cloud', '2026-10-06T13:00:00Z') RETURNING id
      `, [`race ${winner}`])).rows[0].id;
      const { installSql, backfillSql } = projectionCutoverPhases();
      await pool.query(installSql);
      const writer = await pool.connect();
      let writerDone = false;
      try {
        await writer.query('BEGIN');
        if (winner === 'update-first') {
          await writer.query(`
            UPDATE public.wpp_outbox SET status = 'sent', cloud_dispatch_state = 'sent',
                   meta_message_id = $2, sent_at = '2026-10-06T13:01:00Z'
             WHERE empresa_id = 1 AND id = $1
          `, [id, `wamid.${winner}`]);
          const backfillPromise = pool.query(backfillSql);
          await waitUntil(async () => (await pool.query(`
            SELECT count(*)::int AS total FROM pg_stat_activity
             WHERE query LIKE '%CUTOVER CAPTURE COMMITTED; SOURCE SCANS FOLLOW%'
               AND wait_event_type = 'Lock'
          `)).rows[0].total > 0, 'backfill did not wait behind outbox update');
          await writer.query('COMMIT');
          writerDone = true;
          await backfillPromise;
        } else {
          await writer.query('ROLLBACK');
          writerDone = true;
          const heldBackfill = backfillSql.replace(
            '-- TENANT BACKFILL LOCK ACQUIRED',
            "PERFORM pg_catalog.pg_sleep(0.35);\n    -- TENANT BACKFILL LOCK ACQUIRED",
          );
          const backfillPromise = pool.query(heldBackfill);
          await waitUntil(async () => (await pool.query(`
            SELECT count(*)::int AS total FROM pg_stat_activity
             WHERE query LIKE '%PERFORM pg_catalog.pg_sleep(0.35)%' AND wait_event = 'PgSleep'
          `)).rows[0].total > 0, 'backfill did not retain tenant lock before scan');
          const updatePromise = pool.query(`
            UPDATE public.wpp_outbox SET status = 'sent', cloud_dispatch_state = 'sent',
                   meta_message_id = $2, sent_at = '2026-10-06T13:01:00Z'
             WHERE empresa_id = 1 AND id = $1
          `, [id, `wamid.${winner}`]);
          await Promise.all([backfillPromise, updatePromise]);
        }
      } finally {
        if (!writerDone) await writer.query('ROLLBACK').catch(() => {});
        writer.release();
      }
      assert.deepEqual((await pool.query(`
        SELECT count(*)::int AS total, min(provider_message_id) AS provider_message_id,
               min(delivery_status) AS delivery_status, min(state_rank)::int AS state_rank
          FROM public.whatsapp_cloud_messages WHERE empresa_id = 1 AND outbox_id = $1
      `, [id])).rows[0], {
        total: 1, provider_message_id: `wamid.${winner}`, delivery_status: 'sent', state_rank: 30,
      });
    });
  }
});

test('consulta productiva status normalizada usa índice parcial canónico con 200k filas', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(outboxSql);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_events
        (empresa_id, event_kind, dedupe_key, message_id, status, source_timestamp, event_data, received_at)
      SELECT CASE WHEN series % 2 = 0 THEN 1 ELSE 2 END,
             'status', 'benchmark:' || series, 'wamid.benchmark.' || series,
             (ARRAY['sent','delivered','read','failed'])[(series % 4) + 1],
             extract(epoch from timestamptz '2026-10-06T14:00:00Z')::bigint::text,
             '{}'::jsonb, '2026-10-06T14:00:01Z'
        FROM generate_series(1, 200000) AS series
    `);
    await pool.query(projectionSql);
    await pool.query('ANALYZE public.whatsapp_cloud_events');
    const plan = (await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT event.status,
             CASE
               WHEN event.source_timestamp ~ '^[0-9]{1,12}$'
                AND event.source_timestamp::NUMERIC > 0
                AND event.source_timestamp::NUMERIC <= 253402300799
                AND pg_catalog.to_timestamp(event.source_timestamp::DOUBLE PRECISION)
                    BETWEEN event.received_at - INTERVAL '30 days'
                        AND event.received_at + INTERVAL '5 minutes'
                 THEN pg_catalog.to_timestamp(event.source_timestamp::DOUBLE PRECISION)
               ELSE event.received_at
             END AS status_at
        FROM public.whatsapp_cloud_events AS event
       WHERE event.empresa_id = 1
         AND BTRIM(event.message_id) = NULLIF(BTRIM('  wamid.benchmark.200000  '), '')
         AND event.event_kind = 'status'
         AND event.status IN ('sent', 'delivered', 'read', 'failed')
         AND NULLIF(BTRIM(event.message_id), '') IS NOT NULL
    `)).rows[0]['QUERY PLAN'][0];
    const serialized = JSON.stringify(plan);
    assert.match(serialized, /whatsapp_cloud_events_status_message_idx/);
    assert.match(serialized, /(?:Index Scan|Index Only Scan|Bitmap Index Scan)/);
    assert.doesNotMatch(serialized, /Seq Scan|Gather/);
    assert.ok(plan['Execution Time'] < 1000, `exact indexed lookup took ${plan['Execution Time']}ms`);
  });
});

test('lookup productivo de mensaje normaliza una vez y usa índice provider canónico con 200k filas', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO public.whatsapp_cloud_messages
        (empresa_id,direction,participant_wa_id,provider_message_id,message_type,text_body,
         delivery_status,state_rank,message_at,sent_at,created_at,updated_at)
      SELECT CASE WHEN series % 2 = 0 THEN 1 ELSE 2 END,
             'outbound', '549351555999', 'wamid.message-benchmark.' || series,
             'text', 'benchmark', 'sent', 30,
             '2026-10-06T14:00:00Z', '2026-10-06T14:00:00Z', '2026-10-06T14:00:00Z',
             '2026-10-06T14:00:00Z'
        FROM generate_series(1, 200000) AS series
    `);
    await pool.query('ANALYZE public.whatsapp_cloud_messages');
    const normalizedProviderMessageId = '  wamid.message-benchmark.200000  '.trim();
    const plan = (await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT message.id
        FROM public.whatsapp_cloud_messages AS message
       WHERE message.empresa_id = $1
         AND message.provider_message_id = $2
         AND message.direction = 'outbound'
       LIMIT 2
    `, [1, normalizedProviderMessageId])).rows[0]['QUERY PLAN'][0];
    const serialized = JSON.stringify(plan);
    assert.match(serialized, /whatsapp_cloud_messages_provider_message_idx/);
    assert.match(serialized, /(?:Index Scan|Index Only Scan)/);
    assert.doesNotMatch(serialized, /(?:Parallel )?Seq Scan/);
    assert.ok(plan['Execution Time'] < 1000,
      `canonical provider lookup benchmark took ${plan['Execution Time']}ms`);

    const reconciliationFunction = (await pool.query(`
      SELECT pg_catalog.pg_get_functiondef(
        'public.whatsapp_cloud_messages_reconcile_status_locked(integer,text)'::regprocedure
      ) AS definition
    `)).rows[0].definition;
    assert.doesNotMatch(reconciliationFunction, /BTRIM\(message\.provider_message_id\)/i);
    assert.match(reconciliationFunction, /message\.provider_message_id = normalized_provider_message_id/i);
    assert.equal((await pool.query(
      "SELECT public.whatsapp_cloud_messages_reconcile_status(1, '  wamid.message-benchmark.200000  ') AS result",
    )).rows[0].result, 'unchanged');
  });
});

test('migración rechaza fuentes outbox con provider duplicado antes del backfill y no las modifica', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    const before = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin, created_at, meta_message_id)
      VALUES
        (1, '549351555700', 'idéntico', 'pending', 'cloud', '2026-10-06T15:00:00Z', 'wamid.same'),
        (1, '549351555700', 'idéntico', 'pending', 'cloud', '2026-10-06T15:00:00Z', 'wamid.same')
      RETURNING id::text, empresa_id, telefono, mensaje, meta_message_id
    `)).rows;
    await assert.rejects(pool.query(projectionSql), error => assertSanitizedProviderIdentityDuplicate(
      error, ['wamid.same', '549351', 'idéntico'],
    ));
    assert.deepEqual((await pool.query(`
      SELECT id::text, empresa_id, telefono, mensaje, meta_message_id
        FROM public.wpp_outbox ORDER BY id
    `)).rows, before);
    assert.equal((await pool.query(`SELECT to_regclass('public.whatsapp_cloud_messages') AS table_name`)).rows[0].table_name, null);
  });
});

test('transiciones autorizadas reabren outcome_unknown sin degradar terminales ni failed ordinario', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(opsSql);
    const ops = createCloudOps({ pool });
    const id = (await pool.query(`
      INSERT INTO public.wpp_outbox
        (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state,
         dispatch_started_at, error, meta_message_id, sent_at)
      VALUES (1, '549351555701', 'incierto', 'error', 'cloud', 'outcome_unknown',
              NOW(), 'cloud_dispatch_unknown', 'wamid.legacy', NOW()) RETURNING id
    `)).rows[0].id;
    await ops.markFailed({ id: Number(id), actor: 'ops-test', reason: 'meta_rejected' });
    assert.deepEqual((await pool.query(`SELECT delivery_status, state_rank, failed_at IS NOT NULL AS failed,
      sent_at, delivered_at, read_at FROM whatsapp_cloud_messages WHERE source_outbox_id=$1`, [id])).rows[0],
    { delivery_status: 'failed', state_rank: 25, failed: true, sent_at: null, delivered_at: null, read_at: null });

    const replayId = (await pool.query(`INSERT INTO public.wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state,
       dispatch_started_at, error, meta_message_id, sent_at)
      VALUES (1,'549351555705','replay','error','cloud','outcome_unknown',NOW(),
              'cloud_dispatch_unknown','wamid.old',NOW()) RETURNING id`)).rows[0].id;
    await ops.confirmNotSent({ id: Number(replayId), actor: 'ops-test', reason: 'meta_confirmed_not_sent' });
    await ops.replay({ id: Number(replayId), actor: 'ops-test', reason: 'manual_replay' });
    assert.deepEqual((await pool.query(`SELECT delivery_status, state_rank, sent_at, delivered_at, read_at, failed_at
      FROM whatsapp_cloud_messages WHERE source_outbox_id=$1`, [replayId])).rows[0],
    { delivery_status: 'queued', state_rank: 10, sent_at: null, delivered_at: null, read_at: null, failed_at: null });

    await pool.query(`UPDATE public.wpp_outbox SET status='sent', cloud_dispatch_state='sent',
      meta_message_id='wamid.final', sent_at=NOW() WHERE id=$1`, [replayId]);
    await pool.query(`UPDATE public.wpp_outbox SET status='error', cloud_dispatch_state='outcome_unknown' WHERE id=$1`, [replayId]);
    assert.equal((await pool.query(`SELECT delivery_status FROM whatsapp_cloud_messages WHERE source_outbox_id=$1`, [replayId])).rows[0].delivery_status, 'sent');

    const ordinary = (await pool.query(`INSERT INTO public.wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state)
      VALUES (1,'549351555702','falló','error','cloud','definitive_failed') RETURNING id`)).rows[0].id;
    await pool.query(`UPDATE public.wpp_outbox SET status='pending', cloud_dispatch_state=NULL WHERE id=$1`, [ordinary]);
    assert.equal((await pool.query(`SELECT delivery_status FROM whatsapp_cloud_messages WHERE source_outbox_id=$1`, [ordinary])).rows[0].delivery_status, 'failed');
  });
});

test('failed vence outcome_unknown a igual rank en ambos órdenes, cleanup/backfill, carreras y callbacks tardíos', async () => {
  const failedSql = `INSERT INTO whatsapp_cloud_events
    (empresa_id,event_kind,dedupe_key,message_id,recipient_id,status,source_timestamp,event_data,received_at)
    VALUES (1,'status',$1,$2,$3,'failed',extract(epoch from $4::timestamptz)::bigint::text,'{}',$4::timestamptz + interval '1 second')`;
  const unknownSql = `INSERT INTO wpp_outbox
    (empresa_id,telefono,mensaje,status,transport_origin,cloud_dispatch_state,meta_message_id,created_at,sent_at)
    VALUES (1,$1,$2,'error','cloud','outcome_unknown',$3,$4,$4)`;
  const assertFailed = async (pool, providerId, at) => assert.deepEqual((await pool.query(`
    SELECT delivery_status,state_rank,sent_at,delivered_at,read_at,
           to_char(failed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') failed_at
      FROM whatsapp_cloud_messages WHERE empresa_id=1 AND provider_message_id=$1`, [providerId])).rows[0],
  { delivery_status: 'failed', state_rank: 25, sent_at: null, delivered_at: null, read_at: null, failed_at: at });

  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(unknownSql, ['5493515999101', 'after', 'wamid.failed-after', '2026-10-06T08:00:00Z']);
    await pool.query(failedSql, ['failed:after', 'wamid.failed-after', '5493515999101', '2026-10-06T08:01:00Z']);
    await assertFailed(pool, 'wamid.failed-after', '2026-10-06T08:01:00Z');
    await pool.query("UPDATE wpp_outbox SET sent_at='2026-10-06T08:02:00Z' WHERE meta_message_id='wamid.failed-after'");
    await assertFailed(pool, 'wamid.failed-after', '2026-10-06T08:01:00Z');

    await pool.query(failedSql, ['failed:before', 'wamid.failed-before', '5493515999102', '2026-10-06T09:01:00Z']);
    await pool.query(unknownSql, ['5493515999102', 'before', 'wamid.failed-before', '2026-10-06T09:00:00Z']);
    await assertFailed(pool, 'wamid.failed-before', '2026-10-06T09:01:00Z');

    for (const winner of ['outbox-first', 'status-first']) {
      const providerId = `wamid.failed-${winner}`;
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query('BEGIN');
        if (winner === 'outbox-first') await first.query(unknownSql,
          ['5493515999201', winner, providerId, '2026-10-06T10:00:00Z']);
        else await first.query(failedSql,
          [`failed:${winner}`, providerId, '5493515999202', '2026-10-06T10:01:00Z']);
        const blocked = winner === 'outbox-first'
          ? second.query(failedSql, [`failed:${winner}`, providerId, '5493515999201', '2026-10-06T10:01:00Z'])
          : second.query(unknownSql, ['5493515999202', winner, providerId, '2026-10-06T10:00:00Z']);
        await waitUntil(async () => (await pool.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [second.processID],
        )).rows[0]?.wait_event_type === 'Lock', `${winner} must overlap on the tenant advisory`);
        await first.query('COMMIT');
        await blocked;
      } finally {
        await first.query('ROLLBACK').catch(() => {});
        first.release();
        second.release();
      }
      await assertFailed(pool, providerId, '2026-10-06T10:01:00Z');
    }

    for (const [status, rank] of [['sent', 30], ['delivered', 40], ['read', 50]]) {
      const providerId = `wamid.late-failed-${status}`;
      await pool.query(`INSERT INTO wpp_outbox
        (empresa_id,telefono,mensaje,status,transport_origin,cloud_dispatch_state,meta_message_id,sent_at)
        VALUES (1,$1,$2,'sent','cloud','sent',$3,'2026-10-06T11:01:00Z')`,
      [`54935159993${rank}`, status, providerId]);
      if (status !== 'sent') await pool.query(`INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,status,event_data)
        VALUES (1,'status',$1,$2,$3,'{}')`, [`late:${status}`, providerId, status]);
      await pool.query(failedSql,
        [`late:${status}:failed`, providerId, `54935159993${rank}`, '2026-10-06T11:03:00Z']);
      assert.deepEqual((await pool.query(`SELECT delivery_status,state_rank FROM whatsapp_cloud_messages
        WHERE provider_message_id=$1`, [providerId])).rows[0], { delivery_status: status, state_rank: rank });
    }
  });

  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(outboxSql);
    await pool.query(unknownSql, ['5493515999401', 'cleanup', 'wamid.failed-cleanup', '2026-10-06T12:00:00Z']);
    await pool.query(unknownSql, ['5493515999402', 'backfill', 'wamid.failed-backfill', '2026-10-06T13:00:00Z']);
    await pool.query(failedSql, ['failed:cleanup', 'wamid.failed-cleanup', '5493515999401', '2026-10-06T12:01:00Z']);
    await pool.query(failedSql, ['failed:backfill', 'wamid.failed-backfill', '5493515999402', '2026-10-06T13:01:00Z']);
    const { installSql, backfillSql } = projectionCutoverPhases();
    await pool.query(installSql);
    await pool.query("DELETE FROM whatsapp_cloud_events WHERE dedupe_key='failed:cleanup'");
    await pool.query(backfillSql);
    await assertFailed(pool, 'wamid.failed-cleanup', '2026-10-06T12:01:00Z');
    await assertFailed(pool, 'wamid.failed-backfill', '2026-10-06T13:01:00Z');
  });
});

test('UPDATE de tenant/transport Cloud falla cerrado, revierte y permite updates ordinarios', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(migrationSql);
    const cloudId = (await pool.query(`INSERT INTO wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1,'549351555703','estable','pending','cloud') RETURNING id`)).rows[0].id;
    const companyId = (await pool.query(`INSERT INTO wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin)
      VALUES (1,'549351555706','web','pending','company') RETURNING id`)).rows[0].id;
    for (const [sql, id] of [
      [`UPDATE wpp_outbox SET empresa_id=2 WHERE id=$1`, cloudId],
      [`UPDATE wpp_outbox SET transport_origin='company' WHERE id=$1`, cloudId],
      [`UPDATE wpp_outbox SET transport_origin='cloud' WHERE id=$1`, companyId],
    ]) {
      await assert.rejects(pool.query(sql, [id]), error => error?.code === 'P0001'
        && error?.message === 'whatsapp_cloud_outbox_identity_change_rejected'
        && !JSON.stringify(error).match(/549351|estable|web|empresa_id|transport_origin/i));
    }
    assert.deepEqual((await pool.query(`SELECT empresa_id, transport_origin, mensaje FROM wpp_outbox WHERE id=$1`, [cloudId])).rows[0],
      { empresa_id: 1, transport_origin: 'cloud', mensaje: 'estable' });
    await pool.query(`UPDATE wpp_outbox SET mensaje='permitido' WHERE id=$1`, [cloudId]);
    assert.equal((await pool.query(`SELECT text_body FROM whatsapp_cloud_messages WHERE source_outbox_id=$1`, [cloudId])).rows[0].text_body, 'permitido');
  });
});

test('correlación status aplica BTRIM a eventos y outbox legacy con whitespace', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    const id = (await pool.query(`INSERT INTO wpp_outbox
      (empresa_id, telefono, mensaje, status, transport_origin, cloud_dispatch_state, meta_message_id, sent_at)
      VALUES (1,'549351555704','trim','sent','cloud','sent','  wamid.trim  ',NOW()) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO whatsapp_cloud_events
      (empresa_id,event_kind,dedupe_key,message_id,status,source_timestamp,event_data)
      VALUES (1,'status','trim:delivered',' wamid.trim ','delivered',extract(epoch from now())::bigint::text,'{}'),
             (1,'status','trim:read','   wamid.trim   ','read',extract(epoch from now())::bigint::text,'{}')`);
    assert.deepEqual((await pool.query(`SELECT provider_message_id, delivery_status, state_rank,
      delivered_at IS NOT NULL AS delivered, read_at IS NOT NULL AS read
      FROM whatsapp_cloud_messages WHERE source_outbox_id=$1`, [id])).rows[0],
      { provider_message_id: 'wamid.trim', delivery_status: 'read', state_rank: 50, delivered: true, read: true });
  });
});

test('migración canonicaliza conversación legacy parcial sin perder id ni estado y es idempotente', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    const stableId = '65cb77fc-72e3-4bc9-87f9-9d484664dd54';
    await pool.query(`
      CREATE TABLE whatsapp_cloud_conversations (
        id TEXT,
        empresa_id BIGINT,
        participant_wa_id VARCHAR(32),
        workflow_status VARCHAR(32),
        version BIGINT,
        created_at TIMESTAMP WITHOUT TIME ZONE
      );
      INSERT INTO whatsapp_cloud_conversations
        (id,empresa_id,participant_wa_id,workflow_status,version,created_at)
      VALUES ('${stableId}',1,'549351555900','resolved',4,'2026-10-06 10:00:00');
      CREATE INDEX idx_whatsapp_cloud_conversations_queue
        ON whatsapp_cloud_conversations (empresa_id)
    `);

    await pool.query(migrationSql);
    const first = (await pool.query(`SELECT id::text,empresa_id,participant_wa_id,
      workflow_status,priority,version,created_at,updated_at
      FROM whatsapp_cloud_conversations`)).rows[0];
    await pool.query(migrationSql);
    const second = (await pool.query(`SELECT id::text,empresa_id,participant_wa_id,
      workflow_status,priority,version,created_at,updated_at
      FROM whatsapp_cloud_conversations`)).rows[0];
    assert.deepEqual(second, first);
    assert.equal(first.id, stableId);
    assert.equal(first.workflow_status, 'resolved');
    assert.equal(first.priority, 'normal');
    assert.equal(first.version, 4);

    const columns = (await pool.query(`
      SELECT attname,format_type(atttypid,atttypmod) AS data_type,attnotnull,
             pg_get_expr(default_row.adbin,default_row.adrelid) AS default_expression
        FROM pg_attribute AS attribute_row
        LEFT JOIN pg_attrdef AS default_row
          ON default_row.adrelid=attribute_row.attrelid AND default_row.adnum=attribute_row.attnum
       WHERE attribute_row.attrelid='whatsapp_cloud_conversations'::regclass
         AND attribute_row.attnum>0 AND NOT attribute_row.attisdropped
       ORDER BY attribute_row.attnum
    `)).rows;
    assert.deepEqual(columns.map(row => [row.attname, row.data_type, row.attnotnull]), [
      ['id', 'uuid', true],
      ['empresa_id', 'integer', true],
      ['participant_wa_id', 'text', true],
      ['workflow_status', 'text', true],
      ['version', 'integer', true],
      ['created_at', 'timestamp with time zone', true],
      ['priority', 'text', true],
      ['updated_at', 'timestamp with time zone', true],
    ]);
    const byName = new Map(columns.map(row => [row.attname, row]));
    assert.equal(byName.get('created_at').data_type, 'timestamp with time zone');
    assert.equal(byName.get('created_at').attnotnull, true);
    assert.match(byName.get('id').default_expression, /gen_random_uuid/i);
    assert.match(byName.get('workflow_status').default_expression, /pending/i);
    assert.match(byName.get('priority').default_expression, /normal/i);
    assert.match(byName.get('version').default_expression, /1/);
    assert.match(byName.get('created_at').default_expression, /now/i);
    assert.match(byName.get('updated_at').default_expression, /now/i);

    const constraints = (await pool.query(`SELECT conname,contype,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='whatsapp_cloud_conversations'::regclass ORDER BY conname`)).rows;
    assert.deepEqual(constraints.map(row => row.conname), [
      'whatsapp_cloud_conversations_created_at_not_null',
      'whatsapp_cloud_conversations_empresa_id_fkey',
      'whatsapp_cloud_conversations_empresa_id_not_null',
      'whatsapp_cloud_conversations_empresa_participant_key',
      'whatsapp_cloud_conversations_id_not_null',
      'whatsapp_cloud_conversations_participant_check',
      'whatsapp_cloud_conversations_participant_wa_id_not_null',
      'whatsapp_cloud_conversations_pkey',
      'whatsapp_cloud_conversations_priority_check',
      'whatsapp_cloud_conversations_priority_not_null',
      'whatsapp_cloud_conversations_timestamps_check',
      'whatsapp_cloud_conversations_updated_at_not_null',
      'whatsapp_cloud_conversations_version_check',
      'whatsapp_cloud_conversations_version_not_null',
      'whatsapp_cloud_conversations_workflow_status_check',
      'whatsapp_cloud_conversations_workflow_status_not_null',
    ]);
    assert.deepEqual(await indexShape(pool, 'idx_whatsapp_cloud_conversations_queue'), {
      indisunique: false,
      indnkeyatts: 5,
      indnatts: 5,
      has_expressions: false,
      sort_options: '0 0 0 3 0',
      key_columns: ['empresa_id', 'workflow_status', 'priority', 'updated_at', 'id'],
      predicate: null,
    });
  });
});

test('migración aborta esquema de conversaciones inseguro antes del backfill con error constante', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      CREATE TABLE whatsapp_cloud_conversations (
        id UUID,
        empresa_id INTEGER,
        participant_wa_id TEXT,
        workflow_status TEXT,
        priority TEXT,
        version INTEGER,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );
      INSERT INTO whatsapp_cloud_conversations VALUES
        ('65cb77fc-72e3-4bc9-87f9-9d484664dd55',1,'549351555899','pending','normal',1,NOW(),NOW()),
        ('65cb77fc-72e3-4bc9-87f9-9d484664dd56',1,'549351555899','resolved','urgent',2,NOW(),NOW());
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data)
      VALUES (1,'message','unsafe-backfill','wamid.unsafe','549351555898','text',
              '{"text":{"body":"must not backfill"}}'::jsonb)
    `);

    await assert.rejects(pool.query(migrationSql), error => {
      assert.equal(error?.code, 'P0001');
      assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error?.detail, undefined);
      assert.equal(error?.hint, undefined);
      assert.doesNotMatch(JSON.stringify(error), /549351|must not backfill|65cb77fc/i);
      return true;
    });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM whatsapp_cloud_conversations')).rows[0].count, 2);
    assert.equal((await pool.query("SELECT to_regclass('public.whatsapp_cloud_messages') AS relation")).rows[0].relation, null);
  });
});

test('migración aborta tipos legacy no convertibles sin filtrar valores ni errores PostgreSQL', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(`
      CREATE TABLE whatsapp_cloud_conversations (
        id TEXT,
        empresa_id TEXT,
        participant_wa_id TEXT
      );
      INSERT INTO whatsapp_cloud_conversations
        (id,empresa_id,participant_wa_id)
      VALUES ('65cb77fc-72e3-4bc9-87f9-9d484664dd57','tenant-secret','549351555897')
    `);

    await assert.rejects(pool.query(migrationSql), error => {
      assert.equal(error?.code, 'P0001');
      assert.equal(error?.message, 'whatsapp_cloud_conversations_schema_unsafe');
      assert.equal(error?.detail, undefined);
      assert.equal(error?.hint, undefined);
      assert.doesNotMatch(JSON.stringify(error), /tenant-secret|invalid input|empresa_id/i);
      return true;
    });
    assert.deepEqual((await pool.query('SELECT empresa_id FROM whatsapp_cloud_conversations')).rows,
      [{ empresa_id: 'tenant-secret' }]);
  });
});

test('migración crea conversaciones operativas allowlisted y es reejecutable con backfill estable', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1), (2)');
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES
        (1,'message','conversation-backfill-1','wamid.backfill-1','549351555901','text',
         '{"text":{"body":"tenant one"}}'::jsonb,'2026-10-06T10:00:00Z'),
        (2,'message','conversation-backfill-2','wamid.backfill-2','549351555901','text',
         '{"text":{"body":"tenant two"}}'::jsonb,'2026-10-06T11:00:00Z')
    `);

    await pool.query(migrationSql);
    const before = (await pool.query(`
      SELECT id::text,empresa_id,participant_wa_id,workflow_status,priority,version,
             created_at,updated_at
        FROM public.whatsapp_cloud_conversations
       ORDER BY empresa_id
    `)).rows;
    await pool.query(migrationSql);
    const afterRows = (await pool.query(`
      SELECT id::text,empresa_id,participant_wa_id,workflow_status,priority,version,
             created_at,updated_at
        FROM public.whatsapp_cloud_conversations
       ORDER BY empresa_id
    `)).rows;

    assert.deepEqual(afterRows, before);
    assert.equal(before.length, 2);
    assert.notEqual(before[0].id, before[1].id);
    assert.match(before[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(before.map(row => [row.empresa_id, row.participant_wa_id, row.workflow_status, row.priority, row.version]), [
      [1, '549351555901', 'pending', 'normal', 1],
      [2, '549351555901', 'pending', 'normal', 1],
    ]);

    const definitions = new Map((await pool.query(`
      SELECT conname,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'public.whatsapp_cloud_conversations'::regclass
    `)).rows.map(row => [row.conname, row.definition]));
    assert.match(definitions.get('whatsapp_cloud_conversations_empresa_participant_key'), /UNIQUE \(empresa_id, participant_wa_id\)/i);
    assert.match(definitions.get('whatsapp_cloud_conversations_participant_check'), /\^\[0-9\]\{6,15\}\$/);
    assert.match(definitions.get('whatsapp_cloud_conversations_workflow_status_check'), /pending.*resolved/i);
    assert.match(definitions.get('whatsapp_cloud_conversations_priority_check'), /normal.*high.*urgent/i);
    assert.match(definitions.get('whatsapp_cloud_conversations_version_check'), /version > 0/i);
    assert.match(definitions.get('whatsapp_cloud_conversations_empresa_id_fkey'), /REFERENCES empresas\(id\) ON DELETE CASCADE/i);
  });
});

test('inbound conserva identidad, reabre pending e incrementa version sin degradar priority', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','conversation-live-1','wamid.live-1','549351555902','text',
              '{"text":{"body":"primero"}}'::jsonb,'2026-10-07T10:00:00Z')
    `);
    const initial = (await pool.query(`
      SELECT id::text,workflow_status,priority,version
        FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='549351555902'
    `)).rows[0];
    await pool.query(`
      UPDATE whatsapp_cloud_conversations
         SET workflow_status='resolved',priority='urgent',version=version+1
       WHERE empresa_id=1 AND id=$1::uuid
    `, [initial.id]);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','conversation-live-2','wamid.live-2','549351555902','text',
              '{"text":{"body":"segundo"}}'::jsonb,'2026-10-07T10:05:00Z')
    `);
    const reopened = (await pool.query(`
      SELECT id::text,workflow_status,priority,version
        FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='549351555902'
    `)).rows[0];
    assert.equal(reopened.id, initial.id);
    assert.deepEqual(reopened, {
      id: initial.id,
      workflow_status: 'pending',
      priority: 'urgent',
      version: 3,
    });

    await pool.query(`
      INSERT INTO wpp_outbox (empresa_id,telefono,mensaje,status,transport_origin,created_at)
      VALUES (1,'549351555902','respuesta','pending','cloud','2026-10-07T10:06:00Z')
    `);
    assert.deepEqual((await pool.query(`
      SELECT id::text,workflow_status,priority,version
        FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='549351555902'
    `)).rows[0], reopened);
  });
});

test('PATCH no-op PostgreSQL conserva version y updated_at, pero CAS incorrecto queda stale', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','conversation-noop-1','wamid.noop-1','549351555903','text',
              '{"text":{"body":"primero"}}'::jsonb,'2026-10-07T10:00:00Z')
    `);
    const before = (await pool.query(`
      SELECT id::text,workflow_status,priority,version,updated_at
        FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND participant_wa_id='549351555903'
    `)).rows[0];
    const query = async (sql, params) => (await pool.query(sql, params)).rows;

    const noOp = await updateCloudConversationState({
      query, empresaId: 1, conversationId: before.id,
      workflowStatus: 'pending', priority: 'normal', expectedVersion: before.version,
    });
    assert.equal(noOp.outcome, 'unchanged');
    assert.deepEqual(noOp.conversation, {
      conversationId: before.id, workflowStatus: 'pending', priority: 'normal', version: before.version,
    });
    const after = (await pool.query(`
      SELECT version,updated_at FROM whatsapp_cloud_conversations
       WHERE empresa_id=1 AND id=$1::uuid
    `, [before.id])).rows[0];
    assert.equal(after.version, before.version);
    assert.equal(after.updated_at.toISOString(), before.updated_at.toISOString());

    const stale = await updateCloudConversationState({
      query, empresaId: 1, conversationId: before.id,
      workflowStatus: 'pending', priority: 'normal', expectedVersion: before.version + 1,
    });
    assert.equal(stale.outcome, 'stale');
    assert.equal(stale.conversation.version, before.version);
  });
});

test('carrera PATCH primero resuelve y el inbound durable posterior reabre pending', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','conversation-race-patch-seed','wamid.race-patch-seed','549351555904','text',
              '{"text":{"body":"seed"}}'::jsonb,'2026-10-07T10:00:00Z')
    `);
    const initial = (await pool.query(`SELECT id::text,version FROM whatsapp_cloud_conversations
      WHERE empresa_id=1 AND participant_wa_id='549351555904'`)).rows[0];
    const patchClient = await pool.connect();
    const inboundClient = await pool.connect();
    try {
      await patchClient.query('BEGIN');
      const patchPid = (await patchClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const patched = await updateCloudConversationState({
        query: async (sql, params) => (await patchClient.query(sql, params)).rows,
        empresaId: 1, conversationId: initial.id,
        workflowStatus: 'resolved', priority: 'urgent', expectedVersion: initial.version,
      });
      assert.equal(patched.outcome, 'updated');

      const inboundPid = (await inboundClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const inbound = inboundClient.query(`
        INSERT INTO whatsapp_cloud_events
          (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
        VALUES (1,'message','conversation-race-patch-inbound','wamid.race-patch-inbound','549351555904','text',
                '{"text":{"body":"posterior"}}'::jsonb,'2026-10-07T10:01:00Z')
      `);
      await waitUntil(async () => {
        const blockers = (await pool.query('SELECT pg_blocking_pids($1) AS pids', [inboundPid])).rows[0].pids;
        return blockers.includes(patchPid);
      }, 'inbound must wait for PATCH row lock');
      await patchClient.query('COMMIT');
      await inbound;

      assert.deepEqual((await pool.query(`SELECT workflow_status,priority,version
        FROM whatsapp_cloud_conversations WHERE empresa_id=1 AND id=$1::uuid`, [initial.id])).rows[0], {
        workflow_status: 'pending', priority: 'urgent', version: initial.version + 2,
      });
    } finally {
      await patchClient.query('ROLLBACK').catch(() => {});
      patchClient.release();
      inboundClient.release();
    }
  });
});

test('carrera inbound primero invalida expectedVersion previo y PATCH queda stale con pending', async () => {
  await withDatabase(async pool => {
    await pool.query('INSERT INTO empresas(id) VALUES (1)');
    await pool.query(migrationSql);
    await pool.query(`
      INSERT INTO whatsapp_cloud_events
        (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
      VALUES (1,'message','conversation-race-inbound-seed','wamid.race-inbound-seed','549351555905','text',
              '{"text":{"body":"seed"}}'::jsonb,'2026-10-07T10:00:00Z')
    `);
    const initial = (await pool.query(`SELECT id::text,version FROM whatsapp_cloud_conversations
      WHERE empresa_id=1 AND participant_wa_id='549351555905'`)).rows[0];
    const inboundClient = await pool.connect();
    const patchClient = await pool.connect();
    try {
      await inboundClient.query('BEGIN');
      const inboundPid = (await inboundClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await inboundClient.query(`
        INSERT INTO whatsapp_cloud_events
          (empresa_id,event_kind,dedupe_key,message_id,sender_id,message_type,event_data,received_at)
        VALUES (1,'message','conversation-race-inbound-wins','wamid.race-inbound-wins','549351555905','text',
                '{"text":{"body":"nuevo"}}'::jsonb,'2026-10-07T10:01:00Z')
      `);

      const patchPid = (await patchClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const patch = updateCloudConversationState({
        query: async (sql, params) => (await patchClient.query(sql, params)).rows,
        empresaId: 1, conversationId: initial.id,
        workflowStatus: 'resolved', priority: 'high', expectedVersion: initial.version,
      });
      await waitUntil(async () => {
        const blockers = (await pool.query('SELECT pg_blocking_pids($1) AS pids', [patchPid])).rows[0].pids;
        return blockers.includes(inboundPid);
      }, 'PATCH must wait for inbound row lock');
      await inboundClient.query('COMMIT');
      const result = await patch;

      assert.equal(result.outcome, 'stale');
      assert.deepEqual(result.conversation, {
        conversationId: initial.id, workflowStatus: 'pending', priority: 'normal', version: initial.version + 1,
      });
      assert.deepEqual((await pool.query(`SELECT workflow_status,priority,version
        FROM whatsapp_cloud_conversations WHERE empresa_id=1 AND id=$1::uuid`, [initial.id])).rows[0], {
        workflow_status: 'pending', priority: 'normal', version: initial.version + 1,
      });
    } finally {
      await inboundClient.query('ROLLBACK').catch(() => {});
      inboundClient.release();
      patchClient.release();
    }
  });
});

after(() => {
  assert.deepEqual([...createdDirectories].map(basename), [], 'all temporary PostgreSQL clusters must be removed');
  const residual = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(residual, [], 'no residual temporary PostgreSQL cluster directories');
});
