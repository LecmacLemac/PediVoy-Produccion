import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  claimWppOutboxRows,
  ensureWppDeliverySchema,
  releaseWppOutboxClaim,
  resolveWhatsappTarget,
} from '../src/wpp/delivery.js';

test('preserva JIDs completos incluyendo @lid sin consultar el número', async () => {
  let lookups = 0;
  const client = { getNumberId: async () => { lookups += 1; } };

  assert.equal(await resolveWhatsappTarget(client, '123456789012345@lid'), '123456789012345@lid');
  assert.equal(await resolveWhatsappTarget(client, '120363000000000000@g.us'), '120363000000000000@g.us');
  assert.equal(lookups, 0);
});

test('resuelve teléfonos y @c.us con getNumberId y conserva fallback seguro', async () => {
  const seen = [];
  const resolvingClient = {
    getNumberId: async phone => {
      seen.push(phone);
      return { _serialized: `${phone}77@lid` };
    },
  };

  assert.equal(await resolveWhatsappTarget(resolvingClient, '11 2345-6789'), '549112345678977@lid');
  assert.equal(await resolveWhatsappTarget(resolvingClient, '5491123456789@c.us'), '549112345678977@lid');
  assert.deepEqual(seen, ['5491123456789', '5491123456789']);

  const failingClient = { getNumberId: async () => { throw new Error('lookup temporal'); } };
  assert.equal(await resolveWhatsappTarget(failingClient, '5491123456789@c.us'), '5491123456789@c.us');
});

test('getNumberId bloqueado vence y conserva fallback seguro sin iniciar envío', async () => {
  const client = { getNumberId: async () => new Promise(() => {}) };

  const target = await resolveWhatsappTarget(client, '3534000000', { timeoutMs: 5 });

  assert.equal(target, '5493534000000@c.us');
});

test('migración runtime agrega lease y heartbeat sin depender de updated_at de outbox', async () => {
  const statements = [];
  await ensureWppDeliverySchema(async sql => { statements.push(sql); return []; });

  const sql = statements.join('\n');
  assert.match(sql, /ALTER TABLE wpp_outbox/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS claim_owner TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS wpp_heartbeat_at TIMESTAMPTZ/i);
  assert.doesNotMatch(sql, /wpp_outbox[\s\S]*updated_at/i);
});

test('claim usa una sola sentencia atómica, SKIP LOCKED y permite recuperar leases vencidos', async () => {
  let captured;
  const rows = await claimWppOutboxRows({
    query: async (sql, params) => {
      captured = { sql, params };
      return [{ id: 7, telefono: '123', mensaje: 'hola' }];
    },
    owner: 'worker-a',
    limit: 3,
    leaseMs: 60000,
    whereSql: 'AND o.empresa_id = $4',
    whereParams: [42],
  });

  assert.equal(rows[0].id, 7);
  assert.match(captured.sql, /FOR UPDATE OF o SKIP LOCKED/i);
  assert.match(captured.sql, /status = 'pending'/i);
  assert.doesNotMatch(captured.sql, /status\s+IN\s*\([^)]*sending/i);
  assert.match(captured.sql, /claim_until IS NULL OR o\.claim_until < NOW\(\)/i);
  assert.match(captured.sql, /UPDATE wpp_outbox/i);
  assert.match(captured.sql, /RETURNING o\.id,[\s\S]*o\.telefono, o\.mensaje/i);
  assert.deepEqual(captured.params, ['worker-a', 60000, 3, 42]);
});

test('initDb mantiene esquema canónico de outbox para fencing y estados no reintentables', async () => {
  const sql = await readFile(new URL('../initDb.sql', import.meta.url), 'utf8');

  assert.match(sql, /ALTER TABLE wpp_outbox[\s\S]*ADD COLUMN IF NOT EXISTS claim_owner TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS claim_epoch BIGINT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ/i);
  assert.match(sql, /wpp_outbox_status_check[\s\S]*pending[\s\S]*sending[\s\S]*sent[\s\S]*error[\s\S]*skipped/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS wpp_outbox_pending_claim_idx[\s\S]*WHERE status = 'pending'/i);
});

test('liberar claim conserva pending para errores previos al envío', async () => {
  let captured;
  await releaseWppOutboxClaim({
    query: async (sql, params) => { captured = { sql, params }; return []; },
    id: 9,
    owner: 'worker-b',
    error: 'Reintento por destino temporalmente no resoluble',
  });

  assert.match(captured.sql, /SET status = 'pending'/i);
  assert.match(captured.sql, /claim_owner = NULL/i);
  assert.match(captured.sql, /claim_until = NULL/i);
  assert.match(captured.sql, /WHERE id = \$2 AND claim_owner = \$3/i);
});
