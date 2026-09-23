import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('../pedidos/dashboard.html', import.meta.url), 'utf8');

test('dashboard convierte listado de pedidos en tarjetas legibles en celular', () => {
  assert.match(source, /@media \(max-width: 760px\)[\s\S]*#rows tr[\s\S]*display:\s*block/i);
  assert.match(source, /#rows td::before[\s\S]*content:\s*attr\(data-label\)/i);
  assert.match(source, /data-label="Cliente"/);
  assert.match(source, /data-label="Dirección"/);
  assert.match(source, /data-label="Acción"/);
  assert.match(source, /id="dashboardMobileHint"/);
});

test('dashboard mejora escritorio con tabla operable y columnas clave fijas', () => {
  assert.match(source, /\.table-responsive[\s\S]*scrollbar-width:\s*thin/i);
  assert.match(source, /@media \(min-width: 900px\)[\s\S]*#rows td:first-child[\s\S]*position:\s*sticky/i);
  assert.match(source, /#rows td:last-child[\s\S]*position:\s*sticky/i);
  assert.match(source, /#tableCard table[\s\S]*min-width:\s*1320px/i);
});

test('script module embebido de dashboard mantiene sintaxis válida', async () => {
  const scriptMatch = source.match(/<script type="module">([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch, 'script module embebido no encontrado');
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-inline-'));
  const file = join(dir, 'inline.mjs');
  await writeFile(file, scriptMatch[1]);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  await rm(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
