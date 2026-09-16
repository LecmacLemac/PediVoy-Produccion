import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { createGeneralControlRepository } from '../src/wpp/generalControlRepository.js';
import { createGeneralOwnership, OwnershipLostError } from '../src/wpp/generalOwnership.js';
import { createGeneralSupervisor } from '../src/wpp/generalSupervisor.js';
import {
  POSTGRES_INTEGRATION_SKIP_REASON,
  resolvePostgresIntegrationGate,
} from './support/wpp-postgres-integration-gate.js';

const initSql = readFileSync(new URL('../initDb.sql', import.meta.url), 'utf8');
const migrationMarker = '-- WhatsApp General: singleton ownership, status and reset coordination.';
const migrationStart = initSql.indexOf(migrationMarker);
assert.ok(migrationStart >= 0, 'initDb.sql must expose the exact General singleton migration');
const migrationSql = initSql.slice(migrationStart);

const state = {
  containerName: `pedivoy-general-${randomUUID()}`,
  password: randomUUID(),
  started: false,
  admin: null,
  setupPools: new Set(),
  config: null,
  postgresVersion: null,
  sends: 0,
};

function dockerEnvironment(host) {
  const env = { ...process.env, DOCKER_HOST: host };
  delete env.DOCKER_CONTEXT;
  return env;
}

const integrationGate = resolvePostgresIntegrationGate();
const localDockerHost = integrationGate.host;
function runDocker(args, options = {}) {
  return execFileSync('docker', args, {
    ...options,
    env: dockerEnvironment(localDockerHost),
  });
}

const integrationOptions = {
  skip: integrationGate.skip,
  timeout: 120_000,
};

