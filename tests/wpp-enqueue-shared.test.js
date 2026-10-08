import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  enqueueWppOutbox,
  enqueueWppOutboxInTransaction,
  enqueueWppOrderConfirmationNotification,
  enqueueWppOrderEnRouteNotification,
  enqueueWppTransferPaymentNotification,
} from '../src/wpp/enqueue.js';

function createPool(handler) {
  const calls = [];
  const releaseArgs = [];
  const client = {
    async query(input, params = []) {
      const config = typeof input === 'string' ? { text: input, values: params } : input;
      calls.push(config);
      return handler(config, calls.length - 1);
    },
    release(error) {
      releaseArgs.push(error);
    },
  };
  return {
    calls,
    client,
    releaseArgs,
    get releases() { return releaseArgs.length; },
    async connect() { return client; },
  };
}

function enterpriseSuccessPool({ duplicate = false } = {}) {
  return createPool(async ({ text }) => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (/pg_advisory_xact_lock\(\$1::integer, \$2::integer\)/i.test(text)) return { rows: [{ locked: null }] };
    if (/SELECT config_integraciones FROM empresas/i.test(text)) {
      return { rows: [{ config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:secret' } } }] };
    }
    if (/hashtextextended/i.test(text)) return { rows: [{ locked: null }] };
    if (/FROM wpp_outbox/i.test(text) && !/INSERT INTO/i.test(text)) {
      return { rows: duplicate ? [{ id: 81, status: 'pending', transport_origin: 'cloud' }] : [] };
    }
    if (/INSERT INTO wpp_outbox/i.test(text)) return { rows: [{ id: 81, status: 'pending', transport_origin: 'cloud' }] };
    throw new Error(`SQL inesperado: ${text}`);
  });
}

test('enqueue empresarial usa una conexión y statements separados en orden config→dedupe', async () => {
  const txPool = enterpriseSuccessPool();
  const result = await enqueueWppOutbox({
    empresaId: 7,
    phone: '3515550000',
    message: 'hola',
  }, txPool);

  assert.deepEqual(result, { queued: true, id: 81, status: 'pending', transportOrigin: 'cloud' });
  assert.equal(txPool.releases, 1);
  assert.deepEqual(txPool.calls.map(call => {
    if (call.text === 'BEGIN' || call.text === 'COMMIT') return call.text;
    if (/\$1::integer, \$2::integer/.test(call.text)) return 'CONFIG_LOCK';
    if (/SELECT config_integraciones FROM empresas/.test(call.text)) return 'CONFIG_READ';
    if (/hashtextextended/.test(call.text)) return 'DEDUPE_LOCK';
    if (/INSERT INTO wpp_outbox/.test(call.text)) return 'INSERT';
    if (/FROM wpp_outbox/.test(call.text)) return 'RECENT';
    return 'UNKNOWN';
  }), ['BEGIN', 'CONFIG_LOCK', 'CONFIG_READ', 'DEDUPE_LOCK', 'RECENT', 'INSERT', 'COMMIT']);
  assert.equal(txPool.calls[1].values[1], 7);
  assert.equal(txPool.calls[4].values[4], 5);
  assert.deepEqual(txPool.calls[4].sensitive, true);
  assert.deepEqual(txPool.calls[5].sensitive, true);
});

test('enqueue sobre transacción externa conserva ownership del caller y el orden config→dedupe', async () => {
  const txPool = enterpriseSuccessPool();
  const result = await enqueueWppOutboxInTransaction({
    empresaId: 7,
    phone: '3515550000',
    message: 'hola desde tx exterior',
  }, { client: txPool.client, transactionOwner: 'caller' });

  assert.deepEqual(result, { queued: true, id: 81, status: 'pending', transportOrigin: 'cloud' });
  assert.equal(txPool.releases, 0);
  assert.deepEqual(txPool.calls.map(call => {
    if (/\$1::integer, \$2::integer/.test(call.text)) return 'CONFIG_LOCK';
    if (/SELECT config_integraciones FROM empresas/.test(call.text)) return 'CONFIG_READ';
    if (/hashtextextended/.test(call.text)) return 'DEDUPE_LOCK';
    if (/INSERT INTO wpp_outbox/.test(call.text)) return 'INSERT';
    if (/FROM wpp_outbox/.test(call.text)) return 'RECENT';
    return call.text;
  }), ['CONFIG_LOCK', 'CONFIG_READ', 'DEDUPE_LOCK', 'RECENT', 'INSERT']);
  assert.equal(txPool.calls.some(call => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.text)), false);
});

test('enqueue sobre transacción externa valida ownership antes de omitir payload inválido', async () => {
  await assert.rejects(
    enqueueWppOutboxInTransaction({ phone: '', message: '' }),
    error => error?.code === 'transaction_client_requerido',
  );

  const txPool = createPool(async ({ text }) => {
    throw new Error(`No debía consultar: ${text}`);
  });
  await assert.rejects(
    enqueueWppOutboxInTransaction(
      { phone: '', message: '' },
      { client: txPool.client },
    ),
    error => error?.code === 'transaction_client_requerido',
  );
  await assert.rejects(
    enqueueWppOutboxInTransaction(
      { phone: '', message: '' },
      { transactionOwner: 'caller' },
    ),
    error => error?.code === 'transaction_client_requerido',
  );
  const result = await enqueueWppOutboxInTransaction(
    { phone: '', message: '' },
    { client: txPool.client, transactionOwner: 'caller' },
  );

  assert.deepEqual(result, { queued: false, skipped: true, reason: 'invalid_payload' });
  assert.deepEqual(txPool.calls, []);
  assert.equal(txPool.releases, 0);
});

test('enqueue sobre transacción externa no confirma, revierte ni libera ante error', async () => {
  const phone = '3515554321';
  const message = 'mensaje privado de transacción';
  const txPool = createPool(async ({ text }) => {
    if (/pg_advisory_xact_lock\(\$1::integer, \$2::integer\)/i.test(text)) return { rows: [] };
    if (/SELECT config_integraciones FROM empresas/i.test(text)) return { rows: [{ config_integraciones: {} }] };
    if (/hashtextextended/i.test(text)) return { rows: [] };
    if (/FROM wpp_outbox/i.test(text) && !/INSERT INTO/i.test(text)) return { rows: [] };
    if (/INSERT INTO wpp_outbox/i.test(text)) throw new Error(`insert failed ${phone} ${message}`);
    throw new Error(`SQL inesperado: ${text}`);
  });

  await assert.rejects(
    enqueueWppOutboxInTransaction(
      { empresaId: 7, phone, message },
      { client: txPool.client, transactionOwner: 'caller' },
    ),
    error => error?.code === 'enqueue_fallido',
  );
  assert.equal(txPool.calls.some(call => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.text)), false);
  assert.equal(txPool.releases, 0);
});

