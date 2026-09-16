import os from 'node:os';
import nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createGeneralControlRepository } from './generalControlRepository.js';
import { createGeneralOwnership } from './generalOwnership.js';
import { createGeneralSupervisor } from './generalSupervisor.js';
import { createGeneralClientFactory } from './generalClientFactory.js';
import { createWppClientAdapter } from './clientAdapter.js';
import { WPP_SESSION_ID, getWppSessionBasePath, getWppSessionDir } from './sessionUtils.js';

const PUPPETEER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-features=VizDisplayCompositor',
  '--window-size=1920,1080', '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process', '--disable-software-rasterizer',
  '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list',
];

function parseResetCounter(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError('General reset counter is malformed');
}

export function createProcessOwnerId({ hostname = os.hostname(), pid = process.pid, uuid = randomUUID() } = {}) {
  return `${hostname}:${pid}:${uuid}`;
}

export function createGeneralRuntime({
  enabled = false,
  qrOnly = false,
  Client,
  LocalAuth,
  path,
  fs = nodeFs,
  query,
  pool,
  repository: injectedRepository,
  ownership: injectedOwnership,
  supervisor: injectedSupervisor,
  ownerId = createProcessOwnerId(),
  fatalExit = error => {
    console.error('[WPP GENERAL] fatal ownership/lifecycle failure:', error);
  },
  logger = console,
  handlers,
  handleIncomingMediaMessage,
  timers = { setTimeout, clearTimeout },
  random = Math.random,
  env = process.env,
  cwd = process.cwd(),
  heartbeatMs = 5000,
  followerMinMs = 2000,
  followerMaxMs = 5000,
  deleteDeadlineMs = 30000,
  authenticatedFallbackDelayMs = 8000,
  authenticatedFallbackMaxAttempts = 10,
  uuid = randomUUID,
  adapterOptions = {},
  ownershipFactory = createGeneralOwnership,
} = {}) {
  const repository = injectedRepository ?? createGeneralControlRepository(query);
  let fatalTriggered = false;
  function callFatal(error) {
    if (fatalTriggered) return;
    fatalTriggered = true;
    try {
      Promise.resolve(fatalExit(error)).catch(() => {});
    } catch {}
  }
  if (!enabled) {
    return {
      enabled: false,
      repository,
      supervisor: injectedSupervisor ?? null,
      tick: async () => false,
      start: () => Promise.resolve(false),
      stopTimers() {},
      snapshot: () => ({ enabled: false, timerActive: false, running: false }),
      getState: () => ({ isConnected: false, isReadyWpp: false, isShuttingDownWpp: false, wppClient: null }),
    };
  }
  if (!injectedSupervisor && (!Client || !LocalAuth || !path)) {
    throw new TypeError('Client, LocalAuth and path are required when WhatsApp General is enabled');
  }

  let supervisor = injectedSupervisor;
  let ownership = injectedOwnership;
  let assignedSupervisor = null;
  if (!supervisor) {
    if (!ownership) {
      ownership = ownershipFactory({
        pool,
        ownerId,
        onOwnershipLost: error => {
          if (assignedSupervisor?.leaseLost) return assignedSupervisor.leaseLost(error);
          callFatal(error);
          return false;
        },
      });
    }

    let ownershipHeartbeat = null;
    const rawOwnership = ownership;
    ownership = new Proxy(rawOwnership, {
      get(target, property) {
        if (property === 'heartbeat') {
          return () => {
            if (!ownershipHeartbeat) {
              ownershipHeartbeat = Promise.resolve()
                .then(() => target.heartbeat())
                .finally(() => { ownershipHeartbeat = null; });
            }
            return ownershipHeartbeat;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const isRender = env.RENDER === 'true';
    const executablePath = env.PUPPETEER_EXECUTABLE_PATH || (isRender ? '/usr/bin/chromium' : null);
    const sessionBasePath = getWppSessionBasePath({ path, cwd });
    const clientFactory = createGeneralClientFactory({
      createClient: ({ generation }) => {
        const authStrategy = new LocalAuth({ clientId: WPP_SESSION_ID, dataPath: sessionBasePath });
        // LocalAuth.logout recursively removes its profile before the supervisor can
        // confirm Chromium is stopped. General reset is the sole deletion authority.
        authStrategy.logout = async () => {};
        const rawClient = new Client({
          authStrategy,
          puppeteer: {
            headless: 'new',
            args: PUPPETEER_ARGS,
            executablePath,
            ignoreHTTPSErrors: true,
            timeout: 60000,
          },
        });
        const adapter = createWppClientAdapter({ rawClient, ...adapterOptions });
        adapter.on('ready', async () => {
          cancelAuthenticatedFallback(generation);
          const page = adapter.pupPage;
          try {
            if (typeof page?.evaluate === 'function') {
              await page.evaluate(() => {
                try {
                  if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                    window.WWebJS.sendSeen = async () => {};
                  }
                } catch {}
              });
            }
            if (typeof page?.evaluateOnNewDocument === 'function') {
              await page.evaluateOnNewDocument(() => {
                try {
                  if (window.WWebJS && typeof window.WWebJS.sendSeen === 'function') {
                    window.WWebJS.sendSeen = async () => {};
                  }
                } catch {}
              });
            }
          } catch (error) {
            logger.warn('[WPP GENERAL] sendSeen patch failed:', error);
          }
        });
        adapter.on('authenticated', () => scheduleAuthenticatedFallback(adapter, generation));
        for (const event of ['disconnected', 'auth_failure', 'error']) {
          adapter.on(event, () => cancelAuthenticatedFallback(generation));
        }
        return adapter;
      },
    });
    supervisor = createGeneralSupervisor({
      ownership,
      clientFactory,
      repository,
      beforeInitialize: async () => !(await takeoverIsBlocked()),
      fatalExit: callFatal,
      onGenerationInvalidated: cancelAuthenticatedFallback,
    });
    assignedSupervisor = supervisor;
  }

  let timer = null;
  let stopped = false;
  let running = null;
  let heartbeatInFlight = null;
  let schemaReady = false;
  let activeClient = null;
  let activeGeneration = null;
  let outboxProcessor = null;
  let activeWork = null;
  let maintenanceWork = null;
  const authenticatedFallbackTimers = new Map();
  const authenticatedFallbackAttempts = new Map();
  const authenticatedFallbackRecoveries = new Set();

  const handlersStarted = new WeakSet();
  const mediaAttached = new WeakSet();

  function cancelAuthenticatedFallback(generation) {
    const pending = authenticatedFallbackTimers.get(generation);
    if (pending !== undefined) timers.clearTimeout(pending);
    authenticatedFallbackTimers.delete(generation);
    authenticatedFallbackAttempts.delete(generation);
  }

  async function inspectAuthenticatedRuntime(client) {
    const page = client?.pupPage;
    if (!page || typeof page.evaluate !== 'function') return { connected: false, runtimeReady: false };
    try {
      return await page.evaluate(() => {
        try {
          let appState = window.Store?.AppState?.state || null;
          if (!appState && typeof window.require === 'function') {
            appState = window.require('WAWebSocketModel')?.Socket?.state || null;
          }
          return {
            connected: appState === 'CONNECTED',
            runtimeReady: Boolean(
              typeof window.WWebJS?.getChat === 'function'
              && typeof window.WWebJS?.sendMessage === 'function'
              && typeof window.WWebJS?.getMessageModel === 'function'
            ),
          };
        } catch {
          return { connected: false, runtimeReady: false };
        }
      });
    } catch {
      return { connected: false, runtimeReady: false };
    }
  }

  async function repairAuthenticatedRuntime(client, generation) {
    let health = await supervisor.withCurrentClient(generation, ({ client: current }) => {
      if (current !== client) return { connected: false, runtimeReady: false, stale: true };
      return inspectAuthenticatedRuntime(client);
    });
    if (health?.stale || !health.connected || health.runtimeReady) return health;

    const injected = await supervisor.withCurrentClient(generation, async ({ client: current }) => {
      if (current !== client) return false;
      await client.inject?.();
      return true;
    });
    if (injected !== true) return { connected: false, runtimeReady: false, stale: true };

    const synced = await supervisor.withCurrentClient(generation, async ({ client: current }) => {
      if (current !== client) return false;
      await client.pupPage?.evaluate(async () => {
        try {
          if (typeof window.onAppStateHasSyncedEvent === 'function') {
            await window.onAppStateHasSyncedEvent();
          }
        } catch {}
      });
      return true;
    });
    if (synced !== true) return { connected: false, runtimeReady: false, stale: true };

    health = await supervisor.withCurrentClient(generation, ({ client: current }) => {
      if (current !== client) return { connected: false, runtimeReady: false, stale: true };
      return inspectAuthenticatedRuntime(client);
    });
    return health;
  }

  async function runAuthenticatedFallback(client, generation) {
    authenticatedFallbackTimers.delete(generation);
    if (stopped || qrOnly || typeof supervisor.withCurrentClient !== 'function') return false;
    try {
      const health = await repairAuthenticatedRuntime(client, generation);
      if (health?.stale) return false;
      if (health?.connected && health.runtimeReady) {
        if (stopped) return false;
        return await supervisor.withCurrentClient(generation, ({ client: current }) => {
          if (stopped || current !== client) return false;
          client.emit('ready');
          return true;
        });
      }
    } catch (error) {
      if (error?.code === 'WPP_NOT_OWNER') return false;
      logger.warn('[WPP GENERAL] authenticated fallback failed:', error);
    }
    scheduleAuthenticatedFallback(client, generation);
    return false;
  }

  function recoverAuthenticatedFallback(generation) {
    if (stopped || authenticatedFallbackRecoveries.has(generation)
      || typeof supervisor.restart !== 'function') return false;
    authenticatedFallbackRecoveries.add(generation);
    Promise.resolve(supervisor.restart('authenticated_fallback_exhausted', { expectedGeneration: generation }))
      .catch(error => {
        if (error?.code !== 'WPP_NOT_OWNER') {
          logger.error('[WPP GENERAL] authenticated fallback recovery failed:', error);
        }
      })
      .finally(() => authenticatedFallbackRecoveries.delete(generation));
    return true;
  }

  function scheduleAuthenticatedFallback(client, generation) {
    if (stopped || qrOnly || authenticatedFallbackTimers.has(generation)) return false;
    const snapshot = supervisor.snapshot();
    if (!snapshot.isOwner || snapshot.generation !== generation || snapshot.ready) return false;
    const attempts = authenticatedFallbackAttempts.get(generation) ?? 0;
    if (attempts >= authenticatedFallbackMaxAttempts) {
      return recoverAuthenticatedFallback(generation);
    }
    authenticatedFallbackAttempts.set(generation, attempts + 1);
    const timerId = timers.setTimeout(
      () => runAuthenticatedFallback(client, generation),
      authenticatedFallbackDelayMs,
    );
    authenticatedFallbackTimers.set(generation, timerId);
    return true;
  }

  async function boundedDeleteSession(sequence) {
    for (const method of ['writeFile', 'rename', 'unlink', 'rm']) {
      if (typeof fs?.promises?.[method] !== 'function') {
        throw new TypeError(`fs.promises.${method} is required for General session reset`);
      }
    }
    const canonical = getWppSessionDir({ path, cwd, sessionId: WPP_SESSION_ID });
    const marker = `${canonical}.reset-in-progress`;
    const quarantine = `${canonical}.reset-${uuid()}`;
    let deadlineTimer;
    let deadlineElapsed = false;
    const timeout = new Promise((_, reject) => {
      deadlineTimer = timers.setTimeout(() => {
        deadlineElapsed = true;
        const error = new Error('General session deletion deadline exceeded');
        error.timedOut = true;
        reject(error);
      }, deleteDeadlineMs);
    });
    const deletion = Promise.resolve().then(async () => {
      const resetSequence = BigInt(sequence);
      const markerContents = JSON.stringify({ version: 1, resetSequence: resetSequence.toString() });
      await fs.promises.writeFile(marker, markerContents, { flag: 'wx', mode: 0o600 });
      // A marker that lands after the deadline cannot authorize this old
      // operation to rename a canonical directory a successor may now use.
      if (deadlineElapsed) return false;
      let detached = true;
      try {
        await fs.promises.rename(canonical, quarantine);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        detached = false;
      }
      await fs.promises.unlink(marker);
      if (detached) await fs.promises.rm(quarantine, { recursive: true, force: true });
      return true;
    });
    deletion.catch(() => {});
    return Promise.race([deletion, timeout]).finally(() => timers.clearTimeout(deadlineTimer));
  }

  async function applyPendingReset(snapshot) {
    if (typeof repository.loadPendingReset !== 'function' || typeof supervisor.reset !== 'function') return false;
    const pending = await repository.loadPendingReset({ ownerId: snapshot.ownerId, epoch: snapshot.epoch });
    if (!pending) return false;
    const sequence = BigInt(pending.reset_requested_seq);
    const applied = BigInt(pending.reset_applied_seq ?? 0);
    if (sequence <= applied) return false;
    await supervisor.reset(sequence, () => boundedDeleteSession(sequence));
    return true;
  }

  async function takeoverIsBlocked() {
    if (typeof fs?.promises?.access !== 'function'
      || typeof repository.getClusterStatus !== 'function') return true;
    const canonical = getWppSessionDir({ path, cwd, sessionId: WPP_SESSION_ID });
    const marker = `${canonical}.reset-in-progress`;
    try {
      const status = await repository.getClusterStatus();
      if (!status) return true;
      const started = parseResetCounter(status.reset_started_seq);
      const applied = parseResetCounter(status.reset_applied_seq);
      const failed = parseResetCounter(status.reset_failed_seq);
      if (started < 0n || applied < 0n || failed < 0n
        || applied > started || failed > started) return true;
      if (started > applied && failed < started) return true;
    } catch {
      return true;
    }
    try {
      await fs.promises.access(marker);
      return true;
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  }

  async function prepareActiveGeneration() {
    if (qrOnly) return false;
    try {
      const prepared = await supervisor.withActiveClient(async ({ client, generation }) => {
        if (!handlersStarted.has(client)) {
          handlersStarted.add(client);
          try {
            await handlers?.start?.(client, {
              generation,
              withActiveClient: supervisor.withActiveClient,
            });
          } catch (error) {
            handlersStarted.delete(client);
            throw error;
          }
        }
        return { client, generation };
      });
      return await supervisor.withActiveClient(async ({ client, generation }) => {
        if (!prepared || prepared.client !== client || prepared.generation !== generation) return false;
        activeClient = client;
        activeGeneration = generation;
        if (typeof handleIncomingMediaMessage === 'function' && !mediaAttached.has(client)) {
          mediaAttached.add(client);
          client.on('message', (...args) => {
            Promise.resolve(supervisor.withActiveClient(({ client: current, generation: currentGeneration }) => {
              if (current !== client || currentGeneration !== generation) return false;
              return handleIncomingMediaMessage(...args);
            })).catch(error => {
              if (error?.code !== 'WPP_NOT_OWNER') {
                logger.error('[WPP GENERAL] incoming media handling failed:', error);
              }
            });
          });
        }
        await outboxProcessor?.processOutbox?.();
        return true;
      });
    } catch (error) {
      if (error?.code !== 'WPP_NOT_OWNER') throw error;
      activeClient = null;
      activeGeneration = null;
      return false;
    }
  }

  function kickActiveGeneration() {
    if (qrOnly || activeWork) return;
    activeWork = prepareActiveGeneration()
      .catch(error => logger.error('[WPP GENERAL] active generation work failed:', error))
      .finally(() => { activeWork = null; });
  }

  function kickMaintenance(snapshot) {
    if (maintenanceWork) return;
    maintenanceWork = (async () => {
      await applyPendingReset(snapshot);
      if (supervisor.snapshot().state !== 'fenced') kickActiveGeneration();
    })()
      .catch(error => logger.error('[WPP GENERAL] maintenance work failed:', error))
      .finally(() => { maintenanceWork = null; });
  }

  function heartbeatOnce() {
    if (!heartbeatInFlight) {
      heartbeatInFlight = Promise.resolve()
        .then(() => supervisor.heartbeatOnce())
        .finally(() => { heartbeatInFlight = null; });
    }
    return heartbeatInFlight;
  }

  async function performTick() {
    if (stopped) return false;
    if (!schemaReady && typeof repository.ensureSchema === 'function') {
      await repository.ensureSchema();
      schemaReady = true;
    }
    let snapshot = supervisor.snapshot();
    if (!snapshot.isOwner) {
      if (await takeoverIsBlocked()) return false;
      const acquired = await supervisor.start();
      if (!acquired) return false;
      snapshot = supervisor.snapshot();
    }
    if (!snapshot.isOwner) return false;
    await heartbeatOnce();
    kickMaintenance(snapshot);
    return true;
  }

  function tick() {
    if (running) return running;
    running = performTick().finally(() => { running = null; });
    return running;
  }

  function delayForNextTick() {
    if (supervisor.snapshot().isOwner) return heartbeatMs;
    const spread = Math.max(0, followerMaxMs - followerMinMs);
    const jitter = Math.min(spread, Math.max(0, Math.floor(random() * (spread + 1))));
    return followerMinMs + jitter;
  }

  function scheduleNext() {
    if (stopped || timer !== null) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      scheduleNext();
      try {
        if (running && supervisor.snapshot().isOwner) {
          await heartbeatOnce();
        } else {
          await tick();
        }
      } catch (error) {
        logger.error('[WPP GENERAL] runtime tick failed:', error);
      }
    }, delayForNextTick());
  }

  function start() {
    if (stopped) return Promise.resolve(false);
    const started = tick();
    scheduleNext();
    return started;
  }

  function stopTimers() {
    stopped = true;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    for (const timerId of authenticatedFallbackTimers.values()) timers.clearTimeout(timerId);
    authenticatedFallbackTimers.clear();
    authenticatedFallbackAttempts.clear();
    authenticatedFallbackRecoveries.clear();
  }

  return {
    enabled: true,
    repository,
    supervisor,
    ownership,
    setOutboxProcessor(processor) {
      if (!processor || typeof processor.processOutbox !== 'function') {
        throw new TypeError('outboxProcessor.processOutbox is required');
      }
      outboxProcessor = processor;
    },
    tick,
    start,
    stopTimers,
    snapshot: () => ({ enabled: true, timerActive: timer !== null, running: running !== null, ...supervisor.snapshot() }),
    getState: () => {
      const state = supervisor.snapshot();
      const exposedClient = state.ready && state.gateOpen
        && activeGeneration === state.generation ? activeClient : null;
      return {
        isConnected: state.ready,
        isReadyWpp: state.ready && state.gateOpen,
        isInitializingWpp: ['acquiring', 'initializing'].includes(state.state),
        isShuttingDownWpp: state.state === 'stopping' || stopped,
        wppClient: exposedClient,
        lastQr: null,
      };
    },
  };
}
