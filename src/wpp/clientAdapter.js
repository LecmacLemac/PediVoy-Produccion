function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function processExited(handle, processAlive) {
  if (!handle || !Number.isInteger(handle.pid) || handle.pid <= 0) return null;
  if (handle.exitCode !== null && handle.exitCode !== undefined) return true;
  if (handle.signalCode !== null && handle.signalCode !== undefined) return true;
  return !processAlive(handle.pid);
}

export function createWppClientAdapter({
  rawClient,
  kill = (pid, signal) => process.kill(pid, signal),
  processAlive = defaultProcessAlive,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  forceStopPollMs = 25,
  forceStopAttempts = 40,
} = {}) {
  if (!rawClient || typeof rawClient.initialize !== 'function') {
    throw new TypeError('rawClient.initialize is required');
  }
  if (typeof rawClient.destroy !== 'function') throw new TypeError('rawClient.destroy is required');

  let initializePromise = null;
  let initializePending = false;
  let destroyCompleted = false;

  const methods = {
    initialize() {
      if (initializePromise) return initializePromise;
      initializePending = true;
      initializePromise = Promise.resolve().then(() => rawClient.initialize()).finally(() => {
        initializePending = false;
      });
      return initializePromise;
    },

    async destroy() {
      await rawClient.destroy();
      destroyCompleted = true;
    },

    async confirmStopped() {
      if (initializePending) return false;
      const browser = rawClient.pupBrowser;
      if (!browser) return false;
      if (typeof browser.isConnected !== 'function') return false;
      if (browser.isConnected()) return false;
      const handle = typeof browser.process === 'function' ? browser.process() : null;
      const exited = processExited(handle, processAlive);
      return exited === null ? destroyCompleted : exited;
    },

    async forceStop() {
      if (initializePending) return false;
      const browser = rawClient.pupBrowser;
      const handle = typeof browser?.process === 'function' ? browser.process() : null;
      if (!handle || !Number.isInteger(handle.pid) || handle.pid <= 0) return false;
      if (processExited(handle, processAlive) === true) return true;
      try {
        kill(handle.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') return false;
      }
      for (let attempt = 0; attempt < forceStopAttempts; attempt += 1) {
        if (processExited(handle, processAlive) === true) return true;
        await wait(forceStopPollMs);
      }
      return processExited(handle, processAlive) === true;
    },
  };

  return new Proxy(methods, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      const value = rawClient[property];
      return typeof value === 'function' ? value.bind(rawClient) : value;
    },
    set(_target, property, value) {
      rawClient[property] = value;
      return true;
    },
  });
}
