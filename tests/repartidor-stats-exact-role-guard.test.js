import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';

const source = readFileSync(new URL('../src/routes/repartidorStats.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('export function', 'function');

async function withServer(identity, run) {
  const calls = { auth: 0, queries: [], services: 0 };
  const context = {
    express,
    withAuth(req, _res, next) {
      calls.auth += 1;
      req.user = identity;
      next();
    },
    async query(sql, params) {
      calls.queries.push({ sql, params: Array.from(params || []) });
      if (/WITH entregas/.test(sql)) return [{ cantidad: 2, pago: 30 }];
      return [{ entregados: 1, pendientes: 2, dinero: 300 }];
    },
    getEmpresaIdFromToken() {
      calls.services += 1;
      throw new Error('getEmpresaIdFromToken must not run');
    },
    console,
  };
  vm.runInNewContext(`${source}\nglobalThis.router = createRepartidorStatsRouter();`, context);

  const app = express();
  app.use('/api/repartidor', context.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const deniedIdentities = [
  { role: 'admin', empresa_id: 3, chofer_id: 7 },
  { role: 'super', empresa_id: 3, chofer_id: 7 },
  { role: 'referente', empresa_id: 3, chofer_id: 7 },
  { role: 'user', empresa_id: 3, chofer_id: 7 },
  { role: 'Repartidor', empresa_id: 3, chofer_id: 7 },
  { role: 'REPARTIDOR', empresa_id: 3, chofer_id: 7 },
  { role: ' repartidor', empresa_id: 3, chofer_id: 7 },
  { role: 'repartidor ', empresa_id: 3, chofer_id: 7 },
  { role: null, empresa_id: 3, chofer_id: 7 },
  null,
  { role: 'repartidor', empresa_id: '3', chofer_id: 7 },
  { role: 'repartidor', empresa_id: 3, chofer_id: '7' },
  { role: 'repartidor', empresa_id: 0, chofer_id: 7 },
  { role: 'repartidor', empresa_id: -1, chofer_id: 7 },
  { role: 'repartidor', empresa_id: 1.5, chofer_id: 7 },
  { role: 'repartidor', empresa_id: Number.MAX_SAFE_INTEGER + 1, chofer_id: 7 },
  { role: 'repartidor', empresa_id: 3, chofer_id: 0 },
  { role: 'repartidor', empresa_id: 3, chofer_id: -1 },
  { role: 'repartidor', empresa_id: 3, chofer_id: 1.5 },
  { role: 'repartidor', empresa_id: 3, chofer_id: Number.MAX_SAFE_INTEGER + 1 },
  { role: 'repartidor', empresa_id: 3, chofer_id: null },
];

for (const path of ['/resumen-dia', '/pago-dia']) {
  test(`${path} exige auth e identidad repartidor exacta antes de toda query o servicio`, async () => {
    for (const identity of deniedIdentities) {
      await withServer(identity, async (baseUrl, calls) => {
        const response = await fetch(`${baseUrl}/api/repartidor${path}?empresa_id=99&chofer_id=88&fecha=2026-09-28`);
        assert.equal(response.status, 403, JSON.stringify(identity));
        assert.deepEqual(await response.json(), { error: 'No autorizado' });
        assert.equal(calls.auth, 1, JSON.stringify(identity));
        assert.equal(calls.queries.length, 0, JSON.stringify(identity));
        assert.equal(calls.services, 0, JSON.stringify(identity));
      });
    }
  });
}

test('repartidor exacto conserva stats y usa exclusivamente empresa/chofer autenticados', async () => {
  await withServer({ role: 'repartidor', empresa_id: 3, chofer_id: 7 }, async (baseUrl, calls) => {
    const resumen = await fetch(`${baseUrl}/api/repartidor/resumen-dia?empresa_id=99&chofer_id=88`);
    assert.equal(resumen.status, 200);
    assert.deepEqual(await resumen.json(), { entregados: 1, pendientes: 2, dinero: 300 });

    const pago = await fetch(`${baseUrl}/api/repartidor/pago-dia?empresa_id=99&chofer_id=88&fecha=2026-09-28`);
    assert.equal(pago.status, 200);
    assert.deepEqual(await pago.json(), { fecha: '2026-09-28', cantidad: 2, pago: 30 });

    assert.equal(calls.auth, 2);
    assert.equal(calls.services, 0);
    assert.equal(calls.queries.length, 2);
    assert.deepEqual(calls.queries[0].params, [3, 7]);
    assert.deepEqual(calls.queries[1].params, [3, 7, '2026-09-28', 3, 7, '2026-09-28']);
  });
});
