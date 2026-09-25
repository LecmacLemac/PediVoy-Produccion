import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { enqueueWppMessagePg } from '../src/transferenciasServices.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

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
  const source = await readFile(new URL('../src/wpp/enqueue.js', import.meta.url), 'utf8');
  assert.match(source, /empresa_id IS NOT DISTINCT FROM \$3/);
});

test('transferencias delega el enqueue transaccional e inserta el transporte resuelto', async () => {
  const transactionPool = createWppEnqueueTestPool({
    configIntegraciones: {
      whatsapp: {
        provider: 'cloud',
        enabled: true,
        phone_number_id: 'phone-7',
        access_token_encrypted: 'encrypted-token',
      },
    },
  });
  const connect = transactionPool.connect.bind(transactionPool);
  let connections = 0;
  transactionPool.connect = async () => {
    connections += 1;
    return connect();
  };

  const result = await enqueueWppMessagePg({
    empresaId: 7,
    phone: '3515550000',
    message: 'comprobante recibido',
  }, transactionPool);

  const configReadIndex = transactionPool.calls.findIndex(call => /SELECT config_integraciones FROM empresas/.test(call.text));
  const insertIndex = transactionPool.calls.findIndex(call => /INSERT INTO wpp_outbox/.test(call.text));
  const commitIndex = transactionPool.calls.findIndex(call => call.text === 'COMMIT');
  assert.equal(connections, 1);
  assert.equal(transactionPool.calls[0].text, 'BEGIN');
  assert.ok(configReadIndex > 0);
  assert.ok(insertIndex > configReadIndex);
  assert.ok(commitIndex > insertIndex);
  assert.match(transactionPool.calls[insertIndex].text, /transport_origin/);
  assert.equal(transactionPool.calls[insertIndex].values[3], 'cloud');
  assert.equal(result.transportOrigin, 'cloud');
  assert.equal(transactionPool.releases, 1);
});

test('pagos permite asociar huérfanos antes de habilitar su validación', async () => {
  const source = await readFile(new URL('../pedidos/pagos.html', import.meta.url), 'utf8');
  assert.match(source, /!t\.pedido_id[\s\S]*asociarPedido/);
  assert.match(source, /\/api\/transferencias\/\$\{id\}\/asociar-pedido/);
  assert.match(source, /pedido_id:\s*pedidoId/);
  assert.match(source, /!!t\.pedido_id[^\n]*!isValidado/);
  const association = source.slice(source.indexOf('async function asociarPedido'), source.indexOf('async function solicitarComprobante'));
  assert.doesNotMatch(association, /payload\.empresa_id|row\.empresa_id/);
});
