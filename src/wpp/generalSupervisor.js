function deadline(promise, milliseconds, label) {
  let timer;
  const observed = Promise.resolve(promise);
  observed.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} deadline exceeded`);
      error.timedOut = true;
      reject(error);
    }, milliseconds);
  });
  return Promise.race([observed, timeout]).finally(() => clearTimeout(timer));
}

function notOwnerError(message = 'WhatsApp General client is not active') {
  return Object.assign(new Error(message), { code: 'WPP_NOT_OWNER' });
}

function preserveCause(error, cause) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    if (error.cause === undefined) error.cause = cause;
    return error;
  }
  return new Error(String(error), { cause });
}

export function createGeneralSupervisor({
  ownership,
  clientFactory,
  repository,
  fatalExit,
  initializeDeadlineMs = 90000,
  destroyDeadlineMs = 10000,
  shutdownDeadlineMs = 20000,
} = {}) {
  for (const method of ['tryAcquire', 'assertOwned', 'heartbeat', 'releaseAfterQuiesced']) {
    if (typeof ownership?.[method] !== 'function') {
      throw new TypeError(`ownership.${method} is required`);
    }
  }
  if (typeof clientFactory?.create !== 'function') throw new TypeError('clientFactory.create is required');
  for (const method of ['updateOwned', 'markResetStarted', 'markResetApplied', 'markResetFailed']) {
    if (typeof repository?.[method] !== 'function') {
      throw new TypeError(`repository.${method} is required`);
    }
  }
  if (typeof fatalExit !== 'function') throw new TypeError('fatalExit must be a function');

  let state = 'standby';
  let generation = 0;
  let current = null;
  let ready = false;
  let gateOpen = false;
  let lastError = null;
  let tail = Promise.resolve();
  let startPromise = null;
  let shuttingDown = false;
  let ownershipLost = false;
  let lossPromise = null;
  let shutdownPromise = null;
  let fatalCalled = false;
  let gateHolds = 0;
  let eventRevision = 0;
  let terminalFenceGeneration = null;

  const snapshot = () => Object.freeze({
    state,
    generation,
    owner: ownership.ownerId ?? null,
    ownerId: ownership.ownerId ?? null,
    epoch: ownership.epoch ?? null,
    ready,
    gate: gateOpen,
    gateOpen,
    isOwner: ownership.isOwner === true,
    lastError,
  });

  function closeGate() {
    ready = false;
    gateOpen = false;
  }

  async function assertOwner() {
    if (ownership.isOwner !== true) throw notOwnerError();
    try {
      const owned = await Promise.resolve(ownership.assertOwned());
      if (owned !== true) throw notOwnerError();
    } catch (error) {
      if (error?.code === 'WPP_NOT_OWNER') throw error;
      throw notOwnerError(error?.message);
    }
  }

  async function publish(nextState, operation = null, error = null) {
    state = nextState;
    if (error) lastError = error;
    if (ownership.isOwner !== true) {
      throw notOwnerError('General ownership was lost before state update');
    }
    const updated = await repository.updateOwned({
      ownerId: ownership.ownerId,
      epoch: ownership.epoch,
      state: nextState,
      operation,
      lastError: error ? String(error.message ?? error) : null,
    });
    if (updated !== true) throw notOwnerError('General ownership fence rejected state update');
  }

  function enqueue(fn, { allowShutdown = false } = {}) {
    if ((shuttingDown || ownershipLost) && !allowShutdown) {
      return Promise.reject(notOwnerError(shuttingDown
        ? 'General supervisor is shutting down'
        : 'General ownership was lost'));
    }
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  }

  function queueStateEvent({ eventGeneration, revision, nextState, operation, qrCode, error }) {
    const eventClient = current;
    const eventEpoch = ownership.epoch;
    enqueue(async () => {
      const terminalEvent = operation === 'profile_lock'
        && terminalFenceGeneration === eventGeneration;
      if (!eventClient || (!terminalEvent && current !== eventClient)
        || (terminalEvent && current !== null && current !== eventClient) || generation !== eventGeneration
        || eventClient.generation !== eventGeneration || ownership.epoch !== eventEpoch
        || shuttingDown || ownershipLost) return false;
      await assertOwner();
      const updated = await repository.updateOwned({
        ownerId: ownership.ownerId,
        epoch: eventEpoch,
        state: nextState,
        operation,
        qrCode,
        lastError: error ? String(error.message ?? error) : null,
      });
      if (updated !== true) throw notOwnerError('General ownership fence rejected event update');
      if ((!terminalEvent && current !== eventClient)
        || (terminalEvent && current !== null && current !== eventClient) || generation !== eventGeneration
        || ownership.epoch !== eventEpoch || shuttingDown || ownershipLost) return false;
      if (revision !== eventRevision) return false;
      state = nextState;
      if (error) lastError = error;
      if (nextState === 'ready') {
        ready = true;
        gateOpen = gateHolds === 0;
      }
      return true;
    }).catch(error => leaseLost(error));
  }

  function eventSink({ event, generation: eventGeneration, args = [] }) {
    if (!current || eventGeneration !== generation || current.generation !== eventGeneration
      || shuttingDown || ownershipLost || terminalFenceGeneration !== null) return;
    const revision = ++eventRevision;
    if (event === 'ready') {
      if (ownership.isOwner !== true) return;
      closeGate();
      queueStateEvent({ eventGeneration, revision, nextState: 'ready', operation: null });
      return;
    }
    if (event === 'qr') {
      closeGate();
      queueStateEvent({
        eventGeneration,
        revision,
        nextState: 'awaiting_qr',
        operation: 'qr',
        qrCode: args[0] ?? null,
      });
      return;
    }
    if (event === 'authenticated') {
      closeGate();
      queueStateEvent({ eventGeneration, revision, nextState: 'authenticated', operation: 'authenticated' });
      return;
    }
    if (event === 'disconnected' || event === 'auth_failure' || event === 'error') {
      closeGate();
      const error = args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? event));
      lastError = error;
      if (/profile\s*lock|singleton(?:lock)?|browser\s+already\s+running/i.test(error.message)) {
        terminalFenceGeneration = eventGeneration;
        queueStateEvent({
          eventGeneration,
          revision,
          nextState: 'fenced',
          operation: 'profile_lock',
          error,
        });
        return;
      }
      restart(event, { expectedGeneration: eventGeneration }).catch(() => {});
    }
  }

  async function persistTerminalFence(operation, error) {
    try {
      await publish('fenced', operation, error);
      return true;
    } catch (persistenceError) {
      state = 'fenced';
      lastError = error;
      leaseLost(preserveCause(persistenceError, error));
      return false;
    }
  }

  async function initializeFresh() {
    try {
      await assertOwner();
      await publish('initializing', 'initialize');
      generation += 1;
      current = clientFactory.create({ generation, eventSink });
      await deadline(current.initialize(), initializeDeadlineMs, 'General client initialize');
      return true;
    } catch (error) {
      closeGate();
      try {
        await stopCurrent();
      } catch (cleanupError) {
        callFatal(cleanupError);
      }
      await persistTerminalFence('initialize_failed', error);
      if (error?.code === 'WPP_NOT_OWNER') leaseLost(error);
      throw error;
    }
  }

  async function stopCurrent() {
    closeGate();
    if (!current) return true;
    const stopping = current;
    await deadline(stopping.destroy(), destroyDeadlineMs, 'General client destroy');
    const stopped = await deadline(stopping.confirmStopped(), destroyDeadlineMs, 'General client stop confirmation');
    if (stopped !== true) throw new Error('General client stop could not be confirmed');
    if (current === stopping) current = null;
    return true;
  }

  function start() {
    if (shuttingDown) return Promise.reject(notOwnerError('General supervisor is shutting down'));
    if (startPromise) return startPromise;
    startPromise = enqueue(async () => {
      if (state === 'fenced') throw notOwnerError('General supervisor is fenced');
      if (current || (ownership.isOwner && generation > 0)) return true;
      state = 'acquiring';
      const acquired = await ownership.tryAcquire();
      if (acquired === false) {
        state = 'standby';
        return false;
      }
      if (acquired !== true) throw notOwnerError('General ownership acquisition was not confirmed');
      return initializeFresh();
    });
    startPromise.finally(() => { startPromise = null; }).catch(() => {});
    return startPromise;
  }

  function abortRestartForTerminalFence() {
    if (terminalFenceGeneration !== generation) return false;
    gateHolds -= 1;
    closeGate();
    return true;
  }

  async function abortResetForTerminalFence({ started, sequence }) {
    if (terminalFenceGeneration !== generation) return false;
    if (started) {
      try {
        const persisted = await repository.markResetFailed({
          ownerId: ownership.ownerId,
          epoch: ownership.epoch,
          sequence,
          error: lastError,
        });
        if (persisted !== true) throw notOwnerError('General reset failure fence rejected persistence');
      } catch (persistenceError) {
        persistenceError.resetFailurePersistenceAttempted = true;
        leaseLost(preserveCause(persistenceError, lastError));
        throw persistenceError;
      }
    }
    gateHolds -= 1;
    closeGate();
    return true;
  }

  function restart(reason = 'restart', { expectedGeneration = null } = {}) {
    gateHolds += 1;
    closeGate();
    return enqueue(async () => {
      if (abortRestartForTerminalFence()) return false;
      if (expectedGeneration !== null && generation !== expectedGeneration) {
        gateHolds -= 1;
        gateOpen = ready && gateHolds === 0;
        return false;
      }
      try {
        await assertOwner();
        await publish('restarting', reason);
        if (abortRestartForTerminalFence()) return false;
        await stopCurrent();
        if (abortRestartForTerminalFence()) return false;
        const restarted = await initializeFresh();
        gateHolds -= 1;
        gateOpen = ready && gateHolds === 0;
        return restarted;
      } catch (error) {
        await persistTerminalFence(reason, error);
        if (error?.code === 'WPP_NOT_OWNER') leaseLost(error);
        throw error;
      }
    });
  }

  function reset(sequence, deleteSessionFn) {
    if (typeof deleteSessionFn !== 'function') return Promise.reject(new TypeError('deleteSessionFn is required'));
    gateHolds += 1;
    closeGate();
    return enqueue(async () => {
      let started = false;
      if (await abortResetForTerminalFence({ started, sequence })) return false;
      try {
        await assertOwner();
        await publish('resetting', 'reset');
        if (await abortResetForTerminalFence({ started, sequence })) return false;
        started = await repository.markResetStarted({ ownerId: ownership.ownerId, epoch: ownership.epoch, sequence });
        if (started !== true) throw notOwnerError('General reset fence rejected start');
        if (await abortResetForTerminalFence({ started, sequence })) return false;
        await stopCurrent();
        if (await abortResetForTerminalFence({ started, sequence })) return false;
        const stillOwned = await Promise.resolve(ownership.assertOwned());
        if (stillOwned !== true) throw notOwnerError('General reset ownership revalidation failed');
        if (await abortResetForTerminalFence({ started, sequence })) return false;
        await deleteSessionFn();
        await initializeFresh();
        const applied = await repository.markResetApplied({ ownerId: ownership.ownerId, epoch: ownership.epoch, sequence });
        if (applied !== true) throw notOwnerError('General reset fence rejected completion');
        gateHolds -= 1;
        gateOpen = ready && gateHolds === 0;
        return true;
      } catch (error) {
        closeGate();
        state = 'fenced';
        lastError = error;
        if (started && error?.resetFailurePersistenceAttempted !== true) {
          try {
            const persisted = await repository.markResetFailed({
              ownerId: ownership.ownerId,
              epoch: ownership.epoch,
              sequence,
              error,
            });
            if (persisted !== true) {
              throw notOwnerError('General reset failure fence rejected persistence');
            }
          } catch (persistenceError) {
            leaseLost(preserveCause(persistenceError, error));
          }
        }
        if (error?.code === 'WPP_NOT_OWNER') leaseLost(error);
        throw error;
      }
    });
  }

  function callFatal(error) {
    if (fatalCalled) return;
    fatalCalled = true;
    Promise.resolve().then(() => fatalExit(error)).catch(() => {});
  }

  async function forceStopAfterDeadline(deadlineError) {
    if (!deadlineError?.timedOut || !current) return deadlineError;
    try {
      const stopped = await deadline(current.forceStop(), destroyDeadlineMs, 'General client force stop');
      if (stopped !== true) {
        return new Error('General client force stop could not be confirmed', { cause: deadlineError });
      }
      return deadlineError;
    } catch (forceStopError) {
      if (forceStopError && forceStopError.cause === undefined) forceStopError.cause = deadlineError;
      return forceStopError;
    }
  }

  function leaseLost(error = notOwnerError('General ownership was lost')) {
    closeGate();
    ownershipLost = true;
    state = 'fenced';
    lastError = error;
    if (lossPromise) return lossPromise;
    const cleanup = tail.then(async () => {
      try {
        await stopCurrent();
      } catch (cleanupError) {
        if (!lastError) lastError = cleanupError;
      } finally {
        state = 'fenced';
        closeGate();
        callFatal(error);
      }
      return false;
    });
    cleanup.catch(() => {});
    lossPromise = deadline(cleanup, shutdownDeadlineMs, 'General lease-loss shutdown').catch(async deadlineError => {
      state = 'fenced';
      closeGate();
      const fatalError = await forceStopAfterDeadline(deadlineError);
      callFatal(fatalError === deadlineError ? error : fatalError);
      return false;
    });
    tail = lossPromise.catch(() => {});
    return lossPromise;
  }

  async function heartbeatOnce() {
    try {
      const alive = await ownership.heartbeat();
      if (alive !== true) throw notOwnerError('General ownership heartbeat was rejected');
      return true;
    } catch (error) {
      leaseLost(error);
      throw error;
    }
  }

  function shutdown() {
    closeGate();
    shuttingDown = true;
    if (shutdownPromise) return shutdownPromise;
    if (ownershipLost) {
      shutdownPromise = Promise.resolve(lossPromise).then(() => false, () => false);
      return shutdownPromise;
    }
    let aborted = false;
    const operation = tail.then(async () => {
      if (aborted) return false;
      state = 'stopping';
      if (ownership.isOwner !== true) {
        await stopCurrent();
        state = 'stopped';
        return true;
      }
      await stopCurrent();
      if (aborted) return false;
      const released = await ownership.releaseAfterQuiesced(async () => {
        if (aborted) throw new Error('General shutdown deadline elapsed during quiescence');
        if (current !== null) throw new Error('General client remained active during quiescence');
        return true;
      });
      if (released !== true) throw new Error('General ownership release could not be confirmed');
      if (aborted) return false;
      state = 'stopped';
      return true;
    });
    operation.catch(() => {});
    shutdownPromise = deadline(operation, shutdownDeadlineMs, 'General supervisor shutdown').catch(async error => {
      aborted = true;
      closeGate();
      state = 'fenced';
      lastError = error;
      callFatal(await forceStopAfterDeadline(error));
      return false;
    });
    tail = shutdownPromise.catch(() => {});
    return shutdownPromise;
  }

  async function withActiveClient(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn is required');
    if (!ready || !gateOpen || !current || shuttingDown || ownershipLost) {
      throw notOwnerError();
    }
    if (ownership.isOwner !== true) {
      const error = notOwnerError('General ownership was lost');
      leaseLost(error);
      throw error;
    }
    const active = current;
    const activeGeneration = generation;
    const activeEpoch = ownership.epoch;
    try {
      const owned = await ownership.heartbeat();
      if (owned !== true) throw notOwnerError('General ownership heartbeat was rejected');
    } catch (error) {
      leaseLost(error);
      throw notOwnerError(error?.message);
    }
    if (!ready || !gateOpen || ownership.isOwner !== true || ownershipLost
      || current !== active || generation !== activeGeneration || ownership.epoch !== activeEpoch) {
      const error = notOwnerError('General ownership changed before client use');
      leaseLost(error);
      throw error;
    }
    return fn({ client: active.client, generation: activeGeneration, epoch: activeEpoch });
  }

  return {
    start,
    restart,
    reset,
    snapshot,
    shutdown,
    leaseLost,
    heartbeatOnce,
    withActiveClient,
    _deadlines: { shutdownDeadlineMs },
    _fatalExit: fatalExit,
  };
}
