import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { basename, join } from 'node:path';
import pg from 'pg';

let bin;
try { bin = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(); } catch {}
const available = bin && existsSync(join(bin, 'initdb')) && process.getuid?.() !== 0;
assert.ok(available,
  'PostgreSQL focal gate requires local PostgreSQL 18 initdb/pg_ctl binaries and a non-root user; refusing a false-green skip');

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const tempPrefix = '.init-db-canonical-pg-';
const createdDirectories = new Set();

const nonFunctionCallIdentifiers = new Set([
  'and', 'any', 'array', 'as', 'btree', 'canonical', 'check', 'coalesce', 'conflict',
  'default', 'exists', 'expected', 'filter', 'from', 'geometry', 'gin', 'gist', 'greatest',
  'if', 'in', 'include', 'index_column', 'key', 'key_column', 'least', 'not', 'nullif',
  'numeric', 'nvarchar', 'or', 'over', 'position', 'requested', 'required', 'required_columns',
  'varchar',
  'required_indexes', 'retained', 'row', 'select', 'then', 'unique', 'values', 'where',
  // Relation names followed by a column/index/CTE list are SQL grammar, not calls.
  'call_campaign_contacts', 'call_campaigns', 'call_events', 'call_sessions', 'call_tasks',
  'chofer_costos', 'chofer_escala_tramos', 'chofer_escalas', 'chofer_stock',
  'chofer_stock_mov', 'choferes', 'cliente_cta_corriente_mov', 'cliente_datos_fiscales',
  'cliente_recompensas', 'cliente_referentes', 'cliente_retornables_movimientos',
  'cliente_retornables_saldos', 'compras_orden_items', 'compras_ordenes',
  'compras_recepcion_items', 'compras_recepciones', 'comprobante_operacion_claims',
  'comprobante_pedido_aprobado_claims', 'comprobantes_transferencia', 'configuracion',
  'crm_oportunidad_actividades', 'crm_oportunidades', 'deposito_chofer', 'depositos',
  'empresa_activos', 'empresa_activos_alquileres', 'empresa_costos_fijos',
  'empresa_costos_variables_aplicacion', 'empresa_costos_variables_def',
  'empresa_cuentas_bancarias', 'empresa_facturacion_config', 'empresa_productos_costos',
  'empresa_prompts', 'empresas', 'entregas_evidencias', 'factura_afip_auditoria',
  'factura_eventos', 'factura_items', 'facturas', 'gastos_repartidor', 'historial_activos',
  'historial_costos_precios', 'historial_pagos', 'incidencias_operativas',
  'incidencias_operativas_historial', 'items_pedido', 'juegos_campanias',
  'juegos_participaciones', 'juegos_premios', 'marketing_contactos',
  'marketing_envios_telemetria', 'page_view_events', 'page_views', 'pedido_activos',
  'pedido_pagos', 'pedido_track_points', 'pedidos', 'presupuesto_mensual', 'producto_prefs',
  'productos', 'promociones_config', 'promociones_redenciones', 'proveedores',
  'puntos_entrega', 'puntos_movimientos', 'push_sub_pedidos', 'push_subs',
  'referente_clientes_propuestos', 'referente_comisiones', 'referente_notificaciones',
  'referente_productos', 'referentes', 'tesoreria_movimientos', 'tracking_incident_acks',
  'transferencias', 'usuarios', 'whatsapp_cloud_events', 'wpp_general_control',
  'wpp_outbox', 'zona_chofer', 'zonas_geograficas',
]);

function unqualifiedCallInventory(sql) {
  const scrubbed = sql
    .replaceAll('\r\n', '\n')
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, match => ' '.repeat(match.length))
    .replace(/'(?:''|[^'])*'/g, match => match.replace(/[^\n]/g, ' '))
    // Keep PL/pgSQL bodies visible while removing their dollar-quote delimiters.
    .replace(/\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$/g, match => ' '.repeat(match.length));
  const calls = [];
  const pattern = /(?<![\w$.])([A-Za-z_][A-Za-z_0-9$]*)\s*\(/g;
  for (const match of scrubbed.matchAll(pattern)) {
    const identifier = match[1].toLowerCase();
    if (nonFunctionCallIdentifiers.has(identifier)) continue;
    calls.push({
      identifier,
      line: scrubbed.slice(0, match.index).split('\n').length,
    });
  }
  return calls;
}

