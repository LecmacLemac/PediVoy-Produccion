import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runTransactionOnLockedClient,
  withEmpresaWhatsappConfigLock,
} from '../src/wpp/companyConfigLock.js';

function createLockPool({ onQuery, onRelease } = {}) {
  const calls = [];
  const releaseArgs = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (onQuery) return onQuery(text, values, calls);
      if (/pg_advisory_unlock/.test(text)) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    },
    release(error) {
      releaseArgs.push(error);
      return onRelease?.(error);
    },
  };
  return {
    calls,
    client,
    releaseArgs,
    async connect() { return client; },
  };
}

function assertSanitized(error, code, secrets = []) {
  assert.equal(error?.code, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const exposed = [
    error?.message,
    error?.stack,
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyDescriptors(error || {})),
  ].join('\n');
  for (const secret of secrets) assert.equal(exposed.includes(secret), false);
  return true;
}

test('lock preserva error primario, intenta unlock y libera una sola vez aunque unlock falle', async () => {
  const primary = new Error('callback primary');
  const unlock = new Error('unlock private detail');
  const pool = createLockPool({
    onQuery: async text => {
      if (/pg_advisory_unlock/.test(text)) throw unlock;
      return { rows: [] };
    },
  });

  await assert.rejects(
    withEmpresaWhatsappConfigLock(pool, 7, async () => { throw primary; }),
    error => error === primary,
  );

  assert.deepEqual(pool.calls.map(call => /unlock/.test(call.text) ? 'UNLOCK' : 'LOCK'), ['LOCK', 'UNLOCK']);
  assert.equal(pool.releaseArgs.length, 1);
  assert.equal(pool.releaseArgs[0], unlock);
});

test('lock libera descartando cliente y propaga error sanitizado si solo falla unlock', async () => {
  const secret = 'unlock-private-pii';
  const unlock = new Error(secret);
  const pool = createLockPool({
    onQuery: async text => {
      if (/pg_advisory_unlock/.test(text)) throw unlock;
      return { rows: [] };
    },
  });

  await assert.rejects(
    withEmpresaWhatsappConfigLock(pool, 7, async () => 'ok'),
    error => assertSanitized(error, 'WPP_CONFIG_LOCK_RELEASE_FAILED', [secret]),
  );
  assert.equal(pool.releaseArgs.length, 1);
  assert.equal(pool.releaseArgs[0], unlock);
});

test('lock no deja que release reemplace el error primario', async () => {
  const primary = new Error('primary transaction error');
  const pool = createLockPool({
    onRelease: () => { throw new Error('release private detail'); },
  });

  await assert.rejects(
    withEmpresaWhatsappConfigLock(pool, 7, async () => { throw primary; }),
    error => error === primary,
  );
  assert.equal(pool.releaseArgs.length, 1);
});

test('lock propaga error sanitizado si release falla sin error primario', async () => {
  const secret = 'release-private-pii';
  const pool = createLockPool({
    onRelease: () => { throw new Error(secret); },
  });

  await assert.rejects(
    withEmpresaWhatsappConfigLock(pool, 7, async () => 'ok'),
    error => assertSanitized(error, 'WPP_CONFIG_LOCK_RELEASE_FAILED', [secret]),
  );
  assert.equal(pool.releaseArgs.length, 1);
});

const invalidUnlockResults = [
  ['rows vacías', { rows: [] }],
  ['campo ausente', { rows: [{}] }],
  ['null', { rows: [{ unlocked: null }] }],
  ['false', { rows: [{ unlocked: false }] }],
  ['múltiples filas', { rows: [{ unlocked: true }, { unlocked: true }] }],
  ['forma inesperada', { rows: null }],
];

for (const [label, unlockResult] of invalidUnlockResults) {
  test(`unlock exige exactamente una fila true: ${label}`, async () => {
    const pool = createLockPool({
      onQuery: async text => (/pg_advisory_unlock/.test(text) ? unlockResult : { rows: [] }),
    });

    await assert.rejects(
      withEmpresaWhatsappConfigLock(pool, 7, async () => 'ok'),
      error => assertSanitized(error, 'WPP_CONFIG_LOCK_RELEASE_FAILED'),
    );
    assert.equal(pool.releaseArgs.length, 1);
    assert.equal(pool.releaseArgs[0] instanceof Error, true);
  });
}

test('unlock dudoso descarta cliente pero preserva el error primario', async () => {
  const primary = new Error('primary operation failed');
  const pool = createLockPool({
    onQuery: async text => (/pg_advisory_unlock/.test(text) ? { rows: [] } : { rows: [] }),
  });

  await assert.rejects(
    withEmpresaWhatsappConfigLock(pool, 7, async () => { throw primary; }),
    error => error === primary,
  );
  assert.equal(pool.releaseArgs.length, 1);
  assert.equal(pool.releaseArgs[0] instanceof Error, true);
  assert.notEqual(pool.releaseArgs[0], primary);
});

test('lock descarta cliente si falla la adquisición y libera una sola vez', async () => {
  const acquire = new Error('acquire failed');
  const pool = createLockPool({
    onQuery: async text => {
      if (/pg_advisory_lock/.test(text)) throw acquire;
      return { rows: [] };
    },
  });

  await assert.rejects(withEmpresaWhatsappConfigLock(pool, 7, async () => {}), error => error === acquire);
  assert.equal(pool.calls.some(call => /pg_advisory_unlock/.test(call.text)), false);
  assert.deepEqual(pool.releaseArgs, [acquire]);
});

test('transacción descarta cliente si BEGIN falla', async () => {
  const begin = new Error('begin failed');
  const client = { async query(text) { if (text === 'BEGIN') throw begin; } };

  await assert.rejects(runTransactionOnLockedClient(client, async () => {}), error => error === begin);
  assert.equal(begin.discardClient, true);
});

test('transacción preserva callback primario y lo marca para descarte si ROLLBACK falla', async () => {
  const primary = new Error('callback failed');
  const rollback = new Error('rollback failed');
  const client = {
    async query(text) {
      if (text === 'ROLLBACK') throw rollback;
      return { rows: [] };
    },
  };

  await assert.rejects(
    runTransactionOnLockedClient(client, async () => { throw primary; }),
    error => error === primary,
  );
  assert.equal(primary.discardClient, true);
});
