import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutboxProcessor } from '../src/wpp/outboxProcessor.js';

test('fallback general obtiene filas exclusivamente mediante claim atómico', async () => {
  const statements = [];
  let sends = 0;
  const client = {
    getNumberId: async () => null,
    getChatById: async () => null,
    sendMessage: async () => { sends += 1; },
  };
  const processor = createOutboxProcessor({
    ENABLE_WPP: true,
    query: async (sql, params = []) => {
      statements.push({ sql: String(sql), params });
      return [];
    },
    lidByPhone: new Map(),
    safeErrorString: String,
    getClient: () => client,
    getIsReady: () => true,
    getIsShuttingDown: () => false,
    reiniciarWhatsApp: async () => {},
    claimOwner: 'general-test',
  });

  await processor.processOutbox();

  const claim = statements.find(entry => /WITH candidates AS/i.test(entry.sql));
  assert.ok(claim, 'debe ejecutar claim CTE');
  assert.match(claim.sql, /FOR UPDATE OF o SKIP LOCKED/i);
  assert.match(claim.sql, /wpp_heartbeat_at/i);
  assert.doesNotMatch(statements.map(entry => entry.sql).join('\n'), /SELECT o\.id, o\.telefono, o\.mensaje\s+FROM wpp_outbox/i);
  assert.equal(sends, 0);
  assert.equal(processor.releaseWatchdogIfStuck, undefined);
});
