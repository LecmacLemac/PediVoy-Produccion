import test from 'node:test';
import assert from 'node:assert/strict';

test('clientLifecycle carga con la versión instalada de whatsapp-web.js', async () => {
  const lifecycle = await import('../src/wpp/clientLifecycle.js');
  assert.equal(typeof lifecycle.createWppClientLifecycle, 'function');
});
