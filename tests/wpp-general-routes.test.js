import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

import { createApp } from '../src/app.js';
import { registerWppRoutes } from '../src/wpp/routes.js';
import { resolveGeneralRouteDeps } from '../src/wpp/whatsappWeb.js';
import { createGeneralControlRepository } from '../src/wpp/generalControlRepository.js';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function buildApp({ repository, supervisor, state = {}, actor = { uid: 7, role: 'super' }, destructive = {} } = {}) {
  const app = express();
  app.use(express.json());
  const localState = {
    isConnected: false,
    isReadyWpp: false,
    isInitializingWpp: false,
    isShuttingDownWpp: false,
    lastQr: null,
    ...state,
  };

  registerWppRoutes(app, {
    ENABLE_WPP: true,
    WPP_QR_ONLY: false,
    qrcode: { toDataURL: async value => `data:image/png;base64,${value}` },
    withAuth(req, _res, next) {
      req.user = actor;
      next();
    },
    isSuper: () => true,
    getState: () => localState,
    repository,
    supervisor,
    getClient: () => ({ destroy: destructive.destroy ?? (() => {}) }),
    initWhatsApp: destructive.initialize ?? (() => {}),
    fs: { rmSync: destructive.rmSync ?? (() => {}) },
    path: {},
    limpiarLocksSesion: destructive.clearLocks ?? (() => {}),
  });
  return app;
}

test('reset only persists a cluster request and returns 202 with its sequence', async () => {
  const calls = [];
  const app = buildApp({
    repository: {
      requestReset: async input => {
        calls.push(['requestReset', input]);
        return { accepted: true, sequence: 12n };
      },
    },
    destructive: {
      destroy: () => calls.push(['destroy']),
      rmSync: () => calls.push(['rmSync']),
      initialize: () => calls.push(['initialize']),
      clearLocks: () => calls.push(['clearLocks']),
    },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      accepted: true,
      request_id: 'wpp-reset-12',
      reset_seq: '12',
      sequence: '12',
    });
  });

  assert.deepEqual(calls, [['requestReset', { requestedBy: '7', cooldownMs: 15000 }]]);
});

test('reset rejects non-canonical actor uids before calling the repository', async t => {
  const actors = [
    ['missing uid', { role: 'super' }],
    ['legacy id only', { id: 7, role: 'super' }],
    ['zero uid', { uid: 0, role: 'super' }],
    ['negative uid', { uid: -1, role: 'super' }],
    ['fractional uid', { uid: 1.5, role: 'super' }],
    ['string uid', { uid: '7', role: 'super' }],
  ];

  for (const [name, actor] of actors) {
    await t.test(name, async () => {
      let repositoryCalls = 0;
      const app = buildApp({
        actor,
        repository: {
          async requestReset() {
            repositoryCalls += 1;
            return { accepted: true, sequence: 1n };
          },
        },
      });

      await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'Usuario autenticado inválido' });
      });
      assert.equal(repositoryCalls, 0);
    });
  }
});

test('two concurrent reset routes expose one sequence and one global cooldown result', async () => {
  let requestCount = 0;
  const app = buildApp({
    repository: {
      async requestReset() {
        const current = requestCount++;
        await Promise.resolve();
        return { accepted: current === 0, sequence: 30n };
      },
    },
  });

  await withServer(app, async baseUrl => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' }),
      fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' }),
    ]);
    assert.deepEqual(responses.map(response => response.status), [202, 202]);
    assert.deepEqual(await Promise.all(responses.map(response => response.json())), [
      {
        ok: true,
        accepted: true,
        request_id: 'wpp-reset-30',
        reset_seq: '30',
        sequence: '30',
      },
      {
        ok: true,
        accepted: false,
        skipped: true,
        reason: 'cooldown',
        request_id: 'wpp-reset-30',
        reset_seq: '30',
        sequence: '30',
      },
    ]);
  });
});

