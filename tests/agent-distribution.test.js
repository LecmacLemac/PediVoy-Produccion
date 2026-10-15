import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
test('the public MCP bridge is distributable and not silently excluded by Git', async () => {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', 'pedidos/agent-bridge.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, 'The bridge is required by the real UI and must not be ignored');
  const script = await readFile(new URL('../pedidos/agent-bridge.mjs', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(script, /@modelcontextprotocol\/sdk\/server\/stdio\.js/);
  assert.match(manifest.dependencies['@modelcontextprotocol/sdk'], /^\d+\.\d+\.\d+$/);
  assert.match(manifest.dependencies.zod, /^3\./);
  assert.match(manifest.dependencies.express, /4\./);
});
