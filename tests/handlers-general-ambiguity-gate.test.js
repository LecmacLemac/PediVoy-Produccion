import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import handlers, { resolveCommandEmpresaId } from '../src/handlers.js';

const PHONE = '5493511111111@c.us';
const commands = [
  'ayuda',
  'necesitas reposición',
  'ver pedidos',
  'ver comprobantes',
  'procesar op 123456',
  'rentabilidad empresa 2',
  'estadistica empresa 2',
  'resumen hoy chofer 8',
  'quiero pedir dos bidones',
];

function fakeClient() {
  let listener;
  return {
    replies: [],
    on(event, fn) { if (event === 'message') listener = fn; },
    async sendMessage(_to, text) { this.replies.push(String(text)); },
    async send(body, index) {
      await listener({
        from: PHONE,
        body,
        id: { _serialized: `ambiguous-command-${index}-${Math.random()}`, fromMe: false },
      });
    },
  };
}

test('F: todos los comandos General bloquean contexto ambiguo antes de lectura, efecto o fuga', async () => {
  for (const [index, command] of commands.entries()) {
    const client = fakeClient();
    let resolverCalls = 0;
    handlers.start(client, {
      contextResolver: async () => {
        resolverCalls += 1;
        return { resolution: 'ambiguous', source: 'telefono_ambiguo' };
      },
      replenishmentWithTransaction: async () => assert.fail('no debe abrir transacción'),
    });

    await client.send(command, index);

    assert.equal(resolverCalls, 1, command);
    assert.equal(client.replies.length, 1, command);
    assert.match(client.replies[0], /canal|enlace|empresa|soporte/i, command);
    assert.doesNotMatch(client.replies[0], /pedido #|dirección:|comprobante|rentabilidad|ventas:|estadística/i, command);
  }
});

test('F2: todos los comandos General bloquean contexto no resuelto antes de ayuda, IA o efectos', async () => {
  for (const [index, command] of commands.entries()) {
    const client = fakeClient();
    handlers.start(client, {
      contextResolver: async () => ({ resolution: 'unresolved', source: 'sin_identidad' }),
      replenishmentWithTransaction: async () => assert.fail('no debe abrir transacción'),
    });

    await client.send(command, `unresolved-${index}`);

    assert.equal(client.replies.length, 1, command);
    assert.match(client.replies[0], /canal|proveedor|empresa|soporte/i, command);
    assert.doesNotMatch(client.replies[0], /menú|pedido #|dirección:|comprobante|rentabilidad|ventas:|estadística/i, command);
  }
});

test('F3: super global sin tenant falla cerrado y no recibe empresa arbitraria', async () => {
  const client = fakeClient();
  handlers.start(client, {
    contextResolver: async () => ({
      resolution: 'unresolved',
      role: 'super',
      empresa_id: null,
      source: 'usuario_registrado',
    }),
  });

  await client.send('ayuda', 'super-global');

  assert.equal(client.replies.length, 1);
  assert.match(client.replies[0], /canal|proveedor|empresa|soporte/i);
  assert.doesNotMatch(client.replies[0], /super|rentabilidad|estadística|empresa uno/i);
});

test('General no acepta empresa seleccionada desde texto libre', () => {
  assert.equal(resolveCommandEmpresaId({ empresa_id: 7 }, 'rentabilidad empresa 8'), 7);
  assert.equal(resolveCommandEmpresaId({ empresa_id: 7 }, 'estadistica emp=9'), 7);
  assert.equal(resolveCommandEmpresaId({ empresa_id: null }, 'rentabilidad empresa 8'), null);
});

test('gate estructural: ambigüedad corta antes de comandos y no queda lookup global por último ID', () => {
  const source = readFileSync(new URL('../src/handlers.js', import.meta.url), 'utf8');
  const resolveAt = source.indexOf('const ctx = await contextResolver(');
  const nullGateAt = source.indexOf('if (!ctx) return;', resolveAt);
  const ambiguityAt = source.indexOf("if (ctx.resolution !== 'unique')", nullGateAt);
  const roleAt = source.indexOf('const { role, empresa_id, chofer_id } = ctx;', resolveAt);
  const commandAt = source.indexOf("if (contenidoLimpio === 'ayuda')", resolveAt);
  assert.ok(resolveAt >= 0 && nullGateAt > resolveAt && ambiguityAt > nullGateAt && ambiguityAt < roleAt && roleAt < commandAt);

  assert.doesNotMatch(
    source,
    /FROM\s+puntos_entrega[\s\S]{0,500}regexp_replace\(COALESCE\(telefono,''\)[\s\S]{0,300}ORDER\s+BY\s+id\s+DESC[\s\S]{0,100}LIMIT\s+1/i
  );
  assert.match(source, /resolveDeliveryPointByPhone\([\s\S]*tenantIds\.size !== 1/);
  assert.match(source, /exact\.length === 1/);
  assert.match(source, /lockGeneralPhoneIdentity[\s\S]*resolveDeliveryPointByPhone/);
  assert.doesNotMatch(source, /SELECT\s+id\s+FROM\s+empresas\s+ORDER\s+BY\s+id\s+LIMIT\s+1/i);
});

test('gate estructural: writer público toma teléfono global antes de namespaces de producto', () => {
  const source = readFileSync(new URL('../src/routes/publicLegacyCreatePedido.js', import.meta.url), 'utf8');
  const transactionAt = source.indexOf('await ensurePedidoScheduleSchema();');
  const phoneLockAt = source.indexOf('lockGeneralPhoneIdentity(', transactionAt);
  const productsAt = source.indexOf('resolveProductIdentityItems(', transactionAt);
  const pointLockAt = source.indexOf('lockDeliveryPointIdentity(', transactionAt);
  assert.ok(transactionAt >= 0 && phoneLockAt > transactionAt && phoneLockAt < productsAt && productsAt < pointLockAt);
});
