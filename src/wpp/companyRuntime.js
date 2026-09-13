import { readFile } from 'fs/promises';

export const COMPANY_RUNTIME_PROBE_DELAY_MS = 400;

function unhealthy(reason, details = {}) {
  return { healthy: false, reason, ...details };
}

export async function inspectCompanyRuntime(client, { timeoutMs = 5000 } = {}) {
  if (!client) return unhealthy('client_unavailable');

  const browser = client.pupBrowser;
  const page = client.pupPage;
  if (!browser?.isConnected?.()) return unhealthy('browser_disconnected');
  if (!page) return unhealthy('page_unavailable');
  if (page.isClosed?.()) return unhealthy('page_closed');

  let timeoutId;
  try {
    const snapshot = await Promise.race([
      page.evaluate(() => {
        let appState = window.Store?.AppState?.state || null;
        let appStateSource = appState ? 'Store.AppState' : null;

        if (!appState && typeof window.require === 'function') {
          try {
            appState = window.require('WAWebSocketModel')?.Socket?.state || null;
            if (appState) appStateSource = 'WAWebSocketModel';
          } catch {}
        }

        return {
          appState,
          appStateSource,
          hasGetChat: typeof window.WWebJS?.getChat === 'function',
          hasSendMessage: typeof window.WWebJS?.sendMessage === 'function',
          hasGetMessageModel: typeof window.WWebJS?.getMessageModel === 'function',
        };
      }),
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);

    if (!snapshot) return unhealthy('probe_timeout');

    const runtimeReady = snapshot.hasGetChat && snapshot.hasSendMessage && snapshot.hasGetMessageModel;
    if (snapshot.appState !== 'CONNECTED') {
      return unhealthy('app_not_connected', snapshot);
    }
    if (!runtimeReady) {
      return unhealthy('runtime_bridge_missing', snapshot);
    }

    return { healthy: true, reason: 'ok', ...snapshot };
  } catch (error) {
    return unhealthy('probe_error', { error: error?.message || String(error) });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function confirmCompanyRuntime(client, {
  delayMs = COMPANY_RUNTIME_PROBE_DELAY_MS,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const first = await inspectCompanyRuntime(client);
  if (first.healthy) return { ...first, attempts: 1 };

  await wait(delayMs);
  const second = await inspectCompanyRuntime(client);
  return { ...second, attempts: 2, firstReason: first.reason };
}

export async function repairCompanyRuntimeBridge(client, loadUtils) {
  const before = await inspectCompanyRuntime(client);
  if (before.healthy) return { ...before, repaired: false };
  if (before.reason !== 'runtime_bridge_missing') return { ...before, repaired: false };

  try {
    await client.pupPage.evaluate(loadUtils);
  } catch (err) {
    return unhealthy('bridge_repair_failed', {
      repaired: false,
      error: String(err?.message || err || 'Error desconocido al reinyectar WWebJS'),
    });
  }

  const after = await inspectCompanyRuntime(client);
  return { ...after, repaired: after.healthy };
}

const SYNC_RESUME_EXPRESSION = `(async () => {
  let state = window.Store?.AppState?.state || null;
  if (!state && typeof window.require === 'function') {
    try {
      state = window.require('WAWebSocketModel')?.Socket?.state || null;
    } catch {
      return false;
    }
  }

  if (state !== 'CONNECTED' || typeof window.onAppStateHasSyncedEvent !== 'function') {
    return false;
  }

  await window.onAppStateHasSyncedEvent();
  return true;
})()`;

async function defaultEvaluateDevTools(devToolsPortFile, expression) {
  const [port] = String(await readFile(devToolsPortFile, 'utf8')).trim().split(/\s+/);
  if (!/^\d+$/.test(port)) throw new Error('Puerto DevTools inválido');

  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools respondió HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find(item => item.type === 'page' && item.url?.includes('web.whatsapp.com'));
  if (!target?.webSocketDebuggerUrl) throw new Error('Página de WhatsApp no encontrada en DevTools');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeoutMs = 5000;

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout abriendo DevTools')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('No se pudo abrir DevTools'));
      }, { once: true });
    });

    const id = 1;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout evaluando DevTools')), timeoutMs);
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || 'Error DevTools'));
        else resolve(message);
      });
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });

    return result?.result?.result?.value === true;
  } finally {
    socket.close();
  }
}

export async function resumeSyncedInitializationFromDevTools(devToolsPortFile, {
  evaluateDevTools = defaultEvaluateDevTools,
} = {}) {
  try {
    return await evaluateDevTools(devToolsPortFile, SYNC_RESUME_EXPRESSION) === true;
  } catch {
    return false;
  }
}

export async function runStartupSyncAssistant({
  devToolsPortFile,
  maxAttempts = 720,
  intervalMs = 5000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  resume = resumeSyncedInitializationFromDevTools,
} = {}) {
  if (!devToolsPortFile) throw new Error('DevToolsActivePort requerido');

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await wait(intervalMs);
    if (await resume(devToolsPortFile)) return true;
  }

  return false;
}

