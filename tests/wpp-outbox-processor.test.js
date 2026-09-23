import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
    requestRestart: async () => {},
    withActiveClient: fn => fn({
      client, ownerId: 'general-test', epoch: 7n, generation: 1,
    }),
  });

  await processor.processOutbox();

  const claim = statements.find(entry => /WITH candidates AS/i.test(entry.sql));
  assert.ok(claim, 'debe ejecutar claim CTE');
  assert.match(claim.sql, /FOR UPDATE OF o SKIP LOCKED/i);
  assert.match(claim.sql, /o\.empresa_id IS NULL/i);
  assert.doesNotMatch(claim.sql, /wpp_heartbeat_at/i);
  assert.doesNotMatch(statements.map(entry => entry.sql).join('\n'), /SELECT o\.id, o\.telefono, o\.mensaje\s+FROM wpp_outbox/i);
  assert.equal(sends, 0);
  assert.equal(processor.releaseWatchdogIfStuck, undefined);
});

test('fallback general conserva un @lid válido aunque colisione con el cache por teléfono', async () => {
  const lid = '123456789012345@lid';
  const cachedCollision = '999999999012345@lid';
  const row = { id: 91, telefono: lid, mensaje: 'respuesta' };
  const sentTargets = [];
  let numberLookups = 0;
  const client = {
    getNumberId: async () => { numberLookups += 1; return null; },
    getChatById: async () => null,
    sendMessage: async target => { sentTargets.push(target); },
  };
  const processor = createOutboxProcessor({
    ENABLE_WPP: true,
    query: async sql => {
      if (/WITH candidates AS/i.test(sql)) return [row];
      if (/RETURNING id/i.test(sql)) return [{ id: row.id }];
      return [];
    },
    lidByPhone: new Map([[lid.slice(0, -4).slice(-10), cachedCollision]]),
    safeErrorString: String,
    getClient: () => client,
    getIsReady: () => true,
    getIsShuttingDown: () => false,
    requestRestart: async () => {},
    withActiveClient: fn => fn({ client, ownerId: 'general-test', epoch: 7n }),
  });

  await processor.processOutbox();

  assert.deepEqual(sentTargets, [lid]);
  assert.equal(numberLookups, 0);
});

test('worker empresarial reclama exclusivamente filas de su empresa', async () => {
  const source = await readFile(new URL('../src/wppWorker.js', import.meta.url), 'utf8');
  const claimStart = source.indexOf('const filas = await claimWppOutboxRows');
  assert.ok(claimStart >= 0);
  const claim = source.slice(claimStart, source.indexOf('});', claimStart) + 3);
  assert.match(claim, /o\.empresa_id = \$4/i);
  assert.match(claim, /o\.transport_origin = 'company'/i);
  assert.match(claim, /o\.transport_origin IS NULL/i);
  assert.match(claim, /whereParams:\s*\[EMPRESA_ID\]/i);
  assert.doesNotMatch(claim, /empresa_id IS NULL/i);
});
