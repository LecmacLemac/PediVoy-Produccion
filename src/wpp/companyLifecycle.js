function notOwnerError(message = 'WhatsApp Empresa worker is not the active owner') {
  return Object.assign(new Error(message), { code: 'WPP_COMPANY_NOT_OWNER' });
}

function deadline(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function aggregateTerminalErrors(primaryError, cleanupError, phase) {
  if (!cleanupError || cleanupError === primaryError) return primaryError;
  return new AggregateError(
    [primaryError, cleanupError],
    `WhatsApp Empresa ${phase} failed and terminal cleanup failed`,
    { cause: primaryError },
  );
}

export function createCompanyLifecycle({
  ownership,
  clientFactory,
  deleteSession = async () => {},
  fatalExit = async () => {},
  drainDeadlineMs = 20000,
} = {}) {
  for (const method of ['tryAcquire', 'assertOwned', 'heartbeat', 'releaseAfterQuiesced']) {
    if (typeof ownership?.[method] !== 'function') throw new TypeError(`ownership.${method} is required`);
  }
  if (typeof clientFactory?.create !== 'function') throw new TypeError('clientFactory.create is required');
  if (typeof deleteSession !== 'function') throw new TypeError('deleteSession must be a function');
  if (typeof fatalExit !== 'function') throw new TypeError('fatalExit must be a function');
  if (!Number.isFinite(drainDeadlineMs) || drainDeadlineMs <= 0) throw new TypeError('drainDeadlineMs must be positive');

  let state = 'standby';
  let generation = 0;
  let current = null;
  let tail = Promise.resolve();
  let shuttingDown = false;
  let fenced = false;
  let gateOpen = false;
  let eventGateOpen = false;
  let lastError = null;
  let fatalExitPromise = null;
  const activeWork = new Map();
  const fatalHandled = new WeakSet();

  const snapshot = () => Object.freeze({
    state,
    generation,
    isOwner: ownership.isOwner === true,
    hasClient: current !== null,
    gateOpen,
    eventGateOpen,
    activeOperations: [...activeWork.values()].reduce((total, entry) => total + entry.count, 0),
    lastError,
  });

  function closeGate() {
    gateOpen = false;
    eventGateOpen = false;
  }

  function invokeFatalExit(error) {
    if (fatalExitPromise) return fatalExitPromise;
    fatalExitPromise = Promise.resolve().then(() => fatalExit(error)).catch(() => {});
    return fatalExitPromise;
  }

  function beginActiveWork(activeGeneration) {
    let entry = activeWork.get(activeGeneration);
    if (!entry) {
      entry = { count: 0, drained: null, resolveDrained: null };
      activeWork.set(activeGeneration, entry);
    }
    if (entry.count === 0) {
      entry.drained = new Promise(resolve => { entry.resolveDrained = resolve; });
    }
    entry.count += 1;
  }

  function finishActiveWork(activeGeneration) {
    const entry = activeWork.get(activeGeneration);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count === 0) {
      activeWork.delete(activeGeneration);
      entry.resolveDrained();
    }
  }

  function waitForActiveWork(activeGeneration) {
    return activeWork.get(activeGeneration)?.drained ?? Promise.resolve();
  }

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
    eventGateOpen = true;
    try {
      await next.initialize();
      state = 'running';
      gateOpen = true;
      return true;
    } catch (error) {
      lastError = error;
      await enterFatalFence(error, { phase: 'initialization' });
      throw error;
    }
  }

  async function stopCurrent() {
    closeGate();
    if (!current) return true;
    const stopping = current;
    const stoppingGeneration = generation;
    await deadline(
      waitForActiveWork(stoppingGeneration),
      drainDeadlineMs,
      'WhatsApp Empresa active work drain',
    );
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

  async function enterFatalFence(error, { stopAlreadyFailed = false, phase = 'lifecycle' } = {}) {
    if (error && typeof error === 'object' && fatalHandled.has(error)) return false;
    if (error && typeof error === 'object') fatalHandled.add(error);
    fenced = true;
    closeGate();
    state = 'fenced';
    lastError = error;

    let stopConfirmed = !current;
    let terminalError = error;
    if (!stopAlreadyFailed && current) {
      try {
        await stopCurrent();
        stopConfirmed = true;
      } catch (stopError) {
        terminalError = aggregateTerminalErrors(error, stopError, phase);
      }
    }

    if (stopConfirmed && ownership.isOwner === true) {
      try {
        const released = await ownership.releaseAfterQuiesced(async () => true);
        if (released !== true) throw new Error('WhatsApp Empresa ownership release was not confirmed');
      } catch (releaseError) {
        terminalError = aggregateTerminalErrors(error, releaseError, phase);
      }
    }

    lastError = terminalError;
    await invokeFatalExit(terminalError);
    return false;
  }

  function start({ beforeInitialize = async () => {} } = {}) {
    if (typeof beforeInitialize !== 'function') {
      return Promise.reject(new TypeError('beforeInitialize must be a function'));
    }
    return enqueue(async () => {
      if (current) return true;
      state = 'acquiring';
      const acquired = await ownership.tryAcquire();
      if (acquired !== true) {
        state = 'standby';
        return false;
      }
      try {
        await beforeInitialize();
      } catch (error) {
        lastError = error;
        try {
          const released = await ownership.releaseAfterQuiesced(async () => true);
          if (released !== true) throw new Error('WhatsApp Empresa ownership release was not confirmed');
          state = 'standby';
        } catch (releaseError) {
          state = 'fenced';
          fenced = true;
          closeGate();
          lastError = releaseError;
          await invokeFatalExit(releaseError);
          throw releaseError;
        }
        throw error;
      }
      return createFresh('start');
    });
  }

  function restart(_reason = 'restart') {
    closeGate();
    return enqueue(async () => {
      ownership.assertOwned();
      state = 'restarting';
      try {
        await stopCurrent();
        return await createFresh('restart');
      } catch (error) {
        await enterFatalFence(error, { stopAlreadyFailed: current !== null });
        throw error;
      }
    });
  }

  function reset(_sequence) {
    closeGate();
    return enqueue(async () => {
      ownership.assertOwned();
      state = 'resetting';
      try {
        await stopCurrent();
        await ownership.heartbeat();
        await deleteSession();
        return await createFresh('reset');
      } catch (error) {
        await enterFatalFence(error, { stopAlreadyFailed: current !== null });
        throw error;
      }
    });
  }

  function shutdown() {
    shuttingDown = true;
    closeGate();
    const result = tail.then(async () => {
      try {
        state = 'stopping';
        if (ownership.isOwner === true) {
          await ownership.releaseAfterQuiesced(stopCurrent);
        } else {
          await stopCurrent();
        }
        state = 'stopped';
        return true;
      } catch (error) {
        state = 'fenced';
        fenced = true;
        lastError = error;
        closeGate();
        await invokeFatalExit(error);
        throw error;
      }
    });
    tail = result.catch(() => {});
    return result;
  }

  function ownershipLost(error = notOwnerError('WhatsApp Empresa ownership was lost')) {
    if (fenced) return tail;
    fenced = true;
    closeGate();
    state = 'fenced';
    lastError = error;
    const result = tail.then(async () => {
      try {
        await stopCurrent();
      } catch (stopError) {
        lastError = stopError;
        await invokeFatalExit(stopError);
        throw stopError;
      } finally {
        state = 'fenced';
      }
      await invokeFatalExit(error);
      return false;
    });
    tail = result.catch(() => {});
    return result;
  }

  async function withActiveClient(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn is required');
    if (!gateOpen || !current || state !== 'running' || ownership.isOwner !== true || shuttingDown || fenced) throw notOwnerError();
    const active = current;
    const activeGeneration = generation;
    beginActiveWork(activeGeneration);
    try {
      await ownership.heartbeat();
      if (!gateOpen || current !== active || generation !== activeGeneration || ownership.isOwner !== true || state !== 'running') {
        throw notOwnerError('WhatsApp Empresa generation changed before client use');
      }
      return await fn({ client: active, generation: activeGeneration });
    } finally {
      finishActiveWork(activeGeneration);
    }
  }

  async function withClientEvent(candidate, candidateGeneration, fn) {
    if (typeof fn !== 'function') throw new TypeError('fn is required');
    const assertCurrent = () => {
      if (!eventGateOpen || current !== candidate || generation !== candidateGeneration
        || ownership.isOwner !== true || !['initializing', 'restarting', 'running'].includes(state)
        || shuttingDown || fenced) {
        throw notOwnerError('WhatsApp Empresa event generation is not active');
      }
      return true;
    };
    assertCurrent();
    beginActiveWork(candidateGeneration);
    try {
      await ownership.heartbeat();
      assertCurrent();
      const result = await fn({ client: candidate, generation: candidateGeneration, assertCurrent });
      assertCurrent();
      return result;
    } finally {
      finishActiveWork(candidateGeneration);
    }
  }

  return {
    start,
    restart,
    reset,
    shutdown,
    ownershipLost,
    withActiveClient,
    withClientEvent,
    snapshot,
    isCurrent(candidate, candidateGeneration) {
      return current === candidate && generation === candidateGeneration && ownership.isOwner === true && !fenced;
    },
    get current() { return current; },
  };
}
