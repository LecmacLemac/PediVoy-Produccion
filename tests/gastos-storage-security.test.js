import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createExclusiveGastosStorage } from '../src/routes/gastos.js';

function store(storage, content, { mimetype = 'application/pdf', originalname = 'comprobante.pdf' } = {}) {
  const file = { mimetype, originalname, stream: Readable.from([Buffer.from(content)]) };
  return new Promise((resolve, reject) => {
    storage._handleFile({}, file, (error, info) => error ? reject(error) : resolve(info));
  });
}

test('gastos uploads use collision-resistant names and never overwrite an existing file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pedivoy-gastos-storage-'));
  try {
    const ids = ['tenant-a-id', 'tenant-b-id'];
    const storage = createExclusiveGastosStorage(dir, { randomId: () => ids.shift() });
    const first = await store(storage, 'tenant A');
    const second = await store(storage, 'tenant B');

    assert.notEqual(first.filename, second.filename);
    assert.equal(await readFile(first.path, 'utf8'), 'tenant A');
    assert.equal(await readFile(second.path, 'utf8'), 'tenant B');

    const collision = createExclusiveGastosStorage(dir, { randomId: () => 'tenant-a-id' });
    await assert.rejects(store(collision, 'overwrite attempt'), error => error?.code === 'EEXIST');
    assert.equal(await readFile(first.path, 'utf8'), 'tenant A');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gastos upload extension is derived from validated MIME, not the original filename', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pedivoy-gastos-storage-'));
  try {
    const storage = createExclusiveGastosStorage(dir, { randomId: () => 'safe-id' });
    const stored = await store(storage, 'PDF', {
      mimetype: 'application/pdf',
      originalname: '../../escape.jpg',
    });
    assert.equal(stored.filename, 'gasto-safe-id.pdf');
    assert.equal(path.dirname(stored.path), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
