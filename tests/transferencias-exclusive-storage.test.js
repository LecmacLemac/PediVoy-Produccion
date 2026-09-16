import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveFileToDisk } from '../src/transferenciasPipeline.js';

test('WhatsApp transfer persistence retries UUID collisions without overwriting', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pedivoy-transfer-exclusive-'));
  try {
    const first = await saveFileToDisk({ buffer: Buffer.from('%PDF-first'), mimetype: 'application/pdf' }, {
      storageDir: dir,
      randomId: () => 'same-id',
    });
    const ids = ['same-id', 'new-id'];
    const second = await saveFileToDisk({ buffer: Buffer.from('%PDF-second'), mimetype: 'application/pdf' }, {
      storageDir: dir,
      randomId: () => ids.shift(),
    });

    assert.equal(first.filename, 'comp-same-id.pdf');
    assert.equal(second.filename, 'comp-new-id.pdf');
    assert.equal(await readFile(first.absolutePath, 'utf8'), '%PDF-first');
    assert.equal(await readFile(second.absolutePath, 'utf8'), '%PDF-second');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