test('reset route fails closed for malformed results and repository failures', async t => {
  const cases = [
    ['undefined result', async () => undefined],
    ['legacy bare sequence', async () => 1n],
    ['missing acceptance result', async () => ({ sequence: 1n })],
    ['missing sequence', async () => ({ accepted: false })],
    ['zero sequence', async () => ({ accepted: true, sequence: 0n })],
    ['negative sequence', async () => ({ accepted: true, sequence: -1n })],
    ['fractional sequence', async () => ({ accepted: true, sequence: 1.5 })],
    ['string sequence', async () => ({ accepted: true, sequence: '1' })],
    ['repository rejection', async () => { throw new Error('database unavailable'); }],
  ];

  for (const [name, requestReset] of cases) {
    await t.test(name, async () => {
      const app = buildApp({ repository: { requestReset } });

      await withServer(app, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: 'No se pudo solicitar el reset de WhatsApp',
        });
      });
    });
  }
});

test('status returns persisted cluster state and the local supervisor role', async () => {
  const clusterStatus = {
    owner_id: 'render-old',
    epoch: 9n,
    state: 'awaiting_scan',
    heartbeat_at: new Date('2026-09-16T12:00:00.000Z'),
    operation: 'initialize',
    qr_code: 'cluster-qr',
    last_error: null,
    reset_requested_seq: 4n,
    reset_started_seq: 3n,
    reset_applied_seq: 3n,
    reset_failed_seq: 0n,
  };
  const app = buildApp({
    repository: { getClusterStatus: async () => clusterStatus },
    supervisor: {
      snapshot: () => ({
        state: 'standby', generation: 0, isOwner: false, ready: false, gateOpen: false,
      }),
    },
    state: { isConnected: true, lastQr: 'stale-local-qr' },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/whatsapp/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.cluster, {
      owner_id: 'render-old',
      epoch: '9',
      state: 'awaiting_scan',
      heartbeat_at: '2026-09-16T12:00:00.000Z',
      operation: 'initialize',
      last_error: null,
      reset_requested_seq: '4',
      reset_started_seq: '3',
      reset_applied_seq: '3',
      reset_failed_seq: '0',
    });
    assert.deepEqual(body.local, {
      role: 'standby', state: 'standby', generation: 0, ready: false, gate_open: false,
    });
    assert.equal(body.connected, false);
    assert.equal(body.has_qr, true);
  });
});

