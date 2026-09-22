function isAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode == null;
}

function waitForExit(children, deadlineMs, timers) {
  const pending = children.filter(isAlive);
  if (pending.length === 0) return Promise.resolve(true);
  return new Promise(resolve => {
    let remaining = pending.length;
    let settled = false;
    const listeners = new Map();
    const finish = result => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      for (const [child, listener] of listeners) child.off?.('exit', listener);
      resolve(result);
    };
    const timer = timers.setTimeout(() => finish(false), deadlineMs);
    for (const child of pending) {
      const listener = () => {
        remaining -= 1;
        if (remaining === 0) finish(true);
      };
      listeners.set(child, listener);
      child.once('exit', listener);
    }
  });
}

export function createCompanyWorkerSupervisor({
  spawnWorker,
  shouldAutoStart,
  respawnDelayMs = 5000,
  shutdownDeadlineMs = 10000,
  timers = { setTimeout, clearTimeout },
  logger = console,
} = {}) {
  if (typeof spawnWorker !== 'function') throw new TypeError('spawnWorker is required');
  if (typeof shouldAutoStart !== 'function') throw new TypeError('shouldAutoStart is required');
  const workers = new Map();
  const respawns = new Map();
  let shuttingDown = false;
  let shutdownPromise = null;

  const delay = Number.isFinite(Number(respawnDelayMs)) && Number(respawnDelayMs) >= 0
    ? Number(respawnDelayMs)
    : 5000;
  const deadline = Number.isFinite(Number(shutdownDeadlineMs)) && Number(shutdownDeadlineMs) > 0
    ? Number(shutdownDeadlineMs)
    : 10000;

  function scheduleRespawn(empresaId, reason = 'exit') {
    if (shuttingDown || !shouldAutoStart() || respawns.has(empresaId)) return;
    const timer = timers.setTimeout(() => {
      respawns.delete(empresaId);
      if (shuttingDown) return;
      const result = ensure(empresaId);
      logger.warn('[WPP EMPRESA] worker respawn:', empresaId, { reason, ...result });
    }, delay);
    timer.unref?.();
    respawns.set(empresaId, timer);
  }

  function ensure(empresaId) {
    if (shuttingDown) return { started: false, reason: 'shutting_down' };
    if (!shouldAutoStart()) return { started: false, reason: 'disabled' };
    const pending = respawns.get(empresaId);
    if (pending) {
      timers.clearTimeout(pending);
      respawns.delete(empresaId);
    }
    const existing = workers.get(empresaId);
    if (isAlive(existing)) return { started: false, reason: 'already_running', pid: existing.pid };

    const child = spawnWorker(empresaId);
    workers.set(empresaId, child);
    child.once('exit', (code, signal) => {
      if (workers.get(empresaId) !== child) return;
      workers.delete(empresaId);
      logger.warn('[WPP EMPRESA] worker exited:', empresaId, { code, signal });
      scheduleRespawn(empresaId, signal || `code_${code ?? 'unknown'}`);
    });
    return { started: true, pid: child.pid };
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    for (const timer of respawns.values()) timers.clearTimeout(timer);
    respawns.clear();
    const children = [...workers.values()].filter(isAlive);
    shutdownPromise = (async () => {
      for (const child of children) child.kill('SIGTERM');
      await waitForExit(children, deadline, timers);
      const remaining = children.filter(isAlive);
      for (const child of remaining) child.kill('SIGKILL');
      const killed = await waitForExit(remaining, deadline, timers);
      return killed && children.every(child => !isAlive(child));
    })();
    return shutdownPromise;
  }

  return {
    ensure,
    shutdown,
    snapshot: () => ({ shuttingDown, workers: workers.size, respawns: respawns.size }),
  };
}