test('enqueue general omite lookup de configuración pero serializa dedupe en transacción', async () => {
  const txPool = createPool(async ({ text }) => {
    if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
    if (/hashtextextended/i.test(text)) return { rows: [] };
    if (/FROM wpp_outbox/i.test(text) && !/INSERT INTO/i.test(text)) return { rows: [] };
    if (/INSERT INTO wpp_outbox/i.test(text)) return { rows: [{ id: 91, status: 'pending', transport_origin: 'general' }] };
    throw new Error(`SQL inesperado: ${text}`);
  });

  const result = await enqueueWppOutbox({ phone: '3515550000', message: 'general' }, txPool);
  assert.equal(result.transportOrigin, 'general');
  assert.equal(txPool.calls.some(call => /FROM empresas/i.test(call.text)), false);
  assert.deepEqual(txPool.calls.map(call => call.text === 'BEGIN' || call.text === 'COMMIT'
    ? call.text
    : (/hashtextextended/i.test(call.text) ? 'DEDUPE_LOCK' : (/INSERT INTO/i.test(call.text) ? 'INSERT' : 'RECENT'))),
  ['BEGIN', 'DEDUPE_LOCK', 'RECENT', 'INSERT', 'COMMIT']);
});

test('enqueue conserva resultado duplicate y ventana de dedupe', async () => {
  const txPool = enterpriseSuccessPool({ duplicate: true });
  const result = await enqueueWppOutbox({
    empresaId: 7,
    phone: '3515550000',
    message: 'hola',
    dedupeWindowMinutes: 10,
  }, txPool);

  assert.deepEqual(result, {
    queued: false,
    skipped: true,
    reason: 'duplicate_10m',
    id: 81,
    status: 'pending',
    transportOrigin: 'cloud',
  });
  assert.equal(txPool.calls.some(call => /INSERT INTO wpp_outbox/i.test(call.text)), false);
  assert.equal(txPool.calls.at(-1).text, 'COMMIT');
});

