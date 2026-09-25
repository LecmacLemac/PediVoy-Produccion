const EMPRESA_WHATSAPP_CONFIG_LOCK_NAMESPACE = 0x57505043;

function normalizeEmpresaId(empresaId) {
  const value = Number(empresaId);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw new TypeError('empresaId must be a positive 32-bit integer');
  }
  return value;
}

function markClientBroken(error) {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'discardClient', { value: true, configurable: true });
  }
  return error;
}

function unknownCommitOutcomeError() {
  return markClientBroken(Object.assign(
    new Error('WhatsApp configuration transaction outcome is unknown'),
    { code: 'WPP_CONFIG_TRANSACTION_OUTCOME_UNKNOWN' },
  ));
}

function configLockReleaseError() {
  return Object.assign(
    new Error('WhatsApp configuration lock cleanup failed'),
    { code: 'WPP_CONFIG_LOCK_RELEASE_FAILED' },
  );
}

export async function runTransactionOnLockedClient(client, work) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client.query is required');
  if (typeof work !== 'function') throw new TypeError('work must be a function');

  let began = false;
  let commitAttempted = false;
  const txQuery = async (sql, params = []) => {
    const result = await client.query(sql, params);
    return result?.rows || [];
  };

  try {
    await client.query('BEGIN');
    began = true;
    const result = await work(txQuery, client);
    commitAttempted = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (commitAttempted) throw unknownCommitOutcomeError();
    if (!began) {
      markClientBroken(error);
      throw error;
    }
    try {
      await client.query('ROLLBACK');
    } catch {
      markClientBroken(error);
    }
    throw error;
  }
}

export async function withEmpresaWhatsappConfigLock(pool, empresaId, work) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool.connect is required');
  }
  if (typeof work !== 'function') throw new TypeError('work must be a function');

  const id = normalizeEmpresaId(empresaId);
  const client = await pool.connect();
  let locked = false;
  let operationError = null;
  let unlockError = null;
  let releaseError = null;
  let result;

  try {
    try {
      await client.query(
        'SELECT pg_advisory_lock($1, $2)',
        [EMPRESA_WHATSAPP_CONFIG_LOCK_NAMESPACE, id],
      );
      locked = true;
      result = await work(client);
    } catch (error) {
      operationError = error;
    }

    if (locked) {
      try {
        const unlockResult = await client.query(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked',
          [EMPRESA_WHATSAPP_CONFIG_LOCK_NAMESPACE, id],
        );
        if (!Array.isArray(unlockResult?.rows)
          || unlockResult.rows.length !== 1
          || unlockResult.rows[0]?.unlocked !== true) {
          throw new Error('empresa WhatsApp advisory lock cleanup was not confirmed');
        }
      } catch (error) {
        unlockError = error;
      }
    }
  } finally {
    const discardError = unlockError
      || (operationError && (!locked || operationError.discardClient === true) ? operationError : null);
    try {
      client.release(discardError || undefined);
    } catch (error) {
      releaseError = error;
    }
  }

  if (operationError) throw operationError;
  if (unlockError || releaseError) throw configLockReleaseError();
  return result;
}

export const empresaWhatsappConfigLockNamespace = EMPRESA_WHATSAPP_CONFIG_LOCK_NAMESPACE;
