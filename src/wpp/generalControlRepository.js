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
    ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS owner_id TEXT,
    ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'standby',
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS operation TEXT,
    ADD COLUMN IF NOT EXISTS qr_code TEXT,
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS reset_requested_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reset_started_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reset_applied_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reset_failed_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reset_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reset_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reset_applied_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reset_failed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reset_failure_error TEXT,
    ADD COLUMN IF NOT EXISTS reset_requested_by TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    async requestReset({ requestedBy, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_requested_seq = reset_requested_seq + 1,
            reset_requested_at = NOW(),
            reset_requested_by = $1,
            updated_at = NOW()
        WHERE id = TRUE
        RETURNING reset_requested_seq
      `, [requestedBy], executor);
      const row = result.rows[0];
      if (!row) throw new Error('General control row is missing');
      return BigInt(row.reset_requested_seq);
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
            reset_failure_error = NULL,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
          AND (reset_started_seq < $3 OR reset_failed_seq = $3)
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
          AND reset_applied_seq < $3 AND reset_started_seq >= $3
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
          AND reset_applied_seq < $3 AND reset_started_seq >= $3
      `, [ownerId, bigintParam(epoch), bigintParam(sequence), String(error)], executor);
      return result.rowCount === 1;
    },
  };
}
