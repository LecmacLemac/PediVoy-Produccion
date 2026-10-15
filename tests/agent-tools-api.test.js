import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { createAgentTools } from '../src/agents/tools.js';
const token = `pva_12345678-1234-4234-8234-123456789abc.${'a'.repeat(43)}`;
const operation = '12345678-1234-4234-8234-123456789abc';
const ctx = { actor: { uid: 1, role: 'repartidor', empresa_id: 7, chofer_id: 4 }, empresaId: 7, scopes: ['identity:read', 'deliveries:read', 'deliveries:claim'], query: async sql => sql.includes('UPDATE') || sql.includes('FROM pedidos') ? [{ id: 1 }] : [{ id: 4 }] };
async function withApi(fn, overrides = {}) {
  let module;
  try { module = await import('../src/routes/agentTools.js'); } catch (err) { assert.fail(`Missing router: ${err.code}`); }
  const calls = [];
  const service = {
    async authenticate(value) { calls.push(['authenticate', value]); if (value !== token) throw Object.assign(new Error('secret SQL detail'), { status: 401, code: 'invalid_agent_token' }); return ctx; },
    async execute(value, options, work) { calls.push(['execute', value, options]); return work(ctx); },
    ...overrides.service,
  };
  const app = express();
  if (overrides.preparsed) app.use(express.json({ limit: '1mb' }));
  app.use('/api/agent/v1', module.createAgentToolsRouter({ service, tools: overrides.tools || createAgentTools({}) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/agent/v1`;
  const request = (path, body, headers = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  try { await fn({ request, calls, base }); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('REST lists effective tools and executes declared scope with stable canonical operation hash', async () => {
  await withApi(async ({ request, calls }) => {
    const list = await request('/tools');
    assert.equal(list.status, 200);
    assert.match(list.headers.get('cache-control'), /private.*no-store/);
    const body = await list.json();
    assert.ok(body.tools.some(t => t.name === 'tomar_pedido'));
    assert.ok(!body.tools.some(t => t.name === 'listar_pedidos'));
    const res = await request('/tools/tomar_pedido', { arguments: { operation_id: operation, pedido_id: 1 } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, result: { pedido_id: 1, ok: true } });
    const options = calls.find(c => c[0] === 'execute')[2];
    assert.deepEqual(options, { scope: 'deliveries:claim', tool: 'tomar_pedido', write: true, idempotencyKey: operation, requestHash: createHash('sha256').update(JSON.stringify({ args: { pedido_id: 1 }, name: 'tomar_pedido' })).digest('hex') });
  });
});

test('auth is closed before tool lookup: no cookies, query tokens, JWT or browser Origin', async () => {
  await withApi(async ({ request, calls, base }) => {
    for (const headers of [{ authorization: '' }, { authorization: 'Bearer eyJ.human.jwt' }, { authorization: '', cookie: `token=${token}` }, { origin: 'https://pedivoy.test' }]) {
      const res = await request('/tools/no_existe', { arguments: {} }, headers);
      assert.ok([401,403].includes(res.status));
      assert.equal((await res.json()).ok, false);
    }
    const res = await fetch(`${base}/tools?token=${token}`);
    assert.equal(res.status, 401);
    assert.equal(calls.filter(c => c[0] === 'execute').length, 0);
  });
});

test('strict envelope, unknown tools/methods, 16KB and private sanitized errors', async () => {
  await withApi(async ({ request, base }) => {
    for (const body of [{}, { arguments: {}, empresa_id: 8 }, { arguments: [] }, '{bad']) {
      const res = await request('/tools/mi_identidad', body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).ok, false);
    }
    assert.equal((await request('/tools/no_existe', { arguments: {} })).status, 404);
    assert.equal((await fetch(base + '/tools', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await request('/tools/mi_identidad', { arguments: { blob: 'x'.repeat(17000) } })).status, 413);
    assert.equal((await request('/tools/mi_identidad', { arguments: { empresa_id: 8 } })).status, 400);
  });
  for (const code of ['TRANSACTION_OUTCOME_UNKNOWN', 'outcome_unknown']) {
    await withApi(async ({ request }) => {
      const res = await request('/tools/mi_identidad', { arguments: {} });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: { code: 'TRANSACTION_OUTCOME_UNKNOWN', message: 'Resultado de la operación indeterminado' } });
    }, { service: { execute: async () => { throw Object.assign(new Error('password SQL pva_secret'), { code, status: 503 }); } } });
  }
  await withApi(async ({ request }) => {
    const res = await request('/tools/mi_identidad', { arguments: {} });
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(await res.json()).includes('secret'));
  }, { service: { execute: async () => { throw new Error('SQL secret'); } } });
});

test('response bound is enforced inside execute before success, including injected/preparsed apps', async () => {
  const normal = createAgentTools({});
  let completed = false;
  await withApi(async ({ request }) => {
    const res = await request('/tools/mi_identidad', { arguments: {} });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'RESULT_TOO_LARGE');
    assert.equal(completed, false);
    assert.equal((await request('/tools/mi_identidad', { arguments: { extra: 'x'.repeat(17000) } })).status, 413);
  }, {
    preparsed: true,
    tools: { ...normal, call: async () => ({ value: 'x'.repeat(2 * 1024 * 1024) }) },
    service: { execute: async (_token, _options, work) => { const result = await work(ctx); completed = true; return result; } },
  });
  await withApi(async ({ request }) => {
    assert.equal((await request('/tools/mi_identidad', '{}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await request('/tools/mi_identidad', '{}', { 'content-encoding': 'gzip' })).status, 415);
  });
});