async function withDatabase(work) {
  const directory = mkdtempSync(join(process.cwd(), tempPrefix));
  createdDirectories.add(directory);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let pool;
  try {
    execFileSync(join(bin, 'initdb'), [
      '-D', directory, '-A', 'trust', '-U', 'init_db_test', '--no-locale', '--encoding=UTF8',
    ], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), [
      '-D', directory, '-l', join(directory, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start',
    ], { stdio: 'pipe' });
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'init_db_test', database: 'postgres', max: 2 });
    const version = await pool.query('SHOW server_version');
    assert.match(version.rows[0].server_version, /^18\./);
    await work(pool, { host: '127.0.0.1', port, database: 'postgres' });
  } finally {
    if (pool) await pool.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), [
      '-D', directory, '-m', 'immediate', '-w', 'stop',
    ], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
    createdDirectories.delete(directory);
  }
}

async function snapshotNamespace(pool, schema) {
  await pool.query('BEGIN');
  try {
    await pool.query('SET LOCAL search_path = public, pg_catalog');
    const result = await pool.query(`
    WITH namespace AS (
      SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1
    ), inventory AS (
      SELECT 'namespace'::TEXT AS kind, namespace_row.oid AS oid, namespace_row.nspname AS name,
             pg_catalog.concat_ws('|', namespace_row.nspowner::TEXT,
               namespace_row.nspacl::TEXT) AS definition
        FROM pg_catalog.pg_namespace AS namespace_row
       WHERE namespace_row.oid IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'class', class_row.oid, class_row.relname,
             pg_catalog.concat_ws('|', class_row.relkind::TEXT, class_row.relpersistence::TEXT,
               class_row.relowner::TEXT, class_row.relam::TEXT,
               CASE WHEN class_row.relkind IN ('v', 'm')
                    THEN pg_catalog.pg_get_viewdef(class_row.oid, true) END,
               CASE WHEN class_row.relkind = 'i'
                    THEN pg_catalog.pg_get_indexdef(class_row.oid) END)
        FROM pg_catalog.pg_class AS class_row
       WHERE class_row.relnamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'attribute', (class_row.oid::BIGINT * 1000 + attribute_row.attnum)::OID,
             class_row.relname || '.' || attribute_row.attname,
             pg_catalog.concat_ws('|', attribute_row.atttypid::TEXT, attribute_row.atttypmod::TEXT,
               attribute_row.attnotnull::TEXT, attribute_row.attidentity::TEXT,
               attribute_row.attgenerated::TEXT, attribute_row.attcollation::TEXT,
               pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid))
        FROM pg_catalog.pg_class AS class_row
        JOIN pg_catalog.pg_attribute AS attribute_row ON attribute_row.attrelid = class_row.oid
        LEFT JOIN pg_catalog.pg_attrdef AS default_row
          ON default_row.adrelid = attribute_row.attrelid AND default_row.adnum = attribute_row.attnum
       WHERE class_row.relnamespace IN (SELECT oid FROM namespace)
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
      UNION ALL
      SELECT 'constraint', constraint_row.oid, constraint_row.conname,
             pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.connamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'function', procedure_row.oid, procedure_row.proname,
             pg_catalog.pg_get_functiondef(procedure_row.oid)
        FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.pronamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'trigger', trigger_row.oid, class_row.relname || '.' || trigger_row.tgname,
             pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
        FROM pg_catalog.pg_trigger AS trigger_row
        JOIN pg_catalog.pg_class AS class_row ON class_row.oid = trigger_row.tgrelid
       WHERE class_row.relnamespace IN (SELECT oid FROM namespace)
      UNION ALL
      SELECT 'type', type_row.oid, type_row.typname,
             pg_catalog.concat_ws('|', type_row.typtype::TEXT, type_row.typcategory::TEXT,
               type_row.typrelid::TEXT, type_row.typelem::TEXT, type_row.typbasetype::TEXT,
               type_row.typnotnull::TEXT,
               (SELECT pg_catalog.string_agg(enum_row.enumlabel, ',' ORDER BY enum_row.enumsortorder)
                  FROM pg_catalog.pg_enum AS enum_row WHERE enum_row.enumtypid = type_row.oid))
        FROM pg_catalog.pg_type AS type_row
       WHERE type_row.typnamespace IN (SELECT oid FROM namespace)
    )
    SELECT kind, oid::TEXT, name, definition
      FROM inventory
     ORDER BY kind, name, oid
    `, [schema]);
    await pool.query('COMMIT');
    return result.rows;
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function canonicalOutboxForeignKey(pool) {
  return pool.query(`
    SELECT constraint_row.oid::TEXT,
           source_namespace.nspname AS source_schema,
           source_table.relname AS source_table,
           ARRAY(
             SELECT attribute_row.attname
               FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute_row
                 ON attribute_row.attrelid = constraint_row.conrelid
                AND attribute_row.attnum = key.attnum
              ORDER BY key.position
           )::TEXT[] AS source_columns,
           target_namespace.nspname AS target_schema,
           target_table.relname AS target_table,
           ARRAY(
             SELECT attribute_row.attname
               FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute_row
                 ON attribute_row.attrelid = constraint_row.confrelid
                AND attribute_row.attnum = key.attnum
              ORDER BY key.position
           )::TEXT[] AS target_columns,
           constraint_row.confupdtype,
           constraint_row.confdeltype,
           constraint_row.confmatchtype,
           constraint_row.condeferrable,
           constraint_row.condeferred,
           constraint_row.convalidated,
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace AS source_namespace ON source_namespace.oid = source_table.relnamespace
      JOIN pg_catalog.pg_class AS target_table ON target_table.oid = constraint_row.confrelid
      JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_table.relnamespace
     WHERE constraint_row.conrelid = 'public.wpp_outbox'::pg_catalog.regclass
       AND constraint_row.conname = 'wpp_outbox_empresa_id_fkey'
       AND constraint_row.contype = 'f'
  `);
}

async function prepareShadow(client) {
  await client.query('CREATE SCHEMA shadow');
  await client.query(`
    SET search_path = shadow, public;
    CREATE TABLE shadow.empresas(id INTEGER PRIMARY KEY, marker TEXT DEFAULT 'shadow');
    CREATE FUNCTION shadow.now() RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE
      AS 'SELECT TIMESTAMPTZ ''2000-01-01T00:00:00Z''';
    CREATE VIEW shadow.empresas_view AS SELECT id, marker FROM shadow.empresas;
  `);
  return snapshotNamespace(client, 'shadow');
}

async function assertOriginalSearchPathAndShadow(client, shadowBefore) {
  assert.equal((await client.query('SHOW search_path')).rows[0].search_path, 'shadow, public');
  assert.deepEqual(await snapshotNamespace(client, 'shadow'), shadowBefore);
}

function injectFailureAfter(sql, marker) {
  const offset = sql.indexOf(marker);
  assert.ok(offset >= 0, `missing failure marker: ${marker}`);
  return `${sql.slice(0, offset + marker.length)}\nSELECT 1 / 0;\n${sql.slice(offset + marker.length)}`;
}

function assertTransactionScopedSearchPath(sql) {
  const lines = sql.replaceAll('\r\n', '\n').split('\n');
  const nextExecutableLine = start => {
    let index = start;
    while (index < lines.length && (!lines[index].trim() || lines[index].trimStart().startsWith('--'))) index += 1;
    return index;
  };
  let beginCount = 0;
  let commitCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === 'BEGIN;') {
      beginCount += 1;
      const next = nextExecutableLine(index + 1);
      assert.equal(lines[next]?.trim(), 'SET LOCAL search_path = public;',
        `BEGIN at line ${index + 1} must set the canonical local search_path first`);
    }
    if (lines[index].trim() === 'COMMIT;') {
      commitCount += 1;
      const next = nextExecutableLine(index + 1);
      if (next < lines.length) assert.equal(lines[next].trim(), 'BEGIN;',
        `COMMIT at line ${index + 1} must be followed by the next scoped phase`);
    }
  }
  assert.ok(beginCount > 0);
  assert.equal(commitCount, beginCount);
}