test('required PostgreSQL integration mode exits nonzero when its local Docker prerequisite is unavailable', () => {
  const helperUrl = new URL('./support/wpp-postgres-integration-gate.js', import.meta.url).href;
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { resolvePostgresIntegrationGate } from ${JSON.stringify(helperUrl)}; resolvePostgresIntegrationGate();`,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REQUIRE_WPP_PG_INTEGRATION: '1',
      DOCKER_HOST: 'tcp://required-mode-must-reject.invalid:2375',
    },
  });

  assert.notEqual(probe.status, 0, probe.stdout);
  assert.match(probe.stderr, /REQUIRE_WPP_PG_INTEGRATION=1/);
  assert.match(probe.stderr, new RegExp(POSTGRES_INTEGRATION_SKIP_REASON.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

async function waitForPostgres(config, deadlineAt) {
  let lastError;
  while (Date.now() < deadlineAt) {
    const pool = new pg.Pool(config);
    state.setupPools.add(pool);
    try {
      await pool.query('SELECT 1');
      state.setupPools.delete(pool);
      return pool;
    } catch (error) {
      lastError = error;
      let ended = false;
      try {
        await withDeadline(pool.end(), 2_000, 'PostgreSQL readiness pool cleanup');
        ended = true;
      } catch {}
      if (ended) state.setupPools.delete(pool);
      if (Date.now() < deadlineAt) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error('PostgreSQL readiness deadline exceeded');
}

function makePool(applicationName, max = 4) {
  const pool = new pg.Pool({ ...state.config, application_name: applicationName, max });
  pool.on('error', () => {
    // Cleanup may terminate a checked-out backend after a failed assertion.
  });
  return pool;
}

function repositoryFor(pool) {
  return createGeneralControlRepository((sql, params) => pool.query(sql, params));
}

async function waitUntil(predicate, label, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function withDeadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function assertSettledOutcomes(results, label, { requireTrue = false } = {}) {
  for (const [index, result] of results.entries()) {
    assert.equal(
      result.status,
      'fulfilled',
      `${label} ${index} rejected: ${result.status === 'rejected' ? result.reason?.stack ?? result.reason : ''}`,
    );
    if (requireTrue) assert.equal(result.value, true, `${label} ${index} was not confirmed`);
  }
}

function makeClientFactory(events, label, destroyControl = null) {
  let count = 0;
  return {
    create({ generation, eventSink }) {
      count += 1;
      const client = new EventEmitter();
      client.sendMessage = async () => { state.sends += 1; };
      return {
        client,
        generation,
        async initialize() {
          events.push(`${label}:initialize:${generation}`);
          eventSink({ event: 'ready', generation, args: [] });
          await new Promise(resolve => setImmediate(resolve));
        },
        async destroy() {
          events.push(`${label}:destroy:${generation}`);
          destroyControl?.started.resolve();
          if (destroyControl) await destroyControl.release.promise;
        },
        async confirmStopped() { events.push(`${label}:stopped:${generation}`); return true; },
        async forceStop() { events.push(`${label}:force-stop:${generation}`); return true; },
      };
    },
    get count() { return count; },
  };
}

async function createOwnedSupervisor({
  pool, ownerId, repository, events, fatalErrors, destroyControl = null,
  beforeInitialize = async () => true,
}) {
  let supervisor;
  let lossCleanup = null;
  const ownership = createGeneralOwnership({
    pool,
    ownerId,
    onOwnershipLost: error => {
      lossCleanup = supervisor?.leaseLost(error, { immediate: true }) ?? Promise.resolve(false);
      return lossCleanup;
    },
  });
  const releaseAfterQuiesced = ownership.releaseAfterQuiesced.bind(ownership);
  ownership.releaseAfterQuiesced = async confirmQuiesced => {
    const released = await releaseAfterQuiesced(confirmQuiesced);
    if (released === true) events.push(`${ownerId}:released`);
    return released;
  };
  const clientFactory = makeClientFactory(events, ownerId, destroyControl);
  supervisor = createGeneralSupervisor({
    ownership,
    repository,
    clientFactory,
    fatalExit: error => { fatalErrors.push(error); },
    beforeInitialize,
    destroyDeadlineMs: 2_000,
    shutdownDeadlineMs: 4_000,
  });
  return {
    ownership,
    supervisor,
    clientFactory,
    get lossCleanup() { return lossCleanup; },
  };
}

before(async () => {
  if (!localDockerHost) return;
  const setupDeadlineAt = Date.now() + 45_000;
  const boundedSetupTimeout = maximum => {
    const remaining = setupDeadlineAt - Date.now();
    if (remaining <= 0) throw new Error('Disposable PostgreSQL setup deadline exceeded');
    return Math.max(1, Math.min(maximum, remaining));
  };
  state.started = true;
  runDocker([
    'run', '--detach', '--rm', '--pull=never', '--name', state.containerName,
    '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_USER=singleton_test',
    '--env', `POSTGRES_PASSWORD=${state.password}`,
    '--env', 'POSTGRES_DB=singleton_test',
    'postgres:16',
  ], { stdio: 'ignore', timeout: boundedSetupTimeout(20_000) });
  const portOutput = runDocker(
    ['port', state.containerName, '5432/tcp'], { encoding: 'utf8', timeout: boundedSetupTimeout(5_000) },
  ).trim();
  const port = Number(portOutput.slice(portOutput.lastIndexOf(':') + 1));
  state.config = {
    host: '127.0.0.1',
    port,
    user: 'singleton_test',
    password: state.password,
    database: 'singleton_test',
    connectionTimeoutMillis: 1_000,
    query_timeout: 3_000,
    ssl: false,
    options: '-c statement_timeout=3000',
  };
  state.admin = await waitForPostgres({ ...state.config, max: 4 }, setupDeadlineAt);
  const version = await state.admin.query('SHOW server_version');
  state.postgresVersion = version.rows[0].server_version;
  assert.match(state.postgresVersion, /^16\./);
}, { timeout: 60_000 });

after(async () => {
  let failure = null;
  try {
    assert.equal(state.sends, 0, 'verification must never send a WhatsApp message');
  } catch (error) {
    failure = error;
  }
  try {
    for (const pool of state.setupPools) {
      await withDeadline(pool.end(), 5_000, 'readiness pool teardown');
    }
    state.setupPools.clear();
    if (state.admin) await withDeadline(state.admin.end(), 5_000, 'admin pool cleanup');
  } catch (error) {
    failure ??= error;
  }
  try {
    if (state.started) {
      runDocker(['rm', '--force', state.containerName], { stdio: 'ignore', timeout: 10_000 });
      const remaining = runDocker([
        'ps', '--all', '--quiet', '--filter', `name=^/${state.containerName}$`,
      ], { encoding: 'utf8', timeout: 10_000 }).trim();
      assert.equal(remaining, '', 'disposable PostgreSQL container must be absent after cleanup');
    }
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
});

test('exact initDb General migration applies twice to fresh and representative legacy schemas under rollback', integrationOptions, async () => {
  for (const legacy of [false, true]) {
    const client = await state.admin.connect();
    const schema = `singleton_${legacy ? 'legacy' : 'fresh'}_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      if (legacy) {
        await client.query(`
          CREATE TABLE wpp_general_control (
            id BOOLEAN PRIMARY KEY,
            epoch BIGINT,
            owner_id TEXT
          );
          INSERT INTO wpp_general_control (id, epoch, owner_id)
          VALUES (TRUE, NULL, 'legacy-owner');
        `);
      }

      await client.query(migrationSql);
      await client.query(migrationSql);

      const columns = await client.query(`
        SELECT column_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'wpp_general_control'
      `, [schema]);
      const byName = new Map(columns.rows.map(row => [row.column_name, row]));
      for (const required of [
        'id', 'epoch', 'owner_id', 'state', 'heartbeat_at', 'operation', 'qr_code', 'last_error',
        'reset_requested_seq', 'reset_started_seq', 'reset_applied_seq', 'reset_failed_seq',
        'reset_requested_at', 'reset_started_at', 'reset_applied_at', 'reset_failed_at',
        'reset_failure_error', 'reset_requested_by', 'updated_at',
      ]) assert.ok(byName.has(required), `missing ${required} in ${legacy ? 'legacy' : 'fresh'} schema`);
      for (const requiredNotNull of [
        'id', 'epoch', 'state', 'reset_requested_seq', 'reset_started_seq',
        'reset_applied_seq', 'reset_failed_seq', 'updated_at',
      ]) assert.equal(byName.get(requiredNotNull).is_nullable, 'NO');
      const expectedDefaults = new Map([
        ['id', 'true'],
        ['epoch', '0'],
        ['state', "'standby'::text"],
        ['reset_requested_seq', '0'],
        ['reset_started_seq', '0'],
        ['reset_applied_seq', '0'],
        ['reset_failed_seq', '0'],
        ['updated_at', 'now()'],
      ]);
      for (const [column, expectedDefault] of expectedDefaults) {
        assert.equal(
          byName.get(column).column_default,
          expectedDefault,
          `${column} default was not repaired in ${legacy ? 'legacy' : 'fresh'} schema`,
        );
      }

      const resetOrder = await client.query(`
        SELECT convalidated, pg_get_expr(conbin, conrelid) AS definition
          FROM pg_constraint
         WHERE conrelid = 'wpp_general_control'::regclass
           AND conname = 'wpp_general_reset_sequence_order'
           AND contype = 'c'
      `);
      assert.equal(resetOrder.rowCount, 1);
      assert.equal(resetOrder.rows[0].convalidated, true);
      assert.equal(
        resetOrder.rows[0].definition.replace(/[()\s]/g, ''),
        'reset_applied_seq<=reset_started_seqANDreset_failed_seq<=reset_started_seqANDreset_started_seq<=reset_requested_seq',
      );

      const row = await client.query('SELECT * FROM wpp_general_control');
      assert.equal(row.rowCount, 1);
      assert.equal(row.rows[0].id, true);
      assert.equal(row.rows[0].epoch, legacy ? '0' : '0');
      assert.equal(row.rows[0].state, 'standby');
      if (legacy) assert.equal(row.rows[0].owner_id, 'legacy-owner');
      await assert.rejects(
        client.query("INSERT INTO wpp_general_control (id) VALUES (FALSE)"),
        error => error?.code === '23514',
      );
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const schemaExists = await state.admin.query('SELECT to_regnamespace($1) AS schema', [schema]);
    assert.equal(schemaExists.rows[0].schema, null);
  }
});

