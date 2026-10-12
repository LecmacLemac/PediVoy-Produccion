import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import http from 'node:http';

function request(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + pathname, { headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, body }));
    }).on('error', reject);
  });
}
import { registerLandingRoutes } from '../src/routes/landingRoutes.js';

async function withLandingServer(work) {
  const app = express();
  app.set('trust proxy', 1);
  registerLandingRoutes(app, {
    projectDir: path.resolve('.'),
    query: async () => { throw new Error('Homepage redirect must not query tenant data'); },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('PediVoy public homepage redirects both exact domains to its canonical landing', async () => {
  await withLandingServer(async base => {
    for (const host of ['pedivoy.com', 'www.pedivoy.com', 'PEDIVOY.COM', 'pedivoy.com:443']) {
      const response = await request(base, '/', { host });
      assert.equal(response.status, 302, host);
      assert.equal(response.location, '/landing/pedivoy', host);
    }
  });
});

test('AguaHidro public homepage redirects both exact domains to its canonical landing', async () => {
  await withLandingServer(async base => {
    for (const host of ['aguahidro.com', 'www.aguahidro.com', 'AGUAHIDRO.COM', 'aguahidro.com:443']) {
      const response = await request(base, '/', { host });
      assert.equal(response.status, 302, host);
      assert.equal(response.location, '/landing/aguahidro', host);
    }
  });
});

test('other hosts and forged forwarded headers keep the global homepage', async () => {
  await withLandingServer(async base => {
    for (const host of ['aguahidro.com.example.test', 'evilaguahidro.com', 'example.test', 'pedivoy.com.example.test', 'evilpedivoy.com']) {
      const response = await request(base, '/', { host, 'x-forwarded-host': 'pedivoy.com' });
      assert.equal(response.status, 200, host);
      assert.equal(response.location, undefined, host);
      assert.match(response.body, /AguaHidro/, host);
    }
  });
});

test('PediVoy redirect does not override explicit selectors or other paths', async () => {
  await withLandingServer(async base => {
    for (const pathname of ['/?slug=unknown', '/?empresa_id=999']) {
      const response = await request(base, pathname, { host: 'pedivoy.com' });
      assert.equal(response.status, 404, pathname);
      assert.equal(response.location, undefined, pathname);
    }
    for (const pathname of ['/index.html', '/unrelated']) {
      const response = await request(base, pathname, { host: 'pedivoy.com' });
      assert.equal(response.status, 200, pathname);
      assert.equal(response.location, undefined, pathname);
    }
  });
});