test('inventario estructural no permite llamadas a funciones sin schema en initDb.sql', () => {
  assert.deepEqual(unqualifiedCallInventory(initSql), []);
});

test('initDb completo limita public a cada transacción y preserva search_path y shadow en doble migración',
  { timeout: 180_000 }, async () => {
    assert.match(initSql, /^BEGIN;\s*SET LOCAL search_path = public;/);
    assert.doesNotMatch(initSql, /^SET(?: LOCAL)? search_path = public, pg_catalog;/m);
    assert.doesNotMatch(initSql, /^RESET search_path;/m);
    assert.match(initSql, /COMMIT;\s*$/);
    assertTransactionScopedSearchPath(initSql);

    await withDatabase(async pool => {
      const client = await pool.connect();
      try {
        const shadowBefore = await prepareShadow(client);

        await client.query(initSql);
        await assertOriginalSearchPathAndShadow(client, shadowBefore);

        const publicObjects = await client.query(`
          SELECT COUNT(*)::INTEGER AS count
            FROM pg_catalog.pg_class AS class_row
            JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
           WHERE namespace_row.nspname = 'public'
        `);
        assert.ok(publicObjects.rows[0].count > 100, 'full install must create the canonical public schema');
        for (const relation of ['public.empresas', 'public.wpp_outbox', 'public.whatsapp_cloud_events']) {
          assert.notEqual((await client.query('SELECT pg_catalog.to_regclass($1) AS oid', [relation])).rows[0].oid, null);
        }

        await client.query(initSql);
        await assertOriginalSearchPathAndShadow(client, shadowBefore);
      } finally {
        client.release();
      }
    });
  });