test('notificación proactiva deduplica por identidad durable sin ventana ni transporte actual', async () => {
  const txPool = enterpriseSuccessPool({ duplicate: true });
  const result = await enqueueWppTransferPaymentNotification({
    empresaId: 7,
    phone: '3515550000',
    message: 'transferencia durable',
    notificationCorrelationId: 'transfer_payment:42',
    utility_template: {
      key: 'transfer_payment',
      parameters: {
        customer_name: 'Ana', amount: '$ 1.000,00', alias: 'ANA.TEST',
        cbu: '0000000000000000000000', bank: 'Banco', holder: 'Ana', company_name: 'Empresa',
      },
    },
  }, txPool);

  assert.deepEqual(result, {
    queued: false,
    skipped: true,
    reason: 'duplicate_notification',
    id: 81,
    status: 'pending',
    transportOrigin: 'cloud',
  });
  const recent = txPool.calls.find(call => /FROM wpp_outbox/i.test(call.text) && !/INSERT INTO/i.test(call.text));
  assert.match(recent.text, /notification_correlation_id = \$2/);
  assert.doesNotMatch(recent.text, /created_at|INTERVAL/);
  assert.deepEqual(recent.values, [7, 'transfer_payment:42']);
});

test('wrappers proactivos exigen identidad durable antes de abrir conexión', async () => {
  for (const [enqueue, key, parameters] of [
    [enqueueWppOrderConfirmationNotification, 'order_confirmation', {
      customer_name: 'Ana', items_block: '1 x Agua', total: '$ 1.000', address: 'A',
      delivery_date: 'Hoy', delivery_window: '9-12', driver_name: 'R', driver_phone: '1',
    }],
    [enqueueWppOrderEnRouteNotification, 'order_en_route', { customer_name: 'Ana', address: 'A', tracking_token: 'tok' }],
    [enqueueWppTransferPaymentNotification, 'transfer_payment', {
      customer_name: 'Ana', amount: '$ 1.000', alias: 'A', cbu: '1', bank: 'B', holder: 'H', company_name: 'E',
    }],
  ]) {
    let connects = 0;
    await assert.rejects(enqueue({
      empresaId: 7,
      phone: '3515550000',
      message: key,
      utility_template: { key, parameters },
    }, { async connect() { connects += 1; } }), { code: 'notification_correlation_id_requerido' });
    assert.equal(connects, 0);
  }
});

