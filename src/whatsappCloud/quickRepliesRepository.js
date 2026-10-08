const PG_INT4_MAX = 2147483647;

function publicError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function tenantId(value) {
  if (!Number.isInteger(value) || value <= 0 || value > PG_INT4_MAX) throw publicError('QUICK_REPLY_INVALID', 'Invalid tenant');
  return value;
}

function actorId(value) {
  if (!Number.isInteger(value) || value <= 0 || value > PG_INT4_MAX) throw publicError('QUICK_REPLY_ACTOR_FORBIDDEN', 'Actor forbidden');
  return value;
}

function actorRole(value) {
  if (value !== 'admin' && value !== 'super') throw publicError('QUICK_REPLY_ACTOR_FORBIDDEN', 'Actor forbidden');
  return value;
}

function quickReplyId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw publicError('QUICK_REPLY_INVALID', 'Invalid quick reply id');
  }
  return value;
}

function version(value) {
  if (!Number.isInteger(value) || value <= 0 || value > PG_INT4_MAX) throw publicError('QUICK_REPLY_INVALID', 'Invalid version');
  return value;
}

function dto(row) {
  return {
    id: String(row.id),
    shortcut: row.shortcut,
    title: row.title,
    body: row.body,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

async function lockActor(client, { usuarioId, actorRole: expectedRole, empresaId }) {
  const result = await client.query(
    `SELECT role, empresa_id, activo
       FROM public.usuarios
      WHERE id = $1
      FOR UPDATE`,
    [usuarioId],
  );
  const actor = result.rows[0];
  const allowed = actor?.activo === true
    && actor.role === expectedRole
    && (expectedRole === 'admin' ? Number(actor.empresa_id) === empresaId : actor.empresa_id == null);
  if (!allowed) throw publicError('QUICK_REPLY_ACTOR_FORBIDDEN', 'Actor forbidden');
}

async function transaction(pool, input, work) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool es requerido');
  const empresaId = tenantId(input.empresaId);
  const usuarioId = actorId(input.usuarioId);
  const expectedRole = actorRole(input.actorRole);
  const client = await pool.connect();
  let commitAttempted = false;
  let releaseError;
  try {
    await client.query('BEGIN');
    await lockActor(client, { usuarioId, actorRole: expectedRole, empresaId });
    const result = await work(client, { empresaId, usuarioId });
    commitAttempted = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (commitAttempted) {
      releaseError = publicError('QUICK_REPLY_OUTCOME_UNKNOWN', 'Quick reply outcome unknown');
      throw releaseError;
    }
    await client.query('ROLLBACK').catch(rollbackError => { releaseError = rollbackError; });
    if (['QUICK_REPLY_INVALID', 'QUICK_REPLY_ACTOR_FORBIDDEN'].includes(error?.code)) throw error;
    if (error?.code === '23505') return { outcome: 'conflict', quickReply: null };
    throw publicError('QUICK_REPLY_FAILED', 'Quick reply operation failed');
  } finally {
    client.release(releaseError);
  }
}

export function createQuickRepliesRepository({ pool, query } = {}) {
  const runQuery = typeof query === 'function'
    ? query
    : async (sql, params) => (await pool.query(sql, params)).rows;
  return {
    async list({ empresaId, includeInactive = false } = {}) {
      const id = tenantId(empresaId);
      try {
        const rows = await runQuery(
          `SELECT id, shortcut, title, body, sort_order, is_active, version, updated_at
             FROM public.whatsapp_cloud_quick_replies
            WHERE empresa_id = $1
              AND ($2::boolean OR is_active)
            ORDER BY sort_order ASC, title ASC, id ASC`,
          [id, includeInactive === true],
          { sensitive: true },
        );
        return rows.map(dto);
      } catch {
        throw publicError('QUICK_REPLY_FAILED', 'Quick reply list failed');
      }
    },

    async create(input = {}) {
      return transaction(pool, input, async (client, { empresaId, usuarioId }) => {
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock(1464550725, $1)', [empresaId]);
        const result = await client.query(
          `INSERT INTO public.whatsapp_cloud_quick_replies
             (empresa_id, shortcut, title, body, sort_order, is_active, version,
              created_by, updated_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,pg_catalog.NOW(),pg_catalog.NOW())
           RETURNING id, shortcut, title, body, sort_order, is_active, version, updated_at`,
          [empresaId, input.shortcut, input.title, input.body, input.sortOrder, input.isActive, usuarioId],
        );
        return { outcome: 'created', quickReply: dto(result.rows[0]) };
      });
    },

    async update(input = {}) {
      const id = quickReplyId(input.id);
      const expectedVersion = version(input.expectedVersion);
      return transaction(pool, input, async (client, { empresaId, usuarioId }) => {
        const currentResult = await client.query(
          `SELECT id, shortcut, title, body, sort_order, is_active, version, updated_at
             FROM public.whatsapp_cloud_quick_replies
            WHERE empresa_id = $1 AND id = $2::uuid
            FOR UPDATE`,
          [empresaId, id],
        );
        if (currentResult.rows.length === 0) return { outcome: 'not_found', quickReply: null };
        const current = currentResult.rows[0];
        if (current.version !== expectedVersion) return { outcome: 'stale', quickReply: dto(current) };
        const result = await client.query(
          `UPDATE public.whatsapp_cloud_quick_replies
              SET shortcut = COALESCE($3, shortcut),
                  title = COALESCE($4, title),
                  body = COALESCE($5, body),
                  sort_order = COALESCE($6, sort_order),
                  is_active = COALESCE($7, is_active),
                  version = version + 1,
                  updated_by = $8,
                  updated_at = pg_catalog.NOW()
            WHERE empresa_id = $1 AND id = $2::uuid AND version = $9
          RETURNING id, shortcut, title, body, sort_order, is_active, version, updated_at`,
          [empresaId, id, input.shortcut ?? null, input.title ?? null, input.body ?? null,
            input.sortOrder ?? null, input.isActive ?? null, usuarioId, expectedVersion],
        );
        if (result.rows.length !== 1) throw new Error('locked quick reply lost');
        return { outcome: 'updated', quickReply: dto(result.rows[0]) };
      });
    },

    async disable(input = {}) {
      return this.update({ ...input, isActive: false });
    },
  };
}
