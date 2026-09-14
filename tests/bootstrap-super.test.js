import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { bootstrapSuper } from '../scripts/bootstrap-super.js';

const initSql = fs.readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function createPool({ existingSuper = [], insertError = null } = {}) {
  const calls = [];
  let connectCount = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id FROM usuarios/i.test(sql)) return { rows: existingSuper };
      if (/INSERT INTO usuarios/i.test(sql)) {
        if (insertError) throw insertError;
        return { rows: [{ id: 7, username: params[0], role: 'super', empresa_id: null, activo: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    calls,
    get connectCount() { return connectCount; },
    async connect() { connectCount += 1; return client; },
  };
}

const validEnv = {
  BOOTSTRAP_SUPER_USERNAME: 'super.ops',
  BOOTSTRAP_SUPER_PASSWORD: 'Correct-Horse-9!',
};

const fakeBcrypt = {
  async hash(password, rounds) {
    assert.equal(password, validEnv.BOOTSTRAP_SUPER_PASSWORD);
    assert.equal(rounds, 12);
    return 'bcrypt-hash-placeholder';
  },
};

test('initDb.sql no crea ni modifica cuentas super/admin ni fuerza la empresa 1 activa', () => {
  assert.doesNotMatch(initSql, /DELETE\s+FROM\s+usuarios/i);
  assert.doesNotMatch(initSql, /INSERT\s+INTO\s+usuarios[\s\S]*?['"]super['"]/i);
  assert.doesNotMatch(initSql, /INSERT\s+INTO\s+empresas\s*\([^;]+VALUES\s*\(\s*1\s*,/i);
  assert.doesNotMatch(initSql, /ON\s+CONFLICT\s*\(id\)[\s\S]*?SET\s+plan_estado\s*=\s*['"]active['"]/i);
  assert.doesNotMatch(initSql, /\b(?:user|usuario|pass|password|contrase(?:ña|na))\s*:/i);
});

test('bootstrap exige credenciales completas por variables de entorno antes de conectar', async () => {
  for (const env of [
    {},
    { BOOTSTRAP_SUPER_USERNAME: validEnv.BOOTSTRAP_SUPER_USERNAME },
    { BOOTSTRAP_SUPER_PASSWORD: validEnv.BOOTSTRAP_SUPER_PASSWORD },
  ]) {
    const pool = createPool();
    await assert.rejects(bootstrapSuper({ pool, bcrypt: fakeBcrypt, env }), /BOOTSTRAP_SUPER_/);
    assert.equal(pool.connectCount, 0);
  }
});

test('bootstrap rechaza username inválido y contraseña débil antes de conectar', async () => {
  const invalidInputs = [
    { ...validEnv, BOOTSTRAP_SUPER_USERNAME: 'nombre con espacios' },
    { ...validEnv, BOOTSTRAP_SUPER_PASSWORD: 'Short-9!' },
    { ...validEnv, BOOTSTRAP_SUPER_PASSWORD: 'solamenteminusculas' },
    { ...validEnv, BOOTSTRAP_SUPER_PASSWORD: 'SINSIMBOLO9A' },
  ];
  for (const env of invalidInputs) {
    const pool = createPool();
    await assert.rejects(bootstrapSuper({ pool, bcrypt: fakeBcrypt, env }), /inválid|contraseña/i);
    assert.equal(pool.connectCount, 0);
  }
});

test('bootstrap aborta y revierte si ya existe cualquier super, incluso inactivo', async () => {
  const pool = createPool({ existingSuper: [{ id: 3 }] });

  await assert.rejects(
    bootstrapSuper({ pool, bcrypt: fakeBcrypt, env: validEnv }),
    /ya existe/i,
  );

  assert.equal(pool.connectCount, 1);
  assert.deepEqual(pool.calls.map(call => call.sql), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1)',
    "SELECT id FROM usuarios WHERE LOWER(BTRIM(role)) = 'super' LIMIT 1",
    'ROLLBACK',
    'RELEASE',
  ]);
});

test('bootstrap detecta variantes sospechosas de super sin normalizarlas ni insertar otra cuenta', async () => {
  const pool = createPool({ existingSuper: [{ id: 9, role: ' super ' }] });

  await assert.rejects(
    bootstrapSuper({ pool, bcrypt: fakeBcrypt, env: validEnv }),
    /ya existe/i,
  );

  const detection = pool.calls.find(call => /SELECT id FROM usuarios/i.test(call.sql));
  assert.match(detection.sql, /LOWER\s*\(\s*BTRIM\s*\(\s*role\s*\)\s*\)\s*=\s*'super'/i);
  assert.equal(pool.calls.some(call => /UPDATE\s+usuarios/i.test(call.sql)), false);
  assert.equal(pool.calls.some(call => /INSERT\s+INTO\s+usuarios/i.test(call.sql)), false);
  assert.deepEqual(pool.calls.slice(-2).map(call => call.sql), ['ROLLBACK', 'RELEASE']);
});

test('bootstrap crea exactamente un super global y confirma usando una sola conexión', async () => {
  const pool = createPool();
  const result = await bootstrapSuper({ pool, bcrypt: fakeBcrypt, env: validEnv });

  assert.deepEqual(result, { id: 7, username: 'super.ops', role: 'super', empresa_id: null, activo: true });
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(pool.calls.map(call => call.sql), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock($1)',
    "SELECT id FROM usuarios WHERE LOWER(BTRIM(role)) = 'super' LIMIT 1",
    `INSERT INTO usuarios (username, password, role, empresa_id, activo)
       VALUES ($1, $2, 'super', NULL, TRUE)
       RETURNING id, username, role, empresa_id, activo`,
    'COMMIT',
    'RELEASE',
  ]);
  const insert = pool.calls.find(call => /INSERT INTO usuarios/i.test(call.sql));
  assert.deepEqual(insert.params, ['super.ops', 'bcrypt-hash-placeholder']);
  assert.equal(pool.calls.some(call => call.params.includes(validEnv.BOOTSTRAP_SUPER_PASSWORD)), false);
});

test('bootstrap revierte y libera la conexión cuando falla el insert', async () => {
  const failure = new Error('insert failure');
  const pool = createPool({ insertError: failure });

  await assert.rejects(
    bootstrapSuper({ pool, bcrypt: fakeBcrypt, env: validEnv }),
    error => error === failure,
  );
  assert.deepEqual(pool.calls.slice(-2).map(call => call.sql), ['ROLLBACK', 'RELEASE']);
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
});

test('bootstrap-super es explícito y no forma parte de start, prestart ni init-db', () => {
  assert.equal(packageJson.scripts['bootstrap-super'], 'node scripts/bootstrap-super.js');
  for (const name of ['start', 'prestart', 'init-db']) {
    assert.doesNotMatch(packageJson.scripts[name], /bootstrap-super/i, name);
  }

  for (const relativePath of ['../server.js', '../initDb.js', '../src/initDb.js']) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /bootstrap-super/i, relativePath);
  }
});
