import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createFacturacionRouter } from '../src/routes/facturacion.js';
import { createFacturaCapabilityRouter } from '../src/facturaCapability.js';
import { buildFacturaPublicUrl } from '../src/services/facturaDeliveryService.js';
import { createWithAuth } from '../src/core/auth.js';
import { cfg } from '../src/config.js';
import { createWppEnqueueTestPool } from './support/wpp-enqueue-test-pool.js';

const secret = process.env.JWT_SECRET || cfg.jwtSecret;
test('outbound URL is a signed invoice capability without raw storage filename', () => {
  const url = buildFacturaPublicUrl({ protocol: 'https', get: key => key === 'host' ? 'invoice.example' : null }, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' });
  assert.match(url, /\/public\/facturas\/10\/pdf\?token=/);
  assert.doesNotMatch(url, /\/Facturas\//);
});

test('production invoice links require a configured canonical origin and ignore Host', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    APP_PUBLIC_URL: process.env.APP_PUBLIC_URL,
    LOCAL_HTTP_DEV: process.env.LOCAL_HTTP_DEV,
  };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.APP_PUBLIC_URL;
    const attackerRequest = { protocol: 'https', get: key => key === 'host' ? 'attacker.invalid' : null };
    assert.throws(
      () => buildFacturaPublicUrl(attackerRequest, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' }),
      error => error?.statusCode === 409,
    );

    process.env.PUBLIC_BASE_URL = 'http://example.com';
    assert.throws(
      () => buildFacturaPublicUrl(attackerRequest, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' }),
      error => error?.statusCode === 409,
    );
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    assert.throws(
      () => buildFacturaPublicUrl(attackerRequest, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' }),
      error => error?.statusCode === 409,
    );

    process.env.PUBLIC_BASE_URL = 'https://www.pedivoy.com/ignored-path';
    const url = buildFacturaPublicUrl(attackerRequest, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' });
    assert.match(url, /^https:\/\/www\.pedivoy\.com\/public\/facturas\/10\/pdf\?token=/);
    assert.doesNotMatch(url, /attacker\.invalid|ignored-path/);

    delete process.env.PUBLIC_BASE_URL;
    process.env.LOCAL_HTTP_DEV = 'true';
    const localRequest = {
      protocol: 'http',
      hostname: 'localhost',
      get: key => key === 'host' ? 'localhost:3000' : null,
    };
    assert.match(buildFacturaPublicUrl(localRequest, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' }), /^http:\/\/localhost:3000\//);
    assert.throws(
      () => buildFacturaPublicUrl(attackerRequest, { id: '10', empresa_id: 7, pdf_url: '/Facturas/private.pdf' }),
      error => error?.statusCode === 409,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('real send route queues capability URL that downloads; authenticated PDF still works', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'invoice-send-'));
  const outsidePath = path.join(os.tmpdir(), `invoice-outside-${process.pid}-${Date.now()}.txt`);
  await fs.mkdir(path.join(projectDir, 'Facturas'));
  await fs.writeFile(path.join(projectDir, 'Facturas', 'private-file.pdf'), 'fiscal PDF');
  await fs.writeFile(outsidePath, 'outside invoice secret');
  const factura = { id: '10', empresa_id: 7, estado: 'emitida', cae: 'test-cae', pdf_url: '/Facturas/private-file.pdf', punto_venta: 1, numero_comprobante: 20, receptor_telefono: '5491112345678' };
  let message;
  const query = async (sql, args) => {
    if (/FROM usuarios/.test(sql)) return [{ id: 1, role: 'admin', empresa_id: 7, activo: true, chofer_id: null, referente_id: null }];
    if (/FROM facturas(?: f)? WHERE|FROM facturas f\s/.test(sql)) return args[0] === 10 && args[1] === 7 ? [factura] : [];
    return [];
  };
  const transactionPool = createWppEnqueueTestPool({
    configIntegraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } },
    onQuery(request) {
      if (/INSERT INTO wpp_outbox/.test(request.text)) message = request.values[2];
      return undefined;
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createFacturacionRouter({ query, pool: transactionPool, withAuth: createWithAuth({ queryFn: query }), checkLicencia: (_q, _s, next) => next(), projectDir }));
  app.use('/public/facturas', createFacturaCapabilityRouter({ query, storageDir: path.join(projectDir, 'Facturas') }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${jwt.sign({ uid: 1, role: 'admin' }, secret)}`, 'Content-Type': 'application/json' };
  try {
    const response = await fetch(`${base}/api/facturas/10/enviar`, { method: 'POST', headers, body: JSON.stringify({ canal: 'whatsapp', empresa_id: 99 }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.public_url, /\/public\/facturas\/10\/pdf\?token=/);
    assert.ok(!body.public_url.includes('private-file.pdf'));
    assert.ok(message.includes(body.public_url));
    const url = new URL(body.public_url);
    const download = await fetch(`${base}${url.pathname}${url.search}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'fiscal PDF');
    const staff = await fetch(`${base}/api/facturas/10/pdf`, { headers });
    assert.equal(staff.status, 200);
    assert.equal(staff.headers.get('x-content-type-options'), 'nosniff');
    assert.match(staff.headers.get('content-disposition'), /^attachment;/);
    assert.equal((await fetch(`${base}/api/facturas/10/pdf`, { headers: { Authorization: ['Bearer', url.searchParams.get('token')].join(' ') } })).status, 401);

    await fs.rm(path.join(projectDir, 'Facturas', 'private-file.pdf'));
    await fs.symlink(outsidePath, path.join(projectDir, 'Facturas', 'private-file.pdf'));
    const symlinkStaff = await fetch(`${base}/api/facturas/10/pdf`, { headers });
    assert.equal(symlinkStaff.status, 404);
    assert.doesNotMatch(await symlinkStaff.text(), /outside invoice secret/);
    assert.equal((await fetch(`${base}${url.pathname}${url.search}`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsidePath, { force: true });
  }
});

test('application logging never includes token-bearing query strings', async () => {
  const source = await fs.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /req\??\.originalUrl/);
});
