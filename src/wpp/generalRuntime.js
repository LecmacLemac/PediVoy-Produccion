import os from 'node:os';
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

export function createProcessOwnerId({ hostname = os.hostname(), pid = process.pid, uuid = randomUUID() } = {}) {
  return `${hostname}:${pid}:${uuid}`;
}

export function createGeneralRuntime({
  enabled = false,
  qrOnly = false,
  Client,
  LocalAuth,
  path,
  fs,
  query,
  pool,
  repository: injectedRepository,
  ownership: injectedOwnership,
  supervisor: injectedSupervisor,
  ownerId = createProcessOwnerId(),
  fatalExit = error => {
    console.error('[WPP GENERAL] fatal ownership/lifecycle failure:', error);
    process.exit(1);
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
    supervisor = createGeneralSupervisor({ ownership, clientFactory, repository, fatalExit: callFatal });
    assignedSupervisor = supervisor;
  }

  let timer = null;
  let stopped = false;
  let running = null;
  let heartbeatInFlight = null;
  let schemaReady = false;
  let activeClient = null;
  let outboxProcessor = null;
  let activeWork = null;
  let maintenanceWork = null;
  const authenticatedFallbackTimers = new Map();
  const authenticatedFallbackAttempts = new Map();

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

  async function repairAuthenticatedRuntime(client) {
    let health = await inspectAuthenticatedRuntime(client);
    if (!health.connected || health.runtimeReady) return health;
    try {
      await client.inject?.();
      await client.pupPage?.evaluate(async () => {
        try {
          if (typeof window.onAppStateHasSyncedEvent === 'function') {
            await window.onAppStateHasSyncedEvent();
          }
        } catch {}
      });
    } catch (error) {
      logger.warn('[WPP GENERAL] authenticated runtime reinjection failed:', error);
    }
    health = await inspectAuthenticatedRuntime(client);
    return health;
  }

  async function runAuthenticatedFallback(client, generation) {
    authenticatedFallbackTimers.delete(generation);
    if (stopped || qrOnly || typeof supervisor.withCurrentClient !== 'function') return false;
    try {
      const health = await supervisor.withCurrentClient(generation, ({ client: current }) => {
        if (current !== client) return { connected: false, runtimeReady: false, stale: true };
        return repairAuthenticatedRuntime(client);
      });
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

  function scheduleAuthenticatedFallback(client, generation) {
    if (stopped || qrOnly || authenticatedFallbackTimers.has(generation)) return false;
    const snapshot = supervisor.snapshot();
    if (!snapshot.isOwner || snapshot.generation !== generation || snapshot.ready) return false;
    const attempts = authenticatedFallbackAttempts.get(generation) ?? 0;
    if (attempts >= authenticatedFallbackMaxAttempts) return false;
    authenticatedFallbackAttempts.set(generation, attempts + 1);
    const timerId = timers.setTimeout(
      () => runAuthenticatedFallback(client, generation),
      authenticatedFallbackDelayMs,
    );
    authenticatedFallbackTimers.set(generation, timerId);
    return true;
  }

  async function boundedDeleteSession() {
    if (typeof fs?.promises?.rename !== 'function' || typeof fs?.promises?.rm !== 'function') {
      throw new TypeError('fs.promises.rename and fs.promises.rm are required for General session reset');
    }
    const canonical = getWppSessionDir({ path, cwd, sessionId: WPP_SESSION_ID });
    const quarantine = `${canonical}.reset-${uuid()}`;
    try {
      await fs.promises.rename(canonical, quarantine);
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
    let deadlineTimer;
    const removal = Promise.resolve().then(() => fs.promises.rm(quarantine, { recursive: true, force: true }));
    removal.catch(() => {});
    const timeout = new Promise((_, reject) => {
      deadlineTimer = timers.setTimeout(() => {
        const error = new Error('General session deletion deadline exceeded');
        error.timedOut = true;
        reject(error);
      }, deleteDeadlineMs);
    });
    await Promise.race([removal, timeout]).finally(() => timers.clearTimeout(deadlineTimer));
    return true;
  }

  async function applyPendingReset(snapshot) {
    if (typeof repository.loadPendingReset !== 'function' || typeof supervisor.reset !== 'function') return false;
    const pending = await repository.loadPendingReset({ ownerId: snapshot.ownerId, epoch: snapshot.epoch });
    if (!pending) return false;
    const sequence = BigInt(pending.reset_requested_seq);
    const applied = BigInt(pending.reset_applied_seq ?? 0);
    if (sequence <= applied) return false;
    await supervisor.reset(sequence, boundedDeleteSession);
    return true;
  }

  async function prepareActiveGeneration() {
    if (qrOnly) return false;
    try {
      const prepared = await supervisor.withActiveClient(async ({ client, generation }) => {
        if (!handlersStarted.has(client)) {
          handlersStarted.add(client);
          try {
            await handlers?.start?.(client);
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
      const exposedClient = state.ready && state.gateOpen ? activeClient : null;
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
