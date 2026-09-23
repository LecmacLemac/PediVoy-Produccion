import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createIncomingMediaHandler } from '../src/wpp/incomingMedia.js';
import {
  buildReceiptStatusMessage,
  finalizeReceiptValidation,
} from '../src/transferenciasPipeline.js';
import {
  asociarComprobantePedidoPg,
  enqueueWppMessagePg,
  insertarComprobantePg,
} from '../src/transferenciasServices.js';

function lidMessage(lid = '123456789012345@lid') {
  return {
    from: lid,
    type: 'image',
    hasMedia: true,
    id: { fromMe: false, id: 'msg-lid', remote: lid, _serialized: `false_${lid}_msg-lid` },
    downloadMedia: async () => ({
      data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64'),
      mimetype: 'image/jpeg',
      filename: 'comprobante.jpg',
    }),
  };
}

test('resuelve @lid con la API PN oficial y conserva el JID original para responder', async () => {
  const queries = [];
  let payload;
  const msg = lidMessage();
  const handler = createIncomingMediaHandler({
    empresaId: 1,
    lidByPhone: new Map(),
    withActiveClient: fn => fn({
      client: {
        getContactLidAndPhone: async ids => {
          assert.deepEqual(ids, [msg.from]);
          return [{ lid: msg.from, pn: '5493534277739@c.us' }];
        },
      },
    }),
    query: async (sql, params) => {
      queries.push({ sql, params });
      return [{ id: 44 }];
    },
    handleIncomingComprobanteFromBotPg: async input => {
      payload = input;
      return { ok: false, saved: true, id: 1085 };
    },
  });

  await handler(msg);

  assert.deepEqual(queries[0].params, ['3534277739', 1]);
  assert.equal(payload.telefono, '5493534277739');
  assert.equal(payload.replyJid, msg.from);
  assert.equal(payload.transportOrigin, 'company');
});

test('comprobante recibido por General conserva ese transporte aunque resuelva una empresa', async () => {
  let payload;
  const handler = createIncomingMediaHandler({
    lidByPhone: new Map(),
    query: async () => [{ empresa_id: 7 }],
    withActiveClient: fn => fn({ client: {} }),
    handleIncomingComprobanteFromBotPg: async input => {
      payload = input;
      return { ok: false, saved: true, id: 1088 };
    },
  });

  await handler({
    from: '5493534277739@c.us',
    type: 'image',
    hasMedia: true,
    id: { fromMe: false, id: 'general-receipt', remote: '5493534277739@c.us' },
    downloadMedia: async () => ({
      data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64'),
      mimetype: 'image/jpeg',
      filename: 'general.jpg',
    }),
  });

  assert.equal(payload.empresaId, 7);
  assert.equal(payload.transportOrigin, 'general');
});

test('un @lid no resuelto nunca se usa como teléfono ni dispara un LIKE %%', async () => {
  const queries = [];
  let payload;
  const msg = lidMessage('987654321098765@lid');
  const handler = createIncomingMediaHandler({
    empresaId: 1,
    lidByPhone: new Map(),
    withActiveClient: fn => fn({
      client: { getContactLidAndPhone: async () => [{ lid: msg.from, pn: undefined }] },
    }),
    query: async (sql, params) => {
      queries.push({ sql, params });
      return [];
    },
    handleIncomingComprobanteFromBotPg: async input => {
      payload = input;
      return { ok: false, saved: true, id: 1086 };
    },
  });

  await handler(msg);

  assert.equal(queries.length, 0);
  assert.equal(payload.telefono, null);
  assert.equal(payload.replyJid, msg.from);
});

test('inserción huérfana sin teléfono no busca pedidos y persiste el chat de origen', async () => {
  const calls = [];
  const result = await insertarComprobantePg({
    telefono: null,
    replyJid: '987654321098765@lid',
    transportOrigin: 'general',
    imagen_path: '/Transferencia/comp.jpg',
    fecha: new Date('2026-09-23T12:00:00Z'),
    empresaId: 1,
    sourceMessageId: 'msg-1',
    fileHash: 'a'.repeat(64),
  }, async (sql, params) => {
    calls.push({ sql, params });
    assert.match(sql, /INSERT INTO comprobantes_transferencia/);
    assert.match(sql, /source_chat_jid/);
    assert.match(sql, /transport_origin/);
    assert.equal(params[0], null);
    assert.ok(params.includes('987654321098765@lid'));
    assert.ok(params.includes('general'));
    return [{ id: 1086, empresa_id: 1, pedido_id: null }];
  });

  assert.equal(calls.length, 1);
  assert.equal(result.pedido_id, null);
  assert.equal(result.association_reason, 'remitente_no_resuelto');
});

