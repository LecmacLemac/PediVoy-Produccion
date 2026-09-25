import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueueCorrelatedWppMessage,
  enqueueWppMessage,
} from '../src/services/messaging.js';
import {
  enqueueCorrelatedWppMessagePg,
  enqueueWppMessagePg,
} from '../src/transferenciasServices.js';
import { isWhatsappCloudActive } from '../src/wpp/enqueue.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

const enqueuers = [
  ['messaging', (payload, pool) => enqueueWppMessage(payload, pool)],
  ['transferencias', (payload, pool) => enqueueWppMessagePg({
    phone: payload.phone,
    message: payload.message,
    empresaId: payload.empresa_id,
    transportOrigin: payload.transport_origin,
  }, pool)],
];

for (const [name, enqueue] of enqueuers) {
  test(`${name}: empresa NULL encola transporte general explícito sin lookup de empresa`, async () => {
    const pool = createWppEnqueueTestPool();
    const result = await enqueue({ phone: '3515550000', message: 'hola', empresa_id: null }, pool);
    const insert = pool.calls.find(call => /INSERT INTO wpp_outbox/.test(call.text));
    assert.equal(result.transportOrigin, 'general');
    assert.equal(insert.values[0], null);
    assert.equal(insert.values[3], 'general');
    assert.equal(pool.calls.some(call => /FROM empresas/.test(call.text)), false);
  });

  test(`${name}: resuelve company y cloud desde la empresa e ignora transporte forzado`, async () => {
    const cases = [
      [{}, 'company'],
      [{ whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:token' } }, 'cloud'],
    ];

    for (const [configIntegraciones, expected] of cases) {
      for (const forced of ['general', 'company', 'cloud', 'arbitrario']) {
        const pool = createWppEnqueueTestPool({ configIntegraciones });
        const result = await enqueue({
          phone: '123456789012345@lid',
          message: `hola-${expected}-${forced}`,
          empresa_id: 7,
          transport_origin: forced,
        }, pool);
        const insert = pool.calls.find(call => /INSERT INTO wpp_outbox/.test(call.text));
        assert.equal(insert.values[0], 7);
        assert.equal(insert.values[1], '123456789012345@lid');
        assert.equal(insert.values[3], expected);
        assert.equal(result.transportOrigin, expected);
      }
    }
  });

  test(`${name}: empresa desconocida o configuración inválida falla sin insertar`, async () => {
    const cases = [
      createWppEnqueueTestPool({ companyExists: false }),
      createWppEnqueueTestPool({ configIntegraciones: null }),
      createWppEnqueueTestPool({ configIntegraciones: { whatsapp: 'cloud' } }),
    ];
    for (const pool of cases) {
      await assert.rejects(enqueue({
        phone: '3515550000', message: 'no insertar', empresa_id: 404, transport_origin: 'general',
      }, pool));
      assert.equal(pool.calls.some(call => /INSERT INTO wpp_outbox/.test(call.text)), false);
      assert.equal(pool.calls.at(-1).text, 'ROLLBACK');
    }
  });

  test(`${name}: Cloud legacy incompleta queda en company para no perder consumidor`, async () => {
    const pool = createWppEnqueueTestPool({
      configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7' } },
    });
    const result = await enqueue({ phone: '3515550000', message: 'legacy', empresa_id: 7 }, pool);
    assert.equal(result.transportOrigin, 'company');
  });
}

for (const [name, enqueue] of [
  ['messaging correlacionado', (payload, pool) => enqueueCorrelatedWppMessage(payload, pool)],
  ['transferencias correlacionado', (payload, pool) => enqueueCorrelatedWppMessagePg({
    phone: payload.phone,
    message: payload.message,
    empresaId: payload.empresa_id,
    transportOrigin: payload.transport_origin,
  }, pool)],
]) {
  test(`${name}: sólo general conserva el canal de ingreso con empresa para auditoría`, async () => {
    const pool = createWppEnqueueTestPool({
      configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:token' } },
    });
    const result = await enqueue({
      phone: '123456789012345@lid',
      message: 'respuesta correlacionada',
      empresa_id: 7,
      transport_origin: 'general',
    }, pool);
    const insert = pool.calls.find(call => /INSERT INTO wpp_outbox/.test(call.text));

    assert.equal(result.transportOrigin, 'general');
    assert.equal(insert.values[0], 7);
    assert.equal(insert.values[3], 'general');
    assert.equal(pool.calls.some(call => /FROM empresas/.test(call.text)), false);
  });

  test(`${name}: rechaza transportes correlacionados distintos de general antes de conectar`, async () => {
    for (const transport_origin of ['company', 'cloud', 'otro', '', null]) {
      let connects = 0;
      await assert.rejects(
        enqueue({
          phone: '3515550000',
          message: 'no insertar',
          empresa_id: 7,
          transport_origin,
        }, { async connect() { connects += 1; } }),
        error => error?.code === 'transport_origin_correlacionado_no_permitido',
      );
      assert.equal(connects, 0);
    }
  });
}

test('enqueueWppMessagePg deduplica obligatoriamente la segunda llamada equivalente', async () => {
  let inserted = false;
  const pool = createWppEnqueueTestPool({
    onQuery({ text, values }) {
      if (/FROM wpp_outbox/.test(text) && !/INSERT INTO/.test(text)) {
        return { rows: inserted ? [{ id: 91, status: 'pending', transport_origin: values[3] }] : [] };
      }
      if (/INSERT INTO wpp_outbox/.test(text)) {
        inserted = true;
        return { rows: [{ id: 91, status: 'pending', transport_origin: values[3] }] };
      }
      return undefined;
    },
  });

  const payload = { phone: '3515550000', message: 'duplicado', empresaId: 7 };
  const first = await enqueueWppMessagePg(payload, pool);
  const second = await enqueueWppMessagePg(payload, pool);
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.reason, 'duplicate_5m');
});

test('política Node conserva tipado booleano estricto', () => {
  assert.equal(isWhatsappCloudActive({ whatsapp: { provider: 'cloud', enabled: 'true', phone_number_id: 'x', access_token_encrypted: 'y' } }), false);
});
