BEGIN;
SET LOCAL search_path = public;

-- =========================================================
-- ARCHIVO DE INICIALIZACIÓN DE BASE DE DATOS (PostgreSQL)
-- Versión "Definitiva" (Orden de Dependencias Corregido)
-- =========================================================

-- 1. EXTENSIONES
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

-- =========================================================
-- 2. EMPRESAS (Multi-tenancy + Control de Licencias)
-- =========================================================
CREATE TABLE IF NOT EXISTS empresas (
  id                 SERIAL PRIMARY KEY,
  nombre             TEXT NOT NULL, 
  razon_social       TEXT,          
  cuit               TEXT,          
  condicion_iva      TEXT,          
  direccion          TEXT,          
  ciudad             TEXT,
  provincia          TEXT,
  pais               TEXT DEFAULT 'Argentina',
  telefono           TEXT,
  email              TEXT,
  rubro              TEXT,          
  etiquetas          TEXT,          
  alias              TEXT,
  
  -- Configuraciones avanzadas
  setup_steps        TEXT DEFAULT '{}',
  landing_domain     TEXT UNIQUE,  
  landing_slug       TEXT UNIQUE,  
  prompt_ia_vendedor TEXT,
  prompt_ia_general  TEXT,
  config_estrategias JSONB DEFAULT '{}',
  config_entrega     JSONB DEFAULT '{}',
  
  -- SISTEMA DE LICENCIAS
  plan_estado        TEXT DEFAULT 'active', 
  plan_tipo          TEXT DEFAULT 'trial', 
  plan_vencimiento   TIMESTAMPTZ DEFAULT (pg_catalog.NOW() + INTERVAL '30 days'),
  plan_precio        NUMERIC(12, 2) DEFAULT 0,
  
  created_at         TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS modulos              JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_operativa     JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_logistica     JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_activos       JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_integraciones JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_landing_domain_unique
  ON empresas (pg_catalog.LOWER(landing_domain))
  WHERE landing_domain IS NOT NULL;

-- BEGIN WHATSAPP CLOUD INBOX MIGRATION
COMMIT;
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
CREATE TABLE IF NOT EXISTS whatsapp_cloud_events (
  id               BIGSERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  event_kind       TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  entry_id         TEXT,
  sender_id        TEXT,
  recipient_id     TEXT,
  message_type     TEXT,
  status           TEXT,
  source_timestamp TEXT,
  phone_number_id  TEXT,
  event_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  processing_state TEXT NOT NULL DEFAULT 'pending',
  claim_owner      TEXT,
  claim_until      TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  processed_at     TIMESTAMPTZ,
  processing_error_code TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ
);

DO $$
DECLARE
  column_definition RECORD;
BEGIN
  FOR column_definition IN
    SELECT * FROM (VALUES
      ('id', 'BIGINT'),
      ('empresa_id', 'INTEGER'),
      ('event_kind', 'TEXT'),
      ('dedupe_key', 'TEXT'),
      ('message_id', 'TEXT'),
      ('entry_id', 'TEXT'),
      ('sender_id', 'TEXT'),
      ('recipient_id', 'TEXT'),
      ('message_type', 'TEXT'),
      ('status', 'TEXT'),
      ('source_timestamp', 'TEXT'),
      ('phone_number_id', 'TEXT'),
      ('event_data', 'JSONB'),
      ('received_at', 'TIMESTAMPTZ'),
      ('processing_state', 'TEXT'),
      ('claim_owner', 'TEXT'),
      ('claim_until', 'TIMESTAMPTZ'),
      ('processing_started_at', 'TIMESTAMPTZ'),
      ('processed_at', 'TIMESTAMPTZ'),
      ('processing_error_code', 'TEXT'),
      ('attempt_count', 'INTEGER'),
      ('retry_count', 'INTEGER'),
      ('next_attempt_at', 'TIMESTAMPTZ')
    ) AS required_columns(column_name, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_attribute
       WHERE attrelid = 'whatsapp_cloud_events'::regclass
         AND attname = column_definition.column_name
         AND NOT attisdropped
    ) THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE whatsapp_cloud_events ADD COLUMN %I %s',
        column_definition.column_name,
        column_definition.data_type
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'whatsapp_cloud_events'::regclass
       AND attname = 'id'
       AND atttypid <> 'bigint'::regtype
       AND NOT attisdropped
  ) THEN
    ALTER TABLE whatsapp_cloud_events
      ALTER COLUMN id TYPE BIGINT USING id::bigint;
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS whatsapp_cloud_events_id_seq AS BIGINT;

DO $$
DECLARE
  id_attribute SMALLINT;
  current_default TEXT;
BEGIN
  SELECT attnum
    INTO id_attribute
    FROM pg_attribute
   WHERE attrelid = 'whatsapp_cloud_events'::regclass
     AND attname = 'id'
     AND NOT attisdropped;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_depend
     WHERE classid = 'pg_class'::regclass
       AND objid = 'whatsapp_cloud_events_id_seq'::regclass
       AND refclassid = 'pg_class'::regclass
       AND refobjid = 'whatsapp_cloud_events'::regclass
       AND refobjsubid = id_attribute
       AND deptype = 'a'
  ) THEN
    ALTER SEQUENCE whatsapp_cloud_events_id_seq
      OWNED BY whatsapp_cloud_events.id;
  END IF;

  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    INTO current_default
    FROM pg_attrdef AS default_row
   WHERE default_row.adrelid = 'whatsapp_cloud_events'::regclass
     AND default_row.adnum = id_attribute;

  IF current_default IS DISTINCT FROM 'nextval(''whatsapp_cloud_events_id_seq''::regclass)' THEN
    ALTER TABLE whatsapp_cloud_events
      ALTER COLUMN id SET DEFAULT pg_catalog.nextval('whatsapp_cloud_events_id_seq'::regclass);
  END IF;
END $$;

DO $$
DECLARE
  maximum_id BIGINT;
  sequence_value BIGINT;
BEGIN
  SELECT COALESCE(pg_catalog.MAX(id), 0) INTO maximum_id FROM whatsapp_cloud_events;
  SELECT last_value INTO sequence_value FROM whatsapp_cloud_events_id_seq;
  IF maximum_id >= sequence_value THEN
    PERFORM pg_catalog.setval('whatsapp_cloud_events_id_seq', maximum_id + 1, false);
  END IF;
END $$;

UPDATE whatsapp_cloud_events
   SET id = pg_catalog.nextval('whatsapp_cloud_events_id_seq'::regclass)
 WHERE id IS NULL;

UPDATE whatsapp_cloud_events
   SET event_data = COALESCE(event_data, '{}'::jsonb),
       received_at = COALESCE(received_at, pg_catalog.NOW()),
       processing_state = COALESCE(processing_state, 'pending'),
       attempt_count = COALESCE(attempt_count, 0),
       retry_count = COALESCE(retry_count, 0)
 WHERE event_data IS NULL OR received_at IS NULL OR processing_state IS NULL
    OR attempt_count IS NULL OR retry_count IS NULL;

DO $$
DECLARE
  required_column TEXT;
  current_default TEXT;
BEGIN
  FOR required_column IN
    SELECT pg_catalog.unnest(ARRAY['id', 'empresa_id', 'event_kind', 'dedupe_key', 'message_id', 'event_data', 'received_at', 'processing_state', 'attempt_count', 'retry_count'])
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_attribute
       WHERE attrelid = 'whatsapp_cloud_events'::regclass
         AND attname = required_column
         AND NOT attnotnull
         AND NOT attisdropped
    ) THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE whatsapp_cloud_events ALTER COLUMN %I SET NOT NULL',
        required_column
      );
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    INTO current_default
    FROM pg_attrdef AS default_row
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = default_row.adrelid
     AND attribute_row.attnum = default_row.adnum
   WHERE default_row.adrelid = 'whatsapp_cloud_events'::regclass
     AND attribute_row.attname = 'event_data';
  IF current_default IS DISTINCT FROM '''{}''::jsonb' THEN
    ALTER TABLE whatsapp_cloud_events
      ALTER COLUMN event_data SET DEFAULT '{}'::jsonb;
  END IF;

  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    INTO current_default
    FROM pg_attrdef AS default_row
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = default_row.adrelid
     AND attribute_row.attnum = default_row.adnum
   WHERE default_row.adrelid = 'whatsapp_cloud_events'::regclass
     AND attribute_row.attname = 'received_at';
  IF current_default IS DISTINCT FROM 'now()' THEN
    ALTER TABLE whatsapp_cloud_events
      ALTER COLUMN received_at SET DEFAULT pg_catalog.NOW();
  END IF;

  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    INTO current_default
    FROM pg_attrdef AS default_row
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = default_row.adrelid
     AND attribute_row.attnum = default_row.adnum
   WHERE default_row.adrelid = 'whatsapp_cloud_events'::regclass
     AND attribute_row.attname = 'processing_state';
  IF current_default IS DISTINCT FROM '''pending''::text' THEN
    ALTER TABLE whatsapp_cloud_events
      ALTER COLUMN processing_state SET DEFAULT 'pending';
  END IF;

  ALTER TABLE whatsapp_cloud_events
    ALTER COLUMN attempt_count SET DEFAULT 0,
    ALTER COLUMN retry_count SET DEFAULT 0;
END $$;

DO $$
DECLARE
  primary_key_name TEXT;
  primary_key_columns TEXT[];
BEGIN
  SELECT constraint_row.conname,
         pg_catalog.array_agg(attribute_row.attname ORDER BY key_column.ordinality)
    INTO primary_key_name, primary_key_columns
    FROM pg_constraint AS constraint_row
    CROSS JOIN LATERAL pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = constraint_row.conrelid
     AND attribute_row.attnum = key_column.attnum
   WHERE constraint_row.conrelid = 'whatsapp_cloud_events'::regclass
     AND constraint_row.contype = 'p'
   GROUP BY constraint_row.conname;

  IF primary_key_name IS NULL THEN
    ALTER TABLE whatsapp_cloud_events
      ADD CONSTRAINT whatsapp_cloud_events_pkey PRIMARY KEY (id);
  ELSIF primary_key_columns <> ARRAY['id']::TEXT[] THEN
    EXECUTE pg_catalog.format('ALTER TABLE whatsapp_cloud_events DROP CONSTRAINT %I', primary_key_name);
    ALTER TABLE whatsapp_cloud_events
      ADD CONSTRAINT whatsapp_cloud_events_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$
DECLARE
  foreign_key RECORD;
  empresa_attribute SMALLINT;
  empresa_target_attribute SMALLINT;
BEGIN
  SELECT attnum INTO empresa_attribute
    FROM pg_attribute
   WHERE attrelid = 'whatsapp_cloud_events'::regclass AND attname = 'empresa_id' AND NOT attisdropped;
  SELECT attnum INTO empresa_target_attribute
    FROM pg_attribute
   WHERE attrelid = 'empresas'::regclass AND attname = 'id' AND NOT attisdropped;

  FOR foreign_key IN
    SELECT conname, confrelid, confkey, confdeltype
      FROM pg_constraint
     WHERE conrelid = 'whatsapp_cloud_events'::regclass
       AND contype = 'f'
       AND conkey = ARRAY[empresa_attribute]::SMALLINT[]
  LOOP
    IF foreign_key.conname <> 'whatsapp_cloud_events_empresa_id_fkey'
       OR foreign_key.confrelid <> 'empresas'::regclass
       OR foreign_key.confkey <> ARRAY[empresa_target_attribute]::SMALLINT[]
       OR foreign_key.confdeltype <> 'c' THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE whatsapp_cloud_events DROP CONSTRAINT %I',
        foreign_key.conname
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'whatsapp_cloud_events'::regclass
       AND conname = 'whatsapp_cloud_events_empresa_id_fkey'
       AND contype = 'f'
       AND conkey = ARRAY[empresa_attribute]::SMALLINT[]
       AND confrelid = 'empresas'::regclass
       AND confkey = ARRAY[empresa_target_attribute]::SMALLINT[]
       AND confdeltype = 'c'
  ) THEN
    ALTER TABLE whatsapp_cloud_events
      ADD CONSTRAINT whatsapp_cloud_events_empresa_id_fkey
      FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'whatsapp_cloud_events'::regclass
       AND conname = 'whatsapp_cloud_events_empresa_id_fkey'
       AND NOT convalidated
  ) THEN
    ALTER TABLE whatsapp_cloud_events
      VALIDATE CONSTRAINT whatsapp_cloud_events_empresa_id_fkey;
  END IF;
END $$;

DO $$
DECLARE
  current_definition TEXT;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid)
    INTO current_definition
    FROM pg_constraint
   WHERE conrelid = 'whatsapp_cloud_events'::regclass
     AND conname = 'whatsapp_cloud_events_kind_check'
     AND contype = 'c';

  IF current_definition IS NOT NULL
     AND current_definition NOT LIKE 'CHECK ((event_kind = ANY (ARRAY[''message''::text, ''status''::text])))%' THEN
    ALTER TABLE whatsapp_cloud_events
      DROP CONSTRAINT whatsapp_cloud_events_kind_check;
    current_definition := NULL;
  END IF;

  IF current_definition IS NULL THEN
    ALTER TABLE whatsapp_cloud_events
      ADD CONSTRAINT whatsapp_cloud_events_kind_check
      CHECK (event_kind IN ('message', 'status')) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'whatsapp_cloud_events'::regclass
       AND conname = 'whatsapp_cloud_events_kind_check'
       AND NOT convalidated
  ) THEN
    ALTER TABLE whatsapp_cloud_events
      VALIDATE CONSTRAINT whatsapp_cloud_events_kind_check;
  END IF;
END $$;

DO $$
DECLARE
  current_definition TEXT;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid)
    INTO current_definition
    FROM pg_constraint
   WHERE conrelid = 'whatsapp_cloud_events'::regclass
     AND conname = 'whatsapp_cloud_events_processing_state_check'
     AND contype = 'c';

  IF current_definition IS NOT NULL
     AND current_definition NOT LIKE '%pending%pre_process%processing_started%processed%skipped%outcome_unknown%' THEN
    ALTER TABLE whatsapp_cloud_events
      DROP CONSTRAINT whatsapp_cloud_events_processing_state_check;
    current_definition := NULL;
  END IF;

  IF current_definition IS NULL THEN
    ALTER TABLE whatsapp_cloud_events
      ADD CONSTRAINT whatsapp_cloud_events_processing_state_check
      CHECK (processing_state IN ('pending', 'pre_process', 'processing_started', 'processed', 'skipped', 'outcome_unknown')) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'whatsapp_cloud_events'::regclass
       AND conname = 'whatsapp_cloud_events_processing_state_check'
       AND NOT convalidated
  ) THEN
    ALTER TABLE whatsapp_cloud_events
      VALIDATE CONSTRAINT whatsapp_cloud_events_processing_state_check;
  END IF;
END $$;

DO $$
DECLARE
  existing_index REGCLASS := pg_catalog.to_regclass('idx_whatsapp_cloud_events_inbound_claim');
  key_columns TEXT[];
  predicate_definition TEXT;
  normalized_predicate TEXT;
  valid_index BOOLEAN := FALSE;
BEGIN
  IF existing_index IS NOT NULL THEN
    SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_column.ordinality)
             FILTER (WHERE key_column.ordinality <= index_row.indnkeyatts),
           pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid),
           NOT index_row.indisunique
             AND index_row.indexprs IS NULL
             AND index_row.indnkeyatts = 4
             AND index_row.indnatts = 4
           INTO key_columns, predicate_definition, valid_index
      FROM pg_index AS index_row
      CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute AS attribute_row
        ON attribute_row.attrelid = index_row.indrelid
       AND attribute_row.attnum = key_column.attnum
     WHERE index_row.indexrelid = existing_index
     GROUP BY index_row.indnkeyatts, index_row.indnatts, index_row.indpred, index_row.indrelid,
              index_row.indisunique, index_row.indexprs;

    normalized_predicate := pg_catalog.regexp_replace(
      pg_catalog.lower(COALESCE(predicate_definition, '')),
      '(::text|[[:space:]()])',
      '',
      'g'
    );
    valid_index := COALESCE(valid_index, FALSE)
      AND key_columns = ARRAY['processing_state', 'next_attempt_at', 'received_at', 'id']::TEXT[]
      AND normalized_predicate = 'event_kind=''message''andprocessing_state=anyarray[''pending'',''pre_process'']';

    IF NOT valid_index THEN
      EXECUTE 'DROP INDEX idx_whatsapp_cloud_events_inbound_claim';
      existing_index := NULL;
    END IF;
  END IF;

  IF existing_index IS NULL THEN
    EXECUTE $index$
      CREATE INDEX idx_whatsapp_cloud_events_inbound_claim
        ON whatsapp_cloud_events (processing_state, next_attempt_at, received_at, id)
       WHERE event_kind = 'message'
         AND processing_state IN ('pending', 'pre_process')
    $index$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_cloud_events_processing_reconcile
  ON whatsapp_cloud_events (claim_until, id)
  WHERE event_kind = 'message'
    AND processing_state = 'processing_started';

DO $$
DECLARE
  empresa_attribute SMALLINT;
  dedupe_attribute SMALLINT;
  existing_index REGCLASS;
  valid_index BOOLEAN := FALSE;
BEGIN
  SELECT attnum INTO empresa_attribute
    FROM pg_attribute
   WHERE attrelid = 'whatsapp_cloud_events'::regclass AND attname = 'empresa_id' AND NOT attisdropped;
  SELECT attnum INTO dedupe_attribute
    FROM pg_attribute
   WHERE attrelid = 'whatsapp_cloud_events'::regclass AND attname = 'dedupe_key' AND NOT attisdropped;
  existing_index := pg_catalog.to_regclass('idx_whatsapp_cloud_events_dedupe_key');

  IF existing_index IS NOT NULL THEN
    SELECT index_row.indisunique
       AND index_row.indpred IS NULL
       AND index_row.indexprs IS NULL
       AND index_row.indnkeyatts = 2
       AND index_row.indkey::TEXT = pg_catalog.format('%s %s', empresa_attribute, dedupe_attribute)
      INTO valid_index
      FROM pg_index AS index_row
     WHERE index_row.indexrelid = existing_index;
    IF NOT COALESCE(valid_index, FALSE) THEN
      EXECUTE 'DROP INDEX idx_whatsapp_cloud_events_dedupe_key';
      existing_index := NULL;
    END IF;
  END IF;

  IF existing_index IS NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX idx_whatsapp_cloud_events_dedupe_key ON whatsapp_cloud_events (empresa_id, dedupe_key)';
  END IF;
END $$;

DO $$
DECLARE
  empresa_attribute SMALLINT;
  received_attribute SMALLINT;
  existing_index REGCLASS := pg_catalog.to_regclass('idx_whatsapp_cloud_events_empresa_received');
  valid_index BOOLEAN := FALSE;
BEGIN
  SELECT attnum INTO empresa_attribute
    FROM pg_attribute
   WHERE attrelid = 'whatsapp_cloud_events'::regclass AND attname = 'empresa_id' AND NOT attisdropped;
  SELECT attnum INTO received_attribute
    FROM pg_attribute
   WHERE attrelid = 'whatsapp_cloud_events'::regclass AND attname = 'received_at' AND NOT attisdropped;

  IF existing_index IS NOT NULL THEN
    SELECT NOT index_row.indisunique
       AND index_row.indpred IS NULL
       AND index_row.indexprs IS NULL
       AND index_row.indnkeyatts = 2
       AND index_row.indkey::TEXT = pg_catalog.format('%s %s', empresa_attribute, received_attribute)
      INTO valid_index
      FROM pg_index AS index_row
     WHERE index_row.indexrelid = existing_index;
    IF NOT COALESCE(valid_index, FALSE) THEN
      EXECUTE 'DROP INDEX idx_whatsapp_cloud_events_empresa_received';
      existing_index := NULL;
    END IF;
  END IF;

  IF existing_index IS NULL THEN
    EXECUTE 'CREATE INDEX idx_whatsapp_cloud_events_empresa_received ON whatsapp_cloud_events (empresa_id, received_at)';
  END IF;
END $$;

DO $$
DECLARE
  existing_index REGCLASS := pg_catalog.to_regclass('idx_empresas_whatsapp_cloud_phone_number_id_unique');
  index_definition TEXT;