test('wrappers proactivos atan identidad canónica al tipo antes de abrir conexión', async () => {
  const parameters = { customer_name: 'Ana', address: 'A', tracking_token: 'tok' };
  const invalid = [
    'order_confirmation:42', 'order_en_route:042', ' order_en_route:42', 'order_en_route:42 ',
    'order_en_route:+42', 'order_en_route:0', 'order_en_route:-1', 'order_en_route:42.0',
    'order_en_route:1e2', 'order_en_route:2147483648', 'order_en_route:42:extra',
    'order_en_route:42#hostile', 'order_en_route:٤٢', 'order_en_route:42\u0000hostile', 'unknown:42',
  ];
  for (const notificationCorrelationId of invalid) {
    let connects = 0;
    await assert.rejects(enqueueWppOrderEnRouteNotification({
      empresaId: 7, phone: '3515550000', message: 'Web', notificationCorrelationId,
      utility_template: { key: 'order_en_route', parameters },
    }, { async connect() { connects += 1; } }), { code: 'notification_correlation_id_invalido' });
    assert.equal(connects, 0, notificationCorrelationId);
  }
});

test('wrapper proactivo acepta el máximo INTEGER canónico', async () => {
  const txPool = enterpriseSuccessPool();
  await enqueueWppOrderEnRouteNotification({
    empresaId: 7, phone: '3515550000', message: 'Web',
    notificationCorrelationId: 'order_en_route:2147483647',
    utility_template: { key: 'order_en_route', parameters: { customer_name: 'Ana', address: 'A', tracking_token: 'tok' } },
  }, txPool);
  const insert = txPool.calls.find(call => /INSERT INTO wpp_outbox/.test(call.text));
  assert.equal(insert.values[5], 'order_en_route:2147483647');
});

test('enqueue falla cerrado para empresa desconocida y hace rollback/release', async () => {
  const txPool = createPool(async ({ text }) => {
    if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
    if (/SELECT config_integraciones FROM empresas/i.test(text)) return { rows: [] };
    throw new Error(`SQL inesperado: ${text}`);
  });

  await assert.rejects(enqueueWppOutbox({
    empresaId: 404,
    phone: '3515550000',
    message: 'no insertar',
  }, txPool), error => error?.code === 'empresa_no_encontrada');
  assert.deepEqual(txPool.calls.map(call => call.text === 'BEGIN' || call.text === 'ROLLBACK'
    ? call.text
    : (/pg_advisory/.test(call.text) ? 'CONFIG_LOCK' : 'CONFIG_READ')),
  ['BEGIN', 'CONFIG_LOCK', 'CONFIG_READ', 'ROLLBACK']);
  assert.equal(txPool.releases, 1);
});

test('enqueue rechaza empresa inválida antes de tomar conexión', async () => {
  let connects = 0;
  await assert.rejects(enqueueWppOutbox({
    empresaId: 'no-es-id',
    phone: '3515550000',
    message: 'no insertar',
  }, { async connect() { connects += 1; } }), /empresa_id_invalido/);
  assert.equal(connects, 0);
});

test('enqueue sanitiza un error al adquirir la conexión', async () => {
  const phone = '3515559876';
  const message = 'mensaje secreto';
  await assert.rejects(
    enqueueWppOutbox({ empresaId: 7, phone, message }, {
      async connect() { throw new Error(`connect ${phone} ${message}`); },
    }),
    error => error?.code === 'enqueue_fallido'
      && !error.message.includes(phone)
      && !error.message.includes(message),
  );
});

test('error público de enqueue no retiene PII en cause, propiedades, JSON ni stack', async () => {
  const phone = '3515559876';
  const message = 'mensaje secreto pii';
  const original = new Error(`connect ${phone} ${message}`);
  original.params = [phone, message];
  original.detail = { phone, message };
  original.code = 'ECONNRESET';

  await assert.rejects(
    enqueueWppOutbox({ empresaId: 7, phone, message }, {
      async connect() { throw original; },
    }),
    error => {
      assert.equal(error.code, 'enqueue_fallido');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      const exposed = [
        error.message,
        error.stack,
        JSON.stringify(error),
        JSON.stringify(Object.getOwnPropertyDescriptors(error)),
      ].join('\n');
      assert.equal(exposed.includes(phone), false);
      assert.equal(exposed.includes(message), false);
      return true;
    },
  );
});

