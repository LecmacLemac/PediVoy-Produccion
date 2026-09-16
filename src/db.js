// src/db.js — PostgreSQL (ESM)
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const url = process.env.DATABASE_URL || '';

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
    console.error('❌ Error en ejecución de Query:', sensitive
      ? { message: 'Consulta sensible fallida', sql: '[REDACTED]', params: '[REDACTED]' }
      : {
          message: error.message,
          sql: sql.substring(0, 100) + '...', // No logueamos todo el SQL por seguridad
          params,
        });
    throw error;
  } finally {
    if (client) client.release();
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
    const txQuery = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return result.rows || [];
    };

    try {
      await client.query('BEGIN');
      const result = await work(txQuery, client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
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

export default { query, pool, withTransaction };
