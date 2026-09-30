import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';

import { createLicenciasMpRouter, createMercadoPagoWebhookRouter } from '../src/routes/licenciasMp.js';
import { createCallsRouter } from '../src/routes/calls.js';
import { registerWppCronAndRoutes } from '../src/wpp/cronRoutes.js';
import { createPagosWebhookRouter } from '../src/qr/pagosWebhookRouter.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakePool({ empresa = { nombre: 'Acme', telefono: null, email: 'a@b.test', plan_precio: 100 } } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push(['connect']);
      return {
        async query(sql, params) {
          calls.push([String(sql), params]);
          if (/SELECT nombre/.test(sql)) return { rows: [empresa] };
          return { rows: [] };
        },
        release() { calls.push(['release']); },
      };
    },
  };
}

function auth(user) {
  return (req, _res, next) => { req.user = user; next(); };
}

function licenseApp({ user, pool, preferenceCalls, wppCalls }) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/licencia', createLicenciasMpRouter({
    withAuth: auth(user),
    pool,
    crearPreferenciaLicencia: async payload => { preferenceCalls.push(payload); return 'https://pago.test/x'; },
    enqueueWppMessage: async payload => { wppCalls.push(payload); },
  }));
  return app;
}

test('licencia rechaza roles bajos y variantes antes de DB/MP/WhatsApp', async () => {
  for (const role of ['user', 'repartidor', 'referente', 'Admin', ' admin ', 'SUPER', '', null]) {
    const pool = fakePool();
    const preferenceCalls = [];
    const wppCalls = [];
    await withServer(licenseApp({ user: { role, empresa_id: 7 }, pool, preferenceCalls, wppCalls }), async base => {
      const response = await fetch(`${base}/api/admin/licencia/generar-pago`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 403, String(role));
    });
    assert.equal(pool.calls.length, 0, String(role));
    assert.equal(preferenceCalls.length, 0, String(role));
    assert.equal(wppCalls.length, 0, String(role));
  }
});

test('licencia limita admin a su empresa y exige selector valido a super', async () => {
  for (const scenario of [
    { user: { role: 'admin', empresa_id: 7 }, body: { empresa_id: 99 }, expectedEmpresa: 7, status: 200 },
    { user: { role: 'super', empresa_id: null }, body: {}, expectedEmpresa: null, status: 400 },
    { user: { role: 'super', empresa_id: null }, body: { empresa_id: 'x' }, expectedEmpresa: null, status: 400 },
    { user: { role: 'super', empresa_id: null }, body: { empresa_id: 9 }, expectedEmpresa: 9, status: 200 },
  ]) {
    const pool = fakePool();
    const preferenceCalls = [];
    await withServer(licenseApp({ user: scenario.user, pool, preferenceCalls, wppCalls: [] }), async base => {
      const response = await fetch(`${base}/api/admin/licencia/generar-pago`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scenario.body),
      });
      assert.equal(response.status, scenario.status, JSON.stringify(scenario));
    });
    if (scenario.expectedEmpresa === null) {
      assert.equal(pool.calls.length, 0);
      assert.equal(preferenceCalls.length, 0);
    } else {
      assert.equal(preferenceCalls[0]?.empresaId, scenario.expectedEmpresa);
    }
  }
});

function callsApp(counters) {
  const app = express();
  app.use(express.json());
  app.use('/api', createCallsRouter({
    withAuth: auth({ role: 'admin', empresa_id: 1 }),
    resolveEmpresaId: () => 1,
    updateCallSession: async () => { counters.update += 1; return { id: 1, campaign_contact_id: 2, empresa_id: 1 }; },
    createCallEvent: async () => { counters.event += 1; },
    updateContactResult: async () => { counters.contact += 1; },
  }));
  return app;
}

