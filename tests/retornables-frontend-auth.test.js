import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../pedidos/cuenta-corriente-retornables.html', import.meta.url),
  'utf8',
);

function functionBody(name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `Falta la función ${name}`);
  const nextFunction = source.indexOf('\n    function ', start + 1);
  return source.slice(start, nextFunction < 0 ? source.length : nextFunction);
}

test('retornables no lee ni envía JWT o usuario desde Web Storage', () => {
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.getItem\(['"](?:token|user)['"]\)/);
  for (const legacyAuthSymbol of ['getToken', 'getStoredUser', 'authHeaders', 'Authorization', 'Bearer']) {
    assert.doesNotMatch(source, new RegExp(`\\b${legacyAuthSymbol}\\b`));
  }
});

test('todas las solicitudes usan la cookie httpOnly sin permitir reemplazar credentials', () => {
  const fetchCalls = source.match(/\bfetch\s*\(/g) || [];
  assert.equal(fetchCalls.length, 2, 'Toda llamada fetch debe estar cubierta por esta prueba');

  const api = functionBody('api');
  assert.match(api, /fetch\(url,\s*\{\s*\.\.\.opts,\s*credentials:\s*['"]include['"],\s*headers:\s*opts\.headers\s*\|\|\s*\{\}\s*\}\)/);

  const logout = source.slice(source.indexOf("$('logout').addEventListener"), source.indexOf('async function loadCurrentUser'));
  assert.match(logout, /fetch\(['"]\/api\/logout['"],\s*\{\s*method:\s*['"]POST['"],\s*credentials:\s*['"]include['"],\s*headers:\s*\{\}\s*\}\)/);
});

test('/api/me es obligatorio y la identidad proviene sólo de me.user', () => {
  const loadCurrentUser = functionBody('loadCurrentUser');
  assert.match(loadCurrentUser, /const me\s*=\s*await api\(['"]\/api\/me['"]\)/);
  assert.match(loadCurrentUser, /const user\s*=\s*me\?\.user\s*;/);
  assert.match(loadCurrentUser, /if\s*\(!user\)\s*throw new Error\(/);
  assert.doesNotMatch(loadCurrentUser, /localStorage|sessionStorage|\|\|\s*getStoredUser/);
  assert.match(loadCurrentUser, /user\.role/);
  assert.match(loadCurrentUser, /user\.empresa_id/);
});

test('limpia token y user legacy de ambos storages al iniciar y al cerrar sesión', () => {
  const cleanup = functionBody('clearLegacyAuthStorage');
  for (const storage of ['localStorage', 'sessionStorage']) {
    for (const key of ['token', 'user']) {
      assert.match(cleanup, new RegExp(`${storage}\\.removeItem\\(['"]${key}['"]\\)`));
    }
  }
  assert.doesNotMatch(cleanup, /getItem/);

  const cleanupCalls = source.match(/clearLegacyAuthStorage\(\)/g) || [];
  assert.equal(cleanupCalls.length, 3, 'Debe definirse y ejecutarse al iniciar y al cerrar sesión');

  const logout = source.slice(source.indexOf("$('logout').addEventListener"), source.indexOf('async function loadCurrentUser'));
  assert.match(logout, /clearLegacyAuthStorage\(\)/);

  const init = source.slice(source.indexOf('(async function init()'));
  assert.match(init, /clearLegacyAuthStorage\(\).*await loadCurrentUser\(\)/s);
});
