#!/usr/bin/env node

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';

async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.error(`❌ ${name}:`, e.message || e);
    return false;
  }
}

async function expectJson(resp, allowedStatuses = [200]) {
  if (!allowedStatuses.includes(resp.status)) {
    throw new Error(`status ${resp.status} (esperado: ${allowedStatuses.join(', ')})`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`content-type inválido: ${ct}`);
  }
  return resp.json();
}

async function run() {
  console.log(`🔎 Smoke public endpoints @ ${BASE_URL}`);

  const results = [];

  results.push(await check('GET /api/health', async () => {
    const r = await fetch(`${BASE_URL}/api/health`);
    await expectJson(r, [200]);
  }));

  results.push(await check('GET /public/config', async () => {
    const r = await fetch(`${BASE_URL}/public/config`);
    const j = await expectJson(r, [200, 404]);
    if (j == null || typeof j !== 'object') throw new Error('respuesta no es objeto JSON');
  }));

  results.push(await check('GET /public/pedido-estado?id=999999999', async () => {
    const r = await fetch(`${BASE_URL}/public/pedido-estado?id=999999999`);
    await expectJson(r, [410]);
  }));

  results.push(await check('POST /public/pedidos (payload inválido)', async () => {
    const r = await fetch(`${BASE_URL}/public/pedidos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ empresa_id: 1 }),
    });
    await expectJson(r, [400]);
  }));

  const ok = results.every(Boolean);
  if (!ok) process.exit(1);
  console.log('🎉 Smoke OK');
}

run().catch((e) => {
  console.error('Smoke failed:', e);
  process.exit(1);
});