test('two real dedicated sessions elect one owner and rolling shutdown quiesces before successor initialize', integrationOptions, async t => {
  await state.admin.query(migrationSql);
  const repository = repositoryFor(state.admin);
  const events = [];
  const fatalErrors = [];
  const oldPool = makePool('singleton-old', 1);
  const nextPool = makePool('singleton-next', 1);
  const oldDestroy = { started: deferred(), release: deferred() };
  const nextDestroy = { started: deferred(), release: deferred() };
  const oldRuntime = await createOwnedSupervisor({
    pool: oldPool, ownerId: 'old-owner', repository, events, fatalErrors, destroyControl: oldDestroy,
  });
  const nextRuntime = await createOwnedSupervisor({
    pool: nextPool, ownerId: 'next-owner', repository, events, fatalErrors, destroyControl: nextDestroy,
  });
  t.after(async () => {
    oldDestroy.release.resolve();
    nextDestroy.release.resolve();
    const shutdowns = await Promise.allSettled([
      withDeadline(oldRuntime.supervisor.shutdown(), 5_000, 'old runtime cleanup'),
      withDeadline(nextRuntime.supervisor.shutdown(), 5_000, 'next runtime cleanup'),
    ]);
    assertSettledOutcomes(shutdowns, 'rolling runtime cleanup', { requireTrue: true });
    const pools = await withDeadline(
      Promise.allSettled([oldPool.end(), nextPool.end()]),
      5_000,
      'rolling pool cleanup',
    );
    assertSettledOutcomes(pools, 'rolling pool cleanup');
  });

  const election = await Promise.all([oldRuntime.supervisor.start(), nextRuntime.supervisor.start()]);
  assert.equal(election.filter(Boolean).length, 1);
  const owner = election[0] ? oldRuntime : nextRuntime;
  const follower = election[0] ? nextRuntime : oldRuntime;
  const ownerLabel = election[0] ? 'old-owner' : 'next-owner';
  const followerLabel = election[0] ? 'next-owner' : 'old-owner';
  const ownerDestroy = election[0] ? oldDestroy : nextDestroy;
  assert.equal(owner.clientFactory.count, 1);
  assert.equal(follower.clientFactory.count, 0);
  await waitUntil(() => owner.supervisor.snapshot().gateOpen, 'elected owner ready gate');

  const activeWorkRelease = deferred();
  const activeWork = owner.supervisor.withActiveClient(async () => {
    events.push(`${ownerLabel}:active-work-started`);
    await activeWorkRelease.promise;
    events.push(`${ownerLabel}:active-work-finished`);
    return true;
  });
  await waitUntil(
    () => events.includes(`${ownerLabel}:active-work-started`),
    'admitted owner operation',
  );

  events.push(`${ownerLabel}:shutdown-requested`);
  const shutdown = owner.supervisor.shutdown();
  assert.equal(owner.supervisor.snapshot().gateOpen, false);
  events.push(`${ownerLabel}:gate-closed`);
  assert.equal(await follower.supervisor.start(), false, 'successor cannot acquire before stop confirmation and unlock');
  assert.equal(follower.clientFactory.count, 0);
  assert.equal(events.includes(`${ownerLabel}:destroy:1`), false);
  assert.equal(events.includes(`${ownerLabel}:stopped:1`), false);

  activeWorkRelease.resolve();
  assert.equal(await activeWork, true);
  await withDeadline(ownerDestroy.started.promise, 2_000, 'old owner destroy start');
  ownerDestroy.release.resolve();
  assert.equal(await shutdown, true);
  assert.equal(await follower.supervisor.start(), true);
  assert.equal(follower.clientFactory.count, 1);

  const gateClosedIndex = events.indexOf(`${ownerLabel}:gate-closed`);
  const workFinishedIndex = events.indexOf(`${ownerLabel}:active-work-finished`);
  const destroyIndex = events.indexOf(`${ownerLabel}:destroy:1`);
  const stoppedIndex = events.indexOf(`${ownerLabel}:stopped:1`);
  const releasedIndex = events.indexOf(`${ownerLabel}:released`);
  const successorIndex = events.indexOf(`${followerLabel}:initialize:1`);
  assert.ok(
    gateClosedIndex >= 0
      && workFinishedIndex > gateClosedIndex
      && destroyIndex > workFinishedIndex
      && stoppedIndex > destroyIndex
      && releasedIndex > stoppedIndex
      && successorIndex > releasedIndex,
    events.join(', '),
  );
  const row = await repository.getClusterStatus();
  assert.equal(row.owner_id, followerLabel);
  assert.equal(row.epoch, 2n);
  assert.equal(fatalErrors.length, 0);
  (election[0] ? nextDestroy : oldDestroy).release.resolve();
  assert.equal(await follower.supervisor.shutdown(), true);
});