export async function resumeSyncedInitialization(client) {
  const browser = client?.pupBrowser;
  const page = client?.pupPage;
  if (!browser?.isConnected?.() || !page || page.isClosed?.()) return false;

  const expression = `(async () => {
    let state = window.Store?.AppState?.state || null;
    if (!state && typeof window.require === 'function') {
      try {
        state = window.require('WAWebSocketModel')?.Socket?.state || null;
      } catch {
        return false;
      }
    }

    if (state !== 'CONNECTED' || typeof window.onAppStateHasSyncedEvent !== 'function') {
      return false;
    }

    await window.onAppStateHasSyncedEvent();
    return true;
  })()`;

  if (typeof page.createCDPSession === 'function') {
    let session = null;
    try {
      session = await page.createCDPSession();
      const response = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return response?.result?.value === true;
    } catch {
      return false;
    } finally {
      try {
        await session?.detach?.();
      } catch {
        // La página puede cerrarse mientras se libera la sesión de diagnóstico.
      }
    }
  }

  try {
    return await page.evaluate(async () => {
      let state = window.Store?.AppState?.state || null;
      if (!state && typeof window.require === 'function') {
        try {
          state = window.require('WAWebSocketModel')?.Socket?.state || null;
        } catch {
          return false;
        }
      }
      if (state !== 'CONNECTED' || typeof window.onAppStateHasSyncedEvent !== 'function') return false;
      await window.onAppStateHasSyncedEvent();
      return true;
    });
  } catch {
    return false;
  }
}

export function isRuntimeBridgeError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('wwebjs') ||
    (message.includes('getchat') && message.includes('undefined')) ||
    (message.includes('sendmessage') && message.includes('undefined'))
  );
}

export function createSingleFlight(task) {
  let inFlight = null;

  return (...args) => {
    if (inFlight) return inFlight;

    try {
      inFlight = Promise.resolve(task(...args));
    } catch (err) {
      inFlight = Promise.reject(err);
    }

    inFlight = inFlight.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createNonOverlappingTask(task) {
  let running = false;

  return async (...args) => {
    if (running) return undefined;
    running = true;
    try {
      return await task(...args);
    } finally {
      running = false;
    }
  };
}

export function createBackoffRecovery({
  task,
  delaysMs = [1000, 5000, 15000, 30000, 60000],
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
} = {}) {
  if (typeof task !== 'function') throw new Error('recovery task requerida');
  if (!Array.isArray(delaysMs) || !delaysMs.length || delaysMs.some(ms => !Number.isFinite(ms) || ms < 0)) {
    throw new Error('delaysMs inválido');
  }

  let inFlight = null;
  let timer = null;
  let scheduledPromise = null;
  let resolveScheduled = null;
  let attempt = 0;
  let lastReason = null;
  let stopped = false;

  function trigger(reason = 'unspecified') {
    if (stopped) return Promise.resolve(false);
    lastReason = reason;
    if (inFlight) return inFlight;
    if (timer) return scheduledPromise;

    inFlight = Promise.resolve()
      .then(() => task(lastReason))
      .then(result => {
        if (result === false) throw new Error('recuperación no completada');
        attempt = 0;
        return true;
      })
      .catch(err => {
        if (stopped) return false;
        onError(err, { reason: lastReason, attempt });
        const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
        attempt += 1;
        scheduledPromise = new Promise(resolve => { resolveScheduled = resolve; });
        timer = setTimer(async () => {
          const scheduledResolve = resolveScheduled;
          timer = null;
          scheduledPromise = null;
          resolveScheduled = null;
          const result = await trigger(lastReason);
          scheduledResolve?.(result);
          return result;
        }, delay);
        return false;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  return {
    trigger,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      resolveScheduled?.(false);
      scheduledPromise = null;
      resolveScheduled = null;
    },
    getState() {
      return { inFlight: Boolean(inFlight), scheduled: Boolean(timer), attempt, lastReason, stopped };
    },
  };
}

export function createPrerequisiteStartup({
  ensurePrerequisites,
  start,
  ...recoveryOptions
} = {}) {
  if (typeof ensurePrerequisites !== 'function') throw new Error('startup prerequisites requeridos');
  if (typeof start !== 'function') throw new Error('startup task requerida');

  let started = false;
  let stopped = false;
  const recovery = createBackoffRecovery({
    ...recoveryOptions,
    task: async reason => {
      if (stopped) return true;
      await ensurePrerequisites();
      if (stopped) return true;
      const result = await start(reason);
      if (result === false) throw new Error('startup no completado');
      started = true;
      return true;
    },
  });

  return {
    trigger(reason) {
      if (stopped) return Promise.resolve(false);
      if (started) return Promise.resolve(true);
      return recovery.trigger(reason);
    },
    stop() {
      stopped = true;
      recovery.stop();
    },
    getState() {
      return { ...recovery.getState(), started, stopped };
    },
  };
}
