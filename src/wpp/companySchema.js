import { pool as dbPool } from '../db.js';
import { ensureComprobantesTransferenciaSchema } from '../transferenciasServices.js';
import { ensureWppDeliverySchema } from './delivery.js';

const COMPANY_SCHEMA_ADVISORY_LOCK_KEY = '5928237161131906375';

const EMPRESA_WHATSAPP_SCHEMA_SQL = `
  ALTER TABLE empresas
    ADD COLUMN IF NOT EXISTS wpp_qr_code TEXT,
    ADD COLUMN IF NOT EXISTS wpp_status TEXT DEFAULT 'disconnected',
    ADD COLUMN IF NOT EXISTS wpp_reset_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
`;

function clientQuery(client) {
  return async (sql, params = []) => {
    const result = await client.query(sql, params);
    return result.rows || [];
  };
}

export async function withCompanySchemaLock({ pool, migrate } = {}) {
  if (typeof pool?.connect !== 'function') throw new TypeError('pool.connect is required');
  if (typeof migrate !== 'function') throw new TypeError('migrate is required');

  const client = await pool.connect();
  let locked = false;
  let result;
  let primaryError;
  let rollbackError;
  let unlockError;
  let releaseError;

  try {
    await client.query(
      'SELECT pg_advisory_lock($1::bigint)',
      [COMPANY_SCHEMA_ADVISORY_LOCK_KEY],
    );
    locked = true;
    result = await migrate(clientQuery(client));
  } catch (error) {
    primaryError = error;
    try {
      await client.query('ROLLBACK');
    } catch (error) {
      rollbackError = error;
    }
  } finally {
    if (locked) {
      try {
        const unlocked = await client.query(
          'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
          [COMPANY_SCHEMA_ADVISORY_LOCK_KEY],
        );
        if (unlocked.rows?.[0]?.unlocked !== true) {
          throw new Error('Company schema advisory lock release was not confirmed');
        }
      } catch (error) {
        unlockError = error;
      }
    }

    const discardError = rollbackError || unlockError;
    try {
      client.release(discardError);
    } catch (error) {
      releaseError = error;
    }
  }

  if (primaryError) throw primaryError;
  if (unlockError) throw unlockError;
  if (releaseError) throw releaseError;
  return result;
}

export async function ensureCompanyWorkerSchema({ pool = dbPool } = {}) {
  return withCompanySchemaLock({
    pool,
    migrate: async query => {
      await query(EMPRESA_WHATSAPP_SCHEMA_SQL);
      await ensureWppDeliverySchema(query);
      await ensureComprobantesTransferenciaSchema(query);
    },
  });
}