test('rol de migración no resuelve funciones homónimas maliciosas de public',
  { timeout: 180_000 }, async () => {
    await withDatabase(async (admin, connection) => {
      await admin.query(`
        CREATE EXTENSION pg_trgm;
        CREATE EXTENSION postgis;
        CREATE ROLE init_db_attacker LOGIN;
        CREATE ROLE init_db_migrator LOGIN;
        GRANT USAGE, CREATE ON SCHEMA public TO init_db_attacker, init_db_migrator;
        CREATE SCHEMA hijack AUTHORIZATION init_db_attacker;
      `);

      const attacker = new pg.Pool({ ...connection, user: 'init_db_attacker', max: 1 });
      const migrator = new pg.Pool({ ...connection, user: 'init_db_migrator', max: 1 });
      try {
        await attacker.query(`
          CREATE SEQUENCE hijack.concat_ws_calls;
          CREATE SEQUENCE hijack.jsonb_typeof_calls;
          CREATE SEQUENCE hijack.format_calls;

          CREATE FUNCTION public.jsonb_typeof(value JSONB)
          RETURNS TEXT
          LANGUAGE plpgsql
          IMMUTABLE
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $function$
          BEGIN
            PERFORM pg_catalog.nextval('hijack.jsonb_typeof_calls'::pg_catalog.regclass);
            RETURN pg_catalog.jsonb_typeof(value);
          END
          $function$;

          CREATE FUNCTION public.concat_ws(separator TEXT, first_arg TEXT, second_arg TEXT)
          RETURNS TEXT
          LANGUAGE plpgsql
          IMMUTABLE
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $function$
          BEGIN
            PERFORM pg_catalog.nextval('hijack.concat_ws_calls'::pg_catalog.regclass);
            RETURN pg_catalog.concat_ws(separator, first_arg, second_arg);
          END
          $function$;

          CREATE FUNCTION public.unnest(value SMALLINT[])
          RETURNS SETOF SMALLINT
          LANGUAGE SQL
          IMMUTABLE
          AS 'SELECT * FROM pg_catalog.unnest(value)';

          CREATE FUNCTION public.format(value TEXT, first_arg TEXT, second_arg TEXT)
          RETURNS TEXT
          LANGUAGE plpgsql
          IMMUTABLE
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $function$
          BEGIN
            PERFORM pg_catalog.nextval('hijack.format_calls'::pg_catalog.regclass);
            RETURN pg_catalog.format(value, first_arg, second_arg);
          END
          $function$;
        `);

        const vulnerableResolution = await admin.query(`
          BEGIN;
          SET LOCAL search_path = public, pg_catalog;
          SELECT
            (SELECT namespace_row.nspname
               FROM pg_catalog.pg_proc AS procedure_row
               JOIN pg_catalog.pg_namespace AS namespace_row
                 ON namespace_row.oid = procedure_row.pronamespace
              WHERE procedure_row.oid = 'jsonb_typeof(jsonb)'::pg_catalog.regprocedure) AS jsonb_schema,
            (SELECT namespace_row.nspname
               FROM pg_catalog.pg_proc AS procedure_row
               JOIN pg_catalog.pg_namespace AS namespace_row
                 ON namespace_row.oid = procedure_row.pronamespace
              WHERE procedure_row.oid = 'concat_ws(text,text,text)'::pg_catalog.regprocedure) AS concat_ws_schema,
            (SELECT namespace_row.nspname
               FROM pg_catalog.pg_proc AS procedure_row
               JOIN pg_catalog.pg_namespace AS namespace_row
                 ON namespace_row.oid = procedure_row.pronamespace
              WHERE procedure_row.oid = 'format(text,text,text)'::pg_catalog.regprocedure) AS format_schema;
          ROLLBACK;
        `);
        assert.deepEqual(vulnerableResolution[2].rows[0], {
          jsonb_schema: 'public',
          concat_ws_schema: 'public',
          format_schema: 'public',
        }, 'the test must install actually resolvable hijacks under the old explicit ordering');

        const invokedHijack = await admin.query(`
          BEGIN;
          SET LOCAL search_path = public, pg_catalog;
          SELECT concat_ws('|', 'hostile', 'invoked') AS value;
          ROLLBACK;
        `);
        assert.equal(invokedHijack[2].rows[0].value, 'hostile|invoked');
        assert.deepEqual((await admin.query(`
          SELECT last_value::BIGINT, is_called FROM hijack.concat_ws_calls
        `)).rows[0], { last_value: '1', is_called: true });
        await admin.query(`SELECT pg_catalog.setval('hijack.concat_ws_calls'::pg_catalog.regclass, 1, false)`);

        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL search_path = public, pg_catalog');
          await assert.rejects(
            admin.query(`SELECT * FROM unnest('1 2'::pg_catalog.int2vector)`),
            error => error?.code === '42725',
          );
        } finally {
          await admin.query('ROLLBACK');
        }

        const shadowBefore = await prepareShadow(admin);
        const client = await migrator.connect();
        try {
          await client.query('SET search_path = shadow, public');
          await client.query(initSql);
          assert.equal((await client.query('SHOW search_path')).rows[0].search_path, 'shadow, public');
          await client.query(initSql);
          assert.equal((await client.query('SHOW search_path')).rows[0].search_path, 'shadow, public');
        } finally {
          client.release();
        }

        assert.deepEqual(await snapshotNamespace(admin, 'shadow'), shadowBefore);
        const callState = await admin.query(`
          SELECT 'concat_ws' AS function_name, last_value::BIGINT, is_called
            FROM hijack.concat_ws_calls
          UNION ALL
          SELECT 'jsonb_typeof', last_value::BIGINT, is_called
            FROM hijack.jsonb_typeof_calls
          UNION ALL
          SELECT 'format', last_value::BIGINT, is_called
            FROM hijack.format_calls
          ORDER BY function_name
        `);
        assert.deepEqual(callState.rows, [
          { function_name: 'concat_ws', last_value: '1', is_called: false },
          { function_name: 'format', last_value: '1', is_called: false },
          { function_name: 'jsonb_typeof', last_value: '1', is_called: false },
        ]);

        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL search_path = public');
          const resolution = await admin.query(`
            SELECT current_schema() AS current_schema,
                   current_schemas(true)::TEXT[] AS effective_path,
                   (SELECT namespace_row.nspname
                      FROM pg_catalog.pg_proc AS procedure_row
                      JOIN pg_catalog.pg_namespace AS namespace_row
                        ON namespace_row.oid = procedure_row.pronamespace
                     WHERE procedure_row.oid = 'jsonb_typeof(jsonb)'::pg_catalog.regprocedure) AS jsonb_schema,
                   (SELECT namespace_row.nspname
                      FROM pg_catalog.pg_proc AS procedure_row
                      JOIN pg_catalog.pg_namespace AS namespace_row
                        ON namespace_row.oid = procedure_row.pronamespace
                     WHERE procedure_row.oid = 'format(text,text,text)'::pg_catalog.regprocedure) AS format_schema,
                   pg_catalog.format('%s %s', 'builtin', 'resolved') AS builtin_format_result,
                   (SELECT namespace_row.nspname
                      FROM pg_catalog.pg_operator AS operator_row
                      JOIN pg_catalog.pg_namespace AS namespace_row
                        ON namespace_row.oid = operator_row.oprnamespace
                     WHERE operator_row.oid = '=(integer,integer)'::pg_catalog.regoperator) AS operator_schema,
                   (SELECT namespace_row.nspname
                      FROM pg_catalog.pg_type AS type_row
                      JOIN pg_catalog.pg_namespace AS namespace_row
                        ON namespace_row.oid = type_row.typnamespace
                     WHERE type_row.oid = 'integer'::pg_catalog.regtype) AS cast_type_schema
          `);
          assert.deepEqual(resolution.rows[0], {
            current_schema: 'public',
            effective_path: ['pg_catalog', 'public'],
            jsonb_schema: 'pg_catalog',
            format_schema: 'public',
            builtin_format_result: 'builtin resolved',
            operator_schema: 'pg_catalog',
            cast_type_schema: 'pg_catalog',
          });
        } finally {
          await admin.query('ROLLBACK');
        }

        const misplacedObjects = await admin.query(`
          SELECT kind, schema_name, object_name
            FROM (
              SELECT 'relation'::TEXT AS kind, namespace_row.nspname AS schema_name,
                     class_row.relname AS object_name
                FROM pg_catalog.pg_class AS class_row
                JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
               WHERE class_row.relowner = 'init_db_migrator'::pg_catalog.regrole
                 AND namespace_row.nspname NOT IN ('public', 'pg_toast')
              UNION ALL
              SELECT 'function', namespace_row.nspname, procedure_row.proname
                FROM pg_catalog.pg_proc AS procedure_row
                JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = procedure_row.pronamespace
               WHERE procedure_row.proowner = 'init_db_migrator'::pg_catalog.regrole
                 AND namespace_row.nspname <> 'public'
            ) AS misplaced
           ORDER BY kind, schema_name, object_name
        `);
        assert.deepEqual(misplacedObjects.rows, []);
      } finally {
        await attacker.end();
        await migrator.end();
      }
    });
  });