test('COMMIT ambiguo no hace rollback, descarta cliente y expone outcome unknown sin PII', async () => {
  const phone = '3515551234';
  const message = 'mensaje privado commit aplicado';
  let persistedRows = 0;
  const txPool = createPool(async ({ text }) => {
    if (text === 'BEGIN') return { rows: [] };
    if (/\$1::integer, \$2::integer/.test(text)) return { rows: [] };
    if (/SELECT config_integraciones FROM empresas/.test(text)) return { rows: [{ config_integraciones: {} }] };
    if (/hashtextextended/.test(text)) return { rows: [] };
    if (/FROM wpp_outbox/.test(text) && !/INSERT INTO/.test(text)) return { rows: [] };
    if (/INSERT INTO wpp_outbox/.test(text)) {
      persistedRows += 1;
      return { rows: [{ id: 1, status: 'pending', transport_origin: 'company' }] };
    }
    if (text === 'COMMIT') throw new Error(`socket lost after commit ${phone} ${message}`);
    if (text === 'ROLLBACK') throw new Error('no debe intentar rollback tras COMMIT');
    throw new Error(`SQL inesperado: ${text}`);
  });

  await assert.rejects(
    enqueueWppOutbox({ empresaId: 7, phone, message }, txPool),
    error => {
      assert.equal(error.code, 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      const exposed = [
        error.message,
        error.stack,
        JSON.stringify(error),
        JSON.stringify(Object.getOwnPropertyDescriptors(error)),
      ].join('\n');
      assert.equal(exposed.includes(phone), false);
      assert.equal(exposed.includes(message), false);
      return true;
    },
  );

  assert.equal(persistedRows, 1);
  assert.equal(txPool.calls.filter(call => call.text === 'COMMIT').length, 1);
  assert.equal(txPool.calls.some(call => call.text === 'ROLLBACK'), false);
  assert.equal(txPool.releaseArgs.length, 1);
  assert.ok(txPool.releaseArgs[0] instanceof Error);
});

for (const failureStage of ['BEGIN', 'CONFIG_LOCK', 'CONFIG_READ', 'DEDUPE_LOCK', 'RECENT', 'INSERT']) {
  test(`enqueue sanitiza error, hace rollback cuando corresponde y release si falla ${failureStage}`, async () => {
    const phone = '3515551234';
    const message = 'mensaje privado que no debe loguearse';
    const txPool = createPool(async ({ text }) => {
      let stage = 'RECENT';
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') stage = text;
      else if (/\$1::integer, \$2::integer/.test(text)) stage = 'CONFIG_LOCK';
      else if (/SELECT config_integraciones FROM empresas/.test(text)) stage = 'CONFIG_READ';
      else if (/hashtextextended/.test(text)) stage = 'DEDUPE_LOCK';
      else if (/INSERT INTO wpp_outbox/.test(text)) stage = 'INSERT';
      if (stage === failureStage) throw new Error(`raw failure ${phone} ${message}`);
      if (stage === 'CONFIG_READ') return { rows: [{ config_integraciones: {} }] };
      if (stage === 'RECENT') return { rows: [] };
      if (stage === 'INSERT') return { rows: [{ id: 1, status: 'pending', transport_origin: 'company' }] };
      return { rows: [] };
    });

    await assert.rejects(
      enqueueWppOutbox({ empresaId: 7, phone, message }, txPool),
      error => {
        assert.equal(error.code, 'enqueue_fallido');
        assert.equal(error.message.includes(phone), false);
        assert.equal(error.message.includes(message), false);
        return true;
      },
    );
    const rolledBack = txPool.calls.some(call => call.text === 'ROLLBACK');
    assert.equal(rolledBack, failureStage !== 'BEGIN');
    assert.equal(txPool.releases, 1);
    if (failureStage === 'BEGIN') assert.ok(txPool.releaseArgs[0] instanceof Error);
  });
}

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  }));
  return nested.flat();
}

