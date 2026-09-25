import { pathToFileURL } from 'node:url';

const MUTATING_COMMANDS = new Set(['mark-sent', 'mark-failed', 'confirm-not-sent', 'replay']);
const VALID_STATES = new Set(['dispatch_started', 'outcome_unknown', 'manual_retryable', 'definitive_failed']);

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(String(value || ''))) throw new Error(`${label} inválido`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} inválido`);
  return parsed;
}

function takeValue(args, index, name) {
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`${name} requiere valor`);
  return args[index + 1];
}

export function requiredConfirmation(command, id) {
  return `${command}:${id}`;
}

export function parseCloudOpsArgs(argv, { env = process.env } = {}) {
  const args = [...argv];
  const command = args.shift();
  if (!['list', ...MUTATING_COMMANDS].includes(command)) throw new Error('comando inválido');
  const parsed = { command };

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--include-definitive-failed') {
      if (command !== 'list') throw new Error(`argumento desconocido: ${name}`);
      parsed.includeDefinitiveFailed = true;
      continue;
    }
    const value = takeValue(args, index, name);
    index += 1;
    switch (name) {
      case '--id': parsed.id = positiveInteger(value, 'id'); break;
      case '--empresa-id': parsed.empresaId = positiveInteger(value, 'empresa-id'); break;
      case '--limit': parsed.limit = positiveInteger(value, 'limit'); break;
      case '--state':
        if (!VALID_STATES.has(value)) throw new Error('state inválido');
        parsed.state = value;
        break;
      case '--actor': parsed.actor = value.trim(); break;
      case '--reason': parsed.reason = value.trim(); break;
      case '--meta-message-id': parsed.metaMessageId = value; break;
      case '--confirm': parsed.confirm = value; break;
      default: throw new Error(`argumento desconocido: ${name}`);
    }
  }

  if (command === 'list') {
    if (parsed.id || parsed.actor || parsed.reason || parsed.metaMessageId || parsed.confirm) {
      throw new Error('argumento desconocido para list');
    }
    return parsed;
  }

  parsed.actor ||= String(env.WHATSAPP_CLOUD_OPS_ACTOR || '').trim();
  if (!parsed.id) throw new Error('id requerido');
  if (!parsed.actor) throw new Error('actor requerido');
  if (parsed.confirm !== requiredConfirmation(command, parsed.id)) throw new Error('confirmación inválida');
  if (command === 'mark-sent' && !parsed.metaMessageId) throw new Error('meta-message-id requerido');
  if (['mark-failed', 'confirm-not-sent'].includes(command) && !parsed.reason) throw new Error('reason requerido');
  return parsed;
}

export function sanitizeCliError(error) {
  const knownCodes = new Set([
    'OPS_INVALID_ARGUMENT', 'OPS_STALE_STATE', 'OPS_NOT_FOUND', 'OPS_CONFIRMATION_REQUIRED',
    'OPS_COMMIT_OUTCOME_UNKNOWN', 'OPS_DB_UNAVAILABLE',
  ]);
  const code = knownCodes.has(error?.code) ? error.code : 'OPS_FAILED';
  return { ok: false, code, error: 'operación rechazada' };
}

export async function runCloudOpsCli(argv = process.argv.slice(2), {
  ops: injectedOps,
  stdout = value => process.stdout.write(`${value}\n`),
  env = process.env,
} = {}) {
  const parsed = parseCloudOpsArgs(argv, { env });
  let ops = injectedOps;
  let ownedPool;
  if (!ops) {
    const [{ pool }, { createCloudOps }] = await Promise.all([
      import('../db.js'),
      import('./opsRepository.js'),
    ]);
    ownedPool = pool;
    ops = createCloudOps({ pool });
  }

  try {
    let payload;
    switch (parsed.command) {
      case 'list':
        payload = {
          ok: true,
          rows: await ops.list({
            empresaId: parsed.empresaId,
            state: parsed.state,
            includeDefinitiveFailed: parsed.includeDefinitiveFailed ?? false,
            limit: parsed.limit ?? 100,
          }),
        };
        break;
      case 'mark-sent':
        payload = {
          ok: true,
          result: await ops.markSent({
            id: parsed.id,
            actor: parsed.actor,
            metaMessageId: parsed.metaMessageId,
          }),
        };
        break;
      case 'mark-failed':
        payload = {
          ok: true,
          result: await ops.markFailed({ id: parsed.id, actor: parsed.actor, reason: parsed.reason }),
        };
        break;
      case 'confirm-not-sent':
        payload = {
          ok: true,
          result: await ops.confirmNotSent({ id: parsed.id, actor: parsed.actor, reason: parsed.reason }),
        };
        break;
      case 'replay':
        payload = {
          ok: true,
          result: await ops.replay({ id: parsed.id, actor: parsed.actor, reason: parsed.reason }),
        };
        break;
      default:
        throw Object.assign(new Error('comando inválido'), { code: 'OPS_INVALID_ARGUMENT' });
    }
    stdout(JSON.stringify(payload));
    return payload;
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloudOpsCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify(sanitizeCliError(error))}\n`);
    process.exitCode = 1;
  });
}
