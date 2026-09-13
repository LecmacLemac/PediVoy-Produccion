import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import express from 'express';

import { resolveTransferenciaStorageDir, createTransferenciaStorageRouter } from '../src/transferenciaStorage.js';
import { procesarArchivoTransferenciaPg } from '../src/transferenciasPipeline.js';

const projectDir = path.resolve('/app/pedivoy');

test('TRANSFERENCIA_STORAGE_PATH tiene prioridad y se resuelve a absoluto', () => {
  assert.equal(
    resolveTransferenciaStorageDir({
      projectDir,
      env: { TRANSFERENCIA_STORAGE_PATH: './persistente', DISK_PATH: '/mnt/disk' },
    }),
    path.resolve('./persistente')
  );
});

test('usa Transferencia dentro de DISK_PATH cuando no hay override', () => {
  assert.equal(
    resolveTransferenciaStorageDir({ projectDir, env: { DISK_PATH: '/mnt/disk' } }),
    path.join('/mnt/disk', 'Transferencia')
  );
});

test('usa Transferencia dentro del proyecto como fallback', () => {
  assert.equal(
    resolveTransferenciaStorageDir({ projectDir, env: {} }),
    path.join(projectDir, 'Transferencia')
  );
});

test('descarga exige licencia y token user administrativo; admin queda limitado a su tenant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-transfer-'));
  fs.writeFileSync(path.join(dir, 'receipt.pdf'), '%PDF-test');
  const app = express();
  let licenseChecks = 0;
  let queries = 0;
  const withAuth = (req, res, next) => {
    req.user = {
      role: String(req.headers['x-role'] || ''),
      type: String(req.headers['x-type'] || ''),
      empresa_id: Number(req.headers['x-empresa-id'] || 0),
    };
    return next();
  };
  const checkLicencia = (_req, _res, next) => { licenseChecks += 1; next(); };
  const query = async (sql, params) => {
    queries += 1;
    assert.match(sql, /comprobantes_transferencia/);
    assert.match(sql, /empresa_id\s*=\s*\$2/);
    return Number(params[1]) === 7 ? [{ id: 10 }] : [];
  };
  app.use('/Transferencia', createTransferenciaStorageRouter({
    storageDir: dir,
    withAuth,
    checkLicencia,
    query,
    isSuper: req => req.user.role === 'super',
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/Transferencia/receipt.pdf`;
  const headers = (role, type, empresaId) => ({ 'x-role': role, 'x-type': type, 'x-empresa-id': String(empresaId) });
  try {
    for (const deniedHeaders of [
      headers('admin', 'client', 7),
      headers('admin', 'repartidor', 7),
      headers('admin', 'unknown', 7),
      headers('user', 'user', 7),
    ]) {
      const denied = await fetch(url, { headers: deniedHeaders });
      assert.equal(denied.status, 403);
    }
    assert.equal(queries, 0);

    const wrongTenant = await fetch(url, { headers: headers('admin', 'user', 1) });
    const allowed = await fetch(url, { headers: headers('admin', 'user', 7) });
    assert.equal(wrongTenant.status, 404);
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('content-disposition'), /^attachment;/);
    assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(licenseChecks, 6);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin legacy sin type descarga el archivo de su tenant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-transfer-legacy-admin-'));
  fs.writeFileSync(path.join(dir, 'receipt.pdf'), '%PDF-test');
  const app = express();
  app.use('/Transferencia', createTransferenciaStorageRouter({
    storageDir: dir,
    withAuth: (req, _res, next) => {
      req.user = { role: 'admin', empresa_id: 1 };
      next();
    },
    checkLicencia: (_req, _res, next) => next(),
    query: async (sql, params) => {
      assert.match(sql, /empresa_id\s*=\s*\$2/);
      assert.deepEqual(params, ['receipt.pdf', 1]);
      return [{ id: 10 }];
    },
    isSuper: req => req.user.role === 'super',
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/Transferencia/receipt.pdf`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('super user administrativo conserva descarga cross-tenant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-transfer-super-'));
  fs.writeFileSync(path.join(dir, 'receipt.pdf'), '%PDF-test');
  const app = express();
  app.use('/Transferencia', createTransferenciaStorageRouter({
    storageDir: dir,
    withAuth: (req, _res, next) => { req.user = { role: 'super', type: 'user', empresa_id: 99 }; next(); },
    checkLicencia: (_req, _res, next) => next(),
    query: async (sql, params) => {
      assert.doesNotMatch(sql, /empresa_id\s*=\s*\$2/);
      assert.deepEqual(params, ['receipt.pdf']);
      return [{ id: 10 }];
    },
    isSuper: req => req.user.role === 'super',
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/Transferencia/receipt.pdf`);
    assert.equal(response.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elimina el archivo propio cuando la reserva DB informa evento duplicado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-transfer-clean-'));
  const absolutePath = path.join(dir, 'duplicate.jpg');
  fs.writeFileSync(absolutePath, Buffer.from([0xff, 0xd8, 0xff]));

  const result = await procesarArchivoTransferenciaPg(
    { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimetype: 'image/jpeg' },
    '3510000000',
    {
      empresaId: 7,
      sourceMessageId: 'msg-duplicate',
      deps: {
        saveFileToDisk: async () => ({
          absolutePath, relativePath: '/Transferencia/duplicate.jpg',
          mimetype: 'image/jpeg', size: 3,
        }),
        insertarComprobantePg: async () => ({ duplicate: true }),
      },
    }
  );

  assert.equal(result.reason, 'duplicate_event_or_file');
  assert.equal(fs.existsSync(absolutePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