test('inventario: existe un solo INSERT productivo a wpp_outbox y vive en la frontera compartida', async () => {
  const srcDir = path.resolve(new URL('../src/', import.meta.url).pathname);
  const allowed = path.resolve(srcDir, 'wpp/enqueue.js');
  const offenders = [];
  let productiveInsertCount = 0;

  for (const file of await collectJsFiles(srcDir)) {
    const source = await readFile(file, 'utf8');
    const inserts = source.match(/INSERT\s+INTO\s+wpp_outbox/gi) || [];
    productiveInsertCount += inserts.length;
    if (path.resolve(file) !== allowed && inserts.length) {
      offenders.push(path.relative(srcDir, file));
    }
  }

  assert.equal(productiveInsertCount, 1);
  assert.deepEqual(offenders.sort(), []);
});

test('utility intent persists only for resolved Cloud and keeps original message and sensitive query', async () => {
  const utility_template = { key: 'order_en_route', parameters: { customer_name: 'Ana', address: 'A', tracking_token: 'tok' } };
  for (const transport of ['cloud', 'company', 'general']) {
    const tx = createPool(async ({ text }) => {
      if (text.includes('SELECT config_integraciones')) return { rows: [{ config_integraciones: transport === 'cloud' ? { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'p', access_token_encrypted: 'e' } } : {} }] };
      return { rows: text.includes('INSERT INTO') ? [{ id: 1, status: 'pending' }] : [] };
    });
    await enqueueWppOutbox({ empresaId: transport === 'general' ? null : 7, phone: '3515550000', message: 'Web\nexacto', utility_template }, tx);
    const insert = tx.calls.find(c => c.text.includes('INSERT INTO'));
    assert.match(insert.text, /cloud_template_key, cloud_template_parameters/);
    assert.equal(insert.values[2], 'Web\nexacto');
    assert.deepEqual(insert.values.slice(5), transport === 'cloud'
      ? [null, utility_template.key, JSON.stringify(utility_template.parameters)]
      : [null, null, null]);
    assert.equal(insert.sensitive, true);
  }
});

test('required producer wrapper validates Cloud strictly only after resolving transport', async () => {
  const overlongCandidate = {
    key: 'order_en_route',
    parameters: { customer_name: 'Ana', address: 'A'.repeat(501), tracking_token: 'https://legacy.example/t?id=1' },
  };
  for (const transport of ['cloud', 'company']) {
    const tx = createPool(async ({ text }) => {
      if (text.includes('SELECT config_integraciones')) return { rows: [{ config_integraciones: transport === 'cloud' ? { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'p', access_token_encrypted: 'e' } } : {} }] };
      return { rows: text.includes('INSERT INTO') ? [{ id: 1, status: 'pending' }] : [] };
    });
    const operation = enqueueWppOrderEnRouteNotification({
      empresaId: 7,
      phone: '3515550000',
      message: 'Web tolerante exacto con dirección histórica ' + 'A'.repeat(501),
      notificationCorrelationId: 'order_en_route:42',
      utility_template: overlongCandidate,
    }, tx);
    if (transport === 'cloud') {
      await assert.rejects(operation, { code: 'cloud_template_payload_invalid' });
      assert.equal(tx.calls.some(call => call.text.includes('INSERT INTO')), false);
    } else {
      await operation;
      const insert = tx.calls.find(call => call.text.includes('INSERT INTO'));
      assert.equal(insert.values[2], 'Web tolerante exacto con dirección histórica ' + 'A'.repeat(501));
      assert.deepEqual(insert.values.slice(5), ['order_en_route:42', null, null]);
    }
  }
});

