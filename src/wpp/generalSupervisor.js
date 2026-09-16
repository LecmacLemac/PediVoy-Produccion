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

export function createGeneralSupervisor({
  ownership,
  clientFactory,
  repository,
  fatalExit = () => {},
  initializeDeadlineMs = 90000,
  destroyDeadlineMs = 10000,
  shutdownDeadlineMs = 20000,
} = {}) {
  if (!ownership?.tryAcquire) throw new TypeError('ownership.tryAcquire is required');
  if (!clientFactory?.create) throw new TypeError('clientFactory.create is required');
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
      const owned = await Promise.resolve(ownership.assertOwned?.());
      if (owned === false) throw notOwnerError();
    } catch (error) {
      if (error?.code === 'WPP_NOT_OWNER') throw error;
      throw notOwnerError(error?.message);
    }
  }

  async function publish(nextState, operation = null, error = null) {
    state = nextState;
    if (error) lastError = error;
    if (repository?.updateOwned && ownership.isOwner) {
      const updated = await repository.updateOwned({
        ownerId: ownership.ownerId,
        epoch: ownership.epoch,
        state: nextState,
        operation,
        lastError: error ? String(error.message ?? error) : null,
      });
      if (updated === false) throw notOwnerError('General ownership fence rejected state update');
    }
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

  function publishEvent(values) {
    Promise.resolve(repository?.updateOwned?.(values)).then(updated => {
      if (updated === false) leaseLost(notOwnerError('General ownership fence rejected event update'));
    }).catch(error => leaseLost(error));
  }

  function eventSink({ event, generation: eventGeneration, args = [] }) {
    if (!current || eventGeneration !== generation || current.generation !== eventGeneration
      || shuttingDown || ownershipLost) return;
    if (event === 'ready') {
      if (ownership.isOwner !== true) return;
      ready = true;
      gateOpen = true;
      state = 'ready';
      publishEvent({
        ownerId: ownership.ownerId, epoch: ownership.epoch, state: 'ready', operation: null,
      });
      return;
    }
    if (event === 'qr') {
      closeGate();
      state = 'awaiting_qr';
      publishEvent({
        ownerId: ownership.ownerId, epoch: ownership.epoch, state, operation: 'qr', qrCode: args[0] ?? null,
      });
      return;
    }
    if (event === 'authenticated') {
      closeGate();
      state = 'authenticated';
      publishEvent({
        ownerId: ownership.ownerId, epoch: ownership.epoch, state, operation: 'authenticated',
      });
      return;
    }
    if (event === 'disconnected' || event === 'auth_failure' || event === 'error') {
      closeGate();
      const error = args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? event));
      lastError = error;
      if (/profile\s*lock|singleton(?:lock)?|browser\s+already\s+running/i.test(error.message)) {
        state = 'fenced';
        publishEvent({
          ownerId: ownership.ownerId,
          epoch: ownership.epoch,
          state: 'fenced',
          operation: 'profile_lock',
          lastError: error.message,
        });
        return;
      }
      restart(event).catch(() => {});
    }
  }

  async function initializeFresh() {
    generation += 1;
    current = clientFactory.create({ generation, eventSink });
    try {
      await publish('initializing', 'initialize');
      await deadline(current.initialize(), initializeDeadlineMs, 'General client initialize');
      return true;
    } catch (error) {
      closeGate();
      try {
        await stopCurrent();
      } catch (cleanupError) {
        callFatal(cleanupError);
      }
      await publish('fenced', 'initialize_failed', error).catch(() => { state = 'fenced'; lastError = error; });
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
      if (!acquired) {
        state = 'standby';
        return false;
      }
      return initializeFresh();
    });
    startPromise.finally(() => { startPromise = null; }).catch(() => {});
    return startPromise;
  }

  function restart(reason = 'restart') {
    closeGate();
    return enqueue(async () => {
      await assertOwner();
      await publish('restarting', reason);
      try {
        await stopCurrent();
        return await initializeFresh();
      } catch (error) {
        await publish('fenced', reason, error).catch(() => { state = 'fenced'; lastError = error; });
        throw error;
      }
    });
  }

  function reset(sequence, deleteSessionFn) {
    if (typeof deleteSessionFn !== 'function') return Promise.reject(new TypeError('deleteSessionFn is required'));
    closeGate();
    return enqueue(async () => {
      await assertOwner();
      await publish('resetting', 'reset');
      let started = false;
      try {
        if (repository?.markResetStarted) {
          started = await repository.markResetStarted({ ownerId: ownership.ownerId, epoch: ownership.epoch, sequence });
          if (!started) throw new Error('General reset fence rejected start');
        }
        await stopCurrent();
        const stillOwned = await Promise.resolve(ownership.assertOwned());
        if (stillOwned === false) throw notOwnerError('General reset ownership revalidation failed');
        await deleteSessionFn();
        await initializeFresh();
        if (repository?.markResetApplied) {
          const applied = await repository.markResetApplied({ ownerId: ownership.ownerId, epoch: ownership.epoch, sequence });
          if (applied === false) throw new Error('General reset fence rejected completion');
        }
        return true;
      } catch (error) {
        closeGate();
        state = 'fenced';
        lastError = error;
        if (started && repository?.markResetFailed) {
          await repository.markResetFailed({ ownerId: ownership.ownerId, epoch: ownership.epoch, sequence, error }).catch(() => {});
        }
        throw error;
      }
    });
  }

  function callFatal(error) {
    if (fatalCalled) return;
    fatalCalled = true;
    Promise.resolve().then(() => fatalExit(error)).catch(() => {});
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
    lossPromise = cleanup;
    tail = cleanup.catch(() => {});
    return lossPromise;
  }

  async function heartbeatOnce() {
    try {
      const alive = await ownership.heartbeat();
      if (alive === false) throw notOwnerError('General ownership heartbeat was rejected');
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
      await ownership.releaseAfterQuiesced(async () => {
        if (aborted) throw new Error('General shutdown deadline elapsed during quiescence');
        if (current !== null) throw new Error('General client remained active during quiescence');
        return true;
      });
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
      if (error?.timedOut && current) {
        try {
          await deadline(current.forceStop(), destroyDeadlineMs, 'General client force stop');
        } catch {}
      }
      callFatal(error);
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
      if (owned === false) throw notOwnerError('General ownership heartbeat was rejected');
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
