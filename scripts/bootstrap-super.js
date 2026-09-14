import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import bcryptDefault from 'bcryptjs';
import { pool as poolDefault } from '../src/db.js';

const ADVISORY_LOCK_KEY = 1163087685;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

function credentialsFromEnv(env) {
  const usernameRaw = env?.BOOTSTRAP_SUPER_USERNAME;
  const password = env?.BOOTSTRAP_SUPER_PASSWORD;

  if (typeof usernameRaw !== 'string' || usernameRaw.length === 0) {
    throw new Error('Falta BOOTSTRAP_SUPER_USERNAME');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Falta BOOTSTRAP_SUPER_PASSWORD');
  }

  const username = usernameRaw.trim();
  if (username !== usernameRaw || !USERNAME_PATTERN.test(username)) {
    throw new Error('BOOTSTRAP_SUPER_USERNAME inválido');
  }
  if (
    password.length < 12
    || !/[a-z]/.test(password)
    || !/[A-Z]/.test(password)
    || !/[0-9]/.test(password)
    || !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error('Contraseña inválida: BOOTSTRAP_SUPER_PASSWORD debe tener al menos 12 caracteres, mayúscula, minúscula, número y símbolo');
  }

  return { username, password };
}

export async function bootstrapSuper({
  pool = poolDefault,
  bcrypt = bcryptDefault,
  env = process.env,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool inválido');
  if (!bcrypt || typeof bcrypt.hash !== 'function') throw new TypeError('bcrypt inválido');

  const { username, password } = credentialsFromEnv(env);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);

    // Los super son globales en el modelo actual: empresa_id siempre queda NULL.
    const existing = await client.query("SELECT id FROM usuarios WHERE LOWER(BTRIM(role)) = 'super' LIMIT 1");
    if (existing.rows.length > 0) {
      throw new Error('Bootstrap cancelado: ya existe un usuario super');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await client.query(
      `INSERT INTO usuarios (username, password, role, empresa_id, activo)
       VALUES ($1, $2, 'super', NULL, TRUE)
       RETURNING id, username, role, empresa_id, activo`,
      [username, passwordHash],
    );
    if (inserted.rowCount !== 1 || inserted.rows.length !== 1) {
      throw new Error('Bootstrap cancelado: no se insertó exactamente un usuario super');
    }

    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function isDirectExecution() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  try {
    const created = await bootstrapSuper();
    console.log(`Bootstrap super completado (id=${created.id})`);
  } catch (error) {
    console.error(`Bootstrap super falló: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await poolDefault.end();
  }
}
