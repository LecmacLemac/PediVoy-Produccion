import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { createPublicLegacyCatalogRouter } from '../src/routes/publicLegacyCatalog.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);

async function withServer(app, work) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function requestJson(base, path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

test('contacto_id solo devuelve 400 uniforme sin transacción ni consulta de punto/pedido', async () => {
  const sqlCalls = [];
  let transactionCalls = 0;
  const query = async (sql, params = []) => {
    sqlCalls.push({ sql: String(sql), params });
    if (/FROM empresas/i.test(sql)) return [{ id: 1 }];
    throw new Error(`consulta de negocio inesperada: ${sql}`);
  };
  const withTransaction = async work => {
    transactionCalls += 1;
    return work(query);
  };
  const app = express();
  app.use('/public', createPublicLegacyCatalogRouter({ query, withTransaction }));

  await withServer(app, async base => {
    const responses = [];
    for (const id of Array.from({ length: 25 }, (_, index) => index + 1)) {
      responses.push(await requestJson(base, `/public/ultimo-pedido?empresa_id=1&contacto_id=${id}`));
    }
    for (const response of responses) {
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: 'telefono requerido', code: 'PUBLIC_PHONE_REQUIRED' });
      assert.doesNotMatch(JSON.stringify(response.body), /pedido|tracking|contacto_id|999999/i);
    }
  });

  assert.equal(transactionCalls, 0);
  assert.equal(sqlCalls.some(({ sql }) => /puntos_entrega|pedidos/i.test(sql)), false);
});

test('estructura: último pedido siempre resuelve teléfono antes de validar concordancia y consultar pedido', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/publicLegacyCatalog.js'), 'utf8');
  const start = source.indexOf("router.get('/ultimo-pedido'");
  const end = source.indexOf('\n  return router;', start);
  const route = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(route, /if\s*\(contactoId\)/);
  assert.doesNotMatch(route, /SELECT\s+id\s+FROM\s+puntos_entrega\s+WHERE[\s\S]*\bid\s*=\s*\$2/i);

  const phoneRequired = route.indexOf('PUBLIC_PHONE_REQUIRED');
  const transaction = route.indexOf('runInTransaction(async txQuery');
  const phoneLock = route.indexOf('lockGeneralPhoneIdentity(txQuery');
  const cardinality = route.indexOf('resolveTenantDeliveryPointByPhone(txQuery');
  const concordance = route.indexOf('contactoId !== null');
  const orderQuery = route.indexOf('FROM pedidos p');
  assert.ok(phoneRequired >= 0 && phoneRequired < transaction);
  assert.ok(transaction < phoneLock && phoneLock < cardinality);
  assert.ok(cardinality < concordance && concordance < orderQuery);
});

function sourceFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(full));
    else if (/\.(?:html|js|mjs|cjs|ts|tsx|py|sh)$/.test(entry.name)) result.push(full);
  }
  return result;
}

test('inventario estructural: ningún caller usa contacto_id como selector único de último pedido', () => {
  const roots = ['index.html', 'pages', 'pedidos', 'scripts'];
  const files = roots.flatMap(relative => {
    const full = path.join(root, relative);
    return fs.statSync(full).isDirectory() ? sourceFiles(full) : [full];
  });
  const callers = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let offset = 0;
    while ((offset = source.indexOf('/public/ultimo-pedido?', offset)) >= 0) {
      const snippet = source.slice(offset, offset + 500);
      callers.push({ file: path.relative(root, file), snippet });
      offset += '/public/ultimo-pedido?'.length;
    }
  }

  assert.ok(callers.length > 0);
  for (const caller of callers) {
    assert.match(caller.snippet, /telefono=/, caller.file);
    assert.doesNotMatch(caller.snippet.split(/[\n`'";]/, 1)[0], /contacto_id=/, caller.file);
  }
});
