import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTransferenciaStorageRouter } from '../src/transferenciaStorage.js';
import { createGastosStorageRouter, createFacturasStorageRouter } from '../src/privateStorage.js';
import { storageHarness } from './helpers/storage-harness.js';

for (const [mount, factory, roles] of [
  ['/Transferencia', createTransferenciaStorageRouter, ['admin']],
  ['/Gastos', createGastosStorageRouter, ['admin', 'user', 'facturacion', 'contable']],
  ['/Facturas', createFacturasStorageRouter, ['admin', 'user', 'facturacion', 'contable']],
]) {
  test(`${mount}: anonymous and explicit token classes denied before DB`, async () => {
    await storageHarness(factory, mount, async ({ state, request }) => {
      for (const filename of ['registered.pdf', '', 'nested/file.pdf']) assert.equal((await request(filename, null)).status, 401);
      for (const type of ['client', 'public', 'user', '', null, {}, 2]) assert.equal((await request('registered.pdf', { uid: 1, role: 'admin', type })).status, 401);
      assert.equal(state.calls.length, 0);
    });
  });
  test(`${mount}: expired license is denied before object lookup`, async () => {
    await storageHarness(factory, mount, async ({ state, request }) => {
      state.licenseDenied = true;
      assert.equal((await request('registered.pdf')).status, 403);
      assert.equal(state.objects, 0);
    });
  });
  test(`${mount}: registered tenant object, cookie flow, cross-tenant and super`, async () => {
    await storageHarness(factory, mount, async ({ state, request }) => {
      for (const role of roles) {
        state.identity.role = role;
        const response = await request('registered.pdf', { uid: 1, role: 'admin', empresa_id: 999 }, true);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.match(response.headers.get('content-disposition'), /^attachment;/);
        assert.equal(await response.text(), 'private PDF');
        assert.equal((await request('manual.pdf')).status, 404);
      }
      state.identity.empresa_id = 9;
      assert.equal((await request()).status, 404);
      state.identity = { ...state.identity, role: 'super', empresa_id: null };
      assert.equal((await request()).status, 200);
      assert.equal((await request('manual.pdf')).status, 404);
    });
  });
  test(`${mount}: incompatible roles, inactive identity and invalid driver rejected before object query`, async () => {
    await storageHarness(factory, mount, async ({ state, request }) => {
      state.identity = { ...state.identity, role: 'referente', referente_id: 2, referente_valid: true };
      assert.equal((await request()).status, 403);
      state.identity = { ...state.identity, role: 'admin', referente_id: null, activo: false };
      assert.equal((await request()).status, 401);
      state.identity = { ...state.identity, role: 'repartidor', activo: true, chofer_id: 8, chofer_valid: false };
      assert.equal((await request()).status, 401);
      assert.equal(state.objects, 0);
    });
  });
  test(`${mount}: traversal rejected before object query; DB errors fail closed`, async () => {
    await storageHarness(factory, mount, async ({ state, request }) => {
      for (const filename of ['..%2Fregistered.pdf', '%5Cregistered.pdf', '%00.pdf', '.hidden', 'nested/file.pdf']) {
        const r = await request(filename);
        assert.ok([400, 404].includes(r.status), `${filename}: ${r.status}`);
      }
      assert.equal(state.objects, 0);
      state.fail = true;
      assert.equal((await request()).status, 500);
    });
  });
}

test('Gastos: repartidor only own tenant and active linked driver', async () => {
  await storageHarness(createGastosStorageRouter, '/Gastos', async ({ state, request }) => {
    state.identity = { ...state.identity, role: 'repartidor', chofer_id: 8, chofer_valid: true };
    assert.equal((await request()).status, 200);
    state.identity.chofer_id = 9;
    assert.equal((await request()).status, 404);
    state.identity.chofer_id = 8;
    state.identity.empresa_id = 9;
    assert.equal((await request()).status, 404);
  });
});

test('app mounts protected storage instead of static directories', async () => {
  const source = await fs.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  for (const domain of ['Gastos', 'Facturas']) {
    assert.match(source, new RegExp(`app.use\\('/${domain}', create${domain}StorageRouter`));
    assert.doesNotMatch(source, new RegExp(`app.use\\('/${domain}', express.static`));
  }
});

test('storage ownership queries do not interpolate authorization predicates', async () => {
  for (const file of ['../src/privateStorage.js', '../src/transferenciaStorage.js']) {
    const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\$\{(?:scope|tenantFilter)\}/);
  }
});

test('registered symlinks cannot escape any protected storage root', async () => {
  const outside = path.join(os.tmpdir(), `pedivoy-storage-secret-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(outside, 'outside secret');
  try {
    for (const [mount, factory] of [
      ['/Transferencia', createTransferenciaStorageRouter],
      ['/Gastos', createGastosStorageRouter],
      ['/Facturas', createFacturasStorageRouter],
    ]) {
      await storageHarness(factory, mount, async ({ dir, request }) => {
        const registered = path.join(dir, 'registered.pdf');
        await fs.rm(registered);
        await fs.symlink(outside, registered);
        const response = await request('registered.pdf');
        assert.equal(response.status, 404, mount);
        assert.doesNotMatch(await response.text(), /outside secret/);
      });
    }
  } finally {
    await fs.rm(outside, { force: true });
  }
});
