import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import { request } from 'node:http';
import { gzipSync } from 'node:zlib';
import { personalAgentHttpBoundary } from '../src/agents/httpBoundary.js';

async function fixture(work) {
  const app = express(); let visits = 0;
  app.use(personalAgentHttpBoundary({ canonicalOrigin: 'https://www.pedivoy.com' }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.all('*', (_req, res) => { visits++; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`, () => visits); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('personal agent boundary rejects credentialed cross-origin reads before compatible CORS', async () => fixture(async (url, visits) => {
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    const res = await fetch(url + '/api/mi-agente/connections', { method, headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.match(res.headers.get('cache-control'), /no-store/);
  }
  assert.equal(visits(), 0);
}));

test('Express case-insensitive mount variants cannot bypass origin checks or early parser limits', async () => fixture(async (url, visits) => {
  for (const prefix of ['/API/mi-agente', '/api/MI-AGENTE', '/API/MI-AGENTE', '/API/agent/v1', '/api/AGENT/V1']) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const response = await fetch(url + prefix + '/connections', { method, headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{untrusted' } : {}) });
      assert.equal(response.status, 403, `${prefix} ${method} must not reach compatible CORS/parser`);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
  const oversized = await fetch(url + '/API/MI-AGENTE/connections', { method: 'POST', headers: { Origin: 'https://www.pedivoy.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(17000) }) });
  assert.equal(oversized.status, 413);
  assert.equal(visits(), 0);
}));

test('management mutations require the configured origin and JSON but unrelated routes are untouched', async () => fixture(async (url, visits) => {
  assert.equal((await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers: { Origin: 'https://www.pedivoy.com', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers: { Origin: 'https://www.pedivoy.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal((await fetch(url + '/api/mi-agente/connections')).status, 200);
  assert.equal((await fetch(url + '/api/mi-agente-legacy', { headers: { Origin: 'https://attacker.invalid' } })).status, 200);
  assert.equal(visits(), 3);
}));

test('agent protocol rejects browser origins including preflight; server-to-server remains usable', async () => fixture(async (url, visits) => {
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    const res = await fetch(url + '/api/agent/v1/tools', { method, headers: { Origin: 'https://www.pedivoy.com' } });
    assert.equal(res.status, 403);
  }
  assert.equal((await fetch(url + '/api/agent/v1/tools')).status, 200);
  assert.equal(visits(), 1);
}));

test('agent payload is bounded before the legacy one-megabyte parser and errors are sanitized', async () => fixture(async (url, visits) => {
  const headers = { Origin: 'https://www.pedivoy.com', 'Content-Type': 'application/json' };
  const tooLarge = await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(17000) }) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'payload_too_large');
  const malformed = await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers, body: '{secret_not_to_echo' });
  assert.equal(malformed.status, 400);
  const text = await malformed.text(); assert.doesNotMatch(text, /secret_not_to_echo|SyntaxError|stack/);
  assert.equal(visits(), 0);
}));

test('chunked and compressed requests cannot evade the decoded body limit', async () => fixture(async (url, visits) => {
  const headers = { Origin: 'https://www.pedivoy.com', 'Content-Type': 'application/json' };
  const status = await new Promise((resolve, reject) => {
    const req = request(url + '/api/mi-agente/connections', { method: 'POST', headers }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.write('{"name":"'); req.write('x'.repeat(17000)); req.end('"}');
  });
  assert.equal(status, 413);
  const compressed = await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify({ name: 'x'.repeat(17000) })) });
  assert.equal(compressed.status, 413);
  assert.equal(visits(), 0);
}));

test('null origins, cross-site fetch metadata and alternate JSON media types fail closed', async () => fixture(async (url, visits) => {
  for (const headers of [{ Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await fetch(url + '/api/mi-agente/connections', { headers })).status, 403);
  }
  const res = await fetch(url + '/api/mi-agente/connections', { method: 'POST', headers: { Origin: 'https://www.pedivoy.com', 'Content-Type': 'application/merge-patch+json' }, body: '{}' });
  assert.equal(res.status, 415);
  assert.equal(visits(), 0);
}));

test('canonical origin is never inferred from hostile Host or forwarded headers', async () => {
  const app = express(); app.use(personalAgentHttpBoundary({ canonicalOrigin: '' }));
  app.post('/api/mi-agente/connections', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mi-agente/connections`, { method: 'POST', headers: { Origin: 'https://attacker.invalid', Host: 'attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
