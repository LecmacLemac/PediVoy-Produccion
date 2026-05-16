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
export async function query(sql, params = []) {
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
    console.error('❌ Error en ejecución de Query:', {
      message: error.message,
      sql: sql.substring(0, 100) + '...', // No logueamos todo el SQL por seguridad
      params
    });
    throw error;
  } finally {
    if (client) client.release();
  }
}

export default { query, pool };