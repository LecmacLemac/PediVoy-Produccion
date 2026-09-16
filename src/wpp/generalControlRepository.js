const CONTROL_ID = true;

const CREATE_SCHEMA_SQL = `
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
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT wpp_general_reset_sequence_order CHECK (
      reset_applied_seq <= reset_started_seq
      AND reset_failed_seq <= reset_started_seq
      AND reset_started_seq <= reset_requested_seq
    )
  )
`;

const UPGRADE_SCHEMA_SQL = `
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
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

  UPDATE wpp_general_control
  SET id = COALESCE(id, TRUE),
      epoch = COALESCE(epoch, 0),
      state = COALESCE(state, 'standby'),
      reset_requested_seq = COALESCE(reset_requested_seq, 0),
      reset_started_seq = COALESCE(reset_started_seq, 0),
      reset_applied_seq = COALESCE(reset_applied_seq, 0),
      reset_failed_seq = COALESCE(reset_failed_seq, 0),
      updated_at = COALESCE(updated_at, NOW())
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
    ALTER COLUMN updated_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET NOT NULL;

  DO $wpp_general_singleton$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'wpp_general_control'::regclass
        AND conname = 'wpp_general_control_singleton_id'
        AND pg_get_constraintdef(oid) = 'CHECK (id)'
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
        AND POSITION('reset_applied_seq <= reset_started_seq' IN pg_get_constraintdef(oid)) > 0
        AND POSITION('reset_failed_seq <= reset_started_seq' IN pg_get_constraintdef(oid)) > 0
        AND POSITION('reset_started_seq <= reset_requested_seq' IN pg_get_constraintdef(oid)) > 0
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
  $wpp_general_reset_order$
`;

const INSERT_CONTROL_ROW_SQL = `
  INSERT INTO wpp_general_control (id)
  VALUES ($1)
  ON CONFLICT (id) DO NOTHING
`;

function asResult(value) {
  if (Array.isArray(value)) return { rows: value, rowCount: value.length };
  return { rows: value?.rows ?? [], rowCount: value?.rowCount ?? value?.rows?.length ?? 0 };
}

function normalizeRow(row) {
  if (!row) return null;
  const normalized = { ...row };
  for (const key of [
    'epoch', 'reset_requested_seq', 'reset_started_seq', 'reset_applied_seq', 'reset_failed_seq',
  ]) {
    if (normalized[key] !== null && normalized[key] !== undefined) normalized[key] = BigInt(normalized[key]);
  }
  return normalized;
}

function bigintParam(value) {
  return BigInt(value).toString();
}

export function createGeneralControlRepository(defaultQuery) {
  if (typeof defaultQuery !== 'function') throw new TypeError('defaultQuery must be a function');

  const run = async (sql, params = [], executor) => {
    const query = executor?.query ? executor.query.bind(executor) : defaultQuery;
    return asResult(await query(sql, params));
  };

  async function getClusterStatus({ executor } = {}) {
    const result = await run('SELECT * FROM wpp_general_control WHERE id = $1', [CONTROL_ID], executor);
    return normalizeRow(result.rows[0]);
  }

  return {
    async ensureSchema({ executor } = {}) {
      await run(CREATE_SCHEMA_SQL, [], executor);
      await run(UPGRADE_SCHEMA_SQL, [], executor);
      await run(INSERT_CONTROL_ROW_SQL, [CONTROL_ID], executor);
    },

    get: getClusterStatus,
    getClusterStatus,

    async publishOwner({ ownerId, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET epoch = epoch + 1,
            owner_id = $1,
            state = 'starting',
            heartbeat_at = NOW(),
            operation = 'acquire',
            qr_code = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = TRUE
        RETURNING *
      `, [ownerId], executor);
      return normalizeRow(result.rows[0]);
    },

    async heartbeat({ ownerId, epoch, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET heartbeat_at = NOW(), updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
      `, [ownerId, bigintParam(epoch)], executor);
      return result.rowCount === 1;
    },

    async updateOwned({ ownerId, epoch, state, operation, qrCode = null, lastError = null, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET state = $3,
            operation = $4,
            qr_code = $5,
            last_error = $6,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
      `, [ownerId, bigintParam(epoch), state, operation, qrCode, lastError], executor);
      return result.rowCount === 1;
    },

    async releaseOwner({ ownerId, epoch, state = 'standby', lastError = null, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET owner_id = NULL,
            state = $3,
            heartbeat_at = NULL,
            operation = NULL,
            qr_code = NULL,
            last_error = $4,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
      `, [ownerId, bigintParam(epoch), state, lastError], executor);
      return result.rowCount === 1;
    },

    async requestReset({ requestedBy, cooldownMs, executor } = {}) {
      const hasCooldown = cooldownMs !== undefined;
      const cooldown = hasCooldown ? bigintParam(cooldownMs) : null;
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_requested_seq = reset_requested_seq + 1,
            reset_requested_at = NOW(),
            reset_requested_by = $1,
            updated_at = NOW()
        WHERE id = TRUE
          ${hasCooldown ? "AND (reset_requested_at IS NULL OR reset_requested_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond'))" : ''}
        RETURNING reset_requested_seq
      `, hasCooldown ? [requestedBy, cooldown] : [requestedBy], executor);
      const row = result.rows[0];
      return row ? BigInt(row.reset_requested_seq) : null;
    },

    async loadPendingReset({ executor } = {}) {
      const result = await run(`
        SELECT * FROM wpp_general_control
        WHERE id = $1 AND reset_requested_seq > reset_applied_seq
      `, [CONTROL_ID], executor);
      return normalizeRow(result.rows[0]);
    },

    async markResetStarted({ ownerId, epoch, sequence, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_started_seq = $3,
            reset_started_at = NOW(),
            operation = 'reset',
            reset_failed_at = NULL,
            reset_failure_error = NULL,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
          AND (
            reset_started_seq < $3
            OR (
              reset_started_seq = $3
              AND reset_failed_seq = $3
              AND reset_failure_error IS NOT NULL
            )
          )
          AND reset_applied_seq < $3 AND reset_requested_seq >= $3
      `, [ownerId, bigintParam(epoch), bigintParam(sequence)], executor);
      return result.rowCount === 1;
    },

    async markResetApplied({ ownerId, epoch, sequence, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_applied_seq = $3,
            reset_applied_at = NOW(),
            operation = NULL,
            reset_failure_error = NULL,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
          AND operation = 'reset'
          AND reset_applied_seq < $3 AND reset_started_seq = $3
      `, [ownerId, bigintParam(epoch), bigintParam(sequence)], executor);
      return result.rowCount === 1;
    },

    async markResetFailed({ ownerId, epoch, sequence, error, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_failed_seq = $3,
            reset_failed_at = NOW(),
            reset_failure_error = $4,
            operation = NULL,
            last_error = $4,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
          AND operation = 'reset'
          AND reset_applied_seq < $3 AND reset_started_seq = $3
      `, [ownerId, bigintParam(epoch), bigintParam(sequence), String(error)], executor);
      return result.rowCount === 1;
    },
  };
}
