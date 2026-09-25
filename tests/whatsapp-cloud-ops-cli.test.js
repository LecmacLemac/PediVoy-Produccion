import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCloudOpsArgs,
  requiredConfirmation,
  runCloudOpsCli,
  sanitizeCliError,
} from '../src/whatsappCloud/opsCli.js';

test('CLI exige confirmación fuerte ligada al id y actor para mutaciones', () => {
  assert.deepEqual(parseCloudOpsArgs([
    'mark-sent', '--id', '42', '--actor', 'guardia-noche',
    '--meta-message-id', 'wamid.safe:42', '--confirm', 'mark-sent:42',
  ]), {
    command: 'mark-sent',
    id: 42,
    actor: 'guardia-noche',
    metaMessageId: 'wamid.safe:42',
    confirm: 'mark-sent:42',
  });
  assert.equal(requiredConfirmation('replay', 42), 'replay:42');
  assert.throws(
    () => parseCloudOpsArgs(['replay', '--id', '42', '--actor', 'ops', '--confirm', 'replay:41']),
    /confirmación inválida/i,
  );
  assert.throws(
    () => parseCloudOpsArgs(['mark-failed', '--id', '42', '--reason', 'meta_rejected', '--confirm', 'mark-failed:42']),
    /actor requerido/i,
  );
});

test('CLI lista con filtros sin requerir actor ni aceptar argumentos desconocidos', () => {
  assert.deepEqual(parseCloudOpsArgs([
    'list', '--empresa-id', '7', '--state', 'outcome_unknown', '--limit', '25',
    '--include-definitive-failed',
  ]), {
    command: 'list',
    empresaId: 7,
    state: 'outcome_unknown',
    limit: 25,
    includeDefinitiveFailed: true,
  });
  assert.throws(() => parseCloudOpsArgs(['list', '--telefono', 'secret']), /argumento desconocido/i);
});

test('errores CLI se reducen a código y mensaje seguro', () => {
  const safe = sanitizeCliError(Object.assign(
    new Error('falló postgresql://user:password@db/pedivoy teléfono 5493512345678'),
    { code: 'OPS_STALE_STATE' },
  ));
  assert.deepEqual(safe, {
    ok: false,
    code: 'OPS_STALE_STATE',
    error: 'operación rechazada',
  });
});

test('runner CLI despacha al repositorio inyectado y emite sólo JSON sanitizado', async () => {
  const calls = [];
  const output = [];
  const ops = {
    async list(args) {
      calls.push(['list', args]);
      return [{ id: 9, empresa_id: 3, status: 'error', cloud_dispatch_state: 'manual_retryable' }];
    },
    async replay(args) {
      calls.push(['replay', args]);
      return { id: args.id, status: 'pending', cloud_dispatch_state: null };
    },
  };

  await runCloudOpsCli(['list', '--empresa-id', '3'], {
    ops,
    stdout: value => output.push(value),
    env: {},
  });
  await runCloudOpsCli([
    'replay', '--id', '9', '--actor', 'guardia', '--reason', 'manual_replay', '--confirm', 'replay:9',
  ], {
    ops,
    stdout: value => output.push(value),
    env: {},
  });

  assert.deepEqual(calls, [
    ['list', { empresaId: 3, state: undefined, includeDefinitiveFailed: false, limit: 100 }],
    ['replay', { id: 9, actor: 'guardia', reason: 'manual_replay' }],
  ]);
  assert.deepEqual(output.map(line => JSON.parse(line)), [
    { ok: true, rows: [{ id: 9, empresa_id: 3, status: 'error', cloud_dispatch_state: 'manual_retryable' }] },
    { ok: true, result: { id: 9, status: 'pending', cloud_dispatch_state: null } },
  ]);
});