test('required producer wrappers fail closed on Cloud without their exact intent and preserve Web text', async () => {
  const cases = [
    [enqueueWppOrderConfirmationNotification, 'order_confirmation'],
    [enqueueWppOrderEnRouteNotification, 'order_en_route'],
    [enqueueWppTransferPaymentNotification, 'transfer_payment'],
  ];
  for (const [enqueue, key] of cases) {
    for (const transport of ['cloud', 'company']) {
      const tx = createPool(async ({ text }) => {
        if (text.includes('SELECT config_integraciones')) return { rows: [{ config_integraciones: transport === 'cloud' ? { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'p', access_token_encrypted: 'e' } } : {} }] };
        return { rows: text.includes('INSERT INTO') ? [{ id: 1, status: 'pending' }] : [] };
      });
      const operation = enqueue({
        empresaId: 7,
        phone: '3515550000',
        message: `texto Web ${key}`,
        notificationCorrelationId: `${key}:42`,
        utility_template: null,
      }, tx);
      if (transport === 'cloud') {
        await assert.rejects(operation, { code: 'cloud_template_payload_invalid' });
        assert.equal(tx.calls.some(call => call.text.includes('INSERT INTO')), false);
      } else {
        await operation;
        const insert = tx.calls.find(call => call.text.includes('INSERT INTO'));
        assert.equal(insert.values[2], `texto Web ${key}`);
        assert.deepEqual(insert.values.slice(5), [`${key}:42`, null, null]);
      }
    }
  }
});

test('generic callers cannot set or alias required-template policy before DB', async () => {
  for (const extra of [
    { require_utility_template: true },
    { requireUtilityTemplate: true },
    { required_template: true },
    { template_required: true },
  ]) {
    const tx = enterpriseSuccessPool();
    await assert.rejects(
      enqueueWppOutbox({ empresaId: 7, phone: '3515550000', message: 'Web', ...extra }, tx),
      { code: 'cloud_template_payload_invalid' },
    );
    assert.equal(tx.calls.length, 0);
  }
});

test('generic Cloud enqueue without intent remains allowed for conversational paths', async () => {
  const tx = enterpriseSuccessPool();
  const result = await enqueueWppOutbox({ empresaId: 7, phone: '3515550000', message: 'reply libre' }, tx);
  assert.equal(result.queued, true);
  const insert = tx.calls.find(call => call.text.includes('INSERT INTO'));
  assert.deepEqual(insert.values.slice(5), [null, null, null]);
});

test('logical candidates reject hostile shapes before DB without reading accessors', async () => {
  let getterReads = 0;
  const accessorParameters = {};
  Object.defineProperty(accessorParameters, 'customer_name', { enumerable: true, get() { getterReads += 1; return 'Ana'; } });
  Object.assign(accessorParameters, { address: 'A', tracking_token: 'tok' });
  const hostile = [
    { key: 'order_en_route', parameters: [] },
    { key: 'order_en_route', parameters: Object.create({ customer_name: 'Ana', address: 'A', tracking_token: 'tok' }) },
    { key: 'order_en_route', parameters: accessorParameters },
  ];
  for (const utility_template of hostile) {
    const tx = enterpriseSuccessPool();
    await assert.rejects(
      enqueueWppOrderEnRouteNotification({
        empresaId: 7,
        phone: '3515550000',
        message: 'Web',
        notificationCorrelationId: 'order_en_route:42',
        utility_template,
      }, tx),
      { code: 'cloud_template_payload_invalid' },
    );
    assert.equal(tx.calls.length, 0);
  }
  assert.equal(getterReads, 0);
});

test('utility intent rejects invalid metadata and caller-selected Graph/transport before any query', async () => {
  for (const extra of [
    { utility_template: { key: 'bad', parameters: {} } },
    { utility_template: { key: 'order_en_route', parameters: {}, name: 'physical' } },
    { name: 'physical' }, { language: 'es_AR' }, { components: [] }, { transport_origin: 'cloud' }, { transportOrigin: 'cloud' },
  ]) {
    const tx = enterpriseSuccessPool();
    await assert.rejects(enqueueWppOutbox({ empresaId: 7, phone: '3515550000', message: 'Web', ...extra }, tx), { code: 'cloud_template_payload_invalid' });
    assert.equal(tx.calls.length, 0);
  }
});
