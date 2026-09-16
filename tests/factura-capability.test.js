import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createFacturaCapabilityRouter, signFacturaDownload } from '../src/facturaCapability.js';
import { secret } from './helpers/storage-harness.js';

async function serve(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factura-cap-'));
  await fs.writeFile(path.join(dir, 'private-invoice.pdf'), 'fiscal PDF');
  const state = { calls: 0, fail: false, row: { id: 10, empresa_id: 7, pdf_url: '/Facturas/private-invoice.pdf', estado: 'emitida' } };
  const query = async (sql, params) => {
    state.calls++;
    assert.match(sql, /id\s*=\s*\$1/);
    assert.match(sql, /empresa_id\s*=\s*\$2/);
    if (state.fail) throw new Error('DB unavailable');
    return params[0] === 10 && params[1] === 7 ? [state.row] : [];
  };
  const app = express();
  app.use('/public/facturas', createFacturaCapabilityRouter({ query, storageDir: dir, jwtSecret: secret }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (token, id = 10, extra = '') => fetch(`http://127.0.0.1:${server.address().port}/public/facturas/${id}/pdf?token=${encodeURIComponent(token)}${extra}`);
  try { await run({ state, request, dir }); }
  finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
}
const signed = () => signFacturaDownload({ id: 10, empresa_id: 7, pdf_url: '/Facturas/private-invoice.pdf' }, { jwtSecret: secret });

test('finite invoice capability downloads attachment with nosniff', async () => {
  await serve(async ({ request }) => {
    const token = signed();
    const claims = jwt.verify(token, secret);
    assert.equal(claims.factura_id, 10);
    assert.equal(claims.empresa_id, 7);
    assert.equal(claims.purpose, 'factura_pdf');
    assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 86400);
    const r = await request(token);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment;/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(await r.text(), 'fiscal PDF');
  });
});

test('invalid, expired, wrong-purpose/class/id capabilities denied before DB', async () => {
  await serve(async ({ state, request }) => {
    const valid = jwt.decode(signed());
    const tokens = ['broken', jwt.sign(valid, 'different-test-key'),
      ...[{ exp: 1 }, { purpose: 'other' }, { type: 'client' }, { type: 'user' },
        { factura_id: '10' }, { empresa_id: '7' }, { empresa_id: null }, { exp: undefined },
      ].map(change => { const payload = { ...valid, ...change }; if (payload.exp === undefined) delete payload.exp; return jwt.sign(payload, secret); }),
      jwt.sign({ uid: 1, role: 'super' }, secret),
    ];
    for (const token of tokens) assert.equal((await request(token)).status, 404);
    assert.equal((await request(signed(), 11)).status, 404);
    assert.equal((await request(signed(), 10, '&token=duplicate')).status, 404);
    assert.equal(state.calls, 0);
  });
});

test('capability bound to exact registered tenant, invoice, emitted state and safe path', async () => {
  await serve(async ({ state, request }) => {
    const token = signed();
    assert.equal((await request(signFacturaDownload({ id: 10, empresa_id: 8, pdf_url: '/Facturas/private-invoice.pdf' }, { jwtSecret: secret }))).status, 404);
    for (const change of [
      { id: 11 }, { empresa_id: 8 }, { estado: 'pendiente' }, { estado: 'cancelada' },
      { pdf_url: null }, { pdf_url: '/Facturas/../secret.pdf' }, { pdf_url: '/FacturasSibling/secret.pdf' },
      { pdf_url: '/Facturas/a%2fb.pdf' }, { pdf_url: 'https://remote/invoice.pdf' },
    ]) {
      const original = state.row;
      state.row = { ...original, ...change };
      assert.equal((await request(token)).status, 404, JSON.stringify(change));
      state.row = original;
    }
    state.fail = true;
    assert.equal((await request(token)).status, 500);
  });
});

test('capability is bound to the exact registered PDF version', async () => {
  await serve(async ({ state, request, dir }) => {
    const token = signed();
    await fs.writeFile(path.join(dir, 'replacement.pdf'), 'replacement PDF');
    state.row = { ...state.row, pdf_url: '/Facturas/replacement.pdf' };
    assert.equal((await request(token)).status, 404);
  });
});
