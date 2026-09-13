import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('pagos no ofrece force y envía tenant del comprobante solo para superadmin', async () => {
  const source = await readFile(new URL('../pedidos/pagos.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bforce\b|forzar|forzada/i);
  assert.match(source, /nroOperacion/);
  assert.match(source, /cuentaBancariaId/);
  assert.match(source, /reason/);
  assert.match(source, /const payload = \{[^}]*nro_operacion:\s*nroOperacion[^}]*cuenta_bancaria_id:\s*cuentaBancariaId[^}]*reason/s);
  assert.match(source, /const row = currentRows\.find\(item => item\.source === 'transferencia' && Number\(item\.id\) === Number\(id\)\)/);
  assert.match(source, /currentUser\?\.role[^\n]*super[^\n]*row\.empresa_id[\s\S]*payload\.empresa_id\s*=\s*Number\(row\.empresa_id\)/);
  assert.match(source, /body:\s*JSON\.stringify\(payload\)/);
  assert.doesNotMatch(source, /payload\.empresa_id\s*=\s*Number\([^)]*fEmpresa/);
});

test('superadmin carga las cuentas del tenant del comprobante seleccionado', async () => {
  const source = await readFile(new URL('../pedidos/pagos.html', import.meta.url), 'utf8');
  assert.match(source, /currentUser\?\.role[^\n]*super[^\n]*row\.empresa_id[\s\S]*await loadCuentasBancarias\(row\.empresa_id\)/);
  assert.match(source, /loadCuentasBancarias\([^)]*empresaId/);
});

test('rutas manuales validan el par operación/cuenta y lo pasan al servicio', async () => {
  const source = await readFile(new URL('../src/routes/transferencias.js', import.meta.url), 'utf8');
  const upload = source.slice(source.indexOf("router.post(\n    '/upload'"), source.indexOf('// VERIFICAR'));
  const verify = source.slice(source.indexOf("router.post('/:id/verificar'"), source.indexOf('// ELIMINAR'));
  assert.match(upload, /nro_operacion/);
  assert.match(upload, /cuenta_bancaria_id/);
  assert.match(upload, /faltantes/);
  assert.match(verify, /nroOperacion:\s*req\.body\?\.nro_operacion/);
  assert.match(verify, /cuentaBancariaId:\s*req\.body\?\.cuenta_bancaria_id/);
});

test('dedupe de outbox incluye tenant null-safe', async () => {
  const source = await readFile(new URL('../src/services/messaging.js', import.meta.url), 'utf8');
  assert.match(source, /empresa_id IS NOT DISTINCT FROM \$3/);
});
