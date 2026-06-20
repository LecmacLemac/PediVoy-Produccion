import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __testables } from '../src/transferenciasPipeline.js';

test('convierte PDF con pdftoppm -singlefile leyendo el archivo prefix.png', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pedivoy-pdf-'));
  const binDir = path.join(tmpDir, 'bin');
  const oldPath = process.env.PATH || '';

  await fs.mkdir(binDir, { recursive: true });

  const fakePdftoppm = path.join(binDir, 'pdftoppm');
  await fs.writeFile(fakePdftoppm, `#!/usr/bin/env node
const fs = require('node:fs');
const outPrefix = process.argv[process.argv.length - 1];
fs.writeFileSync(outPrefix + '.png', Buffer.from('pdf-page-ok'));
`, { mode: 0o755 });

  const pdfPath = path.join(tmpDir, 'comprobante.pdf');
  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\\n'));

  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  try {
    const base64 = await __testables.convertPdfFirstPageWithPdftoppm(pdfPath);
    assert.equal(Buffer.from(base64, 'base64').toString(), 'pdf-page-ok');
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('clasifica Premature close de OpenAI como error transitorio', () => {
  assert.equal(
    __testables.isTransientOpenAIError(new Error('Invalid response body: Premature close')),
    true
  );
});
