#!/usr/bin/env node

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const SMOKE_USER = process.env.SMOKE_USER || '';
const SMOKE_PASS = process.env.SMOKE_PASS || '';

let cookieHeader = '';

function setCookiesFromResponse(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return;
  const first = raw.split(',')[0];
  const cookie = first.split(';')[0];
  if (cookie) cookieHeader = cookie;
}

async function request(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookieHeader) headers.cookie = cookieHeader;
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  setCookiesFromResponse(res);
  return res;
}

async function expectJson(res, allowed = [200]) {
  if (!allowed.includes(res.status)) {
    throw new Error(`status ${res.status} (esperado ${allowed.join(',')})`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`content-type inválido: ${ct}`);
  }
  return res.json();
}

async function expectHtml(res, allowed = [200]) {
  if (!allowed.includes(res.status)) {
    throw new Error(`status ${res.status} (esperado ${allowed.join(',')})`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html')) {
    throw new Error(`content-type inválido: ${ct}`);
  }
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message || e}`);
    return false;
  }
}

async function runPublicChecks() {
  const results = [];

  results.push(await check('GET /api/health', async () => {
    const r = await request('/api/health');
    await expectJson(r, [200]);
  }));

  results.push(await check('GET /pedidos/login.html', async () => {
    const r = await request('/pedidos/login.html');
    await expectHtml(r, [200]);
  }));

  results.push(await check('GET /pedidos/signup.html', async () => {
    const r = await request('/pedidos/signup.html');
    await expectHtml(r, [200]);
  }));

  results.push(await check('GET /public/config', async () => {
    const r = await request('/public/config');
    await expectJson(r, [200, 404]);
  }));

  results.push(await check('POST /public/pedidos inválido', async () => {
    const r = await request('/public/pedidos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ empresa_id: 1 }),
    });
    await expectJson(r, [400]);
  }));

  return results;
}

async function runAuthChecks() {
  if (!SMOKE_USER || !SMOKE_PASS) {
    console.log('ℹ️ Saltando auth checks (definí SMOKE_USER y SMOKE_PASS).');
    return [true];
  }

  const results = [];

  results.push(await check('POST /api/login', async () => {
    const r = await request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: SMOKE_USER, password: SMOKE_PASS }),
    });
    await expectJson(r, [200]);
  }));

  results.push(await check('GET /api/me (autenticado)', async () => {
    const r = await request('/api/me');
    const j = await expectJson(r, [200]);
    if (!j?.user?.username) throw new Error('respuesta /api/me sin user.username');
  }));

  results.push(await check('POST /api/logout', async () => {
    const r = await request('/api/logout', { method: 'POST' });
    await expectJson(r, [200]);
  }));

  results.push(await check('GET /api/me (post-logout)', async () => {
    const r = await request('/api/me');
    await expectJson(r, [401]);
  }));

  return results;
}

async function main() {
  console.log(`🔎 Smoke post-deploy @ ${BASE_URL}`);
  const publicResults = await runPublicChecks();
  const authResults = await runAuthChecks();
  const ok = [...publicResults, ...authResults].every(Boolean);
  if (!ok) process.exit(1);
  console.log('🎉 Smoke post-deploy OK');
}

main().catch((e) => {
  console.error('Smoke post-deploy failed:', e);
  process.exit(1);
});
