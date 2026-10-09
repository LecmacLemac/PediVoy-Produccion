// src/db.js — PostgreSQL (ESM)
import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import pkg from 'pg';
const { Pool } = pkg;

const url = process.env.DATABASE_URL || '';
const dbQueryContext = new AsyncLocalStorage();

export function runWithSensitiveDbQueries(work) {
  if (typeof work !== 'function') throw new TypeError('work es requerida');
  return dbQueryContext.run({ sensitive: true, suppressErrors: true }, work);
}

// Detectar si estamos en Render para forzar SSL
const isRender =
  !!process.env.RENDER ||
  /render\.com/i.test(url) ||
  /onrender\.com/i.test(url);

/**
 * Configuración del Pool de Conexiones
 * max: 20 es ideal para el Worker de una sola empresa.
 * Si este archivo lo usa el "MultiWorker", considera subirlo a 50.
 */
export const pool = new Pool({
  connectionString: url,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // No esperar más de 5s para conectar
  ssl: isRender ? { rejectUnauthorized: false } : false,
  keepAlive: true
});

// Evento de error para evitar que el proceso se cuelgue
pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool de PostgreSQL:', err.message);
});

/**
 * Función de consulta con manejo de errores y logging
 */
export async function query(sql, params = [], { sensitive = false } = {}) {
  const start = Date.now();
  let client;
  let releaseError;

  try {
    client = await pool.connect();
    const res = await client.query(sql, params);

    // Log opcional para debug en desarrollo
    if (process.env.NODE_ENV !== 'production' && process.env.DEBUG_DB) {
      const duration = Date.now() - start;
      console.log(`[DB Query] ${duration}ms | rows: ${res.rowCount}`);
    }

    return res.rows;
  } catch (error) {
    if (client && /^\s*BEGIN\s*;/i.test(String(sql))) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    const context = dbQueryContext.getStore();
    const effectiveSensitive = sensitive || context?.sensitive === true;
    if (context?.suppressErrors !== true) {
      console.error('❌ Error en ejecución de Query:', effectiveSensitive
        ? { message: 'Consulta sensible fallida', sql: '[REDACTED]', params: '[REDACTED]' }
        : {
            message: error.message,
            sql: sql.substring(0, 100) + '...', // No logueamos todo el SQL por seguridad
            params,
          });
    }
    throw error;
  } finally {
    if (client) client.release(releaseError);
  }
}

const RETRYABLE_TRANSACTION_CODES = new Set(['40P01', '40001']);

// Mantiene lecturas con bloqueo y escrituras en la misma conexión.
export async function withTransaction(work, {
  pool: transactionPool = pool,
  maxRetries = 2,
  retryDelayMs = 20,
} = {}) {
  if (typeof work !== 'function') throw new TypeError('withTransaction requiere una función');

  for (let attempt = 0; ; attempt += 1) {
    const client = await transactionPool.connect();
    let releaseError;
    let retry = false;
    let phase = 'BEGIN';
    const txQuery = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return result.rows || [];
    };

    try {
      await client.query('BEGIN');
      phase = 'WORK';
      const result = await work(txQuery, client);
      phase = 'COMMIT';
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (phase === 'COMMIT') {
        releaseError = error;
        const outcomeUnknown = new Error('No se pudo confirmar el resultado de la transacción');
        outcomeUnknown.code = 'TRANSACTION_OUTCOME_UNKNOWN';
        throw outcomeUnknown;
      }

      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
      }

      retry = !releaseError
        && RETRYABLE_TRANSACTION_CODES.has(error?.code)
        && attempt < maxRetries;
      if (!retry) throw error;
    } finally {
      client.release(releaseError);
    }

    if (retryDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

export default { query, pool, runWithSensitiveDbQueries, withTransaction };