for (const [phase, marker] of [
  ['temprano', 'SET LOCAL search_path = public;'],
  ['medio', 'LOCK TABLE public.wpp_outbox IN ACCESS EXCLUSIVE MODE;'],
  ['tardío', '-- END WHATSAPP CLOUD QUICK REPLIES MIGRATION\n\nBEGIN;\nSET LOCAL search_path = public;'],
]) {
  test(`initDb restaura search_path original tras error ${phase}, rollback y query posterior`,
    { timeout: 180_000 }, async () => {
      await withDatabase(async pool => {
        const client = await pool.connect();
        try {
          const shadowBefore = await prepareShadow(client);
          const failingSql = injectFailureAfter(initSql.replaceAll('\r\n', '\n'), marker);
          await assert.rejects(client.query(failingSql), error => error?.code === '22012');
          await client.query('ROLLBACK');
          await assertOriginalSearchPathAndShadow(client, shadowBefore);
          assert.equal((await client.query('SELECT current_schema() AS schema')).rows[0].schema, 'shadow');
        } finally {
          client.release();
        }
      });
    });
}

test('initDb repara cualquier constraint homónima y preserva constraints de otros nombres',
  { timeout: 180_000 }, async () => {
    await withDatabase(async pool => {
      await pool.query(initSql);
      await pool.query(`
        CREATE TABLE public.outbox_reply_parent(id TEXT PRIMARY KEY);
        CREATE TABLE public.outbox_empresa_parent(id INTEGER PRIMARY KEY);
        ALTER TABLE public.wpp_outbox
          ADD CONSTRAINT wpp_outbox_reply_correlation_fkey
          FOREIGN KEY (reply_correlation_id) REFERENCES public.outbox_reply_parent(id)
          ON DELETE SET NULL;
        ALTER TABLE public.wpp_outbox
          ADD CONSTRAINT wpp_outbox_empresa_alt_fkey
          FOREIGN KEY (empresa_id) REFERENCES public.outbox_empresa_parent(id);
      `);

      const unrelatedConstraints = async () => (await pool.query(`
        SELECT oid::TEXT, pg_catalog.pg_get_constraintdef(oid, true) AS definition
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.wpp_outbox'::pg_catalog.regclass
           AND conname IN ('wpp_outbox_reply_correlation_fkey', 'wpp_outbox_empresa_alt_fkey')
         ORDER BY conname
      `)).rows;
      const unrelatedBefore = await unrelatedConstraints();

      const deceptiveDefinitions = [
        `ALTER TABLE public.wpp_outbox
           ADD CONSTRAINT wpp_outbox_empresa_id_fkey
           CHECK (claim_owner IS NULL OR claim_owner <> '') NOT VALID`,
        `ALTER TABLE public.wpp_outbox
           ADD CONSTRAINT wpp_outbox_empresa_id_fkey
           FOREIGN KEY (claim_owner) REFERENCES public.outbox_reply_parent(id) NOT VALID`,
        `ALTER TABLE public.wpp_outbox
           ADD CONSTRAINT wpp_outbox_empresa_id_fkey
           FOREIGN KEY (empresa_id) REFERENCES public.outbox_empresa_parent(id) NOT VALID`,
        `ALTER TABLE public.wpp_outbox
           ADD CONSTRAINT wpp_outbox_empresa_id_fkey
           FOREIGN KEY (empresa_id) REFERENCES public.empresas(id)
           MATCH SIMPLE ON UPDATE CASCADE ON DELETE CASCADE
           DEFERRABLE INITIALLY DEFERRED NOT VALID`,
      ];

      for (const deceptiveDefinition of deceptiveDefinitions) {
        await pool.query('ALTER TABLE public.wpp_outbox DROP CONSTRAINT wpp_outbox_empresa_id_fkey');
        await pool.query(deceptiveDefinition);

        await pool.query(initSql);
        await pool.query(initSql);

        const canonical = await canonicalOutboxForeignKey(pool);
        assert.equal(canonical.rowCount, 1);
        assert.deepEqual(canonical.rows[0], {
          oid: canonical.rows[0].oid,
          source_schema: 'public',
          source_table: 'wpp_outbox',
          source_columns: ['empresa_id'],
          target_schema: 'public',
          target_table: 'empresas',
          target_columns: ['id'],
          confupdtype: 'a',
          confdeltype: 'c',
          confmatchtype: 's',
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          definition: 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE',
        });
        assert.deepEqual(await unrelatedConstraints(), unrelatedBefore);
      }
    });
  });

after(() => {
  assert.deepEqual([...createdDirectories].map(basename), [], 'all temporary PostgreSQL clusters must be removed');
  const residual = readdirSync(process.cwd()).filter(name => name.startsWith(tempPrefix));
  assert.deepEqual(residual, [], 'no residual temporary PostgreSQL cluster directories');
});
