function notOwnerError(message = 'WhatsApp Empresa worker is not the active owner') {
  return Object.assign(new Error(message), { code: 'WPP_COMPANY_NOT_OWNER' });
}

export function createCompanyLifecycle({
  ownership,
  clientFactory,
  deleteSession = async () => {},
} = {}) {
  for (const method of ['tryAcquire', 'assertOwned', 'heartbeat', 'releaseAfterQuiesced']) {
    if (typeof ownership?.[method] !== 'function') throw new TypeError(`ownership.${method} is required`);
  }
  if (typeof clientFactory?.create !== 'function') throw new TypeError('clientFactory.create is required');
  if (typeof deleteSession !== 'function') throw new TypeError('deleteSession must be a function');

  let state = 'standby';
  let generation = 0;
  let current = null;
  let tail = Promise.resolve();
  let shuttingDown = false;
  let fenced = false;
  let lastError = null;

  const snapshot = () => Object.freeze({
    state,
    generation,
    isOwner: ownership.isOwner === true,
    hasClient: current !== null,
    lastError,
  });

  function enqueue(work, { allowShutdown = false } = {}) {
    if ((shuttingDown && !allowShutdown) || fenced) {
      return Promise.reject(notOwnerError(fenced ? 'WhatsApp Empresa lifecycle is fenced' : 'WhatsApp Empresa lifecycle is shutting down'));
    }
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }

  async function createFresh(operation) {
    ownership.assertOwned();
    state = operation === 'restart' ? 'restarting' : 'initializing';
    const nextGeneration = generation + 1;
    const next = clientFactory.create({ generation: nextGeneration });
    current = next;
    generation = nextGeneration;
    try {
      await next.initialize();
      state = 'running';
      return true;
    } catch (error) {
      lastError = error;
      state = 'fenced';
      fenced = true;
      try { await stopCurrent(); } catch {}
      throw error;
    }
  }

  async function stopCurrent() {
    if (!current) return true;
    const stopping = current;
    stopping.removeAllListeners?.();
    let destroyError = null;
    try {
      await stopping.destroy();
    } catch (error) {
      destroyError = error;
    }
    let stopped = false;
    try {
      stopped = await stopping.confirmStopped() === true;
    } catch {}
    if (!stopped) {
      try { stopped = await stopping.forceStop() === true; } catch {}
    }
    if (!stopped) {
      const error = new Error('WhatsApp Empresa client stop could not be confirmed', { cause: destroyError });
      lastError = error;
      throw error;
    }
    if (current === stopping) current = null;
    return true;
  }

  function start() {
    return enqueue(async () => {
      if (current) return true;
      state = 'acquiring';
      const acquired = await ownership.tryAcquire();
      if (acquired !== true) {
        state = 'standby';
        return false;
      }
      return createFresh('start');
    });
  }

  function restart(_reason = 'restart') {
    return enqueue(async () => {
      ownership.assertOwned();
      state = 'restarting';
      try {
        await stopCurrent();
        return await createFresh('restart');
      } catch (error) {
        state = 'fenced';
        fenced = true;
        lastError = error;
        throw error;
      }
    });
  }

  function reset(_sequence) {
    return enqueue(async () => {
      ownership.assertOwned();
      state = 'resetting';
      try {
        await stopCurrent();
        await ownership.heartbeat();
        await deleteSession();
        return await createFresh('reset');
      } catch (error) {
        state = 'fenced';
        fenced = true;
        lastError = error;
        throw error;
      }
    });
  }

  function shutdown() {
    shuttingDown = true;
    const result = tail.then(async () => {
      state = 'stopping';
      if (ownership.isOwner === true) {
        await ownership.releaseAfterQuiesced(stopCurrent);
      } else {
        await stopCurrent();
      }
      state = 'stopped';
      return true;
    });
    tail = result.catch(() => {});
    return result;
  }

  function ownershipLost(error = notOwnerError('WhatsApp Empresa ownership was lost')) {
    if (fenced) return tail;
    fenced = true;
    state = 'fenced';
    lastError = error;
    const result = tail.then(async () => {
      try { await stopCurrent(); } finally { state = 'fenced'; }
      return false;
    });
    tail = result.catch(() => {});
    return result;
  }

  async function withActiveClient(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn is required');
    if (!current || state !== 'running' || ownership.isOwner !== true || shuttingDown || fenced) throw notOwnerError();
    const active = current;
    const activeGeneration = generation;
    await ownership.heartbeat();
    if (current !== active || generation !== activeGeneration || ownership.isOwner !== true || state !== 'running') {
      throw notOwnerError('WhatsApp Empresa generation changed before client use');
    }
    return fn({ client: active, generation: activeGeneration });
  }

  return {
    start,
    restart,
    reset,
    shutdown,
    ownershipLost,
    withActiveClient,
    snapshot,
    isCurrent(candidate, candidateGeneration) {
      return current === candidate && generation === candidateGeneration && ownership.isOwner === true && !fenced;
    },
    get current() { return current; },
  };
}