test('QR route renders the persisted owner QR instead of stale local memory', async () => {
  const encoded = [];
  const app = express();
  app.use(express.json());
  registerWppRoutes(app, {
    ENABLE_WPP: true,
    WPP_QR_ONLY: false,
    qrcode: {
      async toDataURL(value) {
        encoded.push(value);
        return `data:image/png;base64,${value}`;
      },
    },
    withAuth(req, _res, next) {
      req.user = { id: 7, role: 'super' };
      next();
    },
    isSuper: () => true,
    getState: () => ({ isConnected: true, isInitializingWpp: false, lastQr: 'stale-local' }),
    repository: {
      getClusterStatus: async () => ({ state: 'awaiting_scan', qr_code: 'owner-qr' }),
    },
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/whatsapp/qr`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data:image\/png;base64,owner-qr/);
  });
  assert.deepEqual(encoded, ['owner-qr']);
});

test('createApp uses WPP singleton injections for status and reset', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'pedivoy-create-app-'));
  const resetInputs = [];
  let statusCalls = 0;
  let snapshotCalls = 0;
  const repository = {
    async getClusterStatus() {
      statusCalls += 1;
      return {
        owner_id: 'owner-app-test',
        epoch: 3n,
        state: 'ready',
        reset_requested_seq: 8n,
      };
    },
    async requestReset(input) {
      resetInputs.push(input);
      return { accepted: true, sequence: 9n };
    },
  };
  const supervisor = {
    snapshot() {
      snapshotCalls += 1;
      return { isOwner: true, state: 'ready', generation: 4, ready: true, gateOpen: true };
    },
  };
  class FakeLocalAuth {}
  class FakeClient {
    on() {}
    async initialize() {}
    async destroy() {}
  }
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setTimeout = () => ({ unref() {} });
  globalThis.setInterval = () => ({ unref() {} });

  try {
    const app = createApp({
      projectDir,
      query: async () => [],
      pool: {
        query: async () => ({ rows: [] }),
        connect: async () => ({
          query: async () => ({ rows: [] }),
          release() {},
        }),
      },
      withTransaction: async callback => callback({ query: async () => ({ rows: [] }) }),
      withAuth(req, _res, next) {
        req.user = { uid: 41, role: 'super' };
        next();
      },
      isSuper: req => req.user?.role === 'super',
      getEmpresaIdFromToken: () => null,
      resolveEmpresaId: () => null,
      getEmpresaById: async () => null,
      crearPreferenciaLicencia: async () => ({}),
      obtenerPago: async () => ({}),
      checkLicencia: (_req, _res, next) => next(),
      ENABLE_WPP: true,
      WPP_QR_ONLY: true,
      wpp: {
        Client: FakeClient,
        LocalAuth: FakeLocalAuth,
        qrcode: { toDataURL: async value => value },
        handlers: { start: async () => {} },
        enqueueWppMessage: async () => {},
        checkLicencia: (_req, _res, next) => next(),
        generalControlRepository: repository,
        generalSupervisor: supervisor,
      },
    });

    await withServer(app, async baseUrl => {
      const statusResponse = await fetch(`${baseUrl}/api/whatsapp/status`);
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      assert.equal(status.cluster.owner_id, 'owner-app-test');
      assert.equal(status.local.role, 'owner');

      const resetResponse = await fetch(`${baseUrl}/api/whatsapp/reset`, { method: 'POST' });
      assert.equal(resetResponse.status, 202);
      assert.equal((await resetResponse.json()).request_id, 'wpp-reset-9');
    });

    assert.equal(statusCalls, 1);
    assert.equal(snapshotCalls, 1);
    assert.deepEqual(resetInputs, [{ requestedBy: '41', cooldownMs: 15000 }]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('whatsappWeb resolves the persisted repository and supervisor used by routes', async () => {
  const repository = { getClusterStatus: async () => ({ state: 'ready' }) };
  const supervisor = { snapshot: () => ({ isOwner: true }) };
  const query = async () => [];

  const injected = resolveGeneralRouteDeps({
    query,
    generalControlRepository: repository,
    generalSupervisor: supervisor,
  });
  assert.equal(injected.repository, repository);
  assert.equal(injected.supervisor, supervisor);

  const defaults = resolveGeneralRouteDeps({ query });
  assert.equal(typeof defaults.repository.getClusterStatus, 'function');
  assert.equal(typeof defaults.repository.requestReset, 'function');
  assert.equal(defaults.supervisor, null);
});

test('atomic global cooldown accepts only one of two concurrent reset requests', async () => {
  let accepted = false;
  const queries = [];
  const repository = createGeneralControlRepository(async (sql, params) => {
    queries.push({ sql, params });
    await Promise.resolve();
    if (/SELECT \* FROM wpp_general_control/i.test(sql)) {
      return { rows: [{ id: true, reset_requested_seq: '21' }], rowCount: 1 };
    }
    if (accepted) return { rows: [], rowCount: 0 };
    accepted = true;
    return { rows: [{ reset_requested_seq: '21' }], rowCount: 1 };
  });

  const results = await Promise.all([
    repository.requestReset({ requestedBy: 'first', cooldownMs: 15000 }),
    repository.requestReset({ requestedBy: 'second', cooldownMs: 15000 }),
  ]);

  assert.deepEqual(results, [
    { accepted: true, sequence: 21n },
    { accepted: false, sequence: 21n },
  ]);
  const updates = queries.filter(({ sql }) => /UPDATE wpp_general_control/i.test(sql));
  assert.equal(updates.length, 2);
  for (const { sql, params } of updates) {
    assert.match(sql, /reset_requested_at\s+IS\s+NULL/i);
    assert.match(sql, /reset_requested_at\s*<=\s*NOW\(\)\s*-\s*\(\$2::bigint\s*\*\s*INTERVAL\s*'1 millisecond'\)/i);
    assert.equal(params[1], '15000');
  }
  assert.equal(queries.filter(({ sql }) => /SELECT \* FROM wpp_general_control/i.test(sql)).length, 1);
});

test('reset repository distinguishes a missing control row from cooldown', async () => {
  const queries = [];
  const repository = createGeneralControlRepository(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    repository.requestReset({ requestedBy: 'admin', cooldownMs: 15000 }),
    /General control row is missing/,
  );
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /UPDATE wpp_general_control/i);
  assert.match(queries[1].sql, /SELECT \* FROM wpp_general_control/i);
});