test('no asocia por descarte si hay más de un pedido elegible del mismo cliente', async () => {
  const calls = [];
  const result = await insertarComprobantePg({
    telefono: '5493534277739',
    imagen_path: '/Transferencia/ambiguo.jpg',
    fecha: new Date('2026-09-23T12:00:00Z'),
    empresaId: 1,
  }, async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM pedidos')) {
      return [
        { pedido_id: 3599, empresa_id: 1, monto: '7000', metodo_pago: 'transferencia', pago_acreditado: false },
        { pedido_id: 3598, empresa_id: 1, monto: '7000', metodo_pago: 'transferencia', pago_acreditado: false },
      ];
    }
    return [{ id: 1087, empresa_id: 1, pedido_id: params[4] }];
  });

  assert.match(calls[0].sql, /LIMIT 2/);
  assert.equal(calls[1].params[4], null);
  assert.equal(result.association_reason, 'pedido_ambiguo');
});

test('outbox de transferencias conserva JID válido y no extrae sus dígitos', async () => {
  const calls = [];
  await enqueueWppMessagePg({
    phone: '987654321098765@lid',
    message: 'Prueba',
    empresaId: 1,
    transportOrigin: 'general',
  }, async (sql, params) => {
    calls.push({ sql, params });
    return [];
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[1], '987654321098765@lid');
  assert.equal(calls[0].params[3], 'general');
});

test('esquema canónico declara y migra chat y transporte de comprobantes y outbox', async () => {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');
  const receiptsCreate = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS comprobantes_transferencia ('),
    sql.indexOf('CREATE TABLE IF NOT EXISTS pedido_pagos ('),
  );
  const outboxCreate = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS wpp_outbox ('),
    sql.indexOf('CREATE TABLE IF NOT EXISTS push_subs ('),
  );

  assert.match(receiptsCreate, /source_chat_jid\s+TEXT/i);
  assert.match(receiptsCreate, /transport_origin\s+TEXT/i);
  assert.match(receiptsCreate, /ALTER TABLE comprobantes_transferencia[\s\S]*ADD COLUMN IF NOT EXISTS source_chat_jid TEXT/i);
  assert.match(receiptsCreate, /ADD COLUMN IF NOT EXISTS transport_origin TEXT/i);
  assert.match(outboxCreate, /transport_origin\s+TEXT/i);
  assert.match(outboxCreate, /ALTER TABLE wpp_outbox[\s\S]*ADD COLUMN IF NOT EXISTS transport_origin TEXT/i);
});

test('mensaje profesional detalla solo datos confiables del comprobante', () => {
  const message = buildReceiptStatusMessage({
    status: 'pending',
    pedidoId: 3599,
    monto: 7000,
    bancoOrigen: 'Mercado Pago',
    cuentaDestino: 'MP.AGUA.HIDRO',
    nroOperacion: '12345678',
  });

  assert.match(message, /Comprobante recibido/);
  assert.match(message, /Pedido: #3599/);
  assert.match(message, /Monto detectado: \$\s?7\.000/);
  assert.match(message, /Banco de origen: Mercado Pago/);
  assert.match(message, /Cuenta destino: MP\.AGUA\.HIDRO/);
  assert.match(message, /Operación: ••••5678/);
  assert.doesNotMatch(message, /CBU|titular/i);
  assert.match(message, /Estado: pendiente de revisión/);
});

test('finalización responde al JID original con pedido, datos y estado', async () => {
  const messages = [];
  const registroDB = {
    id: 10,
    pedido_id: 20,
    empresa_id: 7,
    pedido_monto: 1500,
    pedido_metodo_pago: 'transferencia',
    pedido_pago_acreditado: false,
    file_hash: 'a'.repeat(64),
    source_chat_jid: '123456789012345@lid',
    transport_origin: 'general',
  };

  const result = await finalizeReceiptValidation({
    registroDB,
    datosIA: {
      monto: 1499,
      nro_operacion: 'OP-REVIEW',
      banco_origen: 'Banco Test',
      alias_destino: 'CUENTA.TEST',
    },
    telefono: '5493534277739',
    replyJid: registroDB.source_chat_jid,
    deps: {
      resolverCuentaBancariaDestinoPg: async () => null,
      actualizarComprobanteDatosPg: async () => {},
      enqueueWppMessagePg: async payload => messages.push(payload),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(messages[0].phone, registroDB.source_chat_jid);
  assert.equal(messages[0].transportOrigin, 'general');
  assert.match(messages[0].message, /Pedido: #20/);
  assert.match(messages[0].message, /Monto detectado: \$\s?1\.499/);
  assert.match(messages[0].message, /Estado: pendiente de revisión/);
});

test('asociación manual de huérfano bloquea tenant y deja trazabilidad sin aprobar', async () => {
  const calls = [];
  const result = await asociarComprobantePedidoPg({
    id: 1085,
    actorRole: 'admin',
    actorEmpresaId: 1,
    pedidoId: 3599,
    actorId: 9,
    reason: 'Cliente y comprobante confirmados',
  }, {
    withTransaction: async fn => fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) {
        return [{ id: 1085, empresa_id: 1, pedido_id: null, estado_revision: 'pendiente', validado: 0, procesado: false, telefono: null }];
      }
      if (sql.includes('FROM pedidos p')) {
        return [{ id: 3599, empresa_id: 1, chofer_id: 2, zona_id: 3, metodo_pago: 'transferencia', estado: 'entregado', telefono_normalizado: '3534277739' }];
      }
      if (sql.includes('FROM pedido_pagos')) return [];
      if (sql.includes('FROM comprobante_pedido_aprobado_claims')) return [];
      if (sql.includes('UPDATE comprobantes_transferencia')) {
        return [{ id: 1085, empresa_id: 1, pedido_id: 3599, source_chat_jid: '123@lid' }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
  });

  assert.equal(result.pedido_id, 3599);
  const update = calls.find(call => call.sql.includes('UPDATE comprobantes_transferencia'));
  assert.match(update.sql, /estado_revision = 'pendiente'/);
  assert.deepEqual(update.params.slice(0, 3), [1085, 1, 3599]);
  assert.match(update.params[6], /asociacion_manual/);
});

test('super exacto adopta huérfano global derivando tenant del pedido bloqueado', async () => {
  const calls = [];
  const result = await asociarComprobantePedidoPg({
    id: 1086,
    actorRole: 'super',
    actorEmpresaId: null,
    pedidoId: 3600,
    actorId: 10,
    reason: 'Identidad confirmada',
  }, {
    withTransaction: async fn => fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM comprobantes_transferencia') && sql.includes('FOR UPDATE')) {
        return [{
          id: 1086,
          empresa_id: null,
          pedido_id: null,
          estado_revision: 'pendiente',
          validado: 0,
          procesado: false,
          telefono: null,
          source_chat_jid: '987654321098765@lid',
          transport_origin: 'general',
        }];
      }
      if (sql.includes('FROM pedidos p')) {
        return [{ id: 3600, empresa_id: 7, chofer_id: 2, zona_id: 3, metodo_pago: 'transferencia', estado: 'entregado', telefono_normalizado: null }];
      }
      if (sql.includes('FROM pedido_pagos')) return [];
      if (sql.includes('FROM comprobante_pedido_aprobado_claims')) return [];
      if (sql.includes('UPDATE comprobantes_transferencia')) {
        return [{
          id: 1086,
          empresa_id: 7,
          pedido_id: 3600,
          source_chat_jid: '987654321098765@lid',
          transport_origin: 'general',
        }];
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
  });

  assert.equal(result.empresa_id, 7);
  assert.equal(result.pedido_id, 3600);
  assert.equal(result.source_chat_jid, '987654321098765@lid');
  assert.equal(result.transport_origin, 'general');
  const receiptLock = calls.find(call => call.sql.includes('FROM comprobantes_transferencia') && call.sql.includes('FOR UPDATE'));
  const orderLock = calls.find(call => call.sql.includes('FROM pedidos p') && call.sql.includes('FOR UPDATE'));
  const update = calls.find(call => call.sql.includes('UPDATE comprobantes_transferencia'));
  assert.ok(calls.indexOf(receiptLock) < calls.indexOf(orderLock));
  assert.match(update.sql, /SET empresa_id = \$2, pedido_id = \$3/);
  assert.doesNotMatch(update.sql, /source_chat_jid\s*=|transport_origin\s*=/);
  assert.deepEqual(update.params.slice(0, 3), [1086, 7, 3600]);
});

test('admin no puede adoptar un comprobante global', async () => {
  await assert.rejects(
    asociarComprobantePedidoPg({
      id: 1086,
      actorRole: 'admin',
      actorEmpresaId: 7,
      pedidoId: 3600,
      actorId: 11,
      reason: 'Intento admin',
    }, {
      withTransaction: async fn => fn(async sql => {
        if (sql.includes('FROM comprobantes_transferencia')) {
          return [{ id: 1086, empresa_id: null, pedido_id: null, estado_revision: 'pendiente', validado: 0, procesado: false, telefono: null }];
        }
        if (sql.includes('FROM pedidos p')) {
          return [{ id: 3600, empresa_id: 7, metodo_pago: 'transferencia', estado: 'entregado', telefono_normalizado: null }];
        }
        throw new Error(`Consulta inesperada: ${sql}`);
      }),
    }),
    error => error?.code === 'adopcion_global_no_autorizada',
  );
});

test('ni super puede mover un comprobante ya tenantizado a otro tenant', async () => {
  await assert.rejects(
    asociarComprobantePedidoPg({
      id: 1087,
      actorRole: 'super',
      actorEmpresaId: null,
      pedidoId: 3601,
      actorId: 10,
      reason: 'Intento cruzado',
    }, {
      withTransaction: async fn => fn(async sql => {
        if (sql.includes('FROM comprobantes_transferencia')) {
          return [{ id: 1087, empresa_id: 3, pedido_id: null, estado_revision: 'pendiente', validado: 0, procesado: false, telefono: null }];
        }
        if (sql.includes('FROM pedidos p')) {
          return [{ id: 3601, empresa_id: 7, metodo_pago: 'transferencia', estado: 'entregado', telefono_normalizado: null }];
        }
        throw new Error(`Consulta inesperada: ${sql}`);
      }),
    }),
    error => error?.code === 'tenant_no_coincide',
  );
});
