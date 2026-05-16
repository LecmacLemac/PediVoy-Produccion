#!/usr/bin/env node

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const TARGETS = [
  '/api/health',
  '/pedidos/login.html',
  '/pedidos/signup.html',
];

const REQUIRED_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
];

function headerMap(res) {
  const out = {};
  for (const [k, v] of res.headers.entries()) out[k.toLowerCase()] = v;
  return out;
}

async function checkTarget(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path}: status ${res.status}`);

  const h = headerMap(res);
  const missing = REQUIRED_HEADERS.filter((name) => !h[name]);
  if (missing.length) {
    throw new Error(`${path}: faltan headers -> ${missing.join(', ')}`);
  }

  if (!String(h['x-frame-options']).toUpperCase().includes('DENY')) {
    throw new Error(`${path}: x-frame-options debería incluir DENY`);
  }

  if (!String(h['x-content-type-options']).toLowerCase().includes('nosniff')) {
    throw new Error(`${path}: x-content-type-options debería ser nosniff`);
  }

  const csp = String(h['content-security-policy'] || '');
  if (!csp.includes("default-src 'self'")) {
    throw new Error(`${path}: CSP sin default-src 'self'`);
  }

  console.log(`✅ ${path}`);
}

async function main() {
  console.log(`🔐 Smoke security headers @ ${BASE_URL}`);
  for (const p of TARGETS) {
    await checkTarget(p);
  }
  console.log('🎉 Security headers OK');
}

main().catch((e) => {
  console.error(`❌ ${e.message || e}`);
  process.exit(1);
});