BEGIN
  LOCK TABLE empresas IN SHARE MODE;

  IF EXISTS (
    SELECT 1
      FROM empresas
     WHERE pg_catalog.jsonb_typeof(config_integraciones::jsonb) = 'object'
       AND config_integraciones::jsonb ? 'whatsapp'
       AND pg_catalog.jsonb_typeof((config_integraciones::jsonb)->'whatsapp') = 'object'
       AND pg_catalog.LOWER(pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'provider', ''))) = 'cloud'
       AND pg_catalog.jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
       AND CASE
             WHEN pg_catalog.jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
               THEN ((config_integraciones::jsonb)->'whatsapp'->>'enabled')::boolean
             ELSE FALSE
           END IS TRUE
       AND pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', '')) <> ''
       AND pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'access_token_encrypted', '')) <> ''
     GROUP BY pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', ''))
    HAVING pg_catalog.COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'WhatsApp Cloud phone_number_id normalizado duplicado; resolver asociaciones activas antes de migrar';
  END IF;

  IF existing_index IS NOT NULL THEN
    SELECT pg_catalog.pg_get_indexdef(existing_index) INTO index_definition;
    IF index_definition NOT LIKE 'CREATE UNIQUE INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique ON public.empresas USING btree %'
       OR index_definition NOT LIKE '%btrim(COALESCE%config_integraciones%jsonb%phone_number_id%'
       OR index_definition NOT LIKE '%jsonb_typeof%config_integraciones%object%'
       OR index_definition NOT LIKE '%? ''whatsapp''::text%'
       OR index_definition NOT LIKE '%jsonb_typeof%config_integraciones%-> ''whatsapp''::text%object%'
       OR index_definition NOT LIKE '%lower(btrim%provider%cloud%'
       OR index_definition NOT LIKE '%jsonb_typeof%config_integraciones%jsonb%enabled%boolean%'
       OR index_definition NOT LIKE '%::boolean%'
       OR index_definition NOT LIKE '%END IS TRUE%'
       OR index_definition NOT LIKE '%btrim%phone_number_id%<> ''''::text%'
       OR index_definition NOT LIKE '%btrim%access_token_encrypted%<> ''''::text%' THEN
      EXECUTE 'DROP INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique';
      existing_index := NULL;
    END IF;
  END IF;

  IF existing_index IS NULL THEN
    EXECUTE $index$
      CREATE UNIQUE INDEX idx_empresas_whatsapp_cloud_phone_number_id_unique
        ON empresas ((pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb #>> '{whatsapp,phone_number_id}'), ''))))
       WHERE pg_catalog.jsonb_typeof(config_integraciones::jsonb) = 'object'
         AND config_integraciones::jsonb ? 'whatsapp'
         AND pg_catalog.jsonb_typeof((config_integraciones::jsonb)->'whatsapp') = 'object'
         AND pg_catalog.LOWER(pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'provider', ''))) = 'cloud'
         AND pg_catalog.jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
         AND CASE
               WHEN pg_catalog.jsonb_typeof((config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
                 THEN ((config_integraciones::jsonb)->'whatsapp'->>'enabled')::boolean
               ELSE FALSE
             END IS TRUE
         AND pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', '')) <> ''
         AND pg_catalog.BTRIM(COALESCE((config_integraciones::jsonb)->'whatsapp'->>'access_token_encrypted', '')) <> ''
    $index$;
  END IF;
END $$;
COMMIT;
-- END WHATSAPP CLOUD INBOX MIGRATION

BEGIN;
SET LOCAL search_path = public;

-- =========================================================
-- 3. CONFIGURACIÓN, PROMPTS Y CUENTAS
-- =========================================================
CREATE TABLE IF NOT EXISTS configuracion (
  key   TEXT PRIMARY KEY,
  value JSONB
);

CREATE TABLE IF NOT EXISTS empresa_prompts (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL, 
  contenido   TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  UNIQUE(empresa_id, tipo)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_global_unique 
  ON empresa_prompts (tipo) 
  WHERE empresa_id IS NULL;

CREATE TABLE IF NOT EXISTS empresa_cuentas_bancarias (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  banco       TEXT,
  alias       TEXT,
  cbu         TEXT,
  titular     TEXT,
  tipo        TEXT DEFAULT 'cc', 
  activa      BOOLEAN DEFAULT TRUE,
  prioridad   INTEGER DEFAULT 1
);

-- Costos fijos de la empresa
CREATE TABLE IF NOT EXISTS empresa_costos_fijos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  monto       NUMERIC(10,2) DEFAULT 0,
  frecuencia  TEXT DEFAULT 'mensual', 
  created_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

-- =========================================================
-- 4. USUARIOS (Dashboard y Admin)
-- =========================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id               SERIAL PRIMARY KEY,
  username         TEXT NOT NULL,
  password         TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user',
  empresa_id       INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        INTEGER,
  referente_id     INTEGER,
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at    TIMESTAMPTZ,
  telefono         TEXT,
  es_invitado      BOOLEAN DEFAULT FALSE,
  fecha_expiracion TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT uq_usuarios_username UNIQUE (username)
);

-- Roles DB: limpiar datos históricos sin elevar privilegios y cerrar escrituras futuras.
COMMIT;
BEGIN;
SET LOCAL search_path = public;
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check;

UPDATE usuarios
SET role = 'user', activo = false
WHERE role IS NULL
   OR role NOT IN ('user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin', 'super');

-- Desactivar identidades cuyo rol no corresponde a su alcance de empresa.
UPDATE usuarios
SET activo = false
WHERE (role = 'super' AND empresa_id IS NOT NULL)
   OR (role IN ('user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin')
       AND (empresa_id IS NULL OR empresa_id <= 0));

ALTER TABLE usuarios ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE usuarios ALTER COLUMN role SET NOT NULL;

ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_role_check
  CHECK (role IS NOT NULL AND role IN ('user', 'repartidor', 'referente', 'facturacion', 'contable', 'admin', 'super'));
COMMIT;

BEGIN;
SET LOCAL search_path = public;

-- =========================================================
-- 5. CHOFERES Y LOGÍSTICA
-- =========================================================
CREATE TABLE IF NOT EXISTS choferes (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  telefono    TEXT,
  email       TEXT,
  activo      BOOLEAN DEFAULT TRUE,
  tipo        TEXT DEFAULT 'propio', 
  sla_horas   INTEGER DEFAULT 24,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

-- Zonas de reparto
CREATE TABLE IF NOT EXISTS zonas_geograficas (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  color       TEXT DEFAULT '#3388ff',
  dias_entrega JSONB DEFAULT '[]'::jsonb,
  poligono    TEXT,
  geom        GEOMETRY(Polygon, 4326),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

ALTER TABLE zonas_geograficas
  ADD COLUMN IF NOT EXISTS dias_entrega JSONB DEFAULT '[]'::jsonb;

-- Asignación Chofer <-> Zona
CREATE TABLE IF NOT EXISTS zona_chofer (
  zona_id    INTEGER REFERENCES zonas_geograficas(id) ON DELETE CASCADE,
  chofer_id  INTEGER REFERENCES choferes(id) ON DELETE CASCADE,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  PRIMARY KEY (zona_id, chofer_id)
);

-- Escalas de pago
CREATE TABLE IF NOT EXISTS chofer_escalas (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id      INTEGER REFERENCES choferes(id) ON DELETE SET NULL, 
  nombre         TEXT NOT NULL, 
  vigente_desde  DATE NOT NULL,
  vigente_hasta  DATE,
  notas          TEXT,
  created_at     TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS chofer_escala_tramos (
  id         SERIAL PRIMARY KEY,
  escala_id  INTEGER NOT NULL REFERENCES chofer_escalas(id) ON DELETE CASCADE,
  rango_min  INTEGER NOT NULL,
  rango_max  INTEGER, 
  monto      NUMERIC(10,2) NOT NULL
);

-- =========================================================
-- 6. CLIENTES Y PUNTOS DE ENTREGA
-- =========================================================

CREATE TABLE IF NOT EXISTS puntos_entrega (
  id                   SERIAL PRIMARY KEY,
  empresa_id           INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente              TEXT NOT NULL,
  nombre               TEXT,
  direccion            TEXT,
  direccion_completa   TEXT,
  ciudad               TEXT,
  provincia            TEXT,
  pais                 TEXT,
  telefono             TEXT,
  telefono_normalizado TEXT,
  email                TEXT,
  email_facturacion    TEXT,
  requiere_factura     BOOLEAN DEFAULT FALSE,
  zona_id              INTEGER REFERENCES zonas_geograficas(id) ON DELETE SET NULL,
  latitud              NUMERIC,
  longitud             NUMERIC,
  geom                 GEOMETRY(Point, 4326),
  notas                TEXT,
  razon_social         TEXT,
  cuit                 TEXT,
  condicion_iva        TEXT,
  frecuencia           INTEGER DEFAULT 7,
  ultima_visita        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

ALTER TABLE puntos_entrega
  ADD COLUMN IF NOT EXISTS crm_estado TEXT DEFAULT 'activo',
  ADD COLUMN IF NOT EXISTS crm_segmento TEXT,
  ADD COLUMN IF NOT EXISTS crm_riesgo TEXT DEFAULT 'bajo',
  ADD COLUMN IF NOT EXISTS crm_motivo TEXT,
  ADD COLUMN IF NOT EXISTS crm_ticket_objetivo NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS crm_proxima_accion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crm_ultima_accion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cuenta_corriente_habilitada BOOLEAN DEFAULT FALSE;

-- =========================================================
-- 7. PRODUCTOS Y STOCK (La Base Fundamental)
-- =========================================================

CREATE TABLE IF NOT EXISTS productos (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre              TEXT NOT NULL,
  descripcion         TEXT,
  precio              NUMERIC(10,2) DEFAULT 0,
  stock_min           INTEGER DEFAULT 0,
  stock_max           INTEGER DEFAULT 0,
  activo              BOOLEAN DEFAULT TRUE,
  imagen              TEXT,
  imagen_2            TEXT,
  imagen_3            TEXT,
  categoria           TEXT,
  orden               INTEGER DEFAULT 0,
  etiqueta            TEXT, 
  imagen_promo        TEXT,
  destacado           BOOLEAN DEFAULT FALSE,
  mostrar_en_catalogo BOOLEAN DEFAULT TRUE,
  mostrar_en_landing  BOOLEAN DEFAULT FALSE,
  config_activo       JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

-- Alteraciones y columnas extra de productos
ALTER TABLE productos 
    ADD COLUMN IF NOT EXISTS comportamiento TEXT DEFAULT 'simple',
    ADD COLUMN IF NOT EXISTS unidad_medida TEXT DEFAULT 'unidad',
    ADD COLUMN IF NOT EXISTS requiere_activo_vacio BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS retornable BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS stock_infinito BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS margen_meta NUMERIC(5,2) DEFAULT 30,
    ADD COLUMN IF NOT EXISTS sku TEXT,
    ADD COLUMN IF NOT EXISTS external_id TEXT,
    ADD COLUMN IF NOT EXISTS created_by INTEGER,
    ADD COLUMN IF NOT EXISTS updated_by INTEGER,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by INTEGER,
    ADD COLUMN IF NOT EXISTS promo_config JSONB,
    ADD COLUMN IF NOT EXISTS imagen_2 TEXT,
    ADD COLUMN IF NOT EXISTS imagen_3 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS productos_empresa_sku_uniq
  ON productos (empresa_id, pg_catalog.lower(sku))
  WHERE sku IS NOT NULL AND pg_catalog.btrim(sku) <> '' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS productos_empresa_external_id_uniq
  ON productos (empresa_id, external_id)
  WHERE external_id IS NOT NULL AND pg_catalog.btrim(external_id) <> '' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS productos_empresa_deleted_idx
  ON productos (empresa_id, deleted_at);

-- =========================================================
-- 8. VARIABLES DE COSTO Y STOCK (DEPENDEN DE PRODUCTOS)
-- =========================================================

-- 1) Definición de variables (Servicio técnico, Marketing, etc.)
CREATE TABLE IF NOT EXISTS empresa_costos_variables_def (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  codigo       TEXT,
  tipo_calculo TEXT NOT NULL DEFAULT 'unitario', 
  orden        INTEGER DEFAULT 0,
  activo       BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at   TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS empresa_costos_variables_def_empresa_codigo_idx
  ON empresa_costos_variables_def (empresa_id, pg_catalog.lower(codigo))
  WHERE codigo IS NOT NULL AND pg_catalog.btrim(codigo) <> '';

CREATE INDEX IF NOT EXISTS empresa_costos_variables_def_empresa_idx
  ON empresa_costos_variables_def (empresa_id, activo, orden);

-- 2) Aplicación de variables
CREATE TABLE IF NOT EXISTS empresa_costos_variables_aplicacion (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  variable_id  INTEGER NOT NULL REFERENCES empresa_costos_variables_def(id) ON DELETE CASCADE,
  nivel        TEXT NOT NULL DEFAULT 'producto', 
  
  producto_id  INTEGER REFERENCES productos(id) ON DELETE CASCADE,
  
  categoria    TEXT,
  etiqueta     TEXT,
  valor        NUMERIC(10,2) NOT NULL DEFAULT 0,
  activo       BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS empresa_costos_variables_aplicacion_empresa_idx
  ON empresa_costos_variables_aplicacion (empresa_id, variable_id, nivel);

CREATE INDEX IF NOT EXISTS empresa_costos_variables_aplicacion_producto_idx
  ON empresa_costos_variables_aplicacion (empresa_id, producto_id, activo);

-- Costos base y Preferencias
CREATE TABLE IF NOT EXISTS empresa_productos_costos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  costo_base  NUMERIC(10,2) DEFAULT 0,
  proveedor   TEXT,
  updated_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  UNIQUE(empresa_id, producto_id)
);

ALTER TABLE empresa_productos_costos 
  ADD COLUMN IF NOT EXISTS costo_packaging NUMERIC(10,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS producto_prefs (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  producto_id      INTEGER REFERENCES productos(id) ON DELETE CASCADE,
  cantidad_usual   INTEGER DEFAULT 1,
  observaciones    TEXT,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

-- Stock físico (Inventario móvil)
CREATE TABLE IF NOT EXISTS chofer_stock (
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id   INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  cantidad    NUMERIC(10,2) DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  PRIMARY KEY (empresa_id, chofer_id, producto_id)
);

CREATE TABLE IF NOT EXISTS chofer_stock_mov (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id   INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  deposito_id INTEGER,
  gasto_id    INTEGER,
  fecha       TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  tipo        TEXT NOT NULL, 
  cantidad    NUMERIC(10,2) NOT NULL,
  motivo      TEXT,
  referencia  TEXT, 
  created_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

ALTER TABLE chofer_stock_mov ADD COLUMN IF NOT EXISTS gasto_id INTEGER;

CREATE TABLE IF NOT EXISTS depositos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  direccion   TEXT,
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  UNIQUE (empresa_id, nombre)
);

CREATE TABLE IF NOT EXISTS deposito_chofer (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE CASCADE,
  chofer_id   INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  UNIQUE (empresa_id, deposito_id, chofer_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_chofer_stock_mov_deposito'
  ) THEN
    ALTER TABLE chofer_stock_mov
      ADD CONSTRAINT fk_chofer_stock_mov_deposito
      FOREIGN KEY (deposito_id) REFERENCES depositos(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chofer_costos (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id      INTEGER NOT NULL REFERENCES choferes(id) ON DELETE CASCADE,
  producto_id    INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  costo_unitario NUMERIC(10,2) NOT NULL,
  UNIQUE(empresa_id, chofer_id, producto_id)
);

-- =========================================================
-- 9. PEDIDOS (CORE)
-- =========================================================
CREATE TABLE IF NOT EXISTS pedidos (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id   INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  chofer_id          INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  zona_id            INTEGER REFERENCES zonas_geograficas(id) ON DELETE SET NULL,
  estado             TEXT DEFAULT 'pendiente', 
  metodo_pago        TEXT DEFAULT 'efectivo',
  monto              NUMERIC(10,2) DEFAULT 0,
  fecha              TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  fecha_entrega_estimada DATE,
  fecha_entrega      TIMESTAMPTZ,
  tracking_token     TEXT, 
  cantidad_entregada NUMERIC DEFAULT 0,
  origen             TEXT DEFAULT 'manual',
  cantidad           NUMERIC DEFAULT 0,
  submission_id      TEXT,
  aviso_recibido     INTEGER DEFAULT 0,
  sats               INTEGER DEFAULT 0,
  referido_por_id    INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  validado           BOOLEAN DEFAULT FALSE,
  notas              TEXT,
  latitud            NUMERIC,
  longitud           NUMERIC,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS en_ruta_notificado_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fecha_entrega_estimada DATE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_empresa_submission_id_uniq
  ON pedidos (empresa_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS items_pedido (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto        TEXT NOT NULL,
  producto_id     INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  cantidad        NUMERIC DEFAULT 1,
  precio_unitario NUMERIC(10,2) DEFAULT 0
);

-- =========================================================
-- 9.b REFERENTES Y COMISIONES
-- =========================================================
CREATE TABLE IF NOT EXISTS referentes (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre                 TEXT NOT NULL,
  telefono               TEXT,
  email                  TEXT,
  direccion              TEXT,
  codigo                 TEXT NOT NULL,
  porcentaje_comision    NUMERIC(5,2) NOT NULL DEFAULT 0,
  vigente_desde          DATE,
  vigente_hasta          DATE,
  activo                 BOOLEAN NOT NULL DEFAULT TRUE,
  notas                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  deleted_at             TIMESTAMPTZ
);

-- Identity-link quarantine: run only after choferes and referentes exist.
COMMIT;
BEGIN;
SET LOCAL search_path = public;
UPDATE usuarios u
SET activo = false
WHERE CASE
  WHEN u.role = 'repartidor' THEN
    u.chofer_id IS NULL OR u.chofer_id <= 0 OR u.referente_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM choferes c
      WHERE c.id = u.chofer_id AND c.empresa_id = u.empresa_id AND c.activo IS TRUE
    )
  WHEN u.role = 'referente' THEN
    u.referente_id IS NULL OR u.referente_id <= 0 OR u.chofer_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM referentes r
      WHERE r.id = u.referente_id AND r.empresa_id = u.empresa_id
        AND r.activo IS TRUE AND r.deleted_at IS NULL
    )
  ELSE u.chofer_id IS NOT NULL OR u.referente_id IS NOT NULL
END;
COMMIT;

BEGIN;
SET LOCAL search_path = public;

CREATE UNIQUE INDEX IF NOT EXISTS referentes_empresa_codigo_uniq
  ON referentes (empresa_id, pg_catalog.LOWER(codigo))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS referentes_empresa_activo_idx
  ON referentes (empresa_id, activo, created_at DESC);

CREATE TABLE IF NOT EXISTS referente_productos (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  producto_id            INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  porcentaje_comision    NUMERIC(5,2),
  vigente_desde          DATE,
  vigente_hasta          DATE,
  activo                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  UNIQUE(referente_id, producto_id)
);

CREATE INDEX IF NOT EXISTS referente_productos_empresa_idx
  ON referente_productos (empresa_id, referente_id, activo);

CREATE TABLE IF NOT EXISTS cliente_referentes (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id       INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  codigo_referente       TEXT,
  estado                 TEXT NOT NULL DEFAULT 'activo',
  asociado_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  desvinculado_at        TIMESTAMPTZ,
  desvinculado_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  desvinculado_motivo    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS cliente_referentes_un_activo_uniq
  ON cliente_referentes (empresa_id, punto_entrega_id)
  WHERE estado = 'activo';

CREATE INDEX IF NOT EXISTS cliente_referentes_referente_idx
  ON cliente_referentes (empresa_id, referente_id, estado);

CREATE TABLE IF NOT EXISTS referente_clientes_propuestos (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  cliente                TEXT NOT NULL,
  telefono               TEXT,
  direccion              TEXT,
  ciudad                 TEXT,
  provincia              TEXT,
  pais                   TEXT,
  email                  TEXT,
  notas                  TEXT,
  estado                 TEXT NOT NULL DEFAULT 'pendiente',
  punto_entrega_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  reviewed_at            TIMESTAMPTZ,
  reviewed_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  rechazo_motivo         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_empresa_estado_idx
  ON referente_clientes_propuestos (empresa_id, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS referente_clientes_propuestos_referente_idx
  ON referente_clientes_propuestos (empresa_id, referente_id, estado);

CREATE TABLE IF NOT EXISTS referente_comisiones (
  id                    SERIAL PRIMARY KEY,
  empresa_id             INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id           INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  punto_entrega_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  pedido_id              INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  item_pedido_id         INTEGER NOT NULL REFERENCES items_pedido(id) ON DELETE CASCADE,
  producto_id            INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  base_monto             NUMERIC(12,2) NOT NULL DEFAULT 0,
  porcentaje             NUMERIC(5,2) NOT NULL DEFAULT 0,
  monto_comision         NUMERIC(12,2) NOT NULL DEFAULT 0,
  estado                 TEXT NOT NULL DEFAULT 'validada',
  validada_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  liquidada_at           TIMESTAMPTZ,
  liquidacion_referencia TEXT,
  liquidacion_nota       TEXT,
  liquidada_por          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  UNIQUE(pedido_id, item_pedido_id, referente_id)
);

CREATE INDEX IF NOT EXISTS referente_comisiones_empresa_estado_idx
  ON referente_comisiones (empresa_id, estado, validada_at DESC);

CREATE TABLE IF NOT EXISTS referente_notificaciones (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  referente_id   INTEGER NOT NULL REFERENCES referentes(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL,
  titulo         TEXT NOT NULL,
  mensaje        TEXT NOT NULL,
  pedido_id      INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  comision_id    INTEGER REFERENCES referente_comisiones(id) ON DELETE SET NULL,
  leida_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS referente_notificaciones_ref_idx
  ON referente_notificaciones (empresa_id, referente_id, leida_at, created_at DESC);

CREATE TABLE IF NOT EXISTS pedido_track_points (
  id         SERIAL PRIMARY KEY,
  pedido_id  INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  latitud    NUMERIC,
  longitud   NUMERIC,
  timestamp  TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  source     TEXT DEFAULT 'gps',
  precision  NUMERIC,
  speed      NUMERIC,
  heading    NUMERIC
);

-- =========================================================
-- 10. RECOMPENSAS
-- =========================================================
CREATE TABLE IF NOT EXISTS cliente_recompensas (
  id               SERIAL PRIMARY KEY,
  cliente_id       INTEGER REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  producto_id      INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  cantidad         INTEGER DEFAULT 1,
  reclamado        BOOLEAN DEFAULT FALSE,
  fecha_ganado     TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  fecha_reclamado  TIMESTAMPTZ,
  origen_pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS promociones_redenciones (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id   INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  trigger_producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  beneficio_tipo     TEXT NOT NULL,
  beneficio_producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  pedido_id          INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_redencion_once_idx
  ON promociones_redenciones (empresa_id, punto_entrega_id, trigger_producto_id, beneficio_tipo)
  WHERE beneficio_tipo = 'gift_once_per_product';

CREATE UNIQUE INDEX IF NOT EXISTS promo_redencion_once_global_idx
  ON promociones_redenciones (empresa_id, punto_entrega_id, beneficio_tipo)
  WHERE beneficio_tipo = 'gift_once_global';

CREATE TABLE IF NOT EXISTS promociones_config (
  empresa_id    INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  points_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  promos_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS juegos_campanias (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  slug                  TEXT NOT NULL,
  public_code           TEXT,
  nombre                TEXT NOT NULL,
  titulo_publico        TEXT NOT NULL,
  descripcion_publica   TEXT,
  tipo_juego            TEXT NOT NULL DEFAULT 'raspadita',
  estado                TEXT NOT NULL DEFAULT 'borrador',
  participacion_limite  TEXT NOT NULL DEFAULT 'once',
  max_participaciones   INTEGER,
  max_ganadores         INTEGER,
  codigo_prefijo        TEXT DEFAULT 'PV',
  whatsapp_mensaje      TEXT,
  bases_condiciones     TEXT,
  valid_from            TIMESTAMPTZ,
  valid_to              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  UNIQUE (empresa_id, slug)
);

CREATE TABLE IF NOT EXISTS juegos_premios (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campania_id     INTEGER NOT NULL REFERENCES juegos_campanias(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  producto_id     INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  nombre_publico  TEXT NOT NULL,
  descripcion     TEXT,
  valor           NUMERIC(12,2),
  probabilidad    INTEGER NOT NULL DEFAULT 1,
  stock_total     INTEGER,
  stock_diario    INTEGER,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  orden           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS juegos_participaciones (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campania_id         INTEGER NOT NULL REFERENCES juegos_campanias(id) ON DELETE CASCADE,
  premio_id           INTEGER REFERENCES juegos_premios(id) ON DELETE SET NULL,
  producto_id         INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  punto_entrega_id    INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  pedido_id           INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  telefono            TEXT NOT NULL,
  telefono_norm       TEXT NOT NULL,
  codigo              TEXT,
  resultado_tipo      TEXT NOT NULL,
  resultado_nombre    TEXT NOT NULL,
  ip_hash             TEXT,
  user_agent          TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  enviado_whatsapp_at TIMESTAMPTZ,
  redimido_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS juegos_campanias_empresa_estado_idx
  ON juegos_campanias (empresa_id, estado, valid_from, valid_to);

ALTER TABLE juegos_campanias
  ADD COLUMN IF NOT EXISTS public_code TEXT;

UPDATE juegos_campanias
   SET public_code = pg_catalog.UPPER(pg_catalog.SUBSTRING(pg_catalog.MD5(empresa_id::text || ':' || slug || ':' || id::text), 1, 10))
 WHERE public_code IS NULL OR pg_catalog.BTRIM(public_code) = '';

ALTER TABLE juegos_campanias
  ALTER COLUMN public_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS juegos_campanias_public_code_uniq
  ON juegos_campanias (pg_catalog.LOWER(public_code));

CREATE INDEX IF NOT EXISTS juegos_premios_campania_idx
  ON juegos_premios (campania_id, activo, orden);

CREATE INDEX IF NOT EXISTS juegos_participaciones_campania_tel_idx
  ON juegos_participaciones (campania_id, telefono_norm, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS juegos_participaciones_codigo_uniq
  ON juegos_participaciones (codigo)
  WHERE codigo IS NOT NULL;

ALTER TABLE juegos_participaciones
  ADD COLUMN IF NOT EXISTS punto_entrega_id INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS puntos_movimientos (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  tipo             TEXT NOT NULL,
  puntos           INTEGER NOT NULL,
  detalle          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS puntos_movimientos_empresa_cliente_idx
  ON puntos_movimientos (empresa_id, punto_entrega_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS puntos_movimientos_entrega_uniq
  ON puntos_movimientos (empresa_id, pedido_id, tipo)
  WHERE pedido_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entregas_evidencias (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id   INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
  chofer_id   INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  checklist   JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidencia   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

-- =========================================================
-- 11. FINANZAS Y GASTOS
-- =========================================================
CREATE TABLE IF NOT EXISTS gastos_repartidor (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  fecha            DATE NOT NULL,
  tipo             TEXT NOT NULL, 
  descripcion      TEXT,
  monto            NUMERIC(10,2) DEFAULT 0,
  comprobante_path TEXT,
  cantidad         NUMERIC,
  producto_id      INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

-- Saldos de envases/retornables por cliente y producto.
CREATE TABLE IF NOT EXISTS cliente_retornables_saldos (
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id  INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  producto_id       INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  saldo             NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  PRIMARY KEY (empresa_id, punto_entrega_id, producto_id)
);

CREATE TABLE IF NOT EXISTS cliente_retornables_movimientos (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id  INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  pedido_id         INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  chofer_id         INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  producto_id       INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  entregados        NUMERIC(12,2) NOT NULL DEFAULT 0,
  devueltos         NUMERIC(12,2) NOT NULL DEFAULT 0,
  delta             NUMERIC(12,2) NOT NULL DEFAULT 0,
  saldo_resultante  NUMERIC(12,2),
  observacion       TEXT,
  fecha             TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_cliente
  ON cliente_retornables_movimientos (empresa_id, punto_entrega_id, producto_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_cliente_retornables_mov_pedido
  ON cliente_retornables_movimientos (pedido_id);

-- CRM comercial: pipeline de oportunidades
CREATE TABLE IF NOT EXISTS crm_oportunidades (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id          INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  nombre              TEXT NOT NULL,
  rubro               TEXT,
  canal               TEXT,
  etapa               TEXT NOT NULL DEFAULT 'prospecto',
  probabilidad        INTEGER DEFAULT 20,
  monto_estimado      NUMERIC(12,2) DEFAULT 0,
  fecha_cierre_estimada DATE,
  origen              TEXT,
  proxima_accion      TIMESTAMPTZ,
  responsable_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  notas               TEXT,
  perdida_motivo      TEXT,
  estado              TEXT NOT NULL DEFAULT 'abierta',
  created_at          TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at          TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_etapa_idx
  ON crm_oportunidades (empresa_id, etapa, estado);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_prox_accion_idx
  ON crm_oportunidades (empresa_id, proxima_accion);

CREATE TABLE IF NOT EXISTS crm_oportunidad_actividades (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  oportunidad_id   INTEGER NOT NULL REFERENCES crm_oportunidades(id) ON DELETE CASCADE,
  tipo             TEXT NOT NULL DEFAULT 'nota',
  descripcion      TEXT,
  usuario_id       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha_programada TIMESTAMPTZ,
  completada       BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS crm_oportunidad_actividades_empresa_idx
  ON crm_oportunidad_actividades (empresa_id, oportunidad_id, created_at DESC);

-- Cuenta corriente por cliente (debe/haber + saldo)
CREATE TABLE IF NOT EXISTS cliente_cta_corriente_mov (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id       INTEGER NOT NULL REFERENCES puntos_entrega(id) ON DELETE CASCADE,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  tipo             TEXT NOT NULL,
  concepto         TEXT,
  debe             NUMERIC(12,2) DEFAULT 0,
  haber            NUMERIC(12,2) DEFAULT 0,
  fecha            TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  vencimiento      TIMESTAMPTZ,
  estado           TEXT DEFAULT 'pendiente',
  referencia       TEXT,
  usuario_id       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS cliente_cta_corriente_empresa_cliente_idx
  ON cliente_cta_corriente_mov (empresa_id, cliente_id, fecha DESC);
CREATE INDEX IF NOT EXISTS cliente_cta_corriente_empresa_estado_idx
  ON cliente_cta_corriente_mov (empresa_id, estado, vencimiento);

CREATE TABLE IF NOT EXISTS transferencias (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  fecha            TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  monto            NUMERIC(10,2) NOT NULL,
  metodo_pago      TEXT DEFAULT 'transferencia',
  referencia       TEXT,
  comprobante_path TEXT,
  estado           TEXT DEFAULT 'verificado', 
  tipo             TEXT DEFAULT 'cobro',      
  notas            TEXT,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS comprobantes_transferencia (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER REFERENCES empresas(id) ON DELETE CASCADE, 
  chofer_id        INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  zona_id          INTEGER REFERENCES zonas_geograficas(id) ON DELETE SET NULL,
  fecha            TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  monto            NUMERIC(10,2),
  metodo_pago      TEXT,
  comentario       TEXT,
  archivo_path     TEXT, 
  comprobante_path TEXT, 
  banco_origen     TEXT,
  nro_operacion    TEXT,
  telefono         TEXT,                      
  validado         INTEGER DEFAULT 0,
  procesado        BOOLEAN DEFAULT FALSE,     
  fecha_procesado  TIMESTAMPTZ,
  banco_destino    TEXT,
  alias_destino    TEXT,
  cbu_destino      TEXT,
  titular_destino  TEXT,
  cuenta_bancaria_id INTEGER REFERENCES empresa_cuentas_bancarias(id) ON DELETE SET NULL,
  cuenta_bancaria_confianza INTEGER DEFAULT 0,
  cuenta_bancaria_match_fuente TEXT,
  cuenta_bancaria_match_detalle TEXT,
  file_hash        TEXT,
  source_message_id TEXT,
  dedupe_file_hash TEXT,
  approval_dedupe_key TEXT,
  source_chat_jid  TEXT,
  transport_origin TEXT,
  estado_revision  TEXT DEFAULT 'pendiente',
  riesgo_score     INTEGER DEFAULT 0,
  riesgo_flags     TEXT,
  verified_by      INTEGER,
  verified_reason  TEXT,
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at       TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

ALTER TABLE comprobantes_transferencia
  ADD COLUMN IF NOT EXISTS source_message_id TEXT,
  ADD COLUMN IF NOT EXISTS dedupe_file_hash TEXT,
  ADD COLUMN IF NOT EXISTS approval_dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS source_chat_jid TEXT,
  ADD COLUMN IF NOT EXISTS transport_origin TEXT;


CREATE TABLE IF NOT EXISTS pedido_pagos (
  id                  SERIAL PRIMARY KEY,

  -- Relaciones
  empresa_id          INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id           INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  cliente_id          INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  chofer_id           INT REFERENCES choferes(id) ON DELETE SET NULL,

  -- Negocio
  metodo_pago         TEXT,                               -- 'transferencia', 'qr_mp', etc.
  canal               TEXT,                               -- 'repartidor', 'whatsapp', 'admin_panel'
  descripcion         TEXT,
  notas               TEXT,

  -- Proveedor de pagos
  proveedor           TEXT NOT NULL,                      -- 'mercado_pago', 'banco_x', etc.
  provider_payment_id TEXT,                               -- id de la operación en el proveedor
  provider_order_id   TEXT,                               -- preference/order id si aplica
  provider_status     TEXT,                               -- estado textual del proveedor
  provider_fee        NUMERIC(12,2),                      -- comisión cobrada
  provider_net_amount NUMERIC(12,2),                      -- monto neto acreditado
  provider_payload    JSONB,                              -- respuesta cruda (limpia)

  -- Estado interno
  estado              TEXT NOT NULL DEFAULT 'pendiente',  -- 'pendiente', 'pagado', 'vencido', 'cancelado', 'error'
  monto               NUMERIC(12,2) NOT NULL,
  moneda              TEXT NOT NULL DEFAULT 'ARS',
  checkout_url        TEXT,
  qr_payload          TEXT,
  vence_at            TIMESTAMPTZ,
  settlement_at       TIMESTAMPTZ,                        -- acreditación real

  -- Conciliación
  conciliado          BOOLEAN NOT NULL DEFAULT FALSE,
  conciliado_por      INT,
  conciliado_en       TIMESTAMPTZ,

  -- Flex
  metadata            JSONB DEFAULT '{}'::jsonb,

  created_at          TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at          TIMESTAMPTZ DEFAULT pg_catalog.NOW(),

  CONSTRAINT uq_pedido_pagos_pedido_proveedor UNIQUE (pedido_id, proveedor)
);

-- BEGIN COMPROBANTE CONCURRENCY MIGRATION
COMMIT;
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
CREATE OR REPLACE FUNCTION public.normalizar_comprobante_operacion(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(pg_catalog.LOWER(pg_catalog.BTRIM(value)), '')
$$;

CREATE TABLE IF NOT EXISTS comprobante_operacion_claims (
  tenant_key BIGINT NOT NULL,
  operacion_key TEXT NOT NULL,
  comprobante_id BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  PRIMARY KEY (tenant_key, operacion_key)
);

CREATE TABLE IF NOT EXISTS comprobante_pedido_aprobado_claims (
  tenant_key BIGINT NOT NULL,
  pedido_id BIGINT NOT NULL,
  comprobante_id BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  PRIMARY KEY (tenant_key, pedido_id)
);

-- El lock evita que un writer se interponga entre el seed legacy y la instalación
-- del trigger. Los duplicados históricos se reducen al id canónico menor.
LOCK TABLE comprobantes_transferencia IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO comprobante_operacion_claims (tenant_key, operacion_key, comprobante_id)
SELECT COALESCE(empresa_id, 0)::BIGINT,
       public.normalizar_comprobante_operacion(nro_operacion),
       pg_catalog.MIN(id)::BIGINT
FROM comprobantes_transferencia
WHERE public.normalizar_comprobante_operacion(nro_operacion) IS NOT NULL
GROUP BY COALESCE(empresa_id, 0)::BIGINT,
         public.normalizar_comprobante_operacion(nro_operacion)
ON CONFLICT (tenant_key, operacion_key) DO NOTHING;

INSERT INTO comprobante_pedido_aprobado_claims (tenant_key, pedido_id, comprobante_id)
SELECT COALESCE(empresa_id, 0)::BIGINT, pedido_id::BIGINT, pg_catalog.MIN(id)::BIGINT
FROM comprobantes_transferencia
WHERE pedido_id IS NOT NULL
  AND (COALESCE(validado, 0) = 1 OR COALESCE(procesado, FALSE) = TRUE
       OR pg_catalog.LOWER(COALESCE(estado_revision, '')) = 'aprobado')
GROUP BY COALESCE(empresa_id, 0)::BIGINT, pedido_id::BIGINT
ON CONFLICT (tenant_key, pedido_id) DO NOTHING;

-- Los aprobados legacy no canónicos quedan en revisión; el claim no se libera.
UPDATE comprobantes_transferencia ct
SET validado = 0, procesado = FALSE, estado_revision = 'en_revision',
    riesgo_flags = pg_catalog.CONCAT_WS(',', NULLIF(ct.riesgo_flags, ''), 'legacy_aprobado_no_canonico'),
    verified_reason = 'legacy_aprobado_no_canonico', updated_at = pg_catalog.NOW()
FROM comprobante_pedido_aprobado_claims claim
WHERE claim.tenant_key = COALESCE(ct.empresa_id, 0)::BIGINT
  AND claim.pedido_id = ct.pedido_id::BIGINT
  AND claim.comprobante_id <> ct.id::BIGINT
  AND (COALESCE(ct.validado, 0) = 1 OR COALESCE(ct.procesado, FALSE) = TRUE
       OR pg_catalog.LOWER(COALESCE(ct.estado_revision, '')) = 'aprobado');

CREATE OR REPLACE FUNCTION public.reclamar_comprobante_operacion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_tenant BIGINT := COALESCE(NEW.empresa_id, 0)::BIGINT;
  new_key TEXT := public.normalizar_comprobante_operacion(NEW.nro_operacion);
  old_tenant BIGINT;
  old_key TEXT;
  owner_id BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_tenant := COALESCE(OLD.empresa_id, 0)::BIGINT;
    old_key := public.normalizar_comprobante_operacion(OLD.nro_operacion);
    -- Compatibilidad: tocar una fila legacy duplicada sin cambiar su clave sigue permitido.
    IF old_tenant IS NOT DISTINCT FROM new_tenant
       AND old_key IS NOT DISTINCT FROM new_key THEN
      RETURN NEW;
    END IF;
  END IF;

  IF new_key IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO comprobante_operacion_claims (tenant_key, operacion_key, comprobante_id)
  VALUES (new_tenant, new_key, NEW.id)
  ON CONFLICT (tenant_key, operacion_key) DO NOTHING;

  SELECT comprobante_id INTO owner_id
  FROM comprobante_operacion_claims
  WHERE tenant_key = new_tenant AND operacion_key = new_key;

  IF owner_id IS DISTINCT FROM NEW.id::BIGINT THEN
    RAISE EXCEPTION 'operación de comprobante ya reclamada para tenant %', new_tenant
      USING ERRCODE = '23505', CONSTRAINT = 'comprobante_operacion_claims_pkey';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_reclamar_comprobante_operacion ON comprobantes_transferencia;
CREATE TRIGGER trg_reclamar_comprobante_operacion
BEFORE INSERT OR UPDATE OF nro_operacion, empresa_id
ON comprobantes_transferencia
FOR EACH ROW EXECUTE FUNCTION public.reclamar_comprobante_operacion();

CREATE OR REPLACE FUNCTION public.validar_aprobacion_comprobante()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_approved BOOLEAN := pg_catalog.LOWER(COALESCE(NEW.estado_revision, '')) = 'aprobado'
    OR COALESCE(NEW.validado, 0) = 1 OR COALESCE(NEW.procesado, FALSE) = TRUE;
  parent_empresa_id INTEGER;
  owner_id BIGINT;
BEGIN
  IF NOT new_approved THEN
    RETURN NEW;
  END IF;

  IF NEW.pedido_id IS NULL THEN
    RAISE EXCEPTION 'un comprobante aprobado requiere pedido'
      USING ERRCODE = '23514', CONSTRAINT = 'ct_approved_order_tenant';
  END IF;

  SELECT empresa_id INTO parent_empresa_id
  FROM pedidos WHERE id = NEW.pedido_id FOR UPDATE;
  IF parent_empresa_id IS NULL OR parent_empresa_id IS DISTINCT FROM NEW.empresa_id THEN
    RAISE EXCEPTION 'pedido y comprobante pertenecen a tenants distintos'
      USING ERRCODE = '23514', CONSTRAINT = 'ct_approved_order_tenant';
  END IF;

  IF public.normalizar_comprobante_operacion(NEW.nro_operacion) IS NULL OR NOT EXISTS (
    SELECT 1 FROM comprobante_operacion_claims claim
    WHERE claim.tenant_key = COALESCE(NEW.empresa_id, 0)::BIGINT
      AND claim.operacion_key = public.normalizar_comprobante_operacion(NEW.nro_operacion)
      AND claim.comprobante_id = NEW.id::BIGINT
  ) THEN
    RAISE EXCEPTION 'el comprobante no es propietario de la operación reclamada'
      USING ERRCODE = '23505', CONSTRAINT = 'comprobante_operacion_claims_pkey';
  END IF;

  INSERT INTO comprobante_pedido_aprobado_claims (tenant_key, pedido_id, comprobante_id)
  VALUES (NEW.empresa_id::BIGINT, NEW.pedido_id::BIGINT, NEW.id::BIGINT)
  ON CONFLICT (tenant_key, pedido_id) DO NOTHING;
  SELECT comprobante_id INTO owner_id
  FROM comprobante_pedido_aprobado_claims
  WHERE tenant_key = NEW.empresa_id::BIGINT AND pedido_id = NEW.pedido_id::BIGINT;
  IF owner_id IS DISTINCT FROM NEW.id::BIGINT THEN
    RAISE EXCEPTION 'el pedido ya posee otro comprobante aprobado'
      USING ERRCODE = '23505', CONSTRAINT = 'ct_one_approved_per_order';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validar_aprobacion_comprobante ON comprobantes_transferencia;
CREATE TRIGGER trg_validar_aprobacion_comprobante
BEFORE INSERT OR UPDATE ON comprobantes_transferencia
FOR EACH ROW EXECUTE FUNCTION public.validar_aprobacion_comprobante();

CREATE OR REPLACE FUNCTION public.serializar_pedido_pago_con_comprobante()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_pedido_id INTEGER;
  target_empresa_id INTEGER;
  parent_empresa_id INTEGER;
  old_acreditado BOOLEAN := FALSE;
  new_acreditado BOOLEAN := FALSE;
  introduce_acreditacion BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_pedido_id := OLD.pedido_id;
    target_empresa_id := OLD.empresa_id;
    SELECT empresa_id INTO parent_empresa_id
      FROM pedidos WHERE id = target_pedido_id FOR UPDATE;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    target_pedido_id := NEW.pedido_id;
    target_empresa_id := NEW.empresa_id;
    introduce_acreditacion := TRUE;
  ELSE
    -- Si cambia de padre, ambos se bloquean siempre en orden para evitar deadlocks.
    PERFORM 1 FROM pedidos
      WHERE id IN (OLD.pedido_id, NEW.pedido_id)
      ORDER BY id
      FOR UPDATE;
    target_pedido_id := NEW.pedido_id;
    target_empresa_id := NEW.empresa_id;
    old_acreditado := OLD.settlement_at IS NOT NULL
      OR pg_catalog.LOWER(COALESCE(OLD.estado, '')) IN ('pagado', 'aprobado', 'acreditado');
    introduce_acreditacion := NOT old_acreditado
      OR OLD.pedido_id IS DISTINCT FROM NEW.pedido_id
      OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    SELECT empresa_id INTO parent_empresa_id
      FROM pedidos WHERE id = target_pedido_id FOR UPDATE;
  ELSE
    SELECT empresa_id INTO parent_empresa_id
      FROM pedidos WHERE id = target_pedido_id;
  END IF;

  IF parent_empresa_id IS NULL OR parent_empresa_id IS DISTINCT FROM target_empresa_id THEN
    RAISE EXCEPTION 'pedido y pago pertenecen a tenants distintos'
      USING ERRCODE = '23514';
  END IF;

  new_acreditado := NEW.settlement_at IS NOT NULL
    OR pg_catalog.LOWER(COALESCE(NEW.estado, '')) IN ('pagado', 'aprobado', 'acreditado');

  IF new_acreditado AND introduce_acreditacion
     AND EXISTS (
       SELECT 1 FROM comprobantes_transferencia ct
       WHERE ct.pedido_id = target_pedido_id
         AND COALESCE(ct.empresa_id, 0) = COALESCE(target_empresa_id, 0)
         AND (pg_catalog.LOWER(COALESCE(ct.estado_revision, '')) = 'aprobado'
              OR COALESCE(ct.validado, 0) = 1
              OR COALESCE(ct.procesado, FALSE) = TRUE)
     ) THEN
    RAISE EXCEPTION 'el pedido ya posee un comprobante aprobado'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_serializar_pedido_pago_comprobante ON pedido_pagos;
CREATE TRIGGER trg_serializar_pedido_pago_comprobante
BEFORE INSERT OR UPDATE OR DELETE ON pedido_pagos
FOR EACH ROW EXECUTE FUNCTION public.serializar_pedido_pago_con_comprobante();
COMMIT;
-- END COMPROBANTE CONCURRENCY MIGRATION

BEGIN;
SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS historial_pagos (
  id SERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  fecha TIMESTAMP DEFAULT pg_catalog.NOW(),
  monto NUMERIC(12,2) NOT NULL,
  metodo TEXT DEFAULT 'mercadopago',
  referencia TEXT,
  estado TEXT DEFAULT 'approved',
  CONSTRAINT uq_historial_pagos_referencia UNIQUE (referencia)
);

CREATE TABLE IF NOT EXISTS historial_costos_precios (
    id SERIAL PRIMARY KEY,
    empresa_id INT NOT NULL,
    producto_id INT NOT NULL,
    costo_base NUMERIC(12,2) NOT NULL,
    costo_packaging NUMERIC(12,2) DEFAULT 0,
    costo_logistica_estimado NUMERIC(12,2) DEFAULT 0,
    costo_fijo_asignado NUMERIC(12,2) DEFAULT 0,
    precio_venta NUMERIC(12,2) NOT NULL,
    moneda VARCHAR(3) DEFAULT 'ARS',
    cotizacion_dolar NUMERIC(10,2) DEFAULT 1,
    stock_al_momento INT,
    proveedor_id INT,
    motivo_cambio TEXT,
    usuario_editor TEXT,
    origen_dato VARCHAR(20) DEFAULT 'manual',
    meta_datos JSONB DEFAULT '{}',
    fecha_registro TIMESTAMP DEFAULT pg_catalog.NOW()
);

-- =========================================================
-- 12. UTILIDADES (WhatsApp, Push, Logs)
-- =========================================================
CREATE TABLE IF NOT EXISTS wpp_outbox (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER,
  telefono    TEXT NOT NULL,
  mensaje     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  sent_at     TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  claim_owner TEXT,
  claim_epoch BIGINT,
  claim_until TIMESTAMPTZ,
  transport_origin TEXT,
  reply_correlation_id TEXT,
  meta_message_id TEXT,
  cloud_dispatch_state TEXT,
  dispatch_started_at TIMESTAMPTZ,
  CONSTRAINT wpp_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'error', 'skipped'))
);

COMMIT;
BEGIN;

SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE public.wpp_outbox IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.wpp_outbox
  DROP CONSTRAINT IF EXISTS wpp_outbox_status_check;

ALTER TABLE public.wpp_outbox
  ADD COLUMN IF NOT EXISTS claim_owner TEXT,
  ADD COLUMN IF NOT EXISTS claim_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transport_origin TEXT,
  ADD COLUMN IF NOT EXISTS reply_correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS meta_message_id TEXT,
  ADD COLUMN IF NOT EXISTS cloud_dispatch_state TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;

DO $$
DECLARE
  foreign_key RECORD;
  empresa_attribute SMALLINT;
  empresa_target_attribute SMALLINT;
BEGIN
  IF pg_catalog.to_regclass('public.empresas') IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM public.wpp_outbox AS outbox
   WHERE outbox.empresa_id IS NOT NULL
     AND NOT EXISTS (
       SELECT TRUE FROM public.empresas AS tenant WHERE tenant.id = outbox.empresa_id
     );

  SELECT attnum INTO empresa_attribute
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.wpp_outbox'::regclass
     AND attname = 'empresa_id'
     AND NOT attisdropped;
  SELECT attnum INTO empresa_target_attribute
    FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.empresas'::regclass
     AND attname = 'id'
     AND NOT attisdropped;

  SELECT contype, conkey, confrelid, confkey, confupdtype, confdeltype, confmatchtype,
         condeferrable, condeferred, convalidated
    INTO foreign_key
    FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.wpp_outbox'::regclass
     AND conname = 'wpp_outbox_empresa_id_fkey';

  IF FOUND AND (
       foreign_key.contype IS DISTINCT FROM 'f'
       OR foreign_key.conkey IS DISTINCT FROM ARRAY[empresa_attribute]::SMALLINT[]
       OR foreign_key.confrelid IS DISTINCT FROM 'public.empresas'::regclass
       OR foreign_key.confkey IS DISTINCT FROM ARRAY[empresa_target_attribute]::SMALLINT[]
       OR foreign_key.confupdtype IS DISTINCT FROM 'a'
       OR foreign_key.confdeltype IS DISTINCT FROM 'c'
       OR foreign_key.confmatchtype IS DISTINCT FROM 's'
       OR foreign_key.condeferrable IS DISTINCT FROM FALSE
       OR foreign_key.condeferred IS DISTINCT FROM FALSE
       OR foreign_key.convalidated IS DISTINCT FROM TRUE
     ) THEN
    ALTER TABLE public.wpp_outbox DROP CONSTRAINT wpp_outbox_empresa_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.wpp_outbox'::regclass
       AND conname = 'wpp_outbox_empresa_id_fkey'
       AND contype = 'f'
       AND conkey = ARRAY[empresa_attribute]::SMALLINT[]
       AND confrelid = 'public.empresas'::regclass
       AND confkey = ARRAY[empresa_target_attribute]::SMALLINT[]
       AND confupdtype = 'a'
       AND confdeltype = 'c'
       AND confmatchtype = 's'
       AND NOT condeferrable
       AND NOT condeferred
       AND convalidated
  ) THEN
    ALTER TABLE public.wpp_outbox
      ADD CONSTRAINT wpp_outbox_empresa_id_fkey
      FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.wpp_outbox'::regclass
       AND conname = 'wpp_outbox_empresa_id_fkey'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.wpp_outbox VALIDATE CONSTRAINT wpp_outbox_empresa_id_fkey;
  END IF;
END $$;

ALTER TABLE public.wpp_outbox
  DROP CONSTRAINT IF EXISTS wpp_outbox_cloud_dispatch_state_check;

DO $repair_wpp_outbox_status$
DECLARE
  target_empresa_id INTEGER;
BEGIN
  FOR target_empresa_id IN
    SELECT DISTINCT outbox.empresa_id
      FROM public.wpp_outbox AS outbox
     WHERE outbox.empresa_id IS NOT NULL
       AND (outbox.status IS NULL
        OR outbox.status NOT IN ('pending', 'sending', 'sent', 'error', 'skipped'))
     ORDER BY outbox.empresa_id
  LOOP
    PERFORM pg_catalog.set_config(
      'pedivoy.whatsapp_cloud_projection_empresa_id', target_empresa_id::TEXT, TRUE
    );
    UPDATE public.wpp_outbox
    SET status = CASE WHEN sent_at IS NOT NULL THEN 'sent' ELSE 'error' END,
        error = CASE
          WHEN sent_at IS NULL THEN COALESCE(error, 'legacy_status_requires_manual_review')
          ELSE error
        END,
        claim_owner = NULL,
        claim_epoch = NULL,
        claim_until = NULL
    WHERE empresa_id = target_empresa_id
      AND (status IS NULL
       OR status NOT IN ('pending', 'sending', 'sent', 'error', 'skipped'));
    PERFORM pg_catalog.set_config('pedivoy.whatsapp_cloud_projection_empresa_id', '', TRUE);
  END LOOP;

  UPDATE public.wpp_outbox
  SET status = CASE WHEN sent_at IS NOT NULL THEN 'sent' ELSE 'error' END,
      error = CASE
        WHEN sent_at IS NULL THEN COALESCE(error, 'legacy_status_requires_manual_review')
        ELSE error
      END,
      claim_owner = NULL,
      claim_epoch = NULL,
      claim_until = NULL
  WHERE empresa_id IS NULL
    AND (status IS NULL
     OR status NOT IN ('pending', 'sending', 'sent', 'error', 'skipped'));
END $repair_wpp_outbox_status$;

DO $repair_wpp_outbox_cloud_dispatch$
DECLARE
  target_empresa_id INTEGER;
BEGIN
  FOR target_empresa_id IN
    SELECT DISTINCT outbox.empresa_id
      FROM public.wpp_outbox AS outbox
     WHERE outbox.empresa_id IS NOT NULL
     ORDER BY outbox.empresa_id
  LOOP
    PERFORM pg_catalog.set_config(
      'pedivoy.whatsapp_cloud_projection_empresa_id', target_empresa_id::TEXT, TRUE
    );
    UPDATE public.wpp_outbox
    SET cloud_dispatch_state = CASE
          WHEN transport_origin IS DISTINCT FROM 'cloud' THEN NULL
          WHEN status = 'sending' THEN CASE
            WHEN cloud_dispatch_state IN ('pre_dispatch', 'dispatch_started') THEN cloud_dispatch_state
            ELSE 'dispatch_started'
          END
          WHEN status = 'sent' THEN 'sent'
          WHEN status = 'error' THEN CASE
            WHEN cloud_dispatch_state IN ('definitive_failed', 'manual_retryable', 'outcome_unknown') THEN cloud_dispatch_state
            ELSE 'outcome_unknown'
          END
          ELSE NULL
        END,
        dispatch_started_at = CASE
          WHEN transport_origin = 'cloud'
           AND (
             status = 'sent'
             OR (status = 'sending' AND cloud_dispatch_state IS DISTINCT FROM 'pre_dispatch')
             OR (status = 'error' AND (
               cloud_dispatch_state IS NULL
               OR cloud_dispatch_state IN ('manual_retryable', 'outcome_unknown')
             ))
           )
            THEN COALESCE(dispatch_started_at, created_at, pg_catalog.NOW())
          ELSE dispatch_started_at
        END
    WHERE empresa_id = target_empresa_id;
    PERFORM pg_catalog.set_config('pedivoy.whatsapp_cloud_projection_empresa_id', '', TRUE);
  END LOOP;

  UPDATE public.wpp_outbox
  SET cloud_dispatch_state = CASE
        WHEN transport_origin IS DISTINCT FROM 'cloud' THEN NULL
        WHEN status = 'sending' THEN CASE
          WHEN cloud_dispatch_state IN ('pre_dispatch', 'dispatch_started') THEN cloud_dispatch_state
          ELSE 'dispatch_started'
        END
        WHEN status = 'sent' THEN 'sent'
        WHEN status = 'error' THEN CASE
          WHEN cloud_dispatch_state IN ('definitive_failed', 'manual_retryable', 'outcome_unknown') THEN cloud_dispatch_state
          ELSE 'outcome_unknown'
        END
        ELSE NULL
      END,
      dispatch_started_at = CASE
        WHEN transport_origin = 'cloud'
         AND (
           status = 'sent'
           OR (status = 'sending' AND cloud_dispatch_state IS DISTINCT FROM 'pre_dispatch')
           OR (status = 'error' AND (
             cloud_dispatch_state IS NULL
             OR cloud_dispatch_state IN ('manual_retryable', 'outcome_unknown')
           ))
         )
          THEN COALESCE(dispatch_started_at, created_at, pg_catalog.NOW())
        ELSE dispatch_started_at
      END
  WHERE empresa_id IS NULL;
END $repair_wpp_outbox_cloud_dispatch$;

UPDATE public.wpp_outbox
SET claim_until = pg_catalog.NOW() - INTERVAL '1 second'
WHERE transport_origin = 'cloud'
  AND status = 'sending'
  AND cloud_dispatch_state = 'pre_dispatch'
  AND claim_until IS NULL;

ALTER TABLE public.wpp_outbox
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT wpp_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'error', 'skipped')) NOT VALID,
  ADD CONSTRAINT wpp_outbox_cloud_dispatch_state_check
    CHECK (
      cloud_dispatch_state IS NULL
      OR (
        transport_origin = 'cloud'
        AND (
          (status = 'sending' AND cloud_dispatch_state IN ('pre_dispatch', 'dispatch_started'))
          OR (status = 'sent' AND cloud_dispatch_state = 'sent')
          OR (
            status = 'error'
            AND cloud_dispatch_state IN ('definitive_failed', 'manual_retryable', 'outcome_unknown')
          )
        )
      )
    ) NOT VALID;

ALTER TABLE public.wpp_outbox
  VALIDATE CONSTRAINT wpp_outbox_status_check;

ALTER TABLE public.wpp_outbox
  VALIDATE CONSTRAINT wpp_outbox_cloud_dispatch_state_check;

DROP INDEX IF EXISTS public.wpp_outbox_pending_claim_idx;
CREATE INDEX wpp_outbox_pending_claim_idx
  ON public.wpp_outbox (created_at, id)
  WHERE status = 'pending';

DROP INDEX IF EXISTS public.wpp_outbox_reply_correlation_uidx;
CREATE UNIQUE INDEX wpp_outbox_reply_correlation_uidx
  ON public.wpp_outbox (COALESCE(empresa_id, 0), transport_origin, reply_correlation_id)
  WHERE reply_correlation_id IS NOT NULL;

DROP INDEX IF EXISTS public.wpp_outbox_cloud_pre_dispatch_recovery_idx;
CREATE INDEX wpp_outbox_cloud_pre_dispatch_recovery_idx
  ON public.wpp_outbox (claim_until, created_at, id)
  WHERE status = 'sending' AND cloud_dispatch_state = 'pre_dispatch';

COMMIT;

-- BEGIN WHATSAPP CLOUD OPS MIGRATION
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS public.whatsapp_cloud_ops_audit (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT NOT NULL,
  empresa_id INTEGER,
  actor TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT NOT NULL,
  from_cloud_dispatch_state TEXT,
  to_status TEXT NOT NULL,
  to_cloud_dispatch_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT whatsapp_cloud_ops_audit_actor_check
    CHECK (actor = pg_catalog.BTRIM(actor) AND actor <> '' AND pg_catalog.length(actor) <= 100),
  CONSTRAINT whatsapp_cloud_ops_audit_reason_check
    CHECK (reason_code = pg_catalog.BTRIM(reason_code) AND reason_code <> '' AND pg_catalog.length(reason_code) <= 80),
  CONSTRAINT whatsapp_cloud_ops_audit_action_check
    CHECK (action IN ('mark_sent', 'mark_failed', 'confirm_not_sent', 'replay'))
);

CREATE INDEX IF NOT EXISTS whatsapp_cloud_ops_audit_outbox_idx
  ON public.whatsapp_cloud_ops_audit (outbox_id, created_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_cloud_ops_audit_empresa_idx
  ON public.whatsapp_cloud_ops_audit (empresa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wpp_outbox_cloud_ops_idx
  ON public.wpp_outbox (transport_origin, status, cloud_dispatch_state, created_at, id)
  WHERE transport_origin = 'cloud';

COMMIT;
-- END WHATSAPP CLOUD OPS MIGRATION
-- END WPP OUTBOX MIGRATION

BEGIN;
SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS push_subs (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

COMMIT;

-- BEGIN WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
-- Stable namespace/key pair for the complete WhatsApp Cloud inbox projection migration.
SELECT pg_catalog.pg_advisory_xact_lock(1464550724, 1229867347);
-- Heavyweight lock order: sources first, then the optional conversation projection.
-- Keep this order aligned with every migration writer to avoid inverse-order deadlocks.
LOCK TABLE public.whatsapp_cloud_events, public.wpp_outbox IN SHARE ROW EXCLUSIVE MODE;
DO $conversation_table_lock$
BEGIN
  IF pg_catalog.to_regclass('public.whatsapp_cloud_conversations') IS NOT NULL THEN
    LOCK TABLE public.whatsapp_cloud_conversations IN SHARE ROW EXCLUSIVE MODE;
  END IF;
END $conversation_table_lock$;

DO $$
DECLARE
  index_row RECORD;
  actual_table pg_catalog.REGCLASS;
  sequence_relation RECORD;
  sequence_owner RECORD;
BEGIN
  SELECT class_row.relkind,
         namespace_row.nspname,
         sequence_meta.seqtypid
    INTO sequence_relation
    FROM pg_catalog.pg_class AS class_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = class_row.relnamespace
    LEFT JOIN pg_catalog.pg_sequence AS sequence_meta
      ON sequence_meta.seqrelid = class_row.oid
   WHERE class_row.oid = pg_catalog.to_regclass('public.whatsapp_cloud_messages_id_seq');

  IF FOUND THEN
    IF sequence_relation.nspname IS DISTINCT FROM 'public'
       OR sequence_relation.relkind IS DISTINCT FROM 'S' THEN
      RAISE EXCEPTION 'canonical sequence relation kind collision: public.whatsapp_cloud_messages_id_seq is %.% relkind %',
        sequence_relation.nspname, 'whatsapp_cloud_messages_id_seq', sequence_relation.relkind;
    END IF;
    IF sequence_relation.seqtypid IS DISTINCT FROM 'pg_catalog.int8'::pg_catalog.regtype THEN
      RAISE EXCEPTION 'canonical sequence type collision: public.whatsapp_cloud_messages_id_seq has type %, expected bigint',
        pg_catalog.format_type(sequence_relation.seqtypid, NULL);
    END IF;

    SELECT dependency.refobjid::pg_catalog.regclass AS owner_table,
           owner_column.attname AS owner_column,
           pg_catalog.count(*) OVER ()::INTEGER AS ownership_count
      INTO sequence_owner
      FROM pg_catalog.pg_depend AS dependency
      JOIN pg_catalog.pg_attribute AS owner_column
        ON owner_column.attrelid = dependency.refobjid
       AND owner_column.attnum = dependency.refobjsubid
     WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND dependency.objid = pg_catalog.to_regclass('public.whatsapp_cloud_messages_id_seq')
       AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND dependency.deptype = 'a';

    IF FOUND AND (
       sequence_owner.ownership_count IS DISTINCT FROM 1
       OR sequence_owner.owner_table IS DISTINCT FROM pg_catalog.to_regclass('public.whatsapp_cloud_messages')
       OR sequence_owner.owner_column IS DISTINCT FROM 'id') THEN
      RAISE EXCEPTION 'canonical sequence ownership collision: public.whatsapp_cloud_messages_id_seq is owned by %.%, expected public.whatsapp_cloud_messages.id',
        COALESCE(sequence_owner.owner_table::TEXT, '<none>'),
        COALESCE(sequence_owner.owner_column, '<none>');
    END IF;
  END IF;

  FOR index_row IN
    SELECT * FROM (VALUES
      ('public.whatsapp_cloud_events_empresa_id_id_uidx', 'public.whatsapp_cloud_events'),
      ('public.wpp_outbox_empresa_id_id_uidx', 'public.wpp_outbox'),
      ('public.whatsapp_cloud_messages_source_event_uidx', 'public.whatsapp_cloud_messages'),
      ('public.whatsapp_cloud_messages_outbox_uidx', 'public.whatsapp_cloud_messages'),
      ('public.whatsapp_cloud_messages_source_outbox_uidx', 'public.whatsapp_cloud_messages'),
      ('public.whatsapp_cloud_messages_provider_message_idx', 'public.whatsapp_cloud_messages'),
      ('public.whatsapp_cloud_events_status_message_idx', 'public.whatsapp_cloud_events'),
      ('public.idx_whatsapp_cloud_messages_conversations', 'public.whatsapp_cloud_messages'),
      ('public.idx_whatsapp_cloud_messages_timeline', 'public.whatsapp_cloud_messages'),
      ('public.idx_whatsapp_cloud_conversations_queue', 'public.whatsapp_cloud_conversations')
    ) AS canonical(index_name, table_name)
  LOOP
    IF pg_catalog.to_regclass(index_row.index_name) IS NOT NULL THEN
      SELECT candidate.indrelid::pg_catalog.regclass
        INTO actual_table
        FROM pg_catalog.pg_index AS candidate
       WHERE candidate.indexrelid = pg_catalog.to_regclass(index_row.index_name);
      IF NOT FOUND OR actual_table IS DISTINCT FROM pg_catalog.to_regclass(index_row.table_name) THEN
        RAISE EXCEPTION 'canonical index name collision: % belongs to %, expected %',
          index_row.index_name, COALESCE(actual_table::TEXT, 'non-index relation'), index_row.table_name;
      END IF;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.whatsapp_cloud_messages (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  participant_wa_id TEXT NOT NULL,
  source_event_id BIGINT,
  outbox_id BIGINT,
  source_outbox_id BIGINT,
  provider_message_id TEXT,
  message_type TEXT NOT NULL,
  text_body TEXT,
  media_mime_type TEXT,
  media_caption TEXT,
  document_filename TEXT,
  delivery_status TEXT NOT NULL,
  state_rank SMALLINT NOT NULL,
  message_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

DO $conversation_relation_guard$
DECLARE
  conversation_relation RECORD;
BEGIN
  SELECT class_row.oid,
         class_row.relkind,
         class_row.relrowsecurity,
         class_row.relforcerowsecurity
    INTO conversation_relation
    FROM pg_catalog.pg_class AS class_row
    JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
   WHERE namespace_row.nspname = 'public'
     AND class_row.relname = 'whatsapp_cloud_conversations';

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF conversation_relation.relkind IS DISTINCT FROM 'r'
     OR conversation_relation.relrowsecurity
     OR conversation_relation.relforcerowsecurity
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = conversation_relation.oid
          AND NOT trigger_row.tgisinternal
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_depend AS dependency
         JOIN pg_catalog.pg_rewrite AS rewrite_row
           ON dependency.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
          AND dependency.objid = rewrite_row.oid
        WHERE dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.refobjid = conversation_relation.oid
          AND (
            rewrite_row.ev_class <> conversation_relation.oid
            OR rewrite_row.rulename <> '_RETURN'
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_inherits AS inheritance_row
        WHERE inheritance_row.inhrelid = conversation_relation.oid
           OR inheritance_row.inhparent = conversation_relation.oid
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_policy AS policy_row
        WHERE policy_row.polrelid = conversation_relation.oid
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.confrelid = conversation_relation.oid
          AND NOT (
            constraint_row.conrelid = pg_catalog.to_regclass('public.whatsapp_cloud_conversation_reads')
            AND constraint_row.conname = 'whatsapp_cloud_conversation_reads_conversation_fkey'
            AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
              = 'FOREIGN KEY (empresa_id, conversation_id) REFERENCES whatsapp_cloud_conversations(empresa_id, id) ON DELETE CASCADE'
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = conversation_relation.oid
          AND NOT (
            (constraint_row.conname = 'whatsapp_cloud_conversations_pkey'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'PRIMARY KEY (id)')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_id_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL id')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_empresa_id_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL empresa_id')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_participant_wa_id_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL participant_wa_id')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_workflow_status_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL workflow_status')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_priority_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL priority')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_version_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL version')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_created_at_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL created_at')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_updated_at_not_null'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'NOT NULL updated_at')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_empresa_id_fkey'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_empresa_participant_key'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'UNIQUE (empresa_id, participant_wa_id)')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_empresa_id_id_key'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'UNIQUE (empresa_id, id)')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_participant_check'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'CHECK (participant_wa_id ~ ''^[0-9]{6,15}$''::text)')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_workflow_status_check'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'CHECK (workflow_status = ANY (ARRAY[''pending''::text, ''resolved''::text]))')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_priority_check'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'CHECK (priority = ANY (ARRAY[''normal''::text, ''high''::text, ''urgent''::text]))')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_version_check'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'CHECK (version > 0)')
            OR (constraint_row.conname = 'whatsapp_cloud_conversations_timestamps_check'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'CHECK (updated_at >= created_at)')
          )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;
END $conversation_relation_guard$;

CREATE TABLE IF NOT EXISTS public.whatsapp_cloud_conversations (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  empresa_id INTEGER NOT NULL,
  participant_wa_id TEXT NOT NULL,
  workflow_status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT whatsapp_cloud_conversations_empresa_id_fkey
    FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_cloud_conversations_empresa_participant_key
    UNIQUE (empresa_id, participant_wa_id),
  CONSTRAINT whatsapp_cloud_conversations_participant_check
    CHECK (participant_wa_id ~ '^[0-9]{6,15}$'),
  CONSTRAINT whatsapp_cloud_conversations_workflow_status_check
    CHECK (workflow_status IN ('pending', 'resolved')),
  CONSTRAINT whatsapp_cloud_conversations_priority_check
    CHECK (priority IN ('normal', 'high', 'urgent')),
  CONSTRAINT whatsapp_cloud_conversations_version_check
    CHECK (version > 0),
  CONSTRAINT whatsapp_cloud_conversations_timestamps_check
    CHECK (updated_at >= created_at)
);

DO $conversation_add_missing_columns$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'id' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN id UUID DEFAULT pg_catalog.gen_random_uuid();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'empresa_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN empresa_id INTEGER;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'participant_wa_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN participant_wa_id TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'workflow_status' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN workflow_status TEXT DEFAULT 'pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'priority' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN priority TEXT DEFAULT 'normal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'version' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN version INTEGER DEFAULT 1;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'created_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN created_at TIMESTAMPTZ DEFAULT pg_catalog.NOW();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND attname = 'updated_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD COLUMN updated_at TIMESTAMPTZ DEFAULT pg_catalog.NOW();
  END IF;
END $conversation_add_missing_columns$;

DO $conversation_preflight$
DECLARE
  conversation_relation RECORD;
  existing_columns TEXT[];
BEGIN
  SELECT class_row.oid, class_row.relkind
    INTO conversation_relation
    FROM pg_catalog.pg_class AS class_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = class_row.relnamespace
   WHERE namespace_row.nspname = 'public'
     AND class_row.relname = 'whatsapp_cloud_conversations';

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF conversation_relation.relkind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY attribute_row.attnum)
    INTO existing_columns
    FROM pg_catalog.pg_attribute AS attribute_row
   WHERE attribute_row.attrelid = conversation_relation.oid
     AND attribute_row.attnum > 0
     AND NOT attribute_row.attisdropped;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(COALESCE(existing_columns, ARRAY[]::TEXT[])) AS column_name
     WHERE NOT (column_name = ANY (ARRAY[
       'id','empresa_id','participant_wa_id','workflow_status','priority','version','created_at','updated_at'
     ]::TEXT[]))
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.confrelid = conversation_relation.oid
       AND NOT (
         constraint_row.conrelid = pg_catalog.to_regclass('public.whatsapp_cloud_conversation_reads')
         AND constraint_row.conname = 'whatsapp_cloud_conversation_reads_conversation_fkey'
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
           = 'FOREIGN KEY (empresa_id, conversation_id) REFERENCES whatsapp_cloud_conversations(empresa_id, id) ON DELETE CASCADE'
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF EXISTS (SELECT 1 FROM public.whatsapp_cloud_conversations LIMIT 1)
     AND (NOT ('empresa_id' = ANY(existing_columns))
       OR NOT ('participant_wa_id' = ANY(existing_columns))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('id' = ANY(existing_columns)) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = conversation_relation.oid AND attname = 'id' AND NOT attisdropped
         AND atttypid IN ('pg_catalog.uuid'::pg_catalog.regtype,
                          'pg_catalog.text'::pg_catalog.regtype,
                          'pg_catalog.varchar'::pg_catalog.regtype)
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations
       WHERE id IS NULL OR id::TEXT !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations GROUP BY id::TEXT HAVING pg_catalog.count(*) > 1
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
    END IF;
  END IF;

  IF ('empresa_id' = ANY(existing_columns)) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = conversation_relation.oid AND attname = 'empresa_id' AND NOT attisdropped
         AND atttypid IN ('pg_catalog.int2'::pg_catalog.regtype,
                          'pg_catalog.int4'::pg_catalog.regtype,
                          'pg_catalog.int8'::pg_catalog.regtype,
                          'pg_catalog.numeric'::pg_catalog.regtype)
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations AS conversation
       WHERE conversation.empresa_id IS NULL
          OR conversation.empresa_id::NUMERIC <> pg_catalog.trunc(conversation.empresa_id::NUMERIC)
          OR conversation.empresa_id::NUMERIC NOT BETWEEN 1 AND 2147483647
          OR NOT EXISTS (SELECT 1 FROM public.empresas AS empresa WHERE empresa.id = conversation.empresa_id::INTEGER)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
    END IF;
  END IF;

  IF ('participant_wa_id' = ANY(existing_columns)) AND (
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = conversation_relation.oid AND attname = 'participant_wa_id' AND NOT attisdropped
         AND atttypid IN ('pg_catalog.text'::pg_catalog.regtype, 'pg_catalog.varchar'::pg_catalog.regtype)
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations
       WHERE participant_wa_id IS NULL OR participant_wa_id::TEXT !~ '^[0-9]{6,15}$'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('workflow_status' = ANY(existing_columns)) AND (
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = conversation_relation.oid AND attname = 'workflow_status' AND NOT attisdropped
         AND atttypid IN ('pg_catalog.text'::pg_catalog.regtype, 'pg_catalog.varchar'::pg_catalog.regtype)
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations
       WHERE workflow_status IS NOT NULL AND workflow_status::TEXT NOT IN ('pending', 'resolved')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('priority' = ANY(existing_columns)) AND (
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = conversation_relation.oid AND attname = 'priority' AND NOT attisdropped
         AND atttypid IN ('pg_catalog.text'::pg_catalog.regtype, 'pg_catalog.varchar'::pg_catalog.regtype)
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations
       WHERE priority IS NOT NULL AND priority::TEXT NOT IN ('normal', 'high', 'urgent')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('version' = ANY(existing_columns)) AND (
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = conversation_relation.oid AND attname = 'version' AND NOT attisdropped
         AND atttypid IN ('pg_catalog.int2'::pg_catalog.regtype,
                          'pg_catalog.int4'::pg_catalog.regtype,
                          'pg_catalog.int8'::pg_catalog.regtype,
                          'pg_catalog.numeric'::pg_catalog.regtype)
    ) OR EXISTS (
      SELECT 1 FROM public.whatsapp_cloud_conversations
       WHERE version IS NOT NULL AND (
         version::NUMERIC <> pg_catalog.trunc(version::NUMERIC)
         OR version::NUMERIC NOT BETWEEN 1 AND 2147483647
       )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('created_at' = ANY(existing_columns)) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = conversation_relation.oid AND attname = 'created_at' AND NOT attisdropped
       AND atttypid IN ('pg_catalog.timestamp'::pg_catalog.regtype,
                        'pg_catalog.timestamptz'::pg_catalog.regtype)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;
  IF ('updated_at' = ANY(existing_columns)) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
     WHERE attrelid = conversation_relation.oid AND attname = 'updated_at' AND NOT attisdropped
       AND atttypid IN ('pg_catalog.timestamp'::pg_catalog.regtype,
                        'pg_catalog.timestamptz'::pg_catalog.regtype)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('empresa_id' = ANY(existing_columns)) AND ('participant_wa_id' = ANY(existing_columns))
     AND EXISTS (
       SELECT 1 FROM public.whatsapp_cloud_conversations
        GROUP BY empresa_id::INTEGER, participant_wa_id::TEXT
       HAVING pg_catalog.count(*) > 1
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;

  IF ('created_at' = ANY(existing_columns)) AND ('updated_at' = ANY(existing_columns))
     AND EXISTS (
       SELECT 1 FROM public.whatsapp_cloud_conversations
        WHERE created_at IS NOT NULL AND updated_at IS NOT NULL AND updated_at < created_at
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_conversations_schema_unsafe';
  END IF;
END $conversation_preflight$;

DO $conversation_columns$
DECLARE
  column_type pg_catalog.OID;
  column_not_null BOOLEAN;
  column_default TEXT;
BEGIN
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='id' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.uuid'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN id TYPE UUID USING id::TEXT::UUID;
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='empresa_id' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.int4'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN empresa_id TYPE INTEGER USING empresa_id::INTEGER;
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='participant_wa_id' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN participant_wa_id TYPE TEXT USING participant_wa_id::TEXT;
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='workflow_status' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN workflow_status TYPE TEXT USING workflow_status::TEXT;
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='priority' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN priority TYPE TEXT USING priority::TEXT;
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='version' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.int4'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN version TYPE INTEGER USING version::INTEGER;
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='created_at' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.timestamptz'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
  END IF;
  SELECT atttypid INTO column_type FROM pg_catalog.pg_attribute
   WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname='updated_at' AND NOT attisdropped;
  IF column_type IS DISTINCT FROM 'pg_catalog.timestamptz'::pg_catalog.regtype THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
  END IF;

  UPDATE public.whatsapp_cloud_conversations
     SET id = COALESCE(id, pg_catalog.gen_random_uuid()),
         workflow_status = COALESCE(workflow_status, 'pending'),
         priority = COALESCE(priority, 'normal'),
         version = COALESCE(version, 1),
         created_at = COALESCE(created_at, updated_at, pg_catalog.now()),
         updated_at = COALESCE(updated_at, created_at, pg_catalog.now())
   WHERE id IS NULL OR workflow_status IS NULL OR priority IS NULL OR version IS NULL
      OR created_at IS NULL OR updated_at IS NULL;

  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    INTO column_default
    FROM pg_catalog.pg_attribute AS column_row
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = column_row.attrelid AND default_row.adnum = column_row.attnum
   WHERE column_row.attrelid = 'public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname = 'id';
  IF column_default IS DISTINCT FROM 'gen_random_uuid()' THEN
    ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();
  END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='empresa_id';
  IF column_default IS NOT NULL THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN empresa_id DROP DEFAULT; END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='participant_wa_id';
  IF column_default IS NOT NULL THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN participant_wa_id DROP DEFAULT; END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='workflow_status';
  IF column_default IS DISTINCT FROM '''pending''::text' THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN workflow_status SET DEFAULT 'pending'; END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='priority';
  IF column_default IS DISTINCT FROM '''normal''::text' THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN priority SET DEFAULT 'normal'; END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='version';
  IF column_default IS DISTINCT FROM '1' THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN version SET DEFAULT 1; END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='created_at';
  IF column_default IS DISTINCT FROM 'now()' THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN created_at SET DEFAULT pg_catalog.now(); END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) INTO column_default
    FROM pg_catalog.pg_attribute AS column_row LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid=column_row.attrelid AND default_row.adnum=column_row.attnum
   WHERE column_row.attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND column_row.attname='updated_at';
  IF column_default IS DISTINCT FROM 'now()' THEN ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN updated_at SET DEFAULT pg_catalog.now(); END IF;

  FOR column_default IN SELECT pg_catalog.unnest(ARRAY['id','empresa_id','participant_wa_id','workflow_status','priority','version','created_at','updated_at']::TEXT[])
  LOOP
    SELECT attnotnull INTO column_not_null FROM pg_catalog.pg_attribute
     WHERE attrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND attname=column_default AND NOT attisdropped;
    IF NOT column_not_null THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.whatsapp_cloud_conversations ALTER COLUMN %I SET NOT NULL', column_default);
    END IF;
  END LOOP;
END $conversation_columns$;

DO $conversation_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_pkey') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_empresa_id_fkey') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_empresa_participant_key') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_empresa_participant_key UNIQUE (empresa_id, participant_wa_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_participant_check') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_participant_check CHECK (participant_wa_id ~ '^[0-9]{6,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_workflow_status_check') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_workflow_status_check CHECK (workflow_status IN ('pending', 'resolved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_priority_check') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_priority_check CHECK (priority IN ('normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_version_check') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_version_check CHECK (version > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass AND conname='whatsapp_cloud_conversations_timestamps_check') THEN
    ALTER TABLE public.whatsapp_cloud_conversations ADD CONSTRAINT whatsapp_cloud_conversations_timestamps_check CHECK (updated_at >= created_at);
  END IF;
END $conversation_constraints$;

DO $conversation_queue_index$
DECLARE
  queue_index pg_catalog.REGCLASS;
BEGIN
  queue_index := pg_catalog.to_regclass('public.idx_whatsapp_cloud_conversations_queue');
  IF queue_index IS NOT NULL
     AND pg_catalog.pg_get_indexdef(queue_index)
       IS DISTINCT FROM 'CREATE INDEX idx_whatsapp_cloud_conversations_queue ON public.whatsapp_cloud_conversations USING btree (empresa_id, workflow_status, priority, updated_at DESC, id)' THEN
    DROP INDEX public.idx_whatsapp_cloud_conversations_queue;
    queue_index := NULL;
  END IF;
  IF queue_index IS NULL THEN
    CREATE INDEX idx_whatsapp_cloud_conversations_queue
      ON public.whatsapp_cloud_conversations
      (empresa_id, workflow_status, priority, updated_at DESC, id);
  END IF;
END $conversation_queue_index$;

DO $$
DECLARE
  column_row RECORD;
BEGIN
  FOR column_row IN
    SELECT * FROM (VALUES
      ('id', 'BIGSERIAL'),
      ('empresa_id', 'INTEGER'),
      ('direction', 'TEXT'),
      ('participant_wa_id', 'TEXT'),
      ('source_event_id', 'BIGINT'),
      ('outbox_id', 'BIGINT'),
      ('source_outbox_id', 'BIGINT'),
      ('provider_message_id', 'TEXT'),
      ('message_type', 'TEXT'),
      ('text_body', 'TEXT'),
      ('media_mime_type', 'TEXT'),
      ('media_caption', 'TEXT'),
      ('document_filename', 'TEXT'),
      ('delivery_status', 'TEXT'),
      ('state_rank', 'SMALLINT'),
      ('message_at', 'TIMESTAMPTZ'),
      ('sent_at', 'TIMESTAMPTZ'),
      ('delivered_at', 'TIMESTAMPTZ'),
      ('read_at', 'TIMESTAMPTZ'),
      ('failed_at', 'TIMESTAMPTZ'),
      ('created_at', 'TIMESTAMPTZ'),
      ('updated_at', 'TIMESTAMPTZ')
    ) AS expected(column_name, column_definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_attribute
       WHERE attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
         AND attname = column_row.column_name
         AND NOT attisdropped
    ) THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.whatsapp_cloud_messages ADD COLUMN %I %s',
        column_row.column_name, column_row.column_definition
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  column_row RECORD;
BEGIN
  FOR column_row IN
    SELECT * FROM (VALUES
      ('id', 'bigint'),
      ('empresa_id', 'integer'),
      ('direction', 'text'),
      ('participant_wa_id', 'text'),
      ('source_event_id', 'bigint'),
      ('outbox_id', 'bigint'),
      ('source_outbox_id', 'bigint'),
      ('provider_message_id', 'text'),
      ('message_type', 'text'),
      ('text_body', 'text'),
      ('media_mime_type', 'text'),
      ('media_caption', 'text'),
      ('document_filename', 'text'),
      ('delivery_status', 'text'),
      ('state_rank', 'smallint'),
      ('message_at', 'timestamp with time zone'),
      ('sent_at', 'timestamp with time zone'),
      ('delivered_at', 'timestamp with time zone'),
      ('read_at', 'timestamp with time zone'),
      ('failed_at', 'timestamp with time zone'),
      ('created_at', 'timestamp with time zone'),
      ('updated_at', 'timestamp with time zone')
    ) AS expected(column_name, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_attribute
       WHERE attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
         AND attname = column_row.column_name
         AND NOT attisdropped
         AND pg_catalog.format_type(atttypid, atttypmod) = column_row.data_type
    ) THEN
      IF column_row.column_name IN (
        'message_at', 'sent_at', 'delivered_at', 'read_at', 'failed_at', 'created_at', 'updated_at'
      ) THEN
        EXECUTE pg_catalog.format(
          'ALTER TABLE public.whatsapp_cloud_messages ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
          column_row.column_name, column_row.column_name
        );
      ELSE
        EXECUTE pg_catalog.format(
          'ALTER TABLE public.whatsapp_cloud_messages ALTER COLUMN %I TYPE %s USING %I::%s',
          column_row.column_name, column_row.data_type, column_row.column_name, column_row.data_type
        );
      END IF;
    END IF;
  END LOOP;
END $$;

CREATE SEQUENCE IF NOT EXISTS public.whatsapp_cloud_messages_id_seq AS BIGINT;
DO $$
DECLARE
  max_id BIGINT;
  sequence_last BIGINT;
  sequence_called BOOLEAN;
  ownership_count INTEGER;
BEGIN
  SELECT pg_catalog.count(*)::INTEGER
    INTO ownership_count
    FROM pg_catalog.pg_depend AS dependency
   WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependency.objid = 'public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass
     AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependency.deptype = 'a';

  IF ownership_count = 0 THEN
    ALTER SEQUENCE public.whatsapp_cloud_messages_id_seq
      OWNED BY public.whatsapp_cloud_messages.id;
  ELSIF ownership_count <> 1 OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_depend AS dependency
     WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND dependency.objid = 'public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass
       AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
       AND dependency.refobjid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND dependency.refobjsubid = (
         SELECT attribute_row.attnum
           FROM pg_catalog.pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
            AND attribute_row.attname = 'id'
            AND NOT attribute_row.attisdropped
       )
       AND dependency.deptype = 'a'
  ) THEN
    RAISE EXCEPTION 'canonical sequence ownership collision: public.whatsapp_cloud_messages_id_seq must be owned only by public.whatsapp_cloud_messages.id';
  END IF;

  IF COALESCE((
    SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
      FROM pg_catalog.pg_attribute AS column_row
      LEFT JOIN pg_catalog.pg_attrdef AS default_row
        ON default_row.adrelid = column_row.attrelid
       AND default_row.adnum = column_row.attnum
     WHERE column_row.attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND column_row.attname = 'id'
  ), '') <> 'nextval(''whatsapp_cloud_messages_id_seq''::regclass)' THEN
    ALTER TABLE public.whatsapp_cloud_messages
      ALTER COLUMN id SET DEFAULT pg_catalog.nextval('public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass);
  END IF;

  SELECT COALESCE(pg_catalog.MAX(id), 0) INTO max_id FROM public.whatsapp_cloud_messages;
  SELECT last_value, is_called INTO sequence_last, sequence_called
    FROM public.whatsapp_cloud_messages_id_seq;
  IF max_id > sequence_last OR (max_id = sequence_last AND NOT sequence_called) THEN
    PERFORM pg_catalog.setval(
      'public.whatsapp_cloud_messages_id_seq'::pg_catalog.regclass,
      GREATEST(max_id, 1),
      max_id >= 1
    );
  END IF;
END $$;

DO $$
DECLARE
  primary_row RECORD;
BEGIN
  SELECT conname,
         (SELECT pg_catalog.array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
            FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
            JOIN pg_attribute AS attribute_row
              ON attribute_row.attrelid = constraint_row.conrelid
             AND attribute_row.attnum = key_column.attnum) AS key_columns
    INTO primary_row
    FROM pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
     AND constraint_row.contype = 'p';

  IF FOUND AND primary_row.key_columns IS DISTINCT FROM ARRAY['id']::TEXT[] THEN
    EXECUTE pg_catalog.format('ALTER TABLE public.whatsapp_cloud_messages DROP CONSTRAINT %I', primary_row.conname);
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND constraint_row.contype = 'p'
  ) THEN
    ALTER TABLE public.whatsapp_cloud_messages
      ADD CONSTRAINT whatsapp_cloud_messages_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_lock_projection(
  target_empresa_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  transaction_empresa_id TEXT;
  cleanup_max_empresa_id_text TEXT;
  cleanup_locked_empresa_ids_text TEXT;
  cleanup_locked_empresa_ids INTEGER[] := ARRAY[]::INTEGER[];
BEGIN
  IF target_empresa_id IS NULL THEN
    RETURN;
  END IF;

  transaction_empresa_id := pg_catalog.current_setting(
    'pedivoy.whatsapp_cloud_projection_empresa_id', TRUE
  );
  IF transaction_empresa_id IS NULL OR transaction_empresa_id = '' THEN
    cleanup_max_empresa_id_text := pg_catalog.current_setting(
      'pedivoy.whatsapp_cloud_projection_cleanup_max_empresa_id', TRUE
    );
    cleanup_locked_empresa_ids_text := pg_catalog.current_setting(
      'pedivoy.whatsapp_cloud_projection_cleanup_locked_empresa_ids', TRUE
    );
    IF cleanup_locked_empresa_ids_text IS NOT NULL
       AND cleanup_locked_empresa_ids_text <> '' THEN
      cleanup_locked_empresa_ids := pg_catalog.string_to_array(
        cleanup_locked_empresa_ids_text, ','
      )::INTEGER[];
    END IF;
    IF cleanup_max_empresa_id_text IS NOT NULL
       AND cleanup_max_empresa_id_text <> ''
       AND target_empresa_id < cleanup_max_empresa_id_text::INTEGER
       AND NOT target_empresa_id = ANY(cleanup_locked_empresa_ids) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_cloud_projection_cleanup_lock_order';
    END IF;
    PERFORM pg_catalog.set_config(
      'pedivoy.whatsapp_cloud_projection_empresa_id', target_empresa_id::TEXT, TRUE
    );
  ELSIF transaction_empresa_id IS DISTINCT FROM target_empresa_id::TEXT THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_projection_cross_tenant_transaction';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(1464550735, target_empresa_id);
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_lock_projection_migration(
  target_empresa_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF target_empresa_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1464550735, target_empresa_id);
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_conversations_touch_locked(
  target_empresa_id INTEGER,
  target_participant_wa_id TEXT,
  target_is_inbound BOOLEAN,
  target_activity_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  conversation_id UUID;
  normalized_activity_at TIMESTAMPTZ := COALESCE(target_activity_at, pg_catalog.NOW());
BEGIN
  IF target_empresa_id IS NULL OR target_participant_wa_id !~ '^[0-9]{6,15}$' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.whatsapp_cloud_conversations (
    empresa_id, participant_wa_id, workflow_status, priority, version,
    created_at, updated_at
  ) VALUES (
    target_empresa_id, target_participant_wa_id, 'pending', 'normal', 1,
    normalized_activity_at, normalized_activity_at
  )
  ON CONFLICT (empresa_id, participant_wa_id) DO UPDATE
    SET workflow_status = CASE
          WHEN target_is_inbound THEN 'pending'
          ELSE whatsapp_cloud_conversations.workflow_status
        END,
        version = CASE
          WHEN target_is_inbound
            THEN whatsapp_cloud_conversations.version + 1
          ELSE whatsapp_cloud_conversations.version
        END,
        updated_at = GREATEST(
          whatsapp_cloud_conversations.updated_at,
          normalized_activity_at
        )
  RETURNING id INTO conversation_id;
  RETURN conversation_id;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_lock_projection_cleanup(
  target_empresa_ids INTEGER[]
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  transaction_empresa_id TEXT;
  cleanup_max_empresa_id_text TEXT;
  cleanup_max_empresa_id INTEGER;
  cleanup_locked_empresa_ids_text TEXT;
  cleanup_locked_empresa_ids INTEGER[] := ARRAY[]::INTEGER[];
  new_empresa_ids INTEGER[] := ARRAY[]::INTEGER[];
  has_null_empresa_id BOOLEAN;
  target_empresa_id INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.unnest(COALESCE(target_empresa_ids, ARRAY[]::INTEGER[]))
        AS requested(empresa_id)
     WHERE requested.empresa_id IS NULL
  ) INTO has_null_empresa_id;

  SELECT pg_catalog.array_agg(distinct_tenant.empresa_id ORDER BY distinct_tenant.empresa_id)
    INTO target_empresa_ids
    FROM (
      SELECT DISTINCT requested.empresa_id
        FROM pg_catalog.unnest(COALESCE(target_empresa_ids, ARRAY[]::INTEGER[]))
          AS requested(empresa_id)
       WHERE requested.empresa_id IS NOT NULL
    ) AS distinct_tenant;

  transaction_empresa_id := pg_catalog.current_setting(
    'pedivoy.whatsapp_cloud_projection_empresa_id', TRUE
  );
  IF transaction_empresa_id IS NOT NULL AND transaction_empresa_id <> '' THEN
    IF has_null_empresa_id OR EXISTS (
      SELECT 1
        FROM pg_catalog.unnest(COALESCE(target_empresa_ids, ARRAY[]::INTEGER[]))
          AS requested(empresa_id)
       WHERE requested.empresa_id::TEXT IS DISTINCT FROM transaction_empresa_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_cloud_projection_cross_tenant_transaction';
    END IF;
    RETURN;
  END IF;

  IF COALESCE(pg_catalog.cardinality(target_empresa_ids), 0) = 0 THEN
    RETURN;
  END IF;

  cleanup_locked_empresa_ids_text := pg_catalog.current_setting(
    'pedivoy.whatsapp_cloud_projection_cleanup_locked_empresa_ids', TRUE
  );
  IF cleanup_locked_empresa_ids_text IS NOT NULL AND cleanup_locked_empresa_ids_text <> '' THEN
    cleanup_locked_empresa_ids := pg_catalog.string_to_array(
      cleanup_locked_empresa_ids_text, ','
    )::INTEGER[];
  END IF;

  SELECT COALESCE(
           pg_catalog.array_agg(requested.empresa_id ORDER BY requested.empresa_id),
           ARRAY[]::INTEGER[]
         )
    INTO new_empresa_ids
    FROM pg_catalog.unnest(target_empresa_ids) AS requested(empresa_id)
   WHERE NOT requested.empresa_id = ANY(cleanup_locked_empresa_ids);

  cleanup_max_empresa_id_text := pg_catalog.current_setting(
    'pedivoy.whatsapp_cloud_projection_cleanup_max_empresa_id', TRUE
  );
  IF cleanup_max_empresa_id_text IS NOT NULL AND cleanup_max_empresa_id_text <> '' THEN
    cleanup_max_empresa_id := cleanup_max_empresa_id_text::INTEGER;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.unnest(new_empresa_ids) AS requested(empresa_id)
       WHERE requested.empresa_id < cleanup_max_empresa_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_cloud_projection_cleanup_lock_order';
    END IF;
  END IF;

  FOREACH target_empresa_id IN ARRAY new_empresa_ids
  LOOP
    PERFORM public.whatsapp_cloud_messages_lock_projection_migration(target_empresa_id);
  END LOOP;

  SELECT pg_catalog.array_agg(distinct_tenant.empresa_id ORDER BY distinct_tenant.empresa_id)
    INTO cleanup_locked_empresa_ids
    FROM (
      SELECT DISTINCT retained.empresa_id
        FROM pg_catalog.unnest(cleanup_locked_empresa_ids || target_empresa_ids)
          AS retained(empresa_id)
    ) AS distinct_tenant;

  PERFORM pg_catalog.set_config(
    'pedivoy.whatsapp_cloud_projection_cleanup_locked_empresa_ids',
    pg_catalog.array_to_string(cleanup_locked_empresa_ids, ','),
    TRUE
  );
  PERFORM pg_catalog.set_config(
    'pedivoy.whatsapp_cloud_projection_cleanup_max_empresa_id',
    cleanup_locked_empresa_ids[pg_catalog.cardinality(cleanup_locked_empresa_ids)]::TEXT,
    TRUE
  );
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_status_transition_wins(
  current_status TEXT,
  current_rank INTEGER,
  incoming_status TEXT,
  incoming_rank INTEGER
) RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT incoming_rank > current_rank
      OR (
        incoming_rank = current_rank
        AND current_status = 'outcome_unknown'
        AND incoming_status = 'failed'
      )
$$;

DROP FUNCTION IF EXISTS public.whatsapp_cloud_messages_reconcile_status(INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.whatsapp_cloud_messages_reconcile_status_locked(INTEGER, TEXT);

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_reconcile_status_locked(
  target_empresa_id INTEGER,
  target_provider_message_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  matching_messages INTEGER;
  updated_messages INTEGER;
  normalized_provider_message_id TEXT := NULLIF(pg_catalog.BTRIM(target_provider_message_id), '');
BEGIN
  SELECT pg_catalog.COUNT(*)::INTEGER
    INTO matching_messages
    FROM public.whatsapp_cloud_messages AS message
   WHERE message.empresa_id = target_empresa_id
     AND message.provider_message_id = normalized_provider_message_id
     AND message.direction = 'outbound';

  IF matching_messages = 0 THEN
    RETURN 'not_found';
  ELSIF matching_messages > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_messages_provider_identity_ambiguous';
  END IF;

  WITH status_events AS (
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
     WHERE event.empresa_id = target_empresa_id
       AND pg_catalog.BTRIM(event.message_id) = normalized_provider_message_id
       AND event.event_kind = 'status'
       AND event.status IN ('sent', 'delivered', 'read', 'failed')
       AND NULLIF(pg_catalog.BTRIM(event.message_id), '') IS NOT NULL
  ), status_summary AS (
    SELECT (pg_catalog.array_agg(status ORDER BY
             CASE status WHEN 'read' THEN 50 WHEN 'delivered' THEN 40
                         WHEN 'sent' THEN 30 WHEN 'failed' THEN 25 ELSE 0 END DESC,
             status_at DESC))[1] AS latest_status,
           pg_catalog.MAX(CASE status WHEN 'read' THEN 50 WHEN 'delivered' THEN 40
                           WHEN 'sent' THEN 30 WHEN 'failed' THEN 25 ELSE 0 END) AS latest_rank,
           pg_catalog.MIN(status_at) FILTER (WHERE status = 'sent') AS sent_at,
           pg_catalog.MIN(status_at) FILTER (WHERE status = 'delivered') AS delivered_at,
           pg_catalog.MIN(status_at) FILTER (WHERE status = 'read') AS read_at,
           pg_catalog.MIN(status_at) FILTER (WHERE status = 'failed') AS failed_at,
           pg_catalog.MAX(status_at) AS updated_at
      FROM status_events
    HAVING pg_catalog.COUNT(*) > 0
  ), locked_message AS (
    SELECT message.*
      FROM public.whatsapp_cloud_messages AS message
     WHERE message.empresa_id = target_empresa_id
       AND message.provider_message_id = normalized_provider_message_id
       AND message.direction = 'outbound'
     FOR UPDATE OF message
  ), winners AS (
    SELECT message.id,
           message.message_at,
           message.delivery_status AS previous_status,
           message.state_rank AS previous_rank,
           message.sent_at AS previous_sent_at,
           message.delivered_at AS previous_delivered_at,
           message.read_at AS previous_read_at,
           message.failed_at AS previous_failed_at,
           message.updated_at AS previous_updated_at,
           summary.*,
           CASE WHEN public.whatsapp_cloud_messages_status_transition_wins(
                       message.delivery_status, message.state_rank,
                       summary.latest_status, summary.latest_rank
                     )
             THEN summary.latest_status ELSE message.delivery_status END AS winning_status,
           GREATEST(summary.latest_rank, message.state_rank) AS winning_rank
      FROM locked_message AS message
      CROSS JOIN status_summary AS summary
  ), sent_timeline AS (
    SELECT winners.*,
           CASE
             WHEN winning_rank >= 30 THEN GREATEST(
               message_at,
               LEAST(previous_sent_at, sent_at, delivered_at, read_at, updated_at)
             )
             WHEN winning_status = 'failed' THEN NULL
             ELSE previous_sent_at
           END AS canonical_sent_at
      FROM winners
  ), delivered_timeline AS (
    SELECT sent_timeline.*,
           CASE
             WHEN winning_rank >= 40 THEN GREATEST(
               canonical_sent_at,
               LEAST(previous_delivered_at, delivered_at, read_at)
             )
             WHEN winning_status IN ('failed', 'sent') THEN NULL
             ELSE previous_delivered_at
           END AS canonical_delivered_at
      FROM sent_timeline
  ), canonical AS (
    SELECT delivered_timeline.*,
           CASE
             WHEN winning_rank >= 50 THEN GREATEST(
               canonical_delivered_at,
               LEAST(previous_read_at, read_at)
             )
             WHEN winning_status IN ('failed', 'sent', 'delivered') THEN NULL
             ELSE previous_read_at
           END AS canonical_read_at,
           CASE
             WHEN winning_status = 'failed' THEN GREATEST(
               message_at,
               LEAST(previous_failed_at, failed_at, updated_at)
             )
             WHEN winning_rank >= 30 THEN NULL
             ELSE previous_failed_at
           END AS canonical_failed_at,
           GREATEST(previous_updated_at, updated_at) AS canonical_updated_at
      FROM delivered_timeline
  )
  UPDATE public.whatsapp_cloud_messages AS message
     SET delivery_status = canonical.winning_status,
         state_rank = canonical.winning_rank,
         sent_at = canonical.canonical_sent_at,
         delivered_at = canonical.canonical_delivered_at,
         read_at = canonical.canonical_read_at,
         failed_at = canonical.canonical_failed_at,
         updated_at = canonical.canonical_updated_at
    FROM canonical
   WHERE message.id = canonical.id
     AND canonical.latest_rank >= message.state_rank
     AND ROW(
      message.delivery_status, message.state_rank, message.sent_at,
      message.delivered_at, message.read_at, message.failed_at, message.updated_at
    ) IS DISTINCT FROM ROW(
      canonical.winning_status, canonical.winning_rank, canonical.canonical_sent_at,
      canonical.canonical_delivered_at, canonical.canonical_read_at,
      canonical.canonical_failed_at, canonical.canonical_updated_at
    );
  GET DIAGNOSTICS updated_messages = ROW_COUNT;
  IF updated_messages = 1 THEN
    RETURN 'reconciled';
  END IF;
  RETURN 'unchanged';
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_reconcile_status(
  target_empresa_id INTEGER,
  target_provider_message_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reconciliation_result TEXT;
BEGIN
  PERFORM public.whatsapp_cloud_messages_lock_projection(target_empresa_id);
  SELECT public.whatsapp_cloud_messages_reconcile_status_locked(
    target_empresa_id,
    target_provider_message_id
  ) INTO reconciliation_result;
  RETURN reconciliation_result;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_capture_event_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.whatsapp_cloud_messages_lock_projection(NEW.empresa_id);

  IF NEW.event_kind = 'message'
     AND NEW.message_type IN ('text', 'image', 'document')
     AND NEW.sender_id ~ '^[0-9]{6,15}$'
     AND (NEW.message_type <> 'text'
       OR pg_catalog.jsonb_typeof(NEW.event_data->'text'->'body') = 'string') THEN
    INSERT INTO public.whatsapp_cloud_messages (
      empresa_id, direction, participant_wa_id, source_event_id,
      provider_message_id, message_type, text_body, media_mime_type,
      media_caption, document_filename, delivery_status, state_rank, message_at,
      created_at, updated_at
    ) VALUES (
      NEW.empresa_id,
      'inbound',
      NEW.sender_id,
      NEW.id,
      NULLIF(pg_catalog.BTRIM(NEW.message_id), ''),
      NEW.message_type,
      CASE WHEN NEW.message_type = 'text'
             AND pg_catalog.jsonb_typeof(NEW.event_data->'text'->'body') = 'string'
        THEN pg_catalog.LEFT(NEW.event_data->'text'->>'body', 4096) END,
      CASE WHEN NEW.message_type IN ('image', 'document')
             AND pg_catalog.jsonb_typeof(NEW.event_data->NEW.message_type->'mime_type') = 'string'
        THEN NULLIF(pg_catalog.LEFT(NEW.event_data->NEW.message_type->>'mime_type', 255), '') END,
      CASE WHEN NEW.message_type IN ('image', 'document')
             AND pg_catalog.jsonb_typeof(NEW.event_data->NEW.message_type->'caption') = 'string'
        THEN pg_catalog.LEFT(NEW.event_data->NEW.message_type->>'caption', 1024) END,
      CASE WHEN NEW.message_type = 'document'
             AND pg_catalog.jsonb_typeof(NEW.event_data->'document'->'filename') = 'string'
        THEN pg_catalog.LEFT(NEW.event_data->'document'->>'filename', 255) END,
      'received',
      0,
      CASE
        WHEN NEW.source_timestamp ~ '^[0-9]{1,12}$'
         AND NEW.source_timestamp::NUMERIC > 0
         AND NEW.source_timestamp::NUMERIC <= 253402300799
         AND pg_catalog.to_timestamp(NEW.source_timestamp::DOUBLE PRECISION)
             BETWEEN NEW.received_at - INTERVAL '30 days'
                 AND NEW.received_at + INTERVAL '5 minutes'
          THEN pg_catalog.to_timestamp(NEW.source_timestamp::DOUBLE PRECISION)
        ELSE NEW.received_at
      END,
      NEW.received_at,
      NEW.received_at
    ) ON CONFLICT DO NOTHING;
    PERFORM public.whatsapp_cloud_conversations_touch_locked(
      NEW.empresa_id,
      NEW.sender_id,
      TRUE,
      NEW.received_at
    );
  ELSIF NEW.event_kind = 'status'
        AND NEW.status IN ('sent', 'delivered', 'read', 'failed')
        AND NULLIF(pg_catalog.BTRIM(NEW.message_id), '') IS NOT NULL THEN
    PERFORM public.whatsapp_cloud_messages_reconcile_status(
      NEW.empresa_id,
      NULLIF(pg_catalog.BTRIM(NEW.message_id), '')
    );
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION IF EXISTS public.whatsapp_cloud_messages_upsert_outbox_locked(
  INTEGER, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_upsert_outbox_locked(
  target_empresa_id INTEGER,
  target_outbox_id BIGINT,
  target_telefono TEXT,
  target_mensaje TEXT,
  target_status TEXT,
  target_transport_origin TEXT,
  target_meta_message_id TEXT,
  target_cloud_dispatch_state TEXT,
  target_created_at TIMESTAMPTZ,
  target_sent_at TIMESTAMPTZ,
  target_link_outbox BOOLEAN DEFAULT TRUE
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  incoming_provider_message_id TEXT := NULLIF(pg_catalog.BTRIM(target_meta_message_id), '');
  incoming_status TEXT;
  incoming_rank SMALLINT;
  incoming_sent_at TIMESTAMPTZ;
  incoming_failed_at TIMESTAMPTZ;
  incoming_updated_at TIMESTAMPTZ;
BEGIN
  IF target_transport_origin IS DISTINCT FROM 'cloud'
     OR target_empresa_id IS NULL
     OR target_telefono !~ '^[0-9]{6,15}$'
     OR target_mensaje IS NULL THEN
    RETURN;
  END IF;

  incoming_status := CASE
    WHEN target_status = 'pending' THEN 'queued'
    WHEN target_status = 'sending' THEN 'sending'
    WHEN target_status = 'sent' THEN 'sent'
    WHEN target_status = 'error' AND target_cloud_dispatch_state = 'manual_retryable'
      THEN 'manual_retry'
    WHEN target_status = 'error' AND target_cloud_dispatch_state = 'outcome_unknown'
      THEN 'outcome_unknown'
    ELSE 'failed'
  END;
  incoming_rank := CASE incoming_status
    WHEN 'queued' THEN 10 WHEN 'manual_retry' THEN 15 WHEN 'sending' THEN 20
    WHEN 'failed' THEN 25 WHEN 'outcome_unknown' THEN 25 WHEN 'sent' THEN 30
  END;
  incoming_sent_at := CASE
    WHEN incoming_status = 'sent'
      THEN GREATEST(target_created_at, COALESCE(target_sent_at, target_created_at))
    WHEN incoming_status = 'failed' THEN NULL
    ELSE target_sent_at
  END;
  incoming_failed_at := CASE WHEN incoming_status = 'failed'
    THEN GREATEST(target_created_at, COALESCE(target_sent_at, target_created_at)) END;
  incoming_updated_at := GREATEST(target_created_at, COALESCE(target_sent_at, target_created_at));

  IF target_outbox_id IS NOT NULL THEN
    INSERT INTO public.whatsapp_cloud_messages (
      empresa_id, direction, participant_wa_id, outbox_id, source_outbox_id,
      provider_message_id, message_type, text_body, delivery_status, state_rank,
      message_at, sent_at, failed_at, created_at, updated_at
    ) VALUES (
      target_empresa_id, 'outbound', target_telefono,
      CASE WHEN target_link_outbox THEN target_outbox_id END,
      target_outbox_id,
      incoming_provider_message_id, 'text', pg_catalog.LEFT(target_mensaje, 4096),
      incoming_status, incoming_rank, target_created_at, incoming_sent_at,
      incoming_failed_at, target_created_at, incoming_updated_at
    ) ON CONFLICT (empresa_id, source_outbox_id) WHERE source_outbox_id IS NOT NULL
    DO UPDATE SET
      outbox_id = COALESCE(EXCLUDED.outbox_id, whatsapp_cloud_messages.outbox_id),
      participant_wa_id = EXCLUDED.participant_wa_id,
      provider_message_id = COALESCE(EXCLUDED.provider_message_id, whatsapp_cloud_messages.provider_message_id),
      text_body = EXCLUDED.text_body,
      delivery_status = CASE
        WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank THEN EXCLUDED.delivery_status
        WHEN whatsapp_cloud_messages.delivery_status = 'outcome_unknown'
         AND EXCLUDED.delivery_status IN ('failed', 'manual_retry') THEN EXCLUDED.delivery_status
        WHEN whatsapp_cloud_messages.delivery_status = 'manual_retry'
         AND EXCLUDED.delivery_status = 'queued' THEN EXCLUDED.delivery_status
        ELSE whatsapp_cloud_messages.delivery_status END,
      state_rank = CASE
        WHEN whatsapp_cloud_messages.delivery_status = 'outcome_unknown'
         AND EXCLUDED.delivery_status IN ('failed', 'manual_retry') THEN EXCLUDED.state_rank
        WHEN whatsapp_cloud_messages.delivery_status = 'manual_retry'
         AND EXCLUDED.delivery_status = 'queued' THEN EXCLUDED.state_rank
        ELSE GREATEST(whatsapp_cloud_messages.state_rank, EXCLUDED.state_rank) END,
      message_at = LEAST(whatsapp_cloud_messages.message_at, EXCLUDED.message_at),
      sent_at = CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN EXCLUDED.sent_at ELSE whatsapp_cloud_messages.sent_at END,
      delivered_at = CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN NULL ELSE whatsapp_cloud_messages.delivered_at END,
      read_at = CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN NULL ELSE whatsapp_cloud_messages.read_at END,
      failed_at = CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN EXCLUDED.failed_at ELSE whatsapp_cloud_messages.failed_at END,
      created_at = LEAST(whatsapp_cloud_messages.created_at, EXCLUDED.created_at),
      updated_at = GREATEST(whatsapp_cloud_messages.updated_at, EXCLUDED.updated_at)
    WHERE ROW(
      whatsapp_cloud_messages.outbox_id,
      whatsapp_cloud_messages.participant_wa_id,
      whatsapp_cloud_messages.provider_message_id,
      whatsapp_cloud_messages.text_body,
      whatsapp_cloud_messages.delivery_status,
      whatsapp_cloud_messages.state_rank,
      whatsapp_cloud_messages.message_at,
      whatsapp_cloud_messages.sent_at,
      whatsapp_cloud_messages.delivered_at,
      whatsapp_cloud_messages.read_at,
      whatsapp_cloud_messages.failed_at,
      whatsapp_cloud_messages.created_at,
      whatsapp_cloud_messages.updated_at
    ) IS DISTINCT FROM ROW(
      COALESCE(EXCLUDED.outbox_id, whatsapp_cloud_messages.outbox_id),
      EXCLUDED.participant_wa_id,
      COALESCE(EXCLUDED.provider_message_id, whatsapp_cloud_messages.provider_message_id),
      EXCLUDED.text_body,
      CASE
        WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank THEN EXCLUDED.delivery_status
        WHEN whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry') THEN EXCLUDED.delivery_status
        WHEN whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued' THEN EXCLUDED.delivery_status
        ELSE whatsapp_cloud_messages.delivery_status END,
      CASE
        WHEN whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry') THEN EXCLUDED.state_rank
        WHEN whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued' THEN EXCLUDED.state_rank
        ELSE GREATEST(whatsapp_cloud_messages.state_rank, EXCLUDED.state_rank) END,
      LEAST(whatsapp_cloud_messages.message_at, EXCLUDED.message_at),
      CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN EXCLUDED.sent_at ELSE whatsapp_cloud_messages.sent_at END,
      CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN NULL ELSE whatsapp_cloud_messages.delivered_at END,
      CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN NULL ELSE whatsapp_cloud_messages.read_at END,
      CASE WHEN EXCLUDED.state_rank > whatsapp_cloud_messages.state_rank
          OR (whatsapp_cloud_messages.delivery_status = 'outcome_unknown' AND EXCLUDED.delivery_status IN ('failed', 'manual_retry'))
          OR (whatsapp_cloud_messages.delivery_status = 'manual_retry' AND EXCLUDED.delivery_status = 'queued')
        THEN EXCLUDED.failed_at ELSE whatsapp_cloud_messages.failed_at END,
      LEAST(whatsapp_cloud_messages.created_at, EXCLUDED.created_at),
      GREATEST(whatsapp_cloud_messages.updated_at, EXCLUDED.updated_at)
    );
  END IF;

  IF incoming_provider_message_id IS NOT NULL THEN
    PERFORM public.whatsapp_cloud_messages_reconcile_status_locked(
      target_empresa_id,
      incoming_provider_message_id
    );
  END IF;
  PERFORM public.whatsapp_cloud_conversations_touch_locked(
    target_empresa_id,
    target_telefono,
    FALSE,
    incoming_updated_at
  );
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_capture_outbox_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.whatsapp_cloud_messages_lock_projection(NEW.empresa_id);
  PERFORM public.whatsapp_cloud_messages_upsert_outbox_locked(
    NEW.empresa_id, NEW.id, NEW.telefono, NEW.mensaje, NEW.status,
    NEW.transport_origin, NEW.meta_message_id, NEW.cloud_dispatch_state,
    NEW.created_at, NEW.sent_at
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_capture_outbox_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.whatsapp_cloud_messages_lock_projection(NEW.empresa_id);
  PERFORM public.whatsapp_cloud_messages_upsert_outbox_locked(
    NEW.empresa_id, NEW.id, NEW.telefono, NEW.mensaje, NEW.status,
    NEW.transport_origin, NEW.meta_message_id, NEW.cloud_dispatch_state,
    NEW.created_at, NEW.sent_at
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_reject_outbox_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (OLD.transport_origin = 'cloud' OR NEW.transport_origin = 'cloud')
     AND (OLD.transport_origin IS DISTINCT FROM NEW.transport_origin
       OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_outbox_identity_change_rejected';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_reject_source_outbox_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.source_outbox_id IS DISTINCT FROM NEW.source_outbox_id
     AND NOT (
       OLD.source_outbox_id IS NULL
       AND NEW.source_outbox_id IS NOT DISTINCT FROM OLD.outbox_id
       AND OLD.direction = 'outbound'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_source_outbox_identity_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_capture_event_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_empresa_id INTEGER;
  status_row RECORD;
  outbox_row RECORD;
BEGIN
  PERFORM public.whatsapp_cloud_messages_lock_projection_cleanup(ARRAY(
    SELECT DISTINCT deleted.empresa_id
      FROM deleted_rows AS deleted
     WHERE deleted.empresa_id IS NULL
        OR EXISTS (
       SELECT TRUE FROM public.empresas AS tenant
        WHERE tenant.id = deleted.empresa_id
     )
     ORDER BY deleted.empresa_id NULLS LAST
  ));

  FOR target_empresa_id IN
    SELECT DISTINCT deleted.empresa_id
      FROM deleted_rows AS deleted
     WHERE deleted.empresa_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.empresas AS tenant
          WHERE tenant.id = deleted.empresa_id
       )
     ORDER BY deleted.empresa_id
  LOOP
    INSERT INTO public.whatsapp_cloud_messages (
      empresa_id, direction, participant_wa_id, source_event_id,
      provider_message_id, message_type, text_body, media_mime_type,
      media_caption, document_filename, delivery_status, state_rank, message_at,
      created_at, updated_at
    )
    SELECT deleted.empresa_id,
           'inbound',
           deleted.sender_id,
           NULL,
           NULLIF(pg_catalog.BTRIM(deleted.message_id), ''),
           deleted.message_type,
           CASE WHEN deleted.message_type = 'text'
                  AND pg_catalog.jsonb_typeof(deleted.event_data->'text'->'body') = 'string'
             THEN pg_catalog.LEFT(deleted.event_data->'text'->>'body', 4096) END,
           CASE WHEN deleted.message_type IN ('image', 'document')
                  AND pg_catalog.jsonb_typeof(deleted.event_data->deleted.message_type->'mime_type') = 'string'
             THEN NULLIF(pg_catalog.LEFT(deleted.event_data->deleted.message_type->>'mime_type', 255), '') END,
           CASE WHEN deleted.message_type IN ('image', 'document')
                  AND pg_catalog.jsonb_typeof(deleted.event_data->deleted.message_type->'caption') = 'string'
             THEN pg_catalog.LEFT(deleted.event_data->deleted.message_type->>'caption', 1024) END,
           CASE WHEN deleted.message_type = 'document'
                  AND pg_catalog.jsonb_typeof(deleted.event_data->'document'->'filename') = 'string'
             THEN pg_catalog.LEFT(deleted.event_data->'document'->>'filename', 255) END,
           'received',
           0,
           CASE
             WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
              AND deleted.source_timestamp::NUMERIC > 0
              AND deleted.source_timestamp::NUMERIC <= 253402300799
              AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                  BETWEEN deleted.received_at - INTERVAL '30 days'
                      AND deleted.received_at + INTERVAL '5 minutes'
               THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
             ELSE deleted.received_at
           END,
           deleted.received_at,
           deleted.received_at
      FROM deleted_rows AS deleted
     WHERE deleted.empresa_id = target_empresa_id
       AND deleted.event_kind = 'message'
       AND deleted.message_type IN ('text', 'image', 'document')
       AND deleted.sender_id ~ '^[0-9]{6,15}$'
       AND (deleted.message_type <> 'text'
         OR pg_catalog.jsonb_typeof(deleted.event_data->'text'->'body') = 'string')
       AND NOT EXISTS (
         SELECT 1
           FROM public.whatsapp_cloud_messages AS projected
          WHERE projected.empresa_id = deleted.empresa_id
            AND projected.direction = 'inbound'
            AND projected.participant_wa_id = deleted.sender_id
            AND projected.provider_message_id IS NOT DISTINCT FROM NULLIF(pg_catalog.BTRIM(deleted.message_id), '')
            AND projected.message_type = deleted.message_type
            AND projected.message_at = CASE
              WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
               AND deleted.source_timestamp::NUMERIC > 0
               AND deleted.source_timestamp::NUMERIC <= 253402300799
               AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                   BETWEEN deleted.received_at - INTERVAL '30 days'
                       AND deleted.received_at + INTERVAL '5 minutes'
                THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
              ELSE deleted.received_at
            END
       )
     ORDER BY deleted.id
    ON CONFLICT DO NOTHING;

    INSERT INTO public.whatsapp_cloud_conversations (
      empresa_id, participant_wa_id, workflow_status, priority, version,
      created_at, updated_at
    )
    SELECT message.empresa_id,
           message.participant_wa_id,
           'pending',
           'normal',
           1,
           pg_catalog.MIN(message.created_at),
           pg_catalog.MAX(message.updated_at)
      FROM public.whatsapp_cloud_messages AS message
     WHERE message.empresa_id = target_empresa_id
     GROUP BY message.empresa_id, message.participant_wa_id
     ORDER BY message.participant_wa_id
    ON CONFLICT (empresa_id, participant_wa_id) DO NOTHING;

    FOR outbox_row IN
      SELECT outbox.*
        FROM public.wpp_outbox AS outbox
       WHERE outbox.empresa_id = target_empresa_id
         AND EXISTS (
           SELECT 1 FROM deleted_rows AS deleted
            WHERE deleted.empresa_id = outbox.empresa_id
              AND deleted.event_kind = 'status'
              AND deleted.status IN ('sent', 'delivered', 'read', 'failed')
              AND NULLIF(pg_catalog.BTRIM(deleted.message_id), '') = NULLIF(pg_catalog.BTRIM(outbox.meta_message_id), '')
         )
       ORDER BY outbox.id
    LOOP
      PERFORM public.whatsapp_cloud_messages_upsert_outbox_locked(
        outbox_row.empresa_id, outbox_row.id, outbox_row.telefono, outbox_row.mensaje,
        outbox_row.status, outbox_row.transport_origin, outbox_row.meta_message_id,
        outbox_row.cloud_dispatch_state, outbox_row.created_at, outbox_row.sent_at, FALSE
      );
    END LOOP;

    FOR status_row IN
      SELECT NULLIF(pg_catalog.BTRIM(deleted.message_id), '') AS provider_message_id,
             (pg_catalog.array_agg(deleted.status ORDER BY
               CASE deleted.status WHEN 'read' THEN 50 WHEN 'delivered' THEN 40
                                   WHEN 'sent' THEN 30 WHEN 'failed' THEN 25 ELSE 0 END DESC,
               CASE
                 WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
                  AND deleted.source_timestamp::NUMERIC > 0
                  AND deleted.source_timestamp::NUMERIC <= 253402300799
                  AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                      BETWEEN deleted.received_at - INTERVAL '30 days'
                          AND deleted.received_at + INTERVAL '5 minutes'
                   THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                 ELSE deleted.received_at
               END DESC))[1] AS latest_status,
             pg_catalog.MAX(CASE deleted.status WHEN 'read' THEN 50 WHEN 'delivered' THEN 40
                                     WHEN 'sent' THEN 30 WHEN 'failed' THEN 25 ELSE 0 END) AS latest_rank,
             pg_catalog.MIN(CASE
               WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
                AND deleted.source_timestamp::NUMERIC > 0
                AND deleted.source_timestamp::NUMERIC <= 253402300799
                AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                    BETWEEN deleted.received_at - INTERVAL '30 days'
                        AND deleted.received_at + INTERVAL '5 minutes'
                 THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
               ELSE deleted.received_at
             END) FILTER (WHERE deleted.status = 'sent') AS sent_at,
             pg_catalog.MIN(CASE
               WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
                AND deleted.source_timestamp::NUMERIC > 0
                AND deleted.source_timestamp::NUMERIC <= 253402300799
                AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                    BETWEEN deleted.received_at - INTERVAL '30 days'
                        AND deleted.received_at + INTERVAL '5 minutes'
                 THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
               ELSE deleted.received_at
             END) FILTER (WHERE deleted.status = 'delivered') AS delivered_at,
             pg_catalog.MIN(CASE
               WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
                AND deleted.source_timestamp::NUMERIC > 0
                AND deleted.source_timestamp::NUMERIC <= 253402300799
                AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                    BETWEEN deleted.received_at - INTERVAL '30 days'
                        AND deleted.received_at + INTERVAL '5 minutes'
                 THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
               ELSE deleted.received_at
             END) FILTER (WHERE deleted.status = 'read') AS read_at,
             pg_catalog.MIN(CASE
               WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
                AND deleted.source_timestamp::NUMERIC > 0
                AND deleted.source_timestamp::NUMERIC <= 253402300799
                AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                    BETWEEN deleted.received_at - INTERVAL '30 days'
                        AND deleted.received_at + INTERVAL '5 minutes'
                 THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
               ELSE deleted.received_at
             END) FILTER (WHERE deleted.status = 'failed') AS failed_at,
             pg_catalog.MAX(CASE
               WHEN deleted.source_timestamp ~ '^[0-9]{1,12}$'
                AND deleted.source_timestamp::NUMERIC > 0
                AND deleted.source_timestamp::NUMERIC <= 253402300799
                AND pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
                    BETWEEN deleted.received_at - INTERVAL '30 days'
                        AND deleted.received_at + INTERVAL '5 minutes'
                 THEN pg_catalog.to_timestamp(deleted.source_timestamp::DOUBLE PRECISION)
               ELSE deleted.received_at
             END) AS updated_at
        FROM deleted_rows AS deleted
       WHERE deleted.empresa_id = target_empresa_id
         AND deleted.event_kind = 'status'
         AND deleted.status IN ('sent', 'delivered', 'read', 'failed')
         AND NULLIF(pg_catalog.BTRIM(deleted.message_id), '') IS NOT NULL
       GROUP BY NULLIF(pg_catalog.BTRIM(deleted.message_id), '')
       ORDER BY NULLIF(pg_catalog.BTRIM(deleted.message_id), '')
    LOOP
      WITH locked AS (
        SELECT message.*,
               status_row.latest_status AS incoming_status,
               status_row.latest_rank AS incoming_rank,
               status_row.sent_at AS incoming_sent_at,
               status_row.delivered_at AS incoming_delivered_at,
               status_row.read_at AS incoming_read_at,
               status_row.failed_at AS incoming_failed_at,
               status_row.updated_at AS incoming_updated_at,
               GREATEST(message.state_rank, status_row.latest_rank) AS winning_rank,
               CASE WHEN public.whatsapp_cloud_messages_status_transition_wins(
                           message.delivery_status, message.state_rank,
                           status_row.latest_status, status_row.latest_rank
                         )
                 THEN status_row.latest_status ELSE message.delivery_status END AS winning_status
          FROM public.whatsapp_cloud_messages AS message
         WHERE message.empresa_id = target_empresa_id
           AND message.direction = 'outbound'
           AND pg_catalog.BTRIM(message.provider_message_id) = status_row.provider_message_id
         FOR UPDATE OF message
      ), sent_timeline AS (
        SELECT locked.*,
               CASE
                 WHEN winning_rank >= 30 THEN GREATEST(
                   message_at,
                   LEAST(sent_at, incoming_sent_at, incoming_delivered_at,
                         incoming_read_at, incoming_updated_at)
                 )
                 WHEN winning_status = 'failed' THEN NULL
                 ELSE sent_at
               END AS canonical_sent_at
          FROM locked
      ), delivered_timeline AS (
        SELECT sent_timeline.*,
               CASE WHEN winning_rank >= 40 THEN GREATEST(
                 canonical_sent_at,
                 LEAST(delivered_at, incoming_delivered_at, incoming_read_at)
               )
               WHEN winning_status IN ('failed', 'sent') THEN NULL
               ELSE delivered_at END AS canonical_delivered_at
          FROM sent_timeline
      ), canonical AS (
        SELECT delivered_timeline.*,
               CASE WHEN winning_rank >= 50 THEN GREATEST(
                 canonical_delivered_at,
                 LEAST(read_at, incoming_read_at)
               )
               WHEN winning_status IN ('failed', 'sent', 'delivered') THEN NULL
               ELSE read_at END AS canonical_read_at,
               CASE WHEN winning_status = 'failed' THEN GREATEST(
                 message_at,
                 LEAST(failed_at, incoming_failed_at, incoming_updated_at)
               )
               WHEN winning_rank >= 30 THEN NULL
               ELSE failed_at END AS canonical_failed_at
          FROM delivered_timeline
      )
      UPDATE public.whatsapp_cloud_messages AS message
         SET delivery_status = canonical.winning_status,
             state_rank = canonical.winning_rank,
             sent_at = canonical.canonical_sent_at,
             delivered_at = canonical.canonical_delivered_at,
             read_at = canonical.canonical_read_at,
             failed_at = canonical.canonical_failed_at,
             updated_at = GREATEST(canonical.updated_at, canonical.incoming_updated_at)
        FROM canonical
       WHERE message.id = canonical.id
         AND canonical.incoming_rank >= message.state_rank;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_cloud_messages_capture_outbox_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_empresa_id INTEGER;
  deleted_row RECORD;
BEGIN
  PERFORM public.whatsapp_cloud_messages_lock_projection_cleanup(ARRAY(
    SELECT DISTINCT deleted.empresa_id
      FROM deleted_rows AS deleted
     WHERE deleted.empresa_id IS NULL
        OR EXISTS (
       SELECT TRUE FROM public.empresas AS tenant
        WHERE tenant.id = deleted.empresa_id
     )
     ORDER BY deleted.empresa_id NULLS LAST
  ));

  FOR target_empresa_id IN
    SELECT DISTINCT deleted.empresa_id
      FROM deleted_rows AS deleted
     WHERE deleted.empresa_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.empresas AS tenant
          WHERE tenant.id = deleted.empresa_id
       )
     ORDER BY deleted.empresa_id
  LOOP
    FOR deleted_row IN
      SELECT deleted.*
        FROM deleted_rows AS deleted
       WHERE deleted.empresa_id = target_empresa_id
       ORDER BY deleted.id
    LOOP
      PERFORM public.whatsapp_cloud_messages_upsert_outbox_locked(
        deleted_row.empresa_id, deleted_row.id, deleted_row.telefono, deleted_row.mensaje,
        deleted_row.status, deleted_row.transport_origin, deleted_row.meta_message_id,
        deleted_row.cloud_dispatch_state, deleted_row.created_at, deleted_row.sent_at, FALSE
      );
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

DO $$
DECLARE
  trigger_spec RECORD;
  trigger_row RECORD;
BEGIN
  FOR trigger_spec IN
    SELECT * FROM (VALUES
      (
        'public.whatsapp_cloud_events'::pg_catalog.regclass,
        'whatsapp_cloud_messages_capture_insert'::TEXT,
        'public.whatsapp_cloud_messages_capture_event_insert()'::pg_catalog.regprocedure,
        5::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_capture_insert AFTER INSERT ON whatsapp_cloud_events FOR EACH ROW EXECUTE FUNCTION whatsapp_cloud_messages_capture_event_insert()',
        'CREATE TRIGGER whatsapp_cloud_messages_capture_insert AFTER INSERT ON public.whatsapp_cloud_events FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_event_insert()'
      ),
      (
        'public.wpp_outbox'::pg_catalog.regclass,
        'whatsapp_cloud_messages_capture_insert'::TEXT,
        'public.whatsapp_cloud_messages_capture_outbox_insert()'::pg_catalog.regprocedure,
        5::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_capture_insert AFTER INSERT ON wpp_outbox FOR EACH ROW EXECUTE FUNCTION whatsapp_cloud_messages_capture_outbox_insert()',
        'CREATE TRIGGER whatsapp_cloud_messages_capture_insert AFTER INSERT ON public.wpp_outbox FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_outbox_insert()'
      ),
      (
        'public.wpp_outbox'::pg_catalog.regclass,
        'whatsapp_cloud_messages_reject_identity_change'::TEXT,
        'public.whatsapp_cloud_messages_reject_outbox_identity_change()'::pg_catalog.regprocedure,
        19::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_reject_identity_change BEFORE UPDATE OF empresa_id, transport_origin ON wpp_outbox FOR EACH ROW EXECUTE FUNCTION whatsapp_cloud_messages_reject_outbox_identity_change()',
        'CREATE TRIGGER whatsapp_cloud_messages_reject_identity_change BEFORE UPDATE OF empresa_id, transport_origin ON public.wpp_outbox FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_reject_outbox_identity_change()'
      ),
      (
        'public.whatsapp_cloud_messages'::pg_catalog.regclass,
        'whatsapp_cloud_messages_reject_source_outbox_identity_change'::TEXT,
        'public.whatsapp_cloud_messages_reject_source_outbox_identity_change()'::pg_catalog.regprocedure,
        19::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_reject_source_outbox_identity_change BEFORE UPDATE OF source_outbox_id ON whatsapp_cloud_messages FOR EACH ROW EXECUTE FUNCTION whatsapp_cloud_messages_reject_source_outbox_identity_change()',
        'CREATE TRIGGER whatsapp_cloud_messages_reject_source_outbox_identity_change BEFORE UPDATE OF source_outbox_id ON public.whatsapp_cloud_messages FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_reject_source_outbox_identity_change()'
      ),
      (
        'public.wpp_outbox'::pg_catalog.regclass,
        'whatsapp_cloud_messages_capture_update'::TEXT,
        'public.whatsapp_cloud_messages_capture_outbox_update()'::pg_catalog.regprocedure,
        17::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_capture_update AFTER UPDATE OF empresa_id, telefono, mensaje, status, sent_at, transport_origin, meta_message_id, cloud_dispatch_state ON wpp_outbox FOR EACH ROW EXECUTE FUNCTION whatsapp_cloud_messages_capture_outbox_update()',
        'CREATE TRIGGER whatsapp_cloud_messages_capture_update AFTER UPDATE OF empresa_id, telefono, mensaje, status, sent_at, transport_origin, meta_message_id, cloud_dispatch_state ON public.wpp_outbox FOR EACH ROW EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_outbox_update()'
      ),
      (
        'public.whatsapp_cloud_events'::pg_catalog.regclass,
        'whatsapp_cloud_messages_capture_delete'::TEXT,
        'public.whatsapp_cloud_messages_capture_event_delete()'::pg_catalog.regprocedure,
        8::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_capture_delete AFTER DELETE ON whatsapp_cloud_events REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION whatsapp_cloud_messages_capture_event_delete()',
        'CREATE TRIGGER whatsapp_cloud_messages_capture_delete AFTER DELETE ON public.whatsapp_cloud_events REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_event_delete()'
      ),
      (
        'public.wpp_outbox'::pg_catalog.regclass,
        'whatsapp_cloud_messages_capture_delete'::TEXT,
        'public.whatsapp_cloud_messages_capture_outbox_delete()'::pg_catalog.regprocedure,
        8::SMALLINT,
        'CREATE TRIGGER whatsapp_cloud_messages_capture_delete AFTER DELETE ON wpp_outbox REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION whatsapp_cloud_messages_capture_outbox_delete()',
        'CREATE TRIGGER whatsapp_cloud_messages_capture_delete AFTER DELETE ON public.wpp_outbox REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.whatsapp_cloud_messages_capture_outbox_delete()'
      )
    ) AS required(table_oid, trigger_name, function_oid, expected_type, expected_definition, create_sql)
  LOOP
    SELECT trigger_meta.tgrelid,
           trigger_meta.tgfoid,
           trigger_meta.tgenabled,
           trigger_meta.tgtype,
           trigger_meta.tgisinternal,
           trigger_meta.tgnargs,
           trigger_meta.tgargs,
           pg_catalog.pg_get_triggerdef(trigger_meta.oid, true) AS definition
      INTO trigger_row
      FROM pg_catalog.pg_trigger AS trigger_meta
     WHERE trigger_meta.tgrelid = trigger_spec.table_oid
       AND trigger_meta.tgname = trigger_spec.trigger_name;

    IF FOUND AND NOT (
      trigger_row.tgrelid = trigger_spec.table_oid
      AND trigger_row.tgfoid = trigger_spec.function_oid
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = trigger_spec.expected_type
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgargs = '\x'::pg_catalog.bytea
      AND trigger_row.definition = trigger_spec.expected_definition
    ) THEN
      EXECUTE pg_catalog.format(
        'DROP TRIGGER %I ON %s',
        trigger_spec.trigger_name, trigger_spec.table_oid
      );
      EXECUTE trigger_spec.create_sql;
    ELSIF NOT FOUND THEN
      EXECUTE trigger_spec.create_sql;
    END IF;
  END LOOP;
END $$;

-- CUTOVER CAPTURE INSTALL COMPLETE; DDL/REPAIRS STILL PRECEDE TENANT DML

DO $drop_legacy_provider_unique$
DECLARE
  legacy_index pg_catalog.REGCLASS := pg_catalog.to_regclass('public.whatsapp_cloud_messages_provider_message_uidx');
  backing_constraint TEXT;
BEGIN
  IF legacy_index IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
     WHERE indexrelid = legacy_index
       AND indrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
  ) THEN
    SELECT conname INTO backing_constraint
      FROM pg_catalog.pg_constraint
     WHERE conindid = legacy_index;
    IF backing_constraint IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.whatsapp_cloud_messages DROP CONSTRAINT %I', backing_constraint
      );
    ELSE
      DROP INDEX public.whatsapp_cloud_messages_provider_message_uidx;
    END IF;
  END IF;
END $drop_legacy_provider_unique$;

DO $repair_source_outbox_identity$
BEGIN
  UPDATE public.whatsapp_cloud_messages
     SET source_outbox_id = outbox_id
   WHERE direction = 'outbound'
     AND outbox_id IS NOT NULL
     AND source_outbox_id IS DISTINCT FROM outbox_id;
END $repair_source_outbox_identity$;

DO $repair_state_rank$
DECLARE
  target_empresa_id INTEGER;
BEGIN
  FOR target_empresa_id IN
    SELECT DISTINCT message.empresa_id
      FROM public.whatsapp_cloud_messages AS message
     WHERE message.empresa_id IS NOT NULL
     ORDER BY message.empresa_id
  LOOP
    -- PRE-DDL REPAIR STATE START
    UPDATE public.whatsapp_cloud_messages
       SET state_rank = CASE delivery_status
             WHEN 'received' THEN 0
             WHEN 'queued' THEN 10
             WHEN 'manual_retry' THEN 15
             WHEN 'sending' THEN 20
             WHEN 'failed' THEN 25
             WHEN 'outcome_unknown' THEN 25
             WHEN 'sent' THEN 30
             WHEN 'delivered' THEN 40
             WHEN 'read' THEN 50
             ELSE state_rank
           END,
           created_at = COALESCE(created_at, message_at, pg_catalog.NOW()),
           updated_at = COALESCE(updated_at, created_at, message_at, pg_catalog.NOW())
     WHERE empresa_id = target_empresa_id
       AND (state_rank IS DISTINCT FROM CASE delivery_status
             WHEN 'received' THEN 0
             WHEN 'queued' THEN 10
             WHEN 'manual_retry' THEN 15
             WHEN 'sending' THEN 20
             WHEN 'failed' THEN 25
             WHEN 'outcome_unknown' THEN 25
             WHEN 'sent' THEN 30
             WHEN 'delivered' THEN 40
             WHEN 'read' THEN 50
             ELSE state_rank
           END
        OR created_at IS NULL
        OR updated_at IS NULL);
  END LOOP;
END $repair_state_rank$;

DO $repair_content_lengths$
DECLARE
  target_empresa_id INTEGER;
BEGIN
  FOR target_empresa_id IN
    SELECT DISTINCT message.empresa_id
      FROM public.whatsapp_cloud_messages AS message
     WHERE message.empresa_id IS NOT NULL
     ORDER BY message.empresa_id
  LOOP
    -- PRE-DDL REPAIR CONTENT START
    UPDATE public.whatsapp_cloud_messages
       SET text_body = pg_catalog.LEFT(text_body, 4096),
           media_mime_type = pg_catalog.LEFT(media_mime_type, 255),
           media_caption = pg_catalog.LEFT(media_caption, 1024),
           document_filename = pg_catalog.LEFT(document_filename, 255)
     WHERE empresa_id = target_empresa_id
       AND (pg_catalog.length(text_body) > 4096
        OR pg_catalog.length(media_mime_type) > 255
        OR pg_catalog.length(media_caption) > 1024
        OR pg_catalog.length(document_filename) > 255);
  END LOOP;
END $repair_content_lengths$;

DO $repair_timeline$
DECLARE
  target_empresa_id INTEGER;
BEGIN
  FOR target_empresa_id IN
    SELECT DISTINCT message.empresa_id
      FROM public.whatsapp_cloud_messages AS message
     WHERE message.empresa_id IS NOT NULL
     ORDER BY message.empresa_id
  LOOP
    -- PRE-DDL REPAIR TIMELINE START
    WITH sent_timeline AS (
      SELECT id,
             CASE
               WHEN direction = 'inbound' OR delivery_status IN ('queued', 'failed') THEN NULL
               WHEN delivery_status IN ('sent', 'delivered', 'read') THEN GREATEST(
                 message_at,
                 CASE delivery_status
                   WHEN 'sent' THEN COALESCE(sent_at, message_at)
                   WHEN 'delivered' THEN COALESCE(sent_at, delivered_at, message_at)
                   WHEN 'read' THEN COALESCE(sent_at, delivered_at, read_at, message_at)
                 END
               )
               WHEN sent_at IS NOT NULL THEN GREATEST(message_at, sent_at)
               ELSE NULL
             END AS canonical_sent_at,
             direction,
             delivery_status,
             message_at,
             sent_at,
             delivered_at,
             read_at,
             failed_at,
             created_at,
             updated_at
        FROM public.whatsapp_cloud_messages
       WHERE empresa_id = target_empresa_id
    ), delivered_timeline AS (
      SELECT sent_timeline.*,
             CASE
               WHEN delivery_status IN ('delivered', 'read') THEN GREATEST(
                 canonical_sent_at,
                 CASE delivery_status
                   WHEN 'delivered' THEN COALESCE(delivered_at, canonical_sent_at)
                   WHEN 'read' THEN COALESCE(delivered_at, read_at, canonical_sent_at)
                 END
               )
               ELSE NULL
             END AS canonical_delivered_at
        FROM sent_timeline
    ), canonical AS (
      SELECT delivered_timeline.*,
             CASE WHEN delivery_status = 'read'
               THEN GREATEST(canonical_delivered_at, COALESCE(read_at, canonical_delivered_at))
               ELSE NULL
             END AS canonical_read_at,
             CASE WHEN delivery_status = 'failed'
               THEN GREATEST(
                 message_at,
                 COALESCE(failed_at, sent_at, updated_at, created_at, message_at)
               )
               ELSE NULL
             END AS canonical_failed_at
        FROM delivered_timeline
    )
    UPDATE public.whatsapp_cloud_messages AS message
       SET sent_at = canonical.canonical_sent_at,
           delivered_at = canonical.canonical_delivered_at,
           read_at = canonical.canonical_read_at,
           failed_at = canonical.canonical_failed_at
      FROM canonical
     WHERE message.empresa_id = target_empresa_id
       AND message.id = canonical.id
       AND ROW(message.sent_at, message.delivered_at, message.read_at, message.failed_at)
           IS DISTINCT FROM ROW(
             canonical.canonical_sent_at, canonical.canonical_delivered_at,
             canonical.canonical_read_at, canonical.canonical_failed_at
           );
  END LOOP;
END $repair_timeline$;

DO $$
DECLARE
  column_name TEXT;
BEGIN
  IF COALESCE((
    SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
      FROM pg_attribute AS column_row
      LEFT JOIN pg_attrdef AS default_row
        ON default_row.adrelid = column_row.attrelid
       AND default_row.adnum = column_row.attnum
     WHERE column_row.attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND column_row.attname = 'created_at'
  ), '') <> 'now()' THEN
    ALTER TABLE public.whatsapp_cloud_messages ALTER COLUMN created_at SET DEFAULT pg_catalog.NOW();
  END IF;
  IF COALESCE((
    SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
      FROM pg_attribute AS column_row
      LEFT JOIN pg_attrdef AS default_row
        ON default_row.adrelid = column_row.attrelid
       AND default_row.adnum = column_row.attnum
     WHERE column_row.attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND column_row.attname = 'updated_at'
  ), '') <> 'now()' THEN
    ALTER TABLE public.whatsapp_cloud_messages ALTER COLUMN updated_at SET DEFAULT pg_catalog.NOW();
  END IF;

  FOREACH column_name IN ARRAY ARRAY[
    'id', 'empresa_id', 'direction', 'participant_wa_id', 'message_type',
    'delivery_status', 'state_rank', 'message_at', 'created_at', 'updated_at'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
         AND attname = column_name AND NOT attisdropped AND NOT attnotnull
    ) THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.whatsapp_cloud_messages ALTER COLUMN %I SET NOT NULL',
        column_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  canonical_index pg_catalog.REGCLASS := pg_catalog.to_regclass(
    'public.whatsapp_cloud_messages_provider_message_idx'
  );
BEGIN
  IF EXISTS (
    WITH eligible_outboxes AS (
      SELECT source.id,
             source.empresa_id,
             NULLIF(pg_catalog.BTRIM(source.meta_message_id), '') AS provider_message_id
        FROM public.wpp_outbox AS source
       WHERE source.transport_origin = 'cloud'
         AND source.empresa_id IS NOT NULL
         AND source.telefono ~ '^[0-9]{6,15}$'
         AND source.mensaje IS NOT NULL
    ), provider_identities AS (
      SELECT message.empresa_id,
             COALESCE(
               source.provider_message_id,
               NULLIF(pg_catalog.BTRIM(message.provider_message_id), '')
             ) AS provider_message_id
        FROM public.whatsapp_cloud_messages AS message
        LEFT JOIN eligible_outboxes AS source
          ON source.empresa_id = message.empresa_id
         AND source.id = message.source_outbox_id
       WHERE message.direction = 'outbound'
      UNION ALL
      SELECT source.empresa_id,
             source.provider_message_id
        FROM eligible_outboxes AS source
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.whatsapp_cloud_messages AS message
          WHERE message.empresa_id = source.empresa_id
            AND message.source_outbox_id = source.id
            AND message.direction = 'outbound'
       )
    )
    SELECT 1
      FROM provider_identities
     WHERE provider_message_id IS NOT NULL
     GROUP BY empresa_id, provider_message_id
    HAVING pg_catalog.COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_cloud_messages_provider_identity_duplicates';
  END IF;

  UPDATE public.whatsapp_cloud_messages
     SET provider_message_id = NULLIF(pg_catalog.BTRIM(provider_message_id), '')
   WHERE provider_message_id IS DISTINCT FROM NULLIF(pg_catalog.BTRIM(provider_message_id), '');

  IF canonical_index IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS candidate
      JOIN pg_catalog.pg_class AS index_class ON index_class.oid = candidate.indexrelid
      JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_class.relam
     WHERE candidate.indexrelid = canonical_index
       AND index_namespace.nspname = 'public'
       AND index_class.relname = 'whatsapp_cloud_messages_provider_message_idx'
       AND candidate.indrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND access_method.amname = 'btree'
       AND candidate.indisvalid
       AND candidate.indisready
       AND candidate.indisunique
       AND candidate.indexprs IS NULL
       AND candidate.indnkeyatts = 2
       AND candidate.indnatts = 2
       AND candidate.indoption::TEXT = '0 0'
       AND (
         SELECT pg_catalog.array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
           FROM pg_catalog.unnest(candidate.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
           JOIN pg_catalog.pg_attribute AS attribute_row
             ON attribute_row.attrelid = candidate.indrelid
            AND attribute_row.attnum = key_column.attnum
       ) = ARRAY['empresa_id', 'provider_message_id']::TEXT[]
       AND pg_catalog.pg_get_expr(candidate.indpred, candidate.indrelid) =
         '((provider_message_id IS NOT NULL) AND (direction = ''outbound''::text))'
  ) THEN
    DROP INDEX public.whatsapp_cloud_messages_provider_message_idx;
    canonical_index := NULL;
  END IF;

  IF canonical_index IS NULL THEN
    CREATE UNIQUE INDEX whatsapp_cloud_messages_provider_message_idx
      ON public.whatsapp_cloud_messages USING btree (empresa_id, provider_message_id)
      WHERE provider_message_id IS NOT NULL AND direction = 'outbound';
  END IF;
END $$;

DO $$
DECLARE
  index_row RECORD;
  backing_constraint RECORD;
  expected_columns TEXT[];
  expected_unique BOOLEAN;
  expected_predicate TEXT;
BEGIN
  FOR index_row IN
    SELECT * FROM (VALUES
      ('public.whatsapp_cloud_events_empresa_id_id_uidx', 'public.whatsapp_cloud_events',
       ARRAY['empresa_id', 'id']::TEXT[], TRUE, NULL::TEXT),
      ('public.wpp_outbox_empresa_id_id_uidx', 'public.wpp_outbox',
       ARRAY['empresa_id', 'id']::TEXT[], TRUE, NULL::TEXT),
      ('public.whatsapp_cloud_messages_source_event_uidx', 'public.whatsapp_cloud_messages',
       ARRAY['empresa_id', 'source_event_id']::TEXT[], TRUE, 'source_event_idisnotnull'),
      ('public.whatsapp_cloud_messages_outbox_uidx', 'public.whatsapp_cloud_messages',
       ARRAY['empresa_id', 'outbox_id']::TEXT[], TRUE, 'outbox_idisnotnull'),
      ('public.whatsapp_cloud_messages_source_outbox_uidx', 'public.whatsapp_cloud_messages',
       ARRAY['empresa_id', 'source_outbox_id']::TEXT[], TRUE, 'source_outbox_idisnotnull')
    ) AS required(index_name, table_name, key_columns, is_unique, predicate_key)
  LOOP
    expected_columns := index_row.key_columns;
    expected_unique := index_row.is_unique;
    expected_predicate := index_row.predicate_key;
    IF pg_catalog.to_regclass(index_row.index_name) IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_index AS candidate
       WHERE candidate.indexrelid = pg_catalog.to_regclass(index_row.index_name)
         AND candidate.indrelid = index_row.table_name::pg_catalog.regclass
         AND candidate.indisunique = expected_unique
         AND candidate.indexprs IS NULL
         AND candidate.indnkeyatts = pg_catalog.cardinality(expected_columns)
         AND candidate.indnatts = pg_catalog.cardinality(expected_columns)
         AND candidate.indoption::TEXT = pg_catalog.array_to_string(pg_catalog.array_fill(0, ARRAY[pg_catalog.cardinality(expected_columns)]), ' ')
         AND (
           SELECT pg_catalog.array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
             FROM pg_catalog.unnest(candidate.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
             JOIN pg_attribute AS attribute_row
               ON attribute_row.attrelid = candidate.indrelid
              AND attribute_row.attnum = key_column.attnum
            WHERE key_column.ordinality <= candidate.indnkeyatts
         ) = expected_columns
         AND CASE
           WHEN expected_predicate IS NULL THEN candidate.indpred IS NULL
           ELSE pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.pg_get_expr(candidate.indpred, candidate.indrelid)), '[^a-z_]', '', 'g')
                = expected_predicate
         END
    ) THEN
      SELECT constraint_row.conrelid::regclass AS table_name, constraint_row.conname
        INTO backing_constraint
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conindid = pg_catalog.to_regclass(index_row.index_name);
      IF FOUND THEN
        EXECUTE pg_catalog.format('ALTER TABLE %s DROP CONSTRAINT %I', backing_constraint.table_name, backing_constraint.conname);
      ELSE
        EXECUTE pg_catalog.format('DROP INDEX %s', index_row.index_name);
      END IF;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.whatsapp_cloud_events_empresa_id_id_uidx') IS NULL THEN
    CREATE UNIQUE INDEX whatsapp_cloud_events_empresa_id_id_uidx
      ON public.whatsapp_cloud_events (empresa_id, id);
  END IF;
  IF pg_catalog.to_regclass('public.wpp_outbox_empresa_id_id_uidx') IS NULL THEN
    CREATE UNIQUE INDEX wpp_outbox_empresa_id_id_uidx
      ON public.wpp_outbox (empresa_id, id);
  END IF;
  IF pg_catalog.to_regclass('public.whatsapp_cloud_messages_source_event_uidx') IS NULL THEN
    CREATE UNIQUE INDEX whatsapp_cloud_messages_source_event_uidx
      ON public.whatsapp_cloud_messages (empresa_id, source_event_id)
      WHERE source_event_id IS NOT NULL;
  END IF;
  IF pg_catalog.to_regclass('public.whatsapp_cloud_messages_outbox_uidx') IS NULL THEN
    CREATE UNIQUE INDEX whatsapp_cloud_messages_outbox_uidx
      ON public.whatsapp_cloud_messages (empresa_id, outbox_id)
      WHERE outbox_id IS NOT NULL;
  END IF;
  IF pg_catalog.to_regclass('public.whatsapp_cloud_messages_source_outbox_uidx') IS NULL THEN
    CREATE UNIQUE INDEX whatsapp_cloud_messages_source_outbox_uidx
      ON public.whatsapp_cloud_messages (empresa_id, source_outbox_id)
      WHERE source_outbox_id IS NOT NULL;
  END IF;
END $$;

DO $$
DECLARE
  canonical_index pg_catalog.REGCLASS := pg_catalog.to_regclass(
    'public.whatsapp_cloud_events_status_message_idx'
  );
BEGIN
  IF canonical_index IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS candidate
      JOIN pg_catalog.pg_class AS index_class ON index_class.oid = candidate.indexrelid
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_class.relnamespace
      JOIN pg_catalog.pg_class AS table_class ON table_class.oid = candidate.indrelid
      JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_class.relam
     WHERE candidate.indexrelid = canonical_index
       AND index_namespace.nspname = 'public'
       AND index_class.relname = 'whatsapp_cloud_events_status_message_idx'
       AND table_namespace.nspname = 'public'
       AND table_class.relname = 'whatsapp_cloud_events'
       AND candidate.indrelid = 'public.whatsapp_cloud_events'::pg_catalog.regclass
       AND access_method.amname = 'btree'
       AND candidate.indisvalid
       AND candidate.indisready
       AND NOT candidate.indisunique
       AND candidate.indnkeyatts = 2
       AND candidate.indnatts = 5
       AND candidate.indoption::TEXT = '0 0'
       AND (
         SELECT pg_catalog.array_agg(
                  attribute_row.attname::TEXT ORDER BY index_column.ordinality
                )
           FROM pg_catalog.unnest(candidate.indkey) WITH ORDINALITY
             AS index_column(attnum, ordinality)
           LEFT JOIN pg_catalog.pg_attribute AS attribute_row
             ON attribute_row.attrelid = candidate.indrelid
            AND attribute_row.attnum = index_column.attnum
          WHERE index_column.ordinality <= candidate.indnkeyatts
       ) IS NOT DISTINCT FROM ARRAY['empresa_id', NULL]::TEXT[]
       AND pg_catalog.pg_get_expr(candidate.indexprs, candidate.indrelid) =
         'btrim(message_id)'
       AND (
         SELECT pg_catalog.array_agg(
                  attribute_row.attname::TEXT ORDER BY index_column.ordinality
                )
           FROM pg_catalog.unnest(candidate.indkey) WITH ORDINALITY
             AS index_column(attnum, ordinality)
           JOIN pg_catalog.pg_attribute AS attribute_row
             ON attribute_row.attrelid = candidate.indrelid
            AND attribute_row.attnum = index_column.attnum
          WHERE index_column.ordinality > candidate.indnkeyatts
       ) = ARRAY['status', 'source_timestamp', 'received_at']::TEXT[]
       AND pg_catalog.pg_get_expr(candidate.indpred, candidate.indrelid) =
         '((event_kind = ''status''::text) AND (status = ANY (ARRAY[''sent''::text, ''delivered''::text, ''read''::text, ''failed''::text])) AND (NULLIF(btrim(message_id), ''''::text) IS NOT NULL))'
  ) THEN
    DROP INDEX public.whatsapp_cloud_events_status_message_idx;
    canonical_index := NULL;
  END IF;

  IF canonical_index IS NULL THEN
    -- The productive reconciliation CTE reads these three values after the
    -- normalized tenant/message lookup, so INCLUDE keeps that lookup covered.
    CREATE INDEX whatsapp_cloud_events_status_message_idx
      ON public.whatsapp_cloud_events USING btree
        (empresa_id, (pg_catalog.btrim(message_id)))
      INCLUDE (status, source_timestamp, received_at)
      WHERE event_kind = 'status'
        AND status IN ('sent', 'delivered', 'read', 'failed')
        AND NULLIF(pg_catalog.BTRIM(message_id), '') IS NOT NULL;
  END IF;
END $$;

DO $$
DECLARE
  constraint_row RECORD;
  current_definition TEXT;
  current_validated BOOLEAN;
  expected_definition TEXT;
BEGIN
  FOR constraint_row IN
    SELECT * FROM (VALUES
      ('whatsapp_cloud_messages_empresa_id_fkey',
       'FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE'),
      ('whatsapp_cloud_messages_source_event_fkey',
       'FOREIGN KEY (empresa_id, source_event_id) REFERENCES public.whatsapp_cloud_events(empresa_id, id) ON DELETE SET NULL (source_event_id)'),
      ('whatsapp_cloud_messages_outbox_fkey',
       'FOREIGN KEY (empresa_id, outbox_id) REFERENCES public.wpp_outbox(empresa_id, id) ON DELETE SET NULL (outbox_id)'),
      ('whatsapp_cloud_messages_direction_check',
       'CHECK (direction IN (''inbound'', ''outbound''))'),
      ('whatsapp_cloud_messages_participant_check',
       'CHECK (participant_wa_id ~ ''^[0-9]{6,15}$'')'),
      ('whatsapp_cloud_messages_type_check',
       'CHECK (message_type IN (''text'', ''image'', ''document''))'),
      ('whatsapp_cloud_messages_content_check',
       'CHECK (((message_type = ''text'' AND text_body IS NOT NULL AND media_mime_type IS NULL AND media_caption IS NULL AND document_filename IS NULL) OR (message_type = ''image'' AND text_body IS NULL AND document_filename IS NULL) OR (message_type = ''document'' AND text_body IS NULL)))'),
      ('whatsapp_cloud_messages_content_length_check',
       'CHECK ((pg_catalog.length(COALESCE(text_body, '''')) <= 4096 AND pg_catalog.length(COALESCE(media_mime_type, '''')) <= 255 AND pg_catalog.length(COALESCE(media_caption, '''')) <= 1024 AND pg_catalog.length(COALESCE(document_filename, '''')) <= 255))'),
      ('whatsapp_cloud_messages_delivery_status_check',
       'CHECK (delivery_status IN (''received'', ''queued'', ''sending'', ''sent'', ''delivered'', ''read'', ''failed'', ''manual_retry'', ''outcome_unknown''))'),
      ('whatsapp_cloud_messages_direction_status_check',
       'CHECK (((direction = ''inbound'' AND delivery_status = ''received'') OR (direction = ''outbound'' AND delivery_status IN (''queued'', ''sending'', ''sent'', ''delivered'', ''read'', ''failed'', ''manual_retry'', ''outcome_unknown''))))'),
      ('whatsapp_cloud_messages_state_rank_check',
       'CHECK (state_rank = CASE delivery_status WHEN ''received'' THEN 0 WHEN ''queued'' THEN 10 WHEN ''manual_retry'' THEN 15 WHEN ''sending'' THEN 20 WHEN ''failed'' THEN 25 WHEN ''outcome_unknown'' THEN 25 WHEN ''sent'' THEN 30 WHEN ''delivered'' THEN 40 WHEN ''read'' THEN 50 END)'),
      ('whatsapp_cloud_messages_timestamps_check',
       'CHECK (((direction = ''inbound'' AND sent_at IS NULL AND delivered_at IS NULL AND read_at IS NULL AND failed_at IS NULL) OR (direction = ''outbound'' AND (sent_at IS NULL OR sent_at >= message_at) AND (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at)) AND (read_at IS NULL OR (delivered_at IS NOT NULL AND read_at >= delivered_at)) AND (failed_at IS NULL OR failed_at >= message_at) AND (CASE delivery_status WHEN ''queued'' THEN (sent_at IS NULL AND delivered_at IS NULL AND read_at IS NULL AND failed_at IS NULL) WHEN ''sending'' THEN (delivered_at IS NULL AND read_at IS NULL AND failed_at IS NULL) WHEN ''manual_retry'' THEN (delivered_at IS NULL AND read_at IS NULL AND failed_at IS NULL) WHEN ''outcome_unknown'' THEN (delivered_at IS NULL AND read_at IS NULL AND failed_at IS NULL) WHEN ''sent'' THEN (sent_at IS NOT NULL AND delivered_at IS NULL AND read_at IS NULL AND failed_at IS NULL) WHEN ''delivered'' THEN (sent_at IS NOT NULL AND delivered_at IS NOT NULL AND read_at IS NULL AND failed_at IS NULL) WHEN ''read'' THEN (sent_at IS NOT NULL AND delivered_at IS NOT NULL AND read_at IS NOT NULL AND failed_at IS NULL) WHEN ''failed'' THEN (sent_at IS NULL AND delivered_at IS NULL AND read_at IS NULL AND failed_at IS NOT NULL) ELSE FALSE END))))'),
      ('whatsapp_cloud_messages_source_direction_check',
       'CHECK (source_event_id IS NULL OR (direction = ''inbound'' AND outbox_id IS NULL))'),
      ('whatsapp_cloud_messages_outbox_direction_check',
       'CHECK (outbox_id IS NULL OR (direction = ''outbound'' AND source_event_id IS NULL))'),
      ('whatsapp_cloud_messages_source_outbox_direction_check',
       'CHECK (source_outbox_id IS NULL OR (direction = ''outbound'' AND source_event_id IS NULL))')
    ) AS required(constraint_name, definition_sql)
  LOOP
    expected_definition := CASE constraint_row.constraint_name
      WHEN 'whatsapp_cloud_messages_empresa_id_fkey'
        THEN 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE'
      WHEN 'whatsapp_cloud_messages_source_event_fkey'
        THEN 'FOREIGN KEY (empresa_id, source_event_id) REFERENCES whatsapp_cloud_events(empresa_id, id) ON DELETE SET NULL (source_event_id)'
      WHEN 'whatsapp_cloud_messages_outbox_fkey'
        THEN 'FOREIGN KEY (empresa_id, outbox_id) REFERENCES wpp_outbox(empresa_id, id) ON DELETE SET NULL (outbox_id)'
      WHEN 'whatsapp_cloud_messages_direction_check'
        THEN 'CHECK ((direction = ANY (ARRAY[''inbound''::text, ''outbound''::text])))'
      WHEN 'whatsapp_cloud_messages_participant_check'
        THEN 'CHECK ((participant_wa_id ~ ''^[0-9]{6,15}$''::text))'
      WHEN 'whatsapp_cloud_messages_type_check'
        THEN 'CHECK ((message_type = ANY (ARRAY[''text''::text, ''image''::text, ''document''::text])))'
      WHEN 'whatsapp_cloud_messages_content_check'
        THEN 'CHECK ((((message_type = ''text''::text) AND (text_body IS NOT NULL) AND (media_mime_type IS NULL) AND (media_caption IS NULL) AND (document_filename IS NULL)) OR ((message_type = ''image''::text) AND (text_body IS NULL) AND (document_filename IS NULL)) OR ((message_type = ''document''::text) AND (text_body IS NULL))))'
      WHEN 'whatsapp_cloud_messages_content_length_check'
        THEN 'CHECK (((length(COALESCE(text_body, ''''::text)) <= 4096) AND (length(COALESCE(media_mime_type, ''''::text)) <= 255) AND (length(COALESCE(media_caption, ''''::text)) <= 1024) AND (length(COALESCE(document_filename, ''''::text)) <= 255)))'
      WHEN 'whatsapp_cloud_messages_delivery_status_check'
        THEN 'CHECK ((delivery_status = ANY (ARRAY[''received''::text, ''queued''::text, ''sending''::text, ''sent''::text, ''delivered''::text, ''read''::text, ''failed''::text, ''manual_retry''::text, ''outcome_unknown''::text])))'
      WHEN 'whatsapp_cloud_messages_direction_status_check'
        THEN 'CHECK ((((direction = ''inbound''::text) AND (delivery_status = ''received''::text)) OR ((direction = ''outbound''::text) AND (delivery_status = ANY (ARRAY[''queued''::text, ''sending''::text, ''sent''::text, ''delivered''::text, ''read''::text, ''failed''::text, ''manual_retry''::text, ''outcome_unknown''::text])))))'
      WHEN 'whatsapp_cloud_messages_state_rank_check'
        THEN 'CHECK ((state_rank = CASE delivery_status WHEN ''received''::text THEN 0 WHEN ''queued''::text THEN 10 WHEN ''manual_retry''::text THEN 15 WHEN ''sending''::text THEN 20 WHEN ''failed''::text THEN 25 WHEN ''outcome_unknown''::text THEN 25 WHEN ''sent''::text THEN 30 WHEN ''delivered''::text THEN 40 WHEN ''read''::text THEN 50 ELSE NULL::integer END))'
      WHEN 'whatsapp_cloud_messages_timestamps_check'
        THEN 'CHECK ((((direction = ''inbound''::text) AND (sent_at IS NULL) AND (delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) OR ((direction = ''outbound''::text) AND ((sent_at IS NULL) OR (sent_at >= message_at)) AND ((delivered_at IS NULL) OR ((sent_at IS NOT NULL) AND (delivered_at >= sent_at))) AND ((read_at IS NULL) OR ((delivered_at IS NOT NULL) AND (read_at >= delivered_at))) AND ((failed_at IS NULL) OR (failed_at >= message_at)) AND CASE delivery_status WHEN ''queued''::text THEN ((sent_at IS NULL) AND (delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) WHEN ''sending''::text THEN ((delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) WHEN ''manual_retry''::text THEN ((delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) WHEN ''outcome_unknown''::text THEN ((delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) WHEN ''sent''::text THEN ((sent_at IS NOT NULL) AND (delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) WHEN ''delivered''::text THEN ((sent_at IS NOT NULL) AND (delivered_at IS NOT NULL) AND (read_at IS NULL) AND (failed_at IS NULL)) WHEN ''read''::text THEN ((sent_at IS NOT NULL) AND (delivered_at IS NOT NULL) AND (read_at IS NOT NULL) AND (failed_at IS NULL)) WHEN ''failed''::text THEN ((sent_at IS NULL) AND (delivered_at IS NULL) AND (read_at IS NULL) AND (failed_at IS NOT NULL)) ELSE false END)))'
      WHEN 'whatsapp_cloud_messages_source_direction_check'
        THEN 'CHECK (((source_event_id IS NULL) OR ((direction = ''inbound''::text) AND (outbox_id IS NULL))))'
      WHEN 'whatsapp_cloud_messages_outbox_direction_check'
        THEN 'CHECK (((outbox_id IS NULL) OR ((direction = ''outbound''::text) AND (source_event_id IS NULL))))'
      WHEN 'whatsapp_cloud_messages_source_outbox_direction_check'
        THEN 'CHECK (((source_outbox_id IS NULL) OR ((direction = ''outbound''::text) AND (source_event_id IS NULL))))'
    END;

    SELECT pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(oid), '\s+', ' ', 'g'), convalidated
      INTO current_definition, current_validated
      FROM pg_constraint
     WHERE conrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
       AND conname = constraint_row.constraint_name;

    IF FOUND AND current_definition = expected_definition THEN
      IF NOT current_validated THEN
        EXECUTE pg_catalog.format(
          'ALTER TABLE public.whatsapp_cloud_messages VALIDATE CONSTRAINT %I',
          constraint_row.constraint_name
        );
      END IF;
    ELSE
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.whatsapp_cloud_messages DROP CONSTRAINT IF EXISTS %I',
        constraint_row.constraint_name
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.whatsapp_cloud_messages ADD CONSTRAINT %I %s NOT VALID',
        constraint_row.constraint_name, constraint_row.definition_sql
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.whatsapp_cloud_messages VALIDATE CONSTRAINT %I',
        constraint_row.constraint_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  index_row RECORD;
  expected_columns TEXT[];
  expected_options TEXT;
BEGIN
  FOR index_row IN
    SELECT * FROM (VALUES
      ('public.idx_whatsapp_cloud_messages_conversations',
       ARRAY['empresa_id', 'message_at', 'id', 'participant_wa_id']::TEXT[],
       '0 3 3 0'),
      ('public.idx_whatsapp_cloud_messages_timeline',
       ARRAY['empresa_id', 'participant_wa_id', 'message_at', 'id']::TEXT[],
       '0 0 3 3')
    ) AS required_indexes(index_name, key_columns, sort_options)
  LOOP
    expected_columns := index_row.key_columns;
    expected_options := index_row.sort_options;
    IF pg_catalog.to_regclass(index_row.index_name) IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_index AS candidate
       WHERE candidate.indexrelid = pg_catalog.to_regclass(index_row.index_name)
         AND candidate.indrelid = 'public.whatsapp_cloud_messages'::pg_catalog.regclass
         AND NOT candidate.indisunique
         AND candidate.indpred IS NULL
         AND candidate.indexprs IS NULL
         AND candidate.indnkeyatts = 4
         AND candidate.indnatts = 4
         AND candidate.indoption::TEXT = expected_options
         AND (
           SELECT pg_catalog.array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
             FROM pg_catalog.unnest(candidate.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
             JOIN pg_attribute AS attribute_row
               ON attribute_row.attrelid = candidate.indrelid
              AND attribute_row.attnum = key_column.attnum
            WHERE key_column.ordinality <= candidate.indnkeyatts
         ) = expected_columns
    ) THEN
      EXECUTE pg_catalog.format('DROP INDEX %s', index_row.index_name);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.idx_whatsapp_cloud_messages_conversations') IS NULL THEN
    CREATE INDEX idx_whatsapp_cloud_messages_conversations
      ON public.whatsapp_cloud_messages
      (empresa_id, message_at DESC, id DESC, participant_wa_id);
  END IF;
  IF pg_catalog.to_regclass('public.idx_whatsapp_cloud_messages_timeline') IS NULL THEN
    CREATE INDEX idx_whatsapp_cloud_messages_timeline
      ON public.whatsapp_cloud_messages
      (empresa_id, participant_wa_id, message_at DESC, id DESC);
  END IF;
END $$;

-- CLOUD PROJECTION DDL COMPLETE; COMMIT BEFORE TENANT DML
COMMIT;

BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_catalog.pg_advisory_xact_lock(1464550724, 1229867347);
-- CUTOVER CAPTURE COMMITTED; SOURCE SCANS FOLLOW

DO $backfill$
DECLARE
  target_empresa_id INTEGER;
  message_row RECORD;
  outbox_row RECORD;
BEGIN
  FOR target_empresa_id IN
    SELECT empresa.id
      FROM public.empresas AS empresa
     ORDER BY empresa.id
  LOOP
    PERFORM public.whatsapp_cloud_messages_lock_projection_migration(target_empresa_id);
    -- TENANT BACKFILL LOCK ACQUIRED

    INSERT INTO public.whatsapp_cloud_messages (
      empresa_id, direction, participant_wa_id, source_event_id,
      provider_message_id, message_type, text_body, media_mime_type,
      media_caption, document_filename, delivery_status, state_rank, message_at,
      created_at, updated_at
    )
    SELECT event.empresa_id,
           'inbound',
           event.sender_id,
           event.id,
           NULLIF(pg_catalog.BTRIM(event.message_id), ''),
           event.message_type,
           CASE WHEN event.message_type = 'text'
                  AND pg_catalog.jsonb_typeof(event.event_data->'text'->'body') = 'string'
             THEN pg_catalog.LEFT(event.event_data->'text'->>'body', 4096) END,
           CASE WHEN event.message_type IN ('image', 'document')
                  AND pg_catalog.jsonb_typeof(event.event_data->event.message_type->'mime_type') = 'string'
             THEN NULLIF(pg_catalog.LEFT(event.event_data->event.message_type->>'mime_type', 255), '') END,
           CASE WHEN event.message_type IN ('image', 'document')
                  AND pg_catalog.jsonb_typeof(event.event_data->event.message_type->'caption') = 'string'
             THEN pg_catalog.LEFT(event.event_data->event.message_type->>'caption', 1024) END,
           CASE WHEN event.message_type = 'document'
                  AND pg_catalog.jsonb_typeof(event.event_data->'document'->'filename') = 'string'
             THEN pg_catalog.LEFT(event.event_data->'document'->>'filename', 255) END,
           'received',
           0,
           CASE
             WHEN event.source_timestamp ~ '^[0-9]{1,12}$'
              AND event.source_timestamp::NUMERIC > 0
              AND event.source_timestamp::NUMERIC <= 253402300799
              AND pg_catalog.to_timestamp(event.source_timestamp::DOUBLE PRECISION)
                  BETWEEN event.received_at - INTERVAL '30 days'
                      AND event.received_at + INTERVAL '5 minutes'
               THEN pg_catalog.to_timestamp(event.source_timestamp::DOUBLE PRECISION)
             ELSE event.received_at
           END,
           event.received_at,
           event.received_at
      FROM public.whatsapp_cloud_events AS event
     WHERE event.empresa_id = target_empresa_id
       AND event.event_kind = 'message'
       AND event.message_type IN ('text', 'image', 'document')
       AND event.sender_id ~ '^[0-9]{6,15}$'
       AND (
         event.message_type <> 'text'
         OR pg_catalog.jsonb_typeof(event.event_data->'text'->'body') = 'string'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.whatsapp_cloud_messages AS projected
          WHERE projected.empresa_id = event.empresa_id
            AND projected.source_event_id = event.id
       )
     ORDER BY event.id
    ON CONFLICT DO NOTHING;

    FOR outbox_row IN
      SELECT outbox.*
        FROM public.wpp_outbox AS outbox
       WHERE outbox.empresa_id = target_empresa_id
       ORDER BY outbox.id
    LOOP
      PERFORM public.whatsapp_cloud_messages_upsert_outbox_locked(
        outbox_row.empresa_id, outbox_row.id, outbox_row.telefono, outbox_row.mensaje,
        outbox_row.status, outbox_row.transport_origin, outbox_row.meta_message_id,
        outbox_row.cloud_dispatch_state, outbox_row.created_at, outbox_row.sent_at
      );
    END LOOP;

    FOR message_row IN
      SELECT message.id, message.provider_message_id
        FROM public.whatsapp_cloud_messages AS message
       WHERE message.empresa_id = target_empresa_id
         AND message.direction = 'outbound'
         AND EXISTS (
           SELECT 1
             FROM public.whatsapp_cloud_events AS event
            WHERE event.empresa_id = target_empresa_id
              AND pg_catalog.BTRIM(event.message_id) = pg_catalog.BTRIM(message.provider_message_id)
              AND event.event_kind = 'status'
              AND event.status IN ('sent', 'delivered', 'read', 'failed')
              AND NULLIF(pg_catalog.BTRIM(event.message_id), '') IS NOT NULL
         )
       ORDER BY message.id
       FOR UPDATE OF message
    LOOP
      PERFORM public.whatsapp_cloud_messages_reconcile_status_locked(
        target_empresa_id,
        message_row.provider_message_id
      );
    END LOOP;

    INSERT INTO public.whatsapp_cloud_conversations (
      empresa_id, participant_wa_id, workflow_status, priority, version,
      created_at, updated_at
    )
    SELECT message.empresa_id,
           message.participant_wa_id,
           'pending',
           'normal',
           1,
           pg_catalog.MIN(message.created_at),
           pg_catalog.MAX(message.updated_at)
      FROM public.whatsapp_cloud_messages AS message
     WHERE message.empresa_id = target_empresa_id
     GROUP BY message.empresa_id, message.participant_wa_id
     ORDER BY message.participant_wa_id
    ON CONFLICT (empresa_id, participant_wa_id) DO NOTHING;
  END LOOP;
END $backfill$;
COMMIT;
-- END WHATSAPP CLOUD MESSAGE PROJECTION MIGRATION

-- BEGIN WHATSAPP CLOUD CONVERSATION READS MIGRATION
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_catalog.pg_advisory_xact_lock(1464550724, 1380275027);
LOCK TABLE public.whatsapp_cloud_conversations, public.whatsapp_cloud_messages, public.usuarios,
  public.puntos_entrega, public.pedidos IN SHARE ROW EXCLUSIVE MODE;

DO $conversation_reads_lock$
BEGIN
  IF pg_catalog.to_regclass('public.whatsapp_cloud_conversation_reads') IS NOT NULL THEN
    LOCK TABLE public.whatsapp_cloud_conversation_reads IN SHARE ROW EXCLUSIVE MODE;
  END IF;
END $conversation_reads_lock$;

DO $conversation_reads_guard$
DECLARE
  relation_row RECORD;
  columns TEXT[];
BEGIN
  SELECT class_row.oid, class_row.relkind, class_row.relrowsecurity, class_row.relforcerowsecurity
    INTO relation_row
    FROM pg_catalog.pg_class AS class_row
    JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = class_row.relnamespace
   WHERE namespace_row.nspname = 'public'
     AND class_row.relname = 'whatsapp_cloud_conversation_reads';
  IF NOT FOUND THEN RETURN; END IF;
  SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY attribute_row.attnum)
    INTO columns
    FROM pg_catalog.pg_attribute AS attribute_row
   WHERE attribute_row.attrelid = relation_row.oid
     AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped;
  IF relation_row.relkind IS DISTINCT FROM 'r'
     OR relation_row.relrowsecurity OR relation_row.relforcerowsecurity
     OR columns IS DISTINCT FROM ARRAY['empresa_id','conversation_id','usuario_id','last_read_message_id','updated_at']::TEXT[]
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute_row
         LEFT JOIN pg_catalog.pg_attrdef AS default_row
           ON default_row.adrelid = attribute_row.attrelid AND default_row.adnum = attribute_row.attnum
        WHERE attribute_row.attrelid = relation_row.oid
          AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
          AND NOT (
            (attribute_row.attname = 'empresa_id' AND attribute_row.atttypid = 'pg_catalog.int4'::pg_catalog.regtype AND attribute_row.attnotnull AND default_row.oid IS NULL)
            OR (attribute_row.attname = 'conversation_id' AND attribute_row.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype AND attribute_row.attnotnull AND default_row.oid IS NULL)
            OR (attribute_row.attname = 'usuario_id' AND attribute_row.atttypid = 'pg_catalog.int4'::pg_catalog.regtype AND attribute_row.attnotnull AND default_row.oid IS NULL)
            OR (attribute_row.attname = 'last_read_message_id' AND attribute_row.atttypid = 'pg_catalog.int8'::pg_catalog.regtype AND NOT attribute_row.attnotnull AND default_row.oid IS NULL)
            OR (attribute_row.attname = 'updated_at' AND attribute_row.atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype AND attribute_row.attnotnull
                AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = 'now()')
          )
     )
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=relation_row.oid AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=relation_row.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=relation_row.oid OR inhparent=relation_row.oid)
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = relation_row.oid
          AND constraint_row.contype IN ('p','f','c','u','x')
          AND NOT (
            (constraint_row.conname = 'whatsapp_cloud_conversation_reads_pkey'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
               = 'PRIMARY KEY (empresa_id, conversation_id, usuario_id)')
            OR (constraint_row.conname = 'whatsapp_cloud_conversation_reads_conversation_fkey'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
               = 'FOREIGN KEY (empresa_id, conversation_id) REFERENCES whatsapp_cloud_conversations(empresa_id, id) ON DELETE CASCADE')
            OR (constraint_row.conname = 'whatsapp_cloud_conversation_reads_usuario_fkey'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
               = 'FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE')
            OR (constraint_row.conname = 'whatsapp_cloud_conversation_reads_message_check'
             AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
               = 'CHECK (last_read_message_id IS NULL OR last_read_message_id > 0)')
          )
     )
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_conversation_reads_schema_unsafe';
  END IF;
END $conversation_reads_guard$;

DO $conversation_reads_legacy_phone_indexes$
DECLARE
  index_row RECORD;
  actual_definition TEXT;
BEGIN
  FOR index_row IN
    SELECT * FROM (VALUES
      ('public.idx_puntos_entrega_whatsapp_phone_lookup',
       'CREATE INDEX idx_puntos_entrega_whatsapp_phone_lookup ON public.puntos_entrega USING btree (empresa_id, "right"(telefono_normalizado, 10))'),
      ('public.idx_puntos_entrega_whatsapp_phone_fallback',
       'CREATE INDEX idx_puntos_entrega_whatsapp_phone_fallback ON public.puntos_entrega USING btree (empresa_id, "right"(regexp_replace(COALESCE(telefono, ''''::text), ''\\D''::text, ''''::text, ''g''::text), 10)) WHERE (telefono_normalizado IS NULL)')
    ) AS expected(index_name, definition)
  LOOP
    IF pg_catalog.to_regclass(index_row.index_name) IS NULL THEN CONTINUE; END IF;
    SELECT pg_catalog.pg_get_indexdef(index_catalog.indexrelid)
      INTO actual_definition
      FROM pg_catalog.pg_index AS index_catalog
     WHERE index_catalog.indexrelid = pg_catalog.to_regclass(index_row.index_name)
       AND index_catalog.indisvalid
       AND index_catalog.indisready
       AND index_catalog.indislive
       AND NOT index_catalog.indisunique
       AND NOT index_catalog.indisprimary
       AND NOT index_catalog.indisexclusion
       AND index_catalog.indimmediate
       AND NOT index_catalog.indisclustered
       AND NOT index_catalog.indisreplident
       AND NOT index_catalog.indcheckxmin;
    IF FOUND AND actual_definition = index_row.definition THEN
      EXECUTE pg_catalog.format('DROP INDEX %s', index_row.index_name);
    END IF;
  END LOOP;
END $conversation_reads_legacy_phone_indexes$;

DO $conversation_reads_index_guard$
DECLARE
  index_row RECORD;
  expected_definition TEXT;
BEGIN
  FOR index_row IN
    SELECT * FROM (VALUES
      ('public.idx_whatsapp_cloud_conversation_reads_user',
       'CREATE INDEX idx_whatsapp_cloud_conversation_reads_user ON public.whatsapp_cloud_conversation_reads USING btree (empresa_id, usuario_id, conversation_id, last_read_message_id)'),
      ('public.idx_whatsapp_cloud_messages_inbound_unread',
       'CREATE INDEX idx_whatsapp_cloud_messages_inbound_unread ON public.whatsapp_cloud_messages USING btree (empresa_id, participant_wa_id, id) WHERE (direction = ''inbound''::text)'),
      ('public.idx_puntos_entrega_whatsapp_search_text_tenant_trgm',
       'CREATE INDEX idx_puntos_entrega_whatsapp_search_text_tenant_trgm ON public.puntos_entrega USING gin (((((empresa_id)::text || '':''::text) || lower(((((COALESCE(NULLIF(btrim(nombre), ''''::text), cliente, ''''::text) || '' ''::text) || COALESCE(direccion_completa, direccion, ''''::text)) || '' ''::text) || COALESCE(ciudad, ''''::text))))) gin_trgm_ops)'),
      ('public.idx_puntos_entrega_whatsapp_search_name_prefix',
       'CREATE INDEX idx_puntos_entrega_whatsapp_search_name_prefix ON public.puntos_entrega USING btree (empresa_id, lower(COALESCE(NULLIF(btrim(nombre), ''''::text), cliente, ''''::text)) text_pattern_ops)'),
      ('public.idx_puntos_entrega_whatsapp_search_address_prefix',
       'CREATE INDEX idx_puntos_entrega_whatsapp_search_address_prefix ON public.puntos_entrega USING btree (empresa_id, lower(((COALESCE(direccion_completa, direccion, ''''::text) || '' ''::text) || COALESCE(ciudad, ''''::text))) text_pattern_ops)'),
      ('public.idx_puntos_entrega_whatsapp_phone_lookup',
       'CREATE INDEX idx_puntos_entrega_whatsapp_phone_lookup ON public.puntos_entrega USING btree (empresa_id, reverse(telefono_normalizado) text_pattern_ops)'),
      ('public.idx_puntos_entrega_whatsapp_phone_fallback',
       'CREATE INDEX idx_puntos_entrega_whatsapp_phone_fallback ON public.puntos_entrega USING btree (empresa_id, reverse(regexp_replace(COALESCE(telefono, ''''::text), ''\\D''::text, ''''::text, ''g''::text)) text_pattern_ops) WHERE (telefono_normalizado IS NULL)'),
      ('public.idx_whatsapp_cloud_conversations_phone_lookup',
       'CREATE INDEX idx_whatsapp_cloud_conversations_phone_lookup ON public.whatsapp_cloud_conversations USING btree (empresa_id, "right"(participant_wa_id, 10))'),
      ('public.idx_pedidos_empresa_punto_fecha',
       'CREATE INDEX idx_pedidos_empresa_punto_fecha ON public.pedidos USING btree (empresa_id, punto_entrega_id, fecha DESC, id DESC)')
    ) AS expected(index_name, definition)
  LOOP
    IF pg_catalog.to_regclass(index_row.index_name) IS NULL THEN CONTINUE; END IF;
    SELECT pg_catalog.pg_get_indexdef(index_catalog.indexrelid)
      INTO expected_definition
      FROM pg_catalog.pg_index AS index_catalog
     WHERE index_catalog.indexrelid = pg_catalog.to_regclass(index_row.index_name)
       AND index_catalog.indisvalid
       AND index_catalog.indisready
       AND index_catalog.indislive
       AND NOT index_catalog.indisunique
       AND NOT index_catalog.indisprimary
       AND NOT index_catalog.indisexclusion
       AND index_catalog.indimmediate
       AND NOT index_catalog.indisclustered
       AND NOT index_catalog.indisreplident
       AND NOT index_catalog.indcheckxmin;
    IF NOT FOUND OR expected_definition IS DISTINCT FROM index_row.definition THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_conversation_reads_schema_unsafe';
    END IF;
  END LOOP;
END $conversation_reads_index_guard$;

DO $conversation_tenant_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='public.whatsapp_cloud_conversations'::pg_catalog.regclass
       AND conname='whatsapp_cloud_conversations_empresa_id_id_key'
  ) THEN
    ALTER TABLE public.whatsapp_cloud_conversations
      ADD CONSTRAINT whatsapp_cloud_conversations_empresa_id_id_key UNIQUE (empresa_id, id);
  END IF;
END $conversation_tenant_identity$;

CREATE TABLE IF NOT EXISTS public.whatsapp_cloud_conversation_reads (
  empresa_id INTEGER NOT NULL,
  conversation_id UUID NOT NULL,
  usuario_id INTEGER NOT NULL,
  last_read_message_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT whatsapp_cloud_conversation_reads_pkey PRIMARY KEY (empresa_id, conversation_id, usuario_id),
  CONSTRAINT whatsapp_cloud_conversation_reads_conversation_fkey
    FOREIGN KEY (empresa_id, conversation_id)
    REFERENCES public.whatsapp_cloud_conversations(empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_cloud_conversation_reads_usuario_fkey
    FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_cloud_conversation_reads_message_check
    CHECK (last_read_message_id IS NULL OR last_read_message_id > 0)
);

DO $conversation_reads_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversation_reads'::pg_catalog.regclass AND conname='whatsapp_cloud_conversation_reads_pkey') THEN
    ALTER TABLE public.whatsapp_cloud_conversation_reads ADD CONSTRAINT whatsapp_cloud_conversation_reads_pkey PRIMARY KEY (empresa_id, conversation_id, usuario_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversation_reads'::pg_catalog.regclass AND conname='whatsapp_cloud_conversation_reads_conversation_fkey') THEN
    ALTER TABLE public.whatsapp_cloud_conversation_reads ADD CONSTRAINT whatsapp_cloud_conversation_reads_conversation_fkey FOREIGN KEY (empresa_id, conversation_id) REFERENCES public.whatsapp_cloud_conversations(empresa_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversation_reads'::pg_catalog.regclass AND conname='whatsapp_cloud_conversation_reads_usuario_fkey') THEN
    ALTER TABLE public.whatsapp_cloud_conversation_reads ADD CONSTRAINT whatsapp_cloud_conversation_reads_usuario_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.whatsapp_cloud_conversation_reads'::pg_catalog.regclass AND conname='whatsapp_cloud_conversation_reads_message_check') THEN
    ALTER TABLE public.whatsapp_cloud_conversation_reads ADD CONSTRAINT whatsapp_cloud_conversation_reads_message_check CHECK (last_read_message_id IS NULL OR last_read_message_id > 0);
  END IF;
END $conversation_reads_constraints$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_cloud_conversation_reads_user
  ON public.whatsapp_cloud_conversation_reads (empresa_id, usuario_id, conversation_id, last_read_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_cloud_messages_inbound_unread
  ON public.whatsapp_cloud_messages (empresa_id, participant_wa_id, id)
  WHERE direction = 'inbound';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_whatsapp_search_text_tenant_trgm
  ON public.puntos_entrega USING gin (
    ((empresa_id::text || ':' || pg_catalog.LOWER(
      COALESCE(NULLIF(pg_catalog.btrim(nombre), ''), cliente, '') || ' ' ||
      COALESCE(direccion_completa, direccion, '') || ' ' || COALESCE(ciudad, '')
    ))) gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_whatsapp_search_name_prefix
  ON public.puntos_entrega (
    empresa_id,
    (pg_catalog.LOWER(COALESCE(NULLIF(pg_catalog.btrim(nombre), ''), cliente, ''))) text_pattern_ops
  );
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_whatsapp_search_address_prefix
  ON public.puntos_entrega (
    empresa_id,
    (pg_catalog.LOWER(COALESCE(direccion_completa, direccion, '') || ' ' || COALESCE(ciudad, ''))) text_pattern_ops
  );

CREATE INDEX IF NOT EXISTS idx_puntos_entrega_whatsapp_phone_lookup
  ON public.puntos_entrega (
    empresa_id,
    (pg_catalog.REVERSE(telefono_normalizado)) text_pattern_ops
  );
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_whatsapp_phone_fallback
  ON public.puntos_entrega (
    empresa_id,
    (pg_catalog.REVERSE(pg_catalog.regexp_replace(COALESCE(telefono, ''), '\\D', '', 'g'))) text_pattern_ops
  ) WHERE telefono_normalizado IS NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_cloud_conversations_phone_lookup
  ON public.whatsapp_cloud_conversations (
    empresa_id,
    (pg_catalog.right(participant_wa_id, 10))
  );
CREATE INDEX IF NOT EXISTS idx_pedidos_empresa_punto_fecha
  ON public.pedidos (empresa_id, punto_entrega_id, fecha DESC, id DESC);
COMMIT;
-- END WHATSAPP CLOUD CONVERSATION READS MIGRATION

-- BEGIN WHATSAPP CLOUD QUICK REPLIES MIGRATION
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_catalog.pg_advisory_xact_lock(1464550725, 1380275028);
LOCK TABLE public.empresas, public.usuarios IN SHARE ROW EXCLUSIVE MODE;

DO $quick_replies_lock$
BEGIN
  IF pg_catalog.to_regclass('public.whatsapp_cloud_quick_replies') IS NOT NULL THEN
    LOCK TABLE public.whatsapp_cloud_quick_replies IN ACCESS EXCLUSIVE MODE;
  END IF;
END $quick_replies_lock$;

DO $quick_replies_guard$
DECLARE
  relation_row RECORD;
  columns TEXT[];
BEGIN
  SELECT class_row.oid, class_row.relkind, class_row.relrowsecurity, class_row.relforcerowsecurity
    INTO relation_row
    FROM pg_catalog.pg_class AS class_row
    JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid=class_row.relnamespace
   WHERE namespace_row.nspname='public' AND class_row.relname='whatsapp_cloud_quick_replies';
  IF NOT FOUND THEN RETURN; END IF;
  SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY attribute_row.attnum)
    INTO columns FROM pg_catalog.pg_attribute AS attribute_row
   WHERE attribute_row.attrelid=relation_row.oid AND attribute_row.attnum>0 AND NOT attribute_row.attisdropped;
  IF relation_row.relkind IS DISTINCT FROM 'r'
     OR relation_row.relrowsecurity OR relation_row.relforcerowsecurity
     OR columns IS DISTINCT FROM ARRAY['id','empresa_id','shortcut','title','body','sort_order','is_active','version','created_by','updated_by','created_at','updated_at']::TEXT[]
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute AS attribute_row
       LEFT JOIN pg_catalog.pg_attrdef AS default_row
         ON default_row.adrelid=attribute_row.attrelid AND default_row.adnum=attribute_row.attnum
       WHERE attribute_row.attrelid=relation_row.oid AND attribute_row.attnum>0 AND NOT attribute_row.attisdropped
         AND NOT (
           (attribute_row.attname='id' AND attribute_row.atttypid='pg_catalog.uuid'::pg_catalog.regtype AND attribute_row.attnotnull AND pg_catalog.pg_get_expr(default_row.adbin,default_row.adrelid)='gen_random_uuid()')
           OR (attribute_row.attname='empresa_id' AND attribute_row.atttypid='pg_catalog.int4'::pg_catalog.regtype AND attribute_row.attnotnull AND default_row.oid IS NULL)
           OR (attribute_row.attname IN ('shortcut','title','body') AND attribute_row.atttypid='pg_catalog.text'::pg_catalog.regtype AND attribute_row.attnotnull AND default_row.oid IS NULL)
           OR (attribute_row.attname='sort_order' AND attribute_row.atttypid='pg_catalog.int4'::pg_catalog.regtype AND attribute_row.attnotnull AND pg_catalog.pg_get_expr(default_row.adbin,default_row.adrelid)='0')
           OR (attribute_row.attname='is_active' AND attribute_row.atttypid='pg_catalog.bool'::pg_catalog.regtype AND attribute_row.attnotnull AND pg_catalog.pg_get_expr(default_row.adbin,default_row.adrelid)='true')
           OR (attribute_row.attname='version' AND attribute_row.atttypid='pg_catalog.int4'::pg_catalog.regtype AND attribute_row.attnotnull AND pg_catalog.pg_get_expr(default_row.adbin,default_row.adrelid)='1')
           OR (attribute_row.attname IN ('created_by','updated_by') AND attribute_row.atttypid='pg_catalog.int4'::pg_catalog.regtype AND attribute_row.attnotnull AND default_row.oid IS NULL)
           OR (attribute_row.attname IN ('created_at','updated_at') AND attribute_row.atttypid='pg_catalog.timestamptz'::pg_catalog.regtype AND attribute_row.attnotnull AND pg_catalog.pg_get_expr(default_row.adbin,default_row.adrelid)='now()')
         )
     )
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=relation_row.oid AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=relation_row.oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=relation_row.oid OR inhparent=relation_row.oid)
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite_row
        WHERE rewrite_row.ev_class=relation_row.oid AND rewrite_row.rulename<>'_RETURN'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_depend AS dependency_row
         JOIN pg_catalog.pg_rewrite AS rewrite_row
           ON dependency_row.classid='pg_catalog.pg_rewrite'::pg_catalog.regclass
          AND dependency_row.objid=rewrite_row.oid
        WHERE dependency_row.refclassid='pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency_row.refobjid=relation_row.oid
          AND rewrite_row.ev_class<>relation_row.oid
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.contype='f' AND constraint_row.confrelid=relation_row.oid
          AND constraint_row.conrelid<>relation_row.oid
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid=relation_row.oid AND constraint_row.contype<>'n'
           AND (
             NOT constraint_row.convalidated OR constraint_row.condeferrable OR constraint_row.condeferred
             OR NOT constraint_row.conislocal OR constraint_row.coninhcount<>0
             OR NOT (
             (constraint_row.conname='whatsapp_cloud_quick_replies_pkey' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='PRIMARY KEY (id)')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_empresa_fkey' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_created_by_fkey' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE RESTRICT')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_updated_by_fkey' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE RESTRICT')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_shortcut_check' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='CHECK (char_length(shortcut) >= 2 AND char_length(shortcut) <= 32 AND shortcut ~ ''^[a-z0-9][a-z0-9._-]{1,31}$''::text)')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_title_check' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='CHECK (char_length(title) >= 1 AND char_length(title) <= 80)')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_body_check' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='CHECK (char_length(body) <= 4096 AND regexp_replace(body, ''[[:space:]   -   　﻿]''::text, ''''::text, ''g''::text) <> ''''::text)')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_sort_check' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='CHECK (sort_order >= 0 AND sort_order <= 100000)')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_is_active_check' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='CHECK (is_active OR NOT is_active)')
            OR (constraint_row.conname='whatsapp_cloud_quick_replies_version_check' AND pg_catalog.pg_get_constraintdef(constraint_row.oid,true)='CHECK (version > 0)')
            )
          )
     )
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
  END IF;
  IF EXISTS (SELECT 1 FROM public.whatsapp_cloud_quick_replies)
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.conrelid=relation_row.oid AND constraint_row.contype<>'n') <> 10
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
  END IF;
END $quick_replies_guard$;

DO $quick_replies_index_guard$
DECLARE
  expected RECORD;
  actual TEXT;
  relation_oid pg_catalog.regclass;
  table_populated BOOLEAN := false;
  canonical_indexes INTEGER := 0;
BEGIN
  relation_oid := pg_catalog.to_regclass('public.whatsapp_cloud_quick_replies');
  IF relation_oid IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.whatsapp_cloud_quick_replies)' INTO table_populated;
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('public.idx_whatsapp_cloud_quick_replies_tenant_shortcut', 'CREATE UNIQUE INDEX idx_whatsapp_cloud_quick_replies_tenant_shortcut ON public.whatsapp_cloud_quick_replies USING btree (empresa_id, shortcut)', true),
    ('public.idx_whatsapp_cloud_quick_replies_list', 'CREATE INDEX idx_whatsapp_cloud_quick_replies_list ON public.whatsapp_cloud_quick_replies USING btree (empresa_id, is_active, sort_order, title, id)', false)
  ) AS expected(index_name, definition, unique_flag)
  LOOP
    IF pg_catalog.to_regclass(expected.index_name) IS NULL THEN CONTINUE; END IF;
    SELECT pg_catalog.pg_get_indexdef(index_row.indexrelid) INTO actual
      FROM pg_catalog.pg_index AS index_row
     WHERE index_row.indexrelid=pg_catalog.to_regclass(expected.index_name)
       AND index_row.indisvalid AND index_row.indisready AND index_row.indislive
       AND index_row.indisunique=expected.unique_flag AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion AND index_row.indimmediate
       AND NOT index_row.indisclustered AND NOT index_row.indisreplident AND NOT index_row.indcheckxmin;
    IF NOT FOUND OR actual IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
    END IF;
    canonical_indexes := canonical_indexes + 1;
  END LOOP;
  IF relation_oid IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM pg_catalog.pg_index AS index_row
         JOIN pg_catalog.pg_class AS index_class ON index_class.oid=index_row.indexrelid
        WHERE index_row.indrelid=pg_catalog.to_regclass('public.whatsapp_cloud_quick_replies')
          AND NOT index_row.indisprimary
          AND index_class.relname NOT IN ('idx_whatsapp_cloud_quick_replies_tenant_shortcut','idx_whatsapp_cloud_quick_replies_list')
     )
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
  END IF;
  IF table_populated AND canonical_indexes <> 2
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
  END IF;
END $quick_replies_index_guard$;

DO $quick_replies_canonicalize_constraints$
DECLARE
  expected RECORD;
BEGIN
  IF pg_catalog.to_regclass('public.whatsapp_cloud_quick_replies') IS NULL THEN RETURN; END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('whatsapp_cloud_quick_replies_pkey', 'PRIMARY KEY (id)'),
    ('whatsapp_cloud_quick_replies_empresa_fkey', 'FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE'),
    ('whatsapp_cloud_quick_replies_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES public.usuarios(id) ON DELETE RESTRICT'),
    ('whatsapp_cloud_quick_replies_updated_by_fkey', 'FOREIGN KEY (updated_by) REFERENCES public.usuarios(id) ON DELETE RESTRICT'),
    ('whatsapp_cloud_quick_replies_shortcut_check', 'CHECK (pg_catalog.char_length(shortcut) >= 2 AND pg_catalog.char_length(shortcut) <= 32 AND shortcut ~ ''^[a-z0-9][a-z0-9._-]{1,31}$'')'),
    ('whatsapp_cloud_quick_replies_title_check', 'CHECK (pg_catalog.char_length(title) >= 1 AND pg_catalog.char_length(title) <= 80)'),
    ('whatsapp_cloud_quick_replies_body_check', 'CHECK (pg_catalog.char_length(body) <= 4096 AND pg_catalog.regexp_replace(body, ''[[:space:]   -   　﻿]'', '''', ''g'') <> '''')'),
    ('whatsapp_cloud_quick_replies_sort_check', 'CHECK (sort_order >= 0 AND sort_order <= 100000)'),
    ('whatsapp_cloud_quick_replies_is_active_check', 'CHECK (is_active OR NOT is_active)'),
    ('whatsapp_cloud_quick_replies_version_check', 'CHECK (version > 0)')
  ) AS expected(constraint_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid='public.whatsapp_cloud_quick_replies'::pg_catalog.regclass
         AND conname=expected.constraint_name
    )
    THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.whatsapp_cloud_quick_replies ADD CONSTRAINT %I %s', expected.constraint_name, expected.definition);
    END IF;
  END LOOP;
END $quick_replies_canonicalize_constraints$;

CREATE TABLE IF NOT EXISTS public.whatsapp_cloud_quick_replies (
  id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  empresa_id INTEGER NOT NULL,
  shortcut TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT whatsapp_cloud_quick_replies_pkey PRIMARY KEY (id),
  CONSTRAINT whatsapp_cloud_quick_replies_empresa_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_cloud_quick_replies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.usuarios(id) ON DELETE RESTRICT,
  CONSTRAINT whatsapp_cloud_quick_replies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.usuarios(id) ON DELETE RESTRICT,
  CONSTRAINT whatsapp_cloud_quick_replies_shortcut_check CHECK (pg_catalog.char_length(shortcut) >= 2 AND pg_catalog.char_length(shortcut) <= 32 AND shortcut ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
  CONSTRAINT whatsapp_cloud_quick_replies_title_check CHECK (pg_catalog.char_length(title) >= 1 AND pg_catalog.char_length(title) <= 80),
  CONSTRAINT whatsapp_cloud_quick_replies_body_check CHECK (pg_catalog.char_length(body) <= 4096 AND pg_catalog.regexp_replace(body, '[[:space:]   -   　﻿]', '', 'g') <> ''),
  CONSTRAINT whatsapp_cloud_quick_replies_sort_check CHECK (sort_order >= 0 AND sort_order <= 100000),
  CONSTRAINT whatsapp_cloud_quick_replies_is_active_check CHECK (is_active OR NOT is_active),
  CONSTRAINT whatsapp_cloud_quick_replies_version_check CHECK (version > 0)
);
DO $quick_replies_canonicalize_indexes$
BEGIN
  IF pg_catalog.to_regclass('public.idx_whatsapp_cloud_quick_replies_tenant_shortcut') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.whatsapp_cloud_quick_replies) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
    END IF;
    CREATE UNIQUE INDEX idx_whatsapp_cloud_quick_replies_tenant_shortcut
      ON public.whatsapp_cloud_quick_replies (empresa_id, shortcut);
  END IF;
  IF pg_catalog.to_regclass('public.idx_whatsapp_cloud_quick_replies_list') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.whatsapp_cloud_quick_replies) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
    END IF;
    CREATE INDEX idx_whatsapp_cloud_quick_replies_list
      ON public.whatsapp_cloud_quick_replies (empresa_id, is_active, sort_order, title, id);
  END IF;
END $quick_replies_canonicalize_indexes$;

DO $quick_replies_postflight$
DECLARE
  expected RECORD;
  actual TEXT;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('whatsapp_cloud_quick_replies_pkey', 'PRIMARY KEY (id)'),
    ('whatsapp_cloud_quick_replies_empresa_fkey', 'FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE'),
    ('whatsapp_cloud_quick_replies_created_by_fkey', 'FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE RESTRICT'),
    ('whatsapp_cloud_quick_replies_updated_by_fkey', 'FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE RESTRICT'),
    ('whatsapp_cloud_quick_replies_shortcut_check', 'CHECK (char_length(shortcut) >= 2 AND char_length(shortcut) <= 32 AND shortcut ~ ''^[a-z0-9][a-z0-9._-]{1,31}$''::text)'),
    ('whatsapp_cloud_quick_replies_title_check', 'CHECK (char_length(title) >= 1 AND char_length(title) <= 80)'),
    ('whatsapp_cloud_quick_replies_body_check', 'CHECK (char_length(body) <= 4096 AND regexp_replace(body, ''[[:space:]   -   　﻿]''::text, ''''::text, ''g''::text) <> ''''::text)'),
    ('whatsapp_cloud_quick_replies_sort_check', 'CHECK (sort_order >= 0 AND sort_order <= 100000)'),
    ('whatsapp_cloud_quick_replies_is_active_check', 'CHECK (is_active OR NOT is_active)'),
    ('whatsapp_cloud_quick_replies_version_check', 'CHECK (version > 0)')
  ) AS expected(constraint_name, definition)
  LOOP
    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid,true) INTO actual
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid='public.whatsapp_cloud_quick_replies'::pg_catalog.regclass
       AND constraint_row.conname=expected.constraint_name
       AND constraint_row.convalidated AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred
       AND constraint_row.conislocal AND constraint_row.coninhcount=0;
    IF NOT FOUND OR actual IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint
       WHERE conrelid='public.whatsapp_cloud_quick_replies'::pg_catalog.regclass AND contype<>'n') <> 10
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('idx_whatsapp_cloud_quick_replies_tenant_shortcut', 'CREATE UNIQUE INDEX idx_whatsapp_cloud_quick_replies_tenant_shortcut ON public.whatsapp_cloud_quick_replies USING btree (empresa_id, shortcut)', true),
    ('idx_whatsapp_cloud_quick_replies_list', 'CREATE INDEX idx_whatsapp_cloud_quick_replies_list ON public.whatsapp_cloud_quick_replies USING btree (empresa_id, is_active, sort_order, title, id)', false)
  ) AS expected(index_name, definition, unique_flag)
  LOOP
    SELECT pg_catalog.pg_get_indexdef(index_row.indexrelid) INTO actual
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_class ON index_class.oid=index_row.indexrelid
     WHERE index_row.indrelid='public.whatsapp_cloud_quick_replies'::pg_catalog.regclass
       AND index_class.relname=expected.index_name
       AND index_row.indisvalid AND index_row.indisready AND index_row.indislive
       AND index_row.indisunique=expected.unique_flag AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion AND index_row.indimmediate
       AND NOT index_row.indisclustered AND NOT index_row.indisreplident AND NOT index_row.indcheckxmin;
    IF NOT FOUND OR actual IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index
       WHERE indrelid='public.whatsapp_cloud_quick_replies'::pg_catalog.regclass AND NOT indisprimary) <> 2
  THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='whatsapp_cloud_quick_replies_schema_unsafe';
  END IF;
END $quick_replies_postflight$;
COMMIT;
-- END WHATSAPP CLOUD QUICK REPLIES MIGRATION

BEGIN;
SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS push_sub_pedidos (
  sub_id    INTEGER NOT NULL REFERENCES push_subs(id) ON DELETE CASCADE,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  PRIMARY KEY (sub_id, pedido_id)
);

CREATE TABLE IF NOT EXISTS page_views (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  fecha        DATE NOT NULL,
  hora         TIME NOT NULL,
  user_agent   TEXT,
  referer      TEXT,
  session_id   TEXT,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS page_view_events (
  id           SERIAL PRIMARY KEY,
  page_view_id INTEGER NOT NULL REFERENCES page_views(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  payload      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

-- =========================================================
-- 13. MÓDULO DE ACTIVOS (COMODATOS / MÁQUINAS)
-- =========================================================
CREATE TABLE IF NOT EXISTS empresa_activos (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  marca        TEXT,
  modelo       TEXT,
  valor_compra NUMERIC(12,2) DEFAULT 0,
  fecha_compra DATE,
  estado       TEXT DEFAULT 'disponible',
  cliente_id   INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  notas        TEXT,
  created_at   TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at   TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  UNIQUE(empresa_id, codigo)
);

-- Extensiones de campos
ALTER TABLE empresa_activos
  -- info técnica y mantenimiento
  ADD COLUMN IF NOT EXISTS detalles_tecnicos JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ultima_sanitizacion DATE,
  ADD COLUMN IF NOT EXISTS frecuencia_mantenimiento INTEGER DEFAULT 6,
  -- vínculo con producto + alquiler
  ADD COLUMN IF NOT EXISTS producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS alquiler_mensual NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS fecha_inicio_alquiler TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fecha_fin_alquiler TIMESTAMPTZ,
  -- QR, garantías y última ubicación
  ADD COLUMN IF NOT EXISTS numero_serie        TEXT,
  ADD COLUMN IF NOT EXISTS codigo_qr           TEXT,
  ADD COLUMN IF NOT EXISTS nro_lote            TEXT,
  ADD COLUMN IF NOT EXISTS fecha_fin_garantia  DATE,
  ADD COLUMN IF NOT EXISTS proveedor_id        BIGINT,
  ADD COLUMN IF NOT EXISTS centro_costo_id     BIGINT,
  ADD COLUMN IF NOT EXISTS cuenta_contable_id  BIGINT,
  ADD COLUMN IF NOT EXISTS metodo_depreciacion TEXT,
  ADD COLUMN IF NOT EXISTS vida_util_meses     INT,
  ADD COLUMN IF NOT EXISTS last_seen_at_utc    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_fuente    TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_lat       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_seen_lng       DOUBLE PRECISION;




CREATE TABLE IF NOT EXISTS historial_activos (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  activo_id    INTEGER NOT NULL REFERENCES empresa_activos(id) ON DELETE CASCADE,
  cliente_id   INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  accion       TEXT NOT NULL,
  fecha        TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  usuario      TEXT,
  observacion  TEXT
);

ALTER TABLE historial_activos
  ADD COLUMN IF NOT EXISTS latitud NUMERIC,
  ADD COLUMN IF NOT EXISTS longitud NUMERIC,
  ADD COLUMN IF NOT EXISTS firma_digital TEXT;

CREATE TABLE IF NOT EXISTS empresa_activos_alquileres (
  id             SERIAL PRIMARY KEY,
  empresa_id     INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id     INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  periodo        DATE NOT NULL, -- ej 2025-01-01 (mes)
  monto_total    NUMERIC(12,2) NOT NULL,
  total_activos  INT NOT NULL DEFAULT 0,
  estado         TEXT NOT NULL DEFAULT 'pendiente', -- pendiente, facturado, cobrado
  created_at     TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  mp_link            TEXT,
  mp_preference_id   TEXT,
  ultimo_pago_fecha  TIMESTAMPTZ,
  ultimo_pago_monto  NUMERIC(12,2),
  updated_at         TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  detalle_activos    JSONB DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alquileres_uniq 
  ON empresa_activos_alquileres (empresa_id, cliente_id, periodo);


-- =========================================================
-- 14. Movimientos de activos asociados a pedidos
-- =========================================================

CREATE TABLE IF NOT EXISTS pedido_activos (
  id                    SERIAL PRIMARY KEY,

  -- Contexto de multi-empresa
  empresa_id            INTEGER NOT NULL,

  -- Pedido e ítem donde se produce el movimiento
  pedido_id             INTEGER NOT NULL,
  item_pedido_id        INTEGER,         -- opcional: link al ítem puntual
  producto_id           INTEGER,         -- opcional: redundancia para reportes

  -- Activo principal involucrado
  activo_id             INTEGER NOT NULL,

  -- Para cambios: activo que sale / se retira
  activo_relacionado_id INTEGER,         -- solo si tipo_operacion = 'cambio'

  -- Tipo de operación sobre el activo
  tipo_operacion        TEXT NOT NULL DEFAULT 'entrega',

  -- Estado del movimiento
  estado                TEXT NOT NULL DEFAULT 'confirmado',

  -- Origen de la acción (para auditoría)
  origen                TEXT NOT NULL DEFAULT 'app_repartidor',

  -- ¿Este movimiento implica que hay que retirar otro activo?
  requiere_retiro       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Datos de contexto
  observacion           TEXT,
  motivo                TEXT,

  -- Momento y lugar de la acción
  accion_at_utc         TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  accion_lat            DOUBLE PRECISION,
  accion_lng            DOUBLE PRECISION,

  -- Evidencias / adjuntos
  foto_entrega_url         TEXT,
  foto_numero_serie_url    TEXT,
  firma_cliente_url        TEXT,

  -- Auditoría
  created_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  created_by            TEXT,

  CONSTRAINT fk_pedido_activos_empresa
    FOREIGN KEY (empresa_id)
    REFERENCES empresas (id)
    ON DELETE CASCADE,

  CONSTRAINT fk_pedido_activos_pedido
    FOREIGN KEY (pedido_id)
    REFERENCES pedidos (id)
    ON DELETE CASCADE,

  CONSTRAINT fk_pedido_activos_item_pedido
    FOREIGN KEY (item_pedido_id)
    REFERENCES items_pedido (id)
    ON DELETE SET NULL,

  CONSTRAINT fk_pedido_activos_producto
    FOREIGN KEY (producto_id)
    REFERENCES productos (id)
    ON DELETE SET NULL,

  CONSTRAINT fk_pedido_activos_activo
    FOREIGN KEY (activo_id)
    REFERENCES empresa_activos (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_pedido_activos_activo_rel
    FOREIGN KEY (activo_relacionado_id)
    REFERENCES empresa_activos (id)
    ON DELETE SET NULL,

  CONSTRAINT chk_pedido_activos_tipo_operacion
    CHECK (tipo_operacion IN ('entrega', 'retiro', 'cambio', 'mantenimiento')),

  CONSTRAINT chk_pedido_activos_estado
    CHECK (estado IN ('pendiente', 'confirmado', 'cancelado')),

  CONSTRAINT chk_pedido_activos_origen
    CHECK (origen IN ('app_repartidor', 'panel_admin', 'import')),

  CONSTRAINT uq_pedido_activos_pedido_activo
    UNIQUE (pedido_id, activo_id)
);

-- =========================================================
-- 14.b FASE 2 - COMPRAS Y PROVEEDORES
-- =========================================================
CREATE TABLE IF NOT EXISTS proveedores (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre            TEXT NOT NULL,
  cuit              TEXT,
  telefono          TEXT,
  email             TEXT,
  contacto          TEXT,
  condiciones_pago  TEXT,
  activo            BOOLEAN DEFAULT TRUE,
  notas             TEXT,
  created_at        TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at        TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS proveedores_empresa_idx
  ON proveedores (empresa_id, activo, nombre);

CREATE TABLE IF NOT EXISTS compras_ordenes (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  proveedor_id          INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  estado                TEXT NOT NULL DEFAULT 'borrador',
  fecha_emision         TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  fecha_entrega_estimada DATE,
  subtotal              NUMERIC(12,2) DEFAULT 0,
  impuestos             NUMERIC(12,2) DEFAULT 0,
  total                 NUMERIC(12,2) DEFAULT 0,
  moneda                TEXT DEFAULT 'ARS',
  referencia_externa    TEXT,
  observaciones         TEXT,
  created_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  updated_at            TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS compras_ordenes_empresa_estado_idx
  ON compras_ordenes (empresa_id, estado, fecha_emision DESC);

CREATE TABLE IF NOT EXISTS compras_orden_items (
  id                SERIAL PRIMARY KEY,
  orden_id          INTEGER NOT NULL REFERENCES compras_ordenes(id) ON DELETE CASCADE,
  producto_id       INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  descripcion       TEXT,
  cantidad          NUMERIC(12,2) NOT NULL DEFAULT 0,
  costo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0,
  impuesto_pct      NUMERIC(6,2) DEFAULT 0,
  subtotal          NUMERIC(12,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS compras_orden_items_orden_idx
  ON compras_orden_items (orden_id);

CREATE TABLE IF NOT EXISTS compras_recepciones (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  orden_id          INTEGER REFERENCES compras_ordenes(id) ON DELETE SET NULL,
  proveedor_id      INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  fecha_recepcion   TIMESTAMPTZ DEFAULT pg_catalog.NOW(),
  numero_remito     TEXT,
  observaciones     TEXT,
  created_by        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE TABLE IF NOT EXISTS compras_recepcion_items (
  id                SERIAL PRIMARY KEY,
  recepcion_id      INTEGER NOT NULL REFERENCES compras_recepciones(id) ON DELETE CASCADE,
  producto_id       INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  cantidad          NUMERIC(12,2) NOT NULL DEFAULT 0,
  costo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal          NUMERIC(12,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS compras_recepciones_empresa_idx
  ON compras_recepciones (empresa_id, fecha_recepcion DESC);

-- 14.c Tesorería proveedores (MVP)
CREATE TABLE IF NOT EXISTS tesoreria_movimientos (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo                  TEXT NOT NULL DEFAULT 'egreso', -- egreso|ingreso
  categoria             TEXT NOT NULL DEFAULT 'pago_proveedor',
  proveedor_id          INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  compra_orden_id       INTEGER REFERENCES compras_ordenes(id) ON DELETE SET NULL,
  fecha                 TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  monto                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  medio_pago            TEXT,
  referencia            TEXT,
  notas                 TEXT,
  conciliado            BOOLEAN NOT NULL DEFAULT FALSE,
  conciliado_at         TIMESTAMPTZ,
  created_by            INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS tesoreria_movimientos_empresa_fecha_idx
  ON tesoreria_movimientos (empresa_id, fecha DESC);

CREATE INDEX IF NOT EXISTS tesoreria_movimientos_conciliado_idx
  ON tesoreria_movimientos (empresa_id, conciliado, fecha DESC);

-- 14.d Presupuesto mensual (compras/tesorería)
CREATE TABLE IF NOT EXISTS presupuesto_mensual (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  anio                INTEGER NOT NULL,
  mes                 INTEGER NOT NULL,
  categoria           TEXT NOT NULL,
  proveedor_id        INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  monto_presupuestado NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT presupuesto_mensual_mes_chk CHECK (mes BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX IF NOT EXISTS presupuesto_mensual_unique_idx
  ON presupuesto_mensual (empresa_id, anio, mes, categoria, COALESCE(proveedor_id, 0));

CREATE INDEX IF NOT EXISTS presupuesto_mensual_empresa_periodo_idx
  ON presupuesto_mensual (empresa_id, anio, mes, categoria);

-- 14.e Incidencias operativas (entrega/cobranza/servicio)
CREATE TABLE IF NOT EXISTS incidencias_operativas (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id           INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  cliente_id          INTEGER REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  chofer_id           INTEGER REFERENCES choferes(id) ON DELETE SET NULL,
  tipo                TEXT NOT NULL DEFAULT 'entrega', -- entrega|cobranza|producto|cliente|sistema
  severidad           TEXT NOT NULL DEFAULT 'media',   -- baja|media|alta|critica
  estado              TEXT NOT NULL DEFAULT 'abierta', -- abierta|en_progreso|resuelta|cancelada
  titulo              TEXT NOT NULL,
  detalle             TEXT,
  accion_recomendada  TEXT,
  responsable_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  vence_at            TIMESTAMPTZ,
  resuelta_at         TIMESTAMPTZ,
  resuelta_por        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

ALTER TABLE incidencias_operativas
  ADD COLUMN IF NOT EXISTS responsable_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE incidencias_operativas
  ADD COLUMN IF NOT EXISTS vence_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS incidencias_operativas_empresa_estado_idx
  ON incidencias_operativas (empresa_id, estado, severidad, created_at DESC);

CREATE INDEX IF NOT EXISTS incidencias_operativas_empresa_tipo_idx
  ON incidencias_operativas (empresa_id, tipo, created_at DESC);

CREATE TABLE IF NOT EXISTS incidencias_operativas_historial (
  id                  SERIAL PRIMARY KEY,
  incidencia_id       INTEGER NOT NULL REFERENCES incidencias_operativas(id) ON DELETE CASCADE,
  empresa_id          INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  evento              TEXT NOT NULL, -- creada|actualizada|estado|resuelta
  payload             JSONB,
  actor_usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS incidencias_historial_incidencia_idx
  ON incidencias_operativas_historial (incidencia_id, created_at DESC);

-- =========================================================
-- 15. ÍNDICES DE RENDIMIENTO (OPTIMIZACIÓN)
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_pedidos_emp_fecha ON pedidos (empresa_id, fecha DESC);

-- Tracking público: asegurar unicidad del token para lookup rápido y sin colisiones
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_tracking_token_unique
  ON pedidos (tracking_token)
  WHERE tracking_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_emp_chofer_fecha ON pedidos (empresa_id, chofer_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_empresa ON puntos_entrega (empresa_id);
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_tel_norm ON puntos_entrega (telefono_normalizado);
CREATE INDEX IF NOT EXISTS idx_puntos_entrega_cliente_trgm ON puntos_entrega USING gin (cliente gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios (username);
CREATE INDEX IF NOT EXISTS idx_recompensas_cliente ON cliente_recompensas(cliente_id) WHERE reclamado = FALSE;
CREATE INDEX IF NOT EXISTS idx_items_pedido_pedido_id ON items_pedido (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_chofer_estado ON pedidos (chofer_id, estado) WHERE estado IN ('pendiente', 'en_ruta', 'en_camino');
CREATE INDEX IF NOT EXISTS idx_zonas_geom ON zonas_geograficas USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_ct_procesado ON comprobantes_transferencia (procesado, fecha);
CREATE INDEX IF NOT EXISTS idx_ct_empresa_file_hash ON comprobantes_transferencia (empresa_id, file_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ct_source_message_new
  ON comprobantes_transferencia ((COALESCE(empresa_id, 0)), source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ct_file_hash_new
  ON comprobantes_transferencia ((COALESCE(empresa_id, 0)), dedupe_file_hash)
  WHERE dedupe_file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_estado_revision ON comprobantes_transferencia (estado_revision);
CREATE INDEX IF NOT EXISTS idx_pedido_track_points_pedido_ts ON pedido_track_points (pedido_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hist_prod_fecha ON historial_costos_precios (producto_id, fecha_registro DESC);
CREATE INDEX IF NOT EXISTS idx_hist_empresa_fecha ON historial_costos_precios (empresa_id, fecha_registro DESC);
CREATE INDEX IF NOT EXISTS idx_activos_detalles ON empresa_activos USING gin (detalles_tecnicos);
CREATE INDEX IF NOT EXISTS idx_puntos_geom ON puntos_entrega USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_empresas_vencimiento ON empresas (plan_vencimiento);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_pedido ON pedido_activos (empresa_id, pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_activo ON pedido_activos (empresa_id, activo_id);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_producto ON pedido_activos (empresa_id, producto_id);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_accion_at ON pedido_activos (empresa_id, accion_at_utc);
CREATE INDEX IF NOT EXISTS idx_pedido_activos_empresa_estado ON pedido_activos (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_empresa_estado ON empresa_activos (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_empresa_cliente ON empresa_activos (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_empresa_producto ON empresa_activos (empresa_id, producto_id);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_last_seen ON empresa_activos (empresa_id, last_seen_at_utc);
CREATE INDEX IF NOT EXISTS idx_empresa_activos_alquileres_detalle ON empresa_activos_alquileres USING gin (detalle_activos);
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pedido ON pedido_pagos (pedido_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_pagos_provider_payment ON pedido_pagos (proveedor, provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pendientes_empresa ON pedido_pagos (empresa_id, vence_at) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_pagados_empresa ON pedido_pagos (empresa_id, settlement_at) WHERE estado = 'pagado';
CREATE INDEX IF NOT EXISTS idx_pedido_pagos_conciliacion ON pedido_pagos (empresa_id, conciliado, settlement_at) WHERE conciliado = FALSE;

-- Garantiza 1 solo pago pendiente por pedido y empresa (evita duplicados por race conditions)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_pagos_one_pending_per_order
  ON pedido_pagos (empresa_id, pedido_id)
  WHERE estado = 'pendiente';


-- Choferes: foto opcional para panel admin
ALTER TABLE choferes
  ADD COLUMN IF NOT EXISTS foto_url TEXT;

-- Empresas: logo opcional para panel admin / branding
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS wpp_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS wpp_status TEXT DEFAULT 'disconnected',
  ADD COLUMN IF NOT EXISTS wpp_reset_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW();

-- ACK de incidentes de tracking (operación / NOC)
CREATE TABLE IF NOT EXISTS tracking_incident_acks (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id         INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  acked_by_user_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  acked_by_username TEXT,
  comment           TEXT,
  acked_at          TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_incident_acks_empresa_pedido_ack
  ON tracking_incident_acks (empresa_id, pedido_id, acked_at DESC);

-- =========================================================
-- 14. TELEMETRÍA MARKETING POR CANAL
-- =========================================================
CREATE TABLE IF NOT EXISTS marketing_envios_telemetria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  estrategia TEXT NOT NULL,
  canal TEXT NOT NULL,
  telefono TEXT,
  mensaje_hash TEXT,
  estado TEXT NOT NULL,
  proveedor TEXT,
  costo_estimado NUMERIC(12,2),
  detalle_error TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_tel_empresa_fecha
  ON marketing_envios_telemetria (empresa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_tel_estrategia_canal_fecha
  ON marketing_envios_telemetria (estrategia, canal, created_at DESC);

-- =========================================================
-- 15. BASE DE CONTACTOS MARKETING (IMPORTACIÓN DE LISTAS)
-- =========================================================
CREATE TABLE IF NOT EXISTS marketing_contactos (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  telefono TEXT NOT NULL,
  telefono_normalizado TEXT NOT NULL,
  lista_nombre TEXT,
  rubro TEXT,
  zona TEXT,
  origen TEXT,
  canal_objetivo TEXT NOT NULL DEFAULT 'whatsapp',
  descripcion TEXT,
  objetivo_campana TEXT,
  context_tag TEXT,
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  consent_source TEXT,
  consent_at TIMESTAMPTZ,
  optout_at TIMESTAMPTZ,
  estado TEXT NOT NULL DEFAULT 'nuevo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_contactos_unique
  ON marketing_contactos (empresa_id, telefono_normalizado);

CREATE INDEX IF NOT EXISTS idx_marketing_contactos_filtros
  ON marketing_contactos (empresa_id, rubro, zona, estado, created_at DESC);

-- =========================================================
-- 16. CAMPAÑAS DE LLAMADAS / VOICE AI
-- =========================================================
CREATE TABLE IF NOT EXISTS call_campaigns (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  prompt_version TEXT,
  max_attempts INT NOT NULL DEFAULT 2,
  allowed_start_time TIME,
  allowed_end_time TIME,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_campaigns_empresa_status
  ON call_campaigns (empresa_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS call_campaign_contacts (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES call_campaigns(id) ON DELETE CASCADE,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  customer_id INT,
  name TEXT,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_call_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  final_disposition TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  UNIQUE (campaign_id, phone_normalized)
);

CREATE INDEX IF NOT EXISTS idx_call_campaign_contacts_dispatch
  ON call_campaign_contacts (empresa_id, campaign_id, status, next_retry_at);

CREATE TABLE IF NOT EXISTS call_sessions (
  id BIGSERIAL PRIMARY KEY,
  campaign_contact_id BIGINT NOT NULL REFERENCES call_campaign_contacts(id) ON DELETE CASCADE,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campaign_id BIGINT NOT NULL REFERENCES call_campaigns(id) ON DELETE CASCADE,
  asterisk_channel_id TEXT,
  asterisk_linkedid TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  status TEXT NOT NULL DEFAULT 'initiated',
  hangup_cause TEXT,
  transcript_text TEXT,
  ai_summary TEXT,
  ai_disposition TEXT,
  ai_confidence NUMERIC(5,2),
  transferred_to_human BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recording_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_empresa_status
  ON call_sessions (empresa_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS call_events (
  id BIGSERIAL PRIMARY KEY,
  call_session_id BIGINT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_events_session_created
  ON call_events (call_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_tasks (
  id BIGSERIAL PRIMARY KEY,
  call_session_id BIGINT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  assigned_user_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_tasks_due
  ON call_tasks (status, due_at);

-- =========================================================
-- 17. FACTURACION ELECTRONICA AFIP/ARCA
-- =========================================================
CREATE TABLE IF NOT EXISTS empresa_facturacion_config (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cuit TEXT NOT NULL,
  razon_social TEXT,
  condicion_iva TEXT,
  punto_venta INT NOT NULL,
  modo_afip TEXT NOT NULL DEFAULT 'homologacion',
  certificado_ref TEXT,
  clave_ref TEXT,
  certificado_pem_encrypted TEXT,
  clave_pem_encrypted TEXT,
  certificado_nombre TEXT,
  clave_nombre TEXT,
  credenciales_updated_at TIMESTAMPTZ,
  wsaa_token_encrypted TEXT,
  wsaa_sign_encrypted TEXT,
  wsaa_expires_at TIMESTAMPTZ,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT uq_empresa_facturacion_config_empresa UNIQUE (empresa_id),
  CONSTRAINT chk_empresa_facturacion_config_modo
    CHECK (modo_afip IN ('homologacion', 'produccion'))
);

CREATE INDEX IF NOT EXISTS idx_empresa_facturacion_config_empresa
  ON empresa_facturacion_config (empresa_id, activo);

CREATE TABLE IF NOT EXISTS cliente_datos_fiscales (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  punto_entrega_id INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  tipo_documento TEXT NOT NULL DEFAULT 'CUIT',
  numero_documento TEXT NOT NULL,
  razon_social TEXT NOT NULL,
  condicion_iva TEXT,
  domicilio_fiscal TEXT,
  email_facturacion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT uq_cliente_datos_fiscales_cliente UNIQUE (empresa_id, punto_entrega_id)
);

CREATE INDEX IF NOT EXISTS idx_cliente_datos_fiscales_empresa_doc
  ON cliente_datos_fiscales (empresa_id, numero_documento);

CREATE TABLE IF NOT EXISTS facturas (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id INT REFERENCES pedidos(id) ON DELETE SET NULL,
  punto_entrega_id INT REFERENCES puntos_entrega(id) ON DELETE SET NULL,
  cliente_datos_fiscales_id BIGINT REFERENCES cliente_datos_fiscales(id) ON DELETE SET NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente_confirmacion',
  modo_afip TEXT NOT NULL DEFAULT 'homologacion',
  tipo_comprobante TEXT,
  codigo_comprobante_afip INT,
  punto_venta INT,
  numero_comprobante BIGINT,
  concepto TEXT NOT NULL DEFAULT 'productos',
  fecha_comprobante DATE,
  importe_neto NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_iva NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  cae TEXT,
  cae_vencimiento DATE,
  pdf_url TEXT,
  error_codigo TEXT,
  error_mensaje TEXT,
  created_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
  emitted_by INT REFERENCES usuarios(id) ON DELETE SET NULL,
  emitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT chk_facturas_estado
    CHECK (estado IN ('borrador', 'pendiente_confirmacion', 'emitiendo', 'emitida', 'rechazada', 'anulada')),
  CONSTRAINT chk_facturas_modo
    CHECK (modo_afip IN ('homologacion', 'produccion'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_pedido_unica
  ON facturas (empresa_id, pedido_id)
  WHERE pedido_id IS NOT NULL AND estado <> 'anulada';

CREATE INDEX IF NOT EXISTS idx_facturas_empresa_estado
  ON facturas (empresa_id, estado, created_at DESC);

CREATE TABLE IF NOT EXISTS factura_items (
  id BIGSERIAL PRIMARY KEY,
  factura_id BIGINT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
  producto_id INT REFERENCES productos(id) ON DELETE SET NULL,
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(12,3) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  alicuota_iva NUMERIC(5,2) NOT NULL DEFAULT 0,
  importe_neto NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_iva NUMERIC(12,2) NOT NULL DEFAULT 0,
  importe_total NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_factura_items_factura
  ON factura_items (factura_id);

CREATE TABLE IF NOT EXISTS factura_afip_auditoria (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  factura_id BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  servicio TEXT NOT NULL,
  operacion TEXT NOT NULL,
  request_xml TEXT,
  response_xml TEXT,
  resultado TEXT,
  error_codigo TEXT,
  error_mensaje TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_factura_afip_auditoria_factura
  ON factura_afip_auditoria (factura_id, created_at DESC);

CREATE TABLE IF NOT EXISTS factura_eventos (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  factura_id BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  accion TEXT NOT NULL,
  detalle TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW()
);

CREATE INDEX IF NOT EXISTS idx_factura_eventos_factura
  ON factura_eventos (factura_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_factura_eventos_empresa
  ON factura_eventos (empresa_id, created_at DESC);


-- WhatsApp General: singleton ownership, status and reset coordination.
CREATE TABLE IF NOT EXISTS wpp_general_control (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  epoch                BIGINT NOT NULL DEFAULT 0,
  owner_id             TEXT,
  state                TEXT NOT NULL DEFAULT 'standby',
  heartbeat_at         TIMESTAMPTZ,
  operation            TEXT,
  qr_code              TEXT,
  last_error           TEXT,
  reset_requested_seq  BIGINT NOT NULL DEFAULT 0,
  reset_started_seq    BIGINT NOT NULL DEFAULT 0,
  reset_applied_seq    BIGINT NOT NULL DEFAULT 0,
  reset_failed_seq     BIGINT NOT NULL DEFAULT 0,
  reset_requested_at   TIMESTAMPTZ,
  reset_started_at     TIMESTAMPTZ,
  reset_applied_at     TIMESTAMPTZ,
  reset_failed_at      TIMESTAMPTZ,
  reset_failure_error  TEXT,
  reset_requested_by   TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.NOW(),
  CONSTRAINT wpp_general_reset_sequence_order CHECK (
    reset_applied_seq <= reset_started_seq
    AND reset_failed_seq <= reset_started_seq
    AND reset_started_seq <= reset_requested_seq
  )
);

ALTER TABLE wpp_general_control
  ADD COLUMN IF NOT EXISTS id BOOLEAN,
  ADD COLUMN IF NOT EXISTS epoch BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owner_id TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'standby',
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operation TEXT,
  ADD COLUMN IF NOT EXISTS qr_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS reset_requested_seq BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reset_started_seq BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reset_applied_seq BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reset_failed_seq BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reset_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reset_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reset_applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reset_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reset_failure_error TEXT,
  ADD COLUMN IF NOT EXISTS reset_requested_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT pg_catalog.NOW();

UPDATE wpp_general_control
SET id = COALESCE(id, TRUE),
    epoch = COALESCE(epoch, 0),
    state = COALESCE(state, 'standby'),
    reset_requested_seq = COALESCE(reset_requested_seq, 0),
    reset_started_seq = COALESCE(reset_started_seq, 0),
    reset_applied_seq = COALESCE(reset_applied_seq, 0),
    reset_failed_seq = COALESCE(reset_failed_seq, 0),
    updated_at = COALESCE(updated_at, pg_catalog.NOW())
WHERE id IS NULL
   OR epoch IS NULL
   OR state IS NULL
   OR reset_requested_seq IS NULL
   OR reset_started_seq IS NULL
   OR reset_applied_seq IS NULL
   OR reset_failed_seq IS NULL
   OR updated_at IS NULL;

ALTER TABLE wpp_general_control
  ALTER COLUMN id SET DEFAULT TRUE,
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN epoch SET DEFAULT 0,
  ALTER COLUMN epoch SET NOT NULL,
  ALTER COLUMN state SET DEFAULT 'standby',
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN reset_requested_seq SET DEFAULT 0,
  ALTER COLUMN reset_requested_seq SET NOT NULL,
  ALTER COLUMN reset_started_seq SET DEFAULT 0,
  ALTER COLUMN reset_started_seq SET NOT NULL,
  ALTER COLUMN reset_applied_seq SET DEFAULT 0,
  ALTER COLUMN reset_applied_seq SET NOT NULL,
  ALTER COLUMN reset_failed_seq SET DEFAULT 0,
  ALTER COLUMN reset_failed_seq SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT pg_catalog.NOW(),
  ALTER COLUMN updated_at SET NOT NULL;

DO $wpp_general_singleton$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wpp_general_control'::regclass
      AND conname = 'wpp_general_control_singleton_id'
      AND pg_catalog.pg_get_constraintdef(oid) = 'CHECK (id)'
  ) THEN
    ALTER TABLE wpp_general_control
      DROP CONSTRAINT IF EXISTS wpp_general_control_singleton_id;
    ALTER TABLE wpp_general_control
      ADD CONSTRAINT wpp_general_control_singleton_id CHECK (id);
  END IF;
END
$wpp_general_singleton$;

CREATE UNIQUE INDEX IF NOT EXISTS wpp_general_control_singleton_id_uidx
  ON wpp_general_control (id);

DO $wpp_general_reset_order$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wpp_general_control'::regclass
      AND conname = 'wpp_general_reset_sequence_order'
      AND POSITION('reset_applied_seq <= reset_started_seq' IN pg_catalog.pg_get_constraintdef(oid)) > 0
      AND POSITION('reset_failed_seq <= reset_started_seq' IN pg_catalog.pg_get_constraintdef(oid)) > 0
      AND POSITION('reset_started_seq <= reset_requested_seq' IN pg_catalog.pg_get_constraintdef(oid)) > 0
  ) THEN
    ALTER TABLE wpp_general_control
      DROP CONSTRAINT IF EXISTS wpp_general_reset_sequence_order;
    ALTER TABLE wpp_general_control
      ADD CONSTRAINT wpp_general_reset_sequence_order CHECK (
        reset_applied_seq <= reset_started_seq
        AND reset_failed_seq <= reset_started_seq
        AND reset_started_seq <= reset_requested_seq
      );
  END IF;
END
$wpp_general_reset_order$;

INSERT INTO wpp_general_control (id)
VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;

COMMIT;
