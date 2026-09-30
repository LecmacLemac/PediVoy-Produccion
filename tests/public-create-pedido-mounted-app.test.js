import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const fixture = new URL('./support/public-pedido-mounted-app.mjs', import.meta.url);

test('createApp monta resolver público server-side y body no puede cruzar tenant', () => {
  const result = spawnSync(process.execPath, [fixture.pathname], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find(value => value.startsWith('RESULT:'));
  assert.ok(line, result.stdout);
  const parsed = JSON.parse(line.slice('RESULT:'.length));
  assert.equal(parsed.status, 403);
  assert.equal(parsed.body.code, 'PUBLIC_TENANT_CONFLICT');
});
