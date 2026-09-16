const CONTROL_ID = true;

function asResult(value) {
  if (Array.isArray(value)) return { rows: value, rowCount: value.length };
  return { rows: value?.rows ?? [], rowCount: value?.rowCount ?? value?.rows?.length ?? 0 };
}

function normalizeRow(row) {
  if (!row) return null;
  const normalized = { ...row };
  for (const key of ['epoch', 'reset_requested_seq', 'reset_started_seq', 'reset_applied_seq']) {
    if (normalized[key] !== null && normalized[key] !== undefined) normalized[key] = BigInt(normalized[key]);
  }
  return normalized;
}

function epochParam(epoch) {
  return BigInt(epoch).toString();
}

export function createGeneralControlRepository(defaultQuery) {
  if (typeof defaultQuery !== 'function') throw new TypeError('defaultQuery must be a function');

  const run = async (sql, params, executor) => {
    const query = executor?.query ? executor.query.bind(executor) : defaultQuery;
    return asResult(await query(sql, params));
  };

  return {
    async get({ executor } = {}) {
      const result = await run('SELECT * FROM wpp_general_control WHERE id = $1', [CONTROL_ID], executor);
      return normalizeRow(result.rows[0]);
    },

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
      `, [ownerId, epochParam(epoch)], executor);
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
      `, [ownerId, epochParam(epoch), state, operation, qrCode, lastError], executor);
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
      `, [ownerId, epochParam(epoch), state, lastError], executor);
      return result.rowCount === 1;
    },

    async requestReset({ requestedBy } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_requested_seq = reset_requested_seq + 1,
            reset_requested_at = NOW(),
            reset_requested_by = $1,
            updated_at = NOW()
        WHERE id = TRUE
        RETURNING reset_requested_seq
      `, [requestedBy]);
      const row = result.rows[0];
      if (!row) throw new Error('General control row is missing');
      return BigInt(row.reset_requested_seq);
    },

    async markResetStarted({ ownerId, epoch, sequence, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_started_seq = $3,
            reset_started_at = NOW(),
            operation = 'reset',
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
          AND reset_started_seq < $3 AND reset_requested_seq >= $3
      `, [ownerId, epochParam(epoch), epochParam(sequence)], executor);
      return result.rowCount === 1;
    },

    async markResetApplied({ ownerId, epoch, sequence, executor } = {}) {
      const result = await run(`
        UPDATE wpp_general_control
        SET reset_applied_seq = $3,
            reset_applied_at = NOW(),
            operation = NULL,
            updated_at = NOW()
        WHERE owner_id = $1 AND epoch = $2 AND id = TRUE
          AND reset_applied_seq < $3 AND reset_started_seq >= $3
      `, [ownerId, epochParam(epoch), epochParam(sequence)], executor);
      return result.rowCount === 1;
    },
  };
}
