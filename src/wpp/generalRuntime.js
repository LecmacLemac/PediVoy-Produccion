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
          assignedSupervisor?.leaseLost(error);
          // Once the advisory session is lost, a successor may immediately use the
          // shared profile. Terminate synchronously so an in-flight rm cannot race it.
          callFatal(error);
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
      createClient: () => {
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
        if (!qrOnly && typeof handleIncomingMediaMessage === 'function') {
          adapter.on('message', handleIncomingMediaMessage);
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

  const handlersStarted = new WeakSet();
  const resetSequences = new Set();

  function boundedDeleteSession() {
    if (typeof fs?.promises?.rm !== 'function') {
      return Promise.reject(new TypeError('fs.promises.rm is required for General session reset'));
    }
    let deadlineTimer;
    const removal = Promise.resolve().then(() => fs.promises.rm(
      getWppSessionDir({ path, cwd, sessionId: WPP_SESSION_ID }),
      { recursive: true, force: true },
    ));
    removal.catch(() => {});
    const timeout = new Promise((_, reject) => {
      deadlineTimer = timers.setTimeout(() => {
        const error = new Error('General session deletion deadline exceeded');
        error.timedOut = true;
        callFatal(error);
        reject(error);
      }, deleteDeadlineMs);
    });
    return Promise.race([removal, timeout]).finally(() => timers.clearTimeout(deadlineTimer));
  }

  async function applyPendingReset(snapshot) {
    if (typeof repository.loadPendingReset !== 'function' || typeof supervisor.reset !== 'function') return false;
    const pending = await repository.loadPendingReset({ ownerId: snapshot.ownerId, epoch: snapshot.epoch });
    if (!pending) return false;
    const sequence = BigInt(pending.reset_requested_seq);
    const applied = BigInt(pending.reset_applied_seq ?? 0);
    if (sequence <= applied || resetSequences.has(sequence)) return false;
    resetSequences.add(sequence);
    await supervisor.reset(sequence, boundedDeleteSession);
    return true;
  }

  async function prepareActiveGeneration() {
    if (qrOnly) return false;
    try {
      return await supervisor.withActiveClient(async ({ client }) => {
        activeClient = client;
        if (!handlersStarted.has(client)) {
          handlersStarted.add(client);
          try {
            await handlers?.start?.(client);
          } catch (error) {
            handlersStarted.delete(client);
            throw error;
          }
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
      return {
        isConnected: state.ready,
        isReadyWpp: state.ready && state.gateOpen,
        isInitializingWpp: ['acquiring', 'initializing'].includes(state.state),
        isShuttingDownWpp: state.state === 'stopping' || stopped,
        wppClient: activeClient,
        lastQr: null,
      };
    },
  };
}