test('Asterisk falla cerrado sin secreto o con secreto incorrecto y válido conserva procesamiento', async () => {
  const previous = process.env.ASTERISK_WEBHOOK_SECRET;
  try {
    for (const scenario of [
      { secret: undefined, header: 'anything', status: 503, calls: 0 },
      { secret: 'correct-secret', header: 'wrong', status: 401, calls: 0 },
      { secret: 'correct-secret', header: 'correct-secret', status: 200, calls: 1 },
    ]) {
      restore('ASTERISK_WEBHOOK_SECRET', scenario.secret);
      const counters = { update: 0, event: 0, contact: 0 };
      await withServer(callsApp(counters), async base => {
        const response = await fetch(`${base}/api/asterisk/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-asterisk-secret': scenario.header },
          body: JSON.stringify({ session_id: 1, event_type: 'answer', empresa_id: 1 }),
        });
        assert.equal(response.status, scenario.status);
      });
      assert.equal(counters.update, scenario.calls);
      assert.equal(counters.event, scenario.calls);
    }
  } finally { restore('ASTERISK_WEBHOOK_SECRET', previous); }
});

test('Mercado Pago licencia falla cerrado sin secreto o incorrecto antes de proveedor/DB', async () => {
  const previous = process.env.MP_WEBHOOK_SECRET;
  try {
    for (const scenario of [
      { secret: undefined, header: 'anything', status: 503, calls: 0 },
      { secret: 'correct-secret', header: 'wrong', status: 403, calls: 0 },
      { secret: 'correct-secret', header: 'correct-secret', status: 200, calls: 1 },
    ]) {
      restore('MP_WEBHOOK_SECRET', scenario.secret);
      const providerCalls = [];
      const pool = fakePool();
      const app = express();
      app.use(express.json());
      app.use('/api/webhooks', createMercadoPagoWebhookRouter({
        pool,
        obtenerPago: async id => { providerCalls.push(id); return { status: 'pending' }; },
        enqueueWppMessage: async () => {},
      }));
      await withServer(app, async base => {
        const response = await fetch(`${base}/api/webhooks/mercadopago?topic=payment&id=123`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-mp-secret': scenario.header }, body: '{}',
        });
        assert.equal(response.status, scenario.status);
      });
      assert.equal(providerCalls.length, scenario.calls);
      assert.equal(pool.calls.length, 0);
    }
  } finally { restore('MP_WEBHOOK_SECRET', previous); }
});

test('Mercado Pago no envía WhatsApp antes de commit y reporta outcome ambiguo para reintento', async () => {
  const previous = process.env.MP_WEBHOOK_SECRET;
  process.env.MP_WEBHOOK_SECRET = 'correct-secret';
  const wppCalls = [];
  const queries = [];
  let releasedWith;
  const client = {
    async query(sql) {
      queries.push(String(sql).trim());
      if (/UPDATE empresas/.test(sql)) return { rows: [{ id: 7, nombre: 'Acme', plan_vencimiento: new Date(), telefono: '54911' }] };
      if (/COMMIT/.test(sql)) throw new Error('connection lost after commit write');
      return { rows: [] };
    },
    release(error) { releasedWith = error; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', createMercadoPagoWebhookRouter({
    pool: { connect: async () => client },
    obtenerPago: async () => ({ status: 'approved', external_reference: '7', transaction_amount: 100 }),
    enqueueWppMessage: async payload => { wppCalls.push(payload); },
  }));
  try {
    await withServer(app, async base => {
      const response = await fetch(`${base}/api/webhooks/mercadopago?topic=payment&id=123`, {
        method: 'POST', headers: { 'x-mp-secret': 'correct-secret' },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'processing_unavailable', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
    });
    assert.ok(queries.some(sql => sql === 'COMMIT'));
    assert.equal(queries.includes('ROLLBACK'), false);
    assert.match(releasedWith?.message || '', /connection lost after commit write/);
    assert.equal(wppCalls.length, 0);
  } finally { restore('MP_WEBHOOK_SECRET', previous); }
});

test('Mercado Pago revierte error de trabajo y libera conexión reutilizable sin postcommit', async () => {
  const previous = process.env.MP_WEBHOOK_SECRET;
  process.env.MP_WEBHOOK_SECRET = 'correct-secret';
  const sequence = [];
  let releasedWith = 'not-released';
  let wppCalls = 0;
  const client = {
    async query(sql) {
      const normalized = String(sql).trim();
      sequence.push(normalized);
      if (/INSERT INTO historial_pagos/.test(normalized)) throw Object.assign(new Error('write failed'), { code: 'XX000' });
      return { rows: [] };
    },
    release(error) { releasedWith = error; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', createMercadoPagoWebhookRouter({
    pool: { connect: async () => client },
    obtenerPago: async () => ({ status: 'approved', external_reference: '7', transaction_amount: 100 }),
    enqueueWppMessage: async () => { wppCalls += 1; },
  }));
  try {
    await withServer(app, async base => {
      const response = await fetch(`${base}/api/webhooks/mercadopago?topic=payment&id=456`, {
        method: 'POST', headers: { 'x-mp-secret': 'correct-secret' },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'processing_unavailable' });
    });
    assert.deepEqual(sequence.filter(sql => /^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)), ['BEGIN', 'ROLLBACK']);
    assert.equal(releasedWith, undefined);
    assert.equal(wppCalls, 0);
  } finally { restore('MP_WEBHOOK_SECRET', previous); }
});

test('cron secrets faltante/incorrecto no consultan; válido sí ejecuta ambos endpoints', async () => {
  const previous = process.env.CRON_SECRET;
  const callbacks = new Map();
  let queryCalls = 0;
  const timers = { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {} };
  const app = { post(path, handler) { callbacks.set(path, handler); } };
  const cron = registerWppCronAndRoutes(app, { query: async () => { queryCalls += 1; return []; }, timers });
  const invoke = async (path, header) => {
    const result = { status: 200, body: null };
    const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
    await callbacks.get(path)({ headers: { 'x-cron-secret': header } }, res);
    return result;
  };
  try {
    for (const path of callbacks.keys()) {
      const before = queryCalls;
      delete process.env.CRON_SECRET;
      assert.equal((await invoke(path, 'x')).status, 503);
      process.env.CRON_SECRET = 'cron-correct';
      assert.equal((await invoke(path, 'wrong')).status, 403);
      assert.equal(queryCalls, before);
      assert.equal((await invoke(path, 'cron-correct')).status, 200);
    }
    assert.equal(queryCalls, 2);
  } finally {
    await cron.stop();
    restore('CRON_SECRET', previous);
  }
});

test('webhooks QR genérico y Mercado Pago fallan cerrados y sólo procesan firma válida', async () => {
  const secret = 'tenant-webhook-secret';
  let configuredSecret = secret;
  const counters = { provider: 0, scoped: 0, payment: 0 };
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', createPagosWebhookRouter({
    queryFn: async () => [{ id: 1, empresa_id: 7 }],
    getConfigPagosEmpresaFn: async () => ({ accessToken: 'token', webhookSecret: configuredSecret, autoConfirmar: true }),
    getMercadoPagoPaymentFn: async () => {
      counters.provider += 1;
      return { id: 123, status: 'pending', external_reference: 'PEDIDO|emp:7|ped:8' };
    },
    getPagoPorPedidoProveedorFn: async () => ({ id: 1, empresa_id: 7, pedido_id: 8 }),
    actualizarEstadoPagoPedidoFn: async () => { counters.payment += 1; return true; },
    actualizarEstadoPagoScopedFn: async () => { counters.scoped += 1; return true; },
  }));

  await withServer(app, async base => {
    const genericBody = { proveedor: 'banco_x', providerPaymentId: 'p-1', nuevoEstado: 'pagado' };
    configuredSecret = null;
    assert.equal((await fetch(`${base}/api/webhooks/pagos`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(genericBody),
    })).status, 503);
    configuredSecret = secret;
    for (const signature of [undefined, '00']) {
      const headers = { 'content-type': 'application/json' };
      if (signature) headers['x-pagos-signature'] = signature;
      const response = await fetch(`${base}/api/webhooks/pagos`, { method: 'POST', headers, body: JSON.stringify(genericBody) });
      assert.equal(response.status, 403);
    }
    assert.equal(counters.scoped, 0);
    const genericSignature = createHmac('sha256', secret).update('banco_x|p-1|pagado').digest('hex');
    assert.equal((await fetch(`${base}/api/webhooks/pagos`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pagos-signature': genericSignature }, body: JSON.stringify(genericBody),
    })).status, 200);
    assert.equal(counters.scoped, 1);

    const mpUrl = `${base}/api/webhooks/pagos/mercado_pago?empresa_id=7&topic=payment&id=123`;
    configuredSecret = null;
    assert.equal((await fetch(mpUrl, { method: 'POST' })).status, 503);
    configuredSecret = secret;
    assert.equal((await fetch(mpUrl, { method: 'POST', headers: { 'x-pagos-signature': '00' } })).status, 403);
    assert.equal(counters.provider, 0);
    const mpSignature = createHmac('sha256', secret).update('mercado_pago|7|123').digest('hex');
    assert.equal((await fetch(mpUrl, { method: 'POST', headers: { 'x-pagos-signature': mpSignature } })).status, 200);
    assert.equal(counters.provider, 1);
  });
});
