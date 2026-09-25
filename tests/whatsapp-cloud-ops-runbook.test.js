import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const runbook = readFileSync(new URL('../docs/WHATSAPP_CLOUD_AMBIGUOUS_OPS_RUNBOOK.md', import.meta.url), 'utf8');

test('CLI Cloud ops es opt-in por npm script y no forma parte del runtime web', () => {
  assert.equal(packageJson.scripts['ops:whatsapp-cloud'], 'node src/whatsappCloud/opsCli.js');
  assert.match(runbook, /consultar Meta antes de replay/i);
  assert.match(runbook, /dispatch_started/i);
  assert.match(runbook, /outcome_unknown/i);
  assert.match(runbook, /429/i);
  assert.match(runbook, /confirm-not-sent/i);
  assert.match(runbook, /replay:<id>/i);
  assert.doesNotMatch(runbook, /access_token|DATABASE_URL|postgresql:\/\//i);
});

test('runbook permite replay directo de 429 manual_retryable y reserva confirm-not-sent para ambiguos', () => {
  const rateLimited = runbook.match(/## Caso 429[\s\S]*?(?=\n## |$)/i)?.[0] || '';
  assert.match(rateLimited, /rechazo remoto explícito/i);
  assert.match(rateLimited, /no hay retry automático/i);
  assert.match(rateLimited, /replay --id <id>/i);
  assert.match(rateLimited, /--confirm replay:<id>/i);
  assert.doesNotMatch(rateLimited, /--\s+confirm-not-sent/i);

  const ambiguous = runbook.match(/## Resolver `outcome_unknown`[\s\S]*?(?=\n## |$)/i)?.[0] || '';
  assert.match(ambiguous, /confirm-not-sent/i);
});