test('global reset cooldown/concurrency persists one request and its owner applies it exactly once', integrationOptions, async t => {
  await state.admin.query(migrationSql);
  await state.admin.query("UPDATE wpp_general_control SET owner_id = NULL, state = 'standby', heartbeat_at = NULL, operation = NULL, reset_requested_seq = 0, reset_started_seq = 0, reset_applied_seq = 0, reset_failed_seq = 0, reset_requested_at = NULL, reset_failure_error = NULL WHERE id = TRUE");
  const repository = repositoryFor(state.admin);
  const outcomes = await Promise.all([
    repository.requestReset({ requestedBy: 'admin-a', cooldownMs: 60_000 }),
    repository.requestReset({ requestedBy: 'admin-b', cooldownMs: 60_000 }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.accepted).length, 1);
  assert.equal(outcomes.filter(outcome => !outcome.accepted).length, 1);
  assert.deepEqual(outcomes.map(outcome => outcome.sequence), [1n, 1n]);
  assert.equal((await repository.requestReset({ requestedBy: 'admin-c', cooldownMs: 60_000 })).accepted, false);

  const pool = makePool('singleton-reset-owner', 1);
  const events = [];
  const fatalErrors = [];
  const runtime = await createOwnedSupervisor({ pool, ownerId: 'reset-owner', repository, events, fatalErrors });
  let resetExecutions = 0;
  t.after(async () => {
    if (runtime.ownership.isOwner) {
      await withDeadline(runtime.supervisor.shutdown(), 5_000, 'reset runtime cleanup').catch(() => {});
    }
    await withDeadline(pool.end(), 5_000, 'reset pool cleanup');
  });

  assert.equal(await runtime.supervisor.start(), true);
  const pending = await repository.loadPendingReset();
  assert.equal(pending.reset_requested_seq, 1n);
  await runtime.supervisor.reset(pending.reset_requested_seq, async () => {
    assert.ok(events.includes('reset-owner:stopped:1'), 'session deletion requires confirmed client stop');
    events.push('reset-owner:delete-session:1');
    resetExecutions += 1;
  });
  assert.equal(resetExecutions, 1);
  const duplicatePending = await repository.loadPendingReset();
  if (duplicatePending) {
    await runtime.supervisor.reset(duplicatePending.reset_requested_seq, async () => { resetExecutions += 1; });
  }
  assert.equal(resetExecutions, 1);
  assert.equal(duplicatePending, null);
  const row = await repository.getClusterStatus();
  assert.equal(row.reset_started_seq, 1n);
  assert.equal(row.reset_applied_seq, 1n);
  assert.equal(row.reset_failed_seq, 0n);
  assert.equal(fatalErrors.length, 0);
  assert.equal(await runtime.supervisor.shutdown(), true);
});

test('backend death releases only the advisory lock while a native-profile guard blocks successor initialization', integrationOptions, async t => {
  await state.admin.query(migrationSql);
  await state.admin.query("UPDATE wpp_general_control SET owner_id = NULL, state = 'standby', heartbeat_at = NULL, operation = NULL WHERE id = TRUE");
  const repository = repositoryFor(state.admin);
  const ownerPool = makePool('singleton-loss-owner', 1);
  const takeoverPool = makePool('singleton-loss-takeover', 1);
  const events = [];
  const fatalErrors = [];
  const lossDestroy = { started: deferred(), release: deferred() };
  const nativeProfileGuard = deferred();
  const owner = await createOwnedSupervisor({
    pool: ownerPool,
    ownerId: 'loss-owner',
    repository,
    events,
    fatalErrors,
    destroyControl: lossDestroy,
  });
  const takeover = await createOwnedSupervisor({
    pool: takeoverPool,
    ownerId: 'takeover-owner',
    repository,
    events,
    fatalErrors,
    beforeInitialize: async () => {
      events.push('takeover-owner:native-profile-guard');
      await nativeProfileGuard.promise;
      return true;
    },
  });
  t.after(async () => {
    lossDestroy.release.resolve();
    nativeProfileGuard.resolve();
    if (owner.lossCleanup) {
      await withDeadline(owner.lossCleanup, 5_000, 'loss-test pending cleanup').catch(() => {});
    }
    if (owner.ownership.isOwner) {
      await withDeadline(owner.supervisor.shutdown(), 5_000, 'loss-test owner shutdown').catch(() => {});
    }
    if (takeover.ownership.isOwner) {
      await withDeadline(takeover.supervisor.shutdown(), 5_000, 'loss-test takeover shutdown').catch(() => {});
    }
    await state.admin.query(`
      SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
       WHERE application_name IN ('singleton-loss-owner', 'singleton-loss-takeover')
         AND state <> 'idle'
         AND pid <> pg_backend_pid()
    `).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    await withDeadline(Promise.allSettled([ownerPool.end(), takeoverPool.end()]), 5_000, 'loss-test pool cleanup');
  });

  assert.equal(await owner.supervisor.start(), true);
  const staleEpoch = owner.ownership.epoch;
  await waitUntil(() => owner.supervisor.snapshot().gateOpen, 'owner ready gate');
  assert.equal(
    await takeover.supervisor.start(),
    false,
    'takeover is rejected while the original PostgreSQL backend still owns the advisory lock',
  );
  assert.equal(takeover.clientFactory.count, 0);

  const backend = await state.admin.query(`
    SELECT pid FROM pg_stat_activity
     WHERE application_name = 'singleton-loss-owner' AND backend_type = 'client backend'
  `);
  assert.equal(backend.rowCount, 1);
  const ownerBackendPid = backend.rows[0].pid;
  assert.equal((await state.admin.query('SELECT pg_terminate_backend($1) AS terminated', [ownerBackendPid])).rows[0].terminated, true);
  await waitUntil(async () => {
    const result = await state.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [ownerBackendPid]);
    return result.rowCount === 0;
  }, 'server-side owner backend termination');

  const successorStart = takeover.supervisor.start();
  await waitUntil(() => takeover.ownership.isOwner, 'advisory-lock takeover after backend disappearance');
  assert.equal(takeover.ownership.epoch, staleEpoch + 1n);
  await waitUntil(
    () => events.includes('takeover-owner:native-profile-guard'),
    'successor native-profile guard',
  );
  assert.equal(takeover.clientFactory.count, 0, 'native-profile guard blocks Chromium initialization');

  await waitUntil(() => owner.lossCleanup !== null, 'ownership-loss cleanup start');
  await withDeadline(lossDestroy.started.promise, 2_000, 'lease-loss destroy start');
  assert.equal(owner.supervisor.snapshot().gateOpen, false, 'gate closes before teardown and fatal completion');
  assert.equal(owner.supervisor.snapshot().ready, false);
  await assert.rejects(owner.supervisor.withActiveClient(async () => true), error => error?.code === 'WPP_NOT_OWNER');
  assert.equal(fatalErrors.length, 0, 'fatal waits for bounded teardown');
  lossDestroy.release.resolve();
  assert.equal(await withDeadline(owner.lossCleanup, 5_000, 'ownership-loss cleanup'), false);
  await waitUntil(() => fatalErrors.length === 1 && owner.supervisor.snapshot().gateOpen === false, 'fatal closed gate');
  assert.equal(owner.supervisor.snapshot().state, 'fenced');
  assert.throws(() => owner.ownership.assertOwned(), OwnershipLostError);
  assert.equal(takeover.clientFactory.count, 0, 'successor still cannot initialize before native cleanup confirmation');

  nativeProfileGuard.resolve();
  assert.equal(await successorStart, true);
  assert.equal(takeover.clientFactory.count, 1);
  assert.ok(
    events.indexOf('takeover-owner:initialize:1') > events.indexOf('loss-owner:destroy:1'),
    events.join(', '),
  );
  assert.equal(await repository.updateOwned({
    ownerId: 'loss-owner', epoch: takeover.ownership.epoch, state: 'ready', operation: null,
  }), false, 'wrong owner is rejected even with current epoch');
  assert.equal(await repository.updateOwned({
    ownerId: 'takeover-owner', epoch: staleEpoch, state: 'ready', operation: null,
  }), false, 'stale epoch is rejected even with current owner');
  assert.equal(await repository.heartbeat({ ownerId: 'loss-owner', epoch: takeover.ownership.epoch }), false);
  assert.equal(await repository.heartbeat({ ownerId: 'takeover-owner', epoch: staleEpoch }), false);
  assert.equal(fatalErrors.length, 1);
  assert.equal(await takeover.supervisor.shutdown(), true);
});
