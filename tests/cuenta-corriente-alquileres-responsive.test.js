import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('../pedidos/cuenta-corriente-alquileres.html', import.meta.url), 'utf8');

test('cuenta corriente alquileres convierte tablas a tarjetas legibles en celular', () => {
  assert.match(source, /@media \(max-width: 760px\)[\s\S]*#cuentasTableBody tr[\s\S]*display:\s*block/i);
  assert.match(source, /#cuentasTableBody td::before[\s\S]*content:\s*attr\(data-label\)/i);
  assert.match(source, /data-label="Cliente"/);
  assert.match(source, /data-label="Total adeudado"/);
  assert.match(source, /data-label="Acción"/);
  assert.match(source, /id="mobileCardsHint"/);
});

test('cuenta corriente alquileres mejora escritorio con tabla operable y columnas clave', () => {
  assert.match(source, /\.table-responsive[\s\S]*scrollbar-width:\s*thin/i);
  assert.match(source, /@media \(min-width: 900px\)[\s\S]*#cuentasTableBody td:first-child[\s\S]*position:\s*sticky/i);
  assert.match(source, /#cuentasTableBody td:last-child[\s\S]*position:\s*sticky/i);
});

test('script embebido de cuenta corriente alquileres mantiene sintaxis válida', async () => {
  const scriptMatch = source.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch, 'script embebido no encontrado');
  const dir = await mkdtemp(join(tmpdir(), 'cuenta-alq-'));
  const file = join(dir, 'inline.mjs');
  await writeFile(file, scriptMatch[1]);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  await rm(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
