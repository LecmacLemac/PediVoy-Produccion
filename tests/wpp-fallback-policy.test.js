import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmpresaWppFallbackCondition } from '../src/wpp/fallbackPolicy.js';

test('fallback general no toma workers sanos y toma connected con heartbeat stale', () => {
  const sql = buildEmpresaWppFallbackCondition({ staleMinutes: 15 });

  assert.match(sql, /wpp_status[^\n]+IN \('disconnected', 'error'\)/);
  assert.match(sql, /wpp_status[^\n]+= 'connected'/);
  assert.match(sql, /wpp_heartbeat_at/);
  assert.match(sql, /IN \('initializing', 'resetting', 'awaiting_scan'\)/);
  assert.match(sql, /INTERVAL '15 minutes'/);
  assert.doesNotMatch(sql, /<> 'connected'/);
});

test('fallback general exige ventana positiva de stale', () => {
  assert.throws(
    () => buildEmpresaWppFallbackCondition({ staleMinutes: 0 }),
    /staleMinutes inválido/
  );
});
