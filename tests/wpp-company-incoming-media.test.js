import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { registerCompanyIncomingMedia } from '../src/wpp/companyIncomingMedia.js';

test('registra una sola escucha media por cliente/generación empresarial', () => {
  const client = new EventEmitter();
  const deps = {
    empresaId: 7,
    query: async () => [],
    lidByPhone: new Map(),
    handleIncomingComprobanteFromBotPg: async () => ({ ok: false }),
  };

  const first = registerCompanyIncomingMedia(client, deps);
  const second = registerCompanyIncomingMedia(client, deps);

  assert.equal(client.listenerCount('message'), 1);
  assert.strictEqual(second, first);
});

test('cada cliente nuevo recibe su propia escucha sin conservar la generación anterior', () => {
  const oldClient = new EventEmitter();
  const newClient = new EventEmitter();
  const deps = {
    empresaId: 7,
    query: async () => [],
    lidByPhone: new Map(),
    handleIncomingComprobanteFromBotPg: async () => ({ ok: false }),
  };

  registerCompanyIncomingMedia(oldClient, deps);
  oldClient.removeAllListeners();
  registerCompanyIncomingMedia(newClient, deps);

  assert.equal(oldClient.listenerCount('message'), 0);
  assert.equal(newClient.listenerCount('message'), 1);
});
