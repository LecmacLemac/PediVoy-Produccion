import test from 'node:test';
import assert from 'node:assert/strict';

import { createComprobanteTenantQueries } from '../src/handlers.js';

test('ver y procesar comprobantes filtran siempre por empresa', async () => {
  const calls = [];
  const api = createComprobanteTenantQueries(async (sql, params) => {
    calls.push({ sql, params });
    return [];
  });

  await api.obtenerUltimos('3510000000', 7);
  await api.marcarProcesado('OP-1', 7);

  assert.match(calls[0].sql, /empresa_id = \$2/);
  assert.deepEqual(calls[0].params, ['3510000000', 7]);
  assert.match(calls[1].sql, /empresa_id = \$2/);
  assert.doesNotMatch(calls[1].sql, /procesado\s*=\s*TRUE/i);
  assert.match(calls[1].sql, /validado\s*=\s*0/i);
  assert.match(calls[1].sql, /estado_revision\s*=\s*'en_revision'/i);
  assert.match(calls[1].sql, /verified_at\s*=\s*NULL/i);
  assert.match(calls[1].sql, /verified_by\s*=\s*NULL/i);
  assert.deepEqual(calls[1].params, ['OP-1', 7]);
});
