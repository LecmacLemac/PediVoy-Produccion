import { createGeneralControlRepository } from './generalControlRepository.js';

export const GENERAL_ADVISORY_LOCK_KEY = '8030559744579091271';

export class OwnershipLostError extends Error {
  constructor(message = 'WhatsApp General ownership lost', options) {
    super(message, options);
    this.name = 'OwnershipLostError';
    this.code = 'WPP_GENERAL_OWNERSHIP_LOST';
  }
}

function deadline(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new OwnershipLostError(`${label} deadline exceeded`);
      error.timedOut = true;
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createGeneralOwnership({
  pool,
  ownerId,
  advisoryLockKey = GENERAL_ADVISORY_LOCK_KEY,
  operationDeadlineMs = 3000,
  heartbeatDeadlineMs = 3000,
  quiesceDeadlineMs = 20000,
  onOwnershipLost = () => {},
} = {}) {
  if (!pool?.connect) throw new TypeError('pool.connect is required');
  if (!ownerId) throw new TypeError('ownerId is required');
  if (typeof onOwnershipLost !== 'function') throw new TypeError('onOwnershipLost must be a function');

  let client = null;
  let activeCheckout = null;
  let clientErrorHandler = null;
  let held = false;
  let acquiring = false;
  let epoch = null;
  let lossNotified = false;

  const repository = createGeneralControlRepository(async () => {
    throw new OwnershipLostError('Dedicated ownership client is unavailable');
  });

  function safeRelease(target, checkout, error) {
    if (!target || !checkout || checkout.released) return;
    checkout.released = true;
    try {
      target.release(error);
    } catch {
      // A pool release failure cannot restore trust in this session.
    }
  }

  function detachConnectionError(target) {
    if (target && clientErrorHandler && typeof target.off === 'function') {
      target.off('error', clientErrorHandler);
    }
    clientErrorHandler = null;
  }

  function notifyLoss(error) {
    if (lossNotified) return;
    lossNotified = true;
    try {
      const result = onOwnershipLost(error);
      Promise.resolve(result).catch(() => {
        // Ownership loss must remain fail-closed even if the async observer fails.
      });
    } catch {
      // Ownership loss must remain fail-closed even if the observer fails.
    }
  }

  function poison(error, target = client, { notify = held, detach = true } = {}) {
    if (!target) return;
    const isActive = target === client;
    const checkout = isActive ? activeCheckout : null;
    if (isActive) {
      if (detach) detachConnectionError(target);
      client = null;
      activeCheckout = null;
      held = false;
      epoch = null;
    }
    safeRelease(target, checkout, error);
    if (isActive && notify) notifyLoss(error);
  }

  function attachConnectionError(target) {
    if (typeof target.on !== 'function') return;
    clientErrorHandler = cause => {
      if (target !== client) return;
      const error = cause instanceof OwnershipLostError
        ? cause
        : new OwnershipLostError('General ownership connection lost', { cause });
      // Keep the listener on the discarded emitter so duplicate driver errors
      // are absorbed without repeating loss notification or cleanup.
      poison(error, target, { notify: held, detach: false });
    };
    target.on('error', clientErrorHandler);
  }

  function assertOwned() {
    if (!held || !client || epoch === null) throw new OwnershipLostError();
    return true;
  }

  async function boundedUnlock(target) {
    return deadline(
      target.query('SELECT pg_advisory_unlock(CAST($1 AS bigint)) AS unlocked', [advisoryLockKey]),
      operationDeadlineMs,
      'General advisory unlock',
    );
  }

  async function tryAcquire() {
    if (held) return true;
    if (acquiring || client) throw new Error('Ownership acquisition already in progress');
    acquiring = true;
    lossNotified = false;

    const checkout = { released: false };
    const connectPromise = Promise.resolve().then(() => pool.connect());
    let candidate;
    try {
      candidate = await deadline(connectPromise, operationDeadlineMs, 'General ownership connect');
    } catch (error) {
      if (error?.timedOut) {
        connectPromise.then(lateClient => safeRelease(lateClient, checkout, error)).catch(() => {});
      }
      acquiring = false;
      throw error;
    }

    client = candidate;
    activeCheckout = checkout;
    attachConnectionError(candidate);
    let lockAcquired = false;

    try {
      const lockResult = await deadline(
        candidate.query('SELECT pg_try_advisory_lock(CAST($1 AS bigint)) AS locked', [advisoryLockKey]),
        operationDeadlineMs,
        'General advisory lock',
      );
      if (candidate !== client) throw new OwnershipLostError('General ownership connection lost during acquisition');
      lockAcquired = lockResult?.rows?.[0]?.locked === true;
      if (!lockAcquired) {
        detachConnectionError(candidate);
        client = null;
        activeCheckout = null;
        safeRelease(candidate, checkout, undefined);
        acquiring = false;
        return false;
      }

      const row = await deadline(
        repository.publishOwner({ ownerId, executor: candidate }),
        operationDeadlineMs,
        'General owner publication',
      );
      if (candidate !== client) throw new OwnershipLostError('General ownership connection lost during publication');
      if (!row) throw new OwnershipLostError('Failed to publish General ownership');
      epoch = row.epoch;
      held = true;
      acquiring = false;
      return true;
    } catch (error) {
      if (candidate === client && lockAcquired && !error?.timedOut) {
        try {
          await boundedUnlock(candidate);
        } catch {
          // Preserve the acquisition failure; poisoning destroys an uncertain session.
        }
      }
      if (candidate === client) poison(error, candidate, { notify: held });
      else safeRelease(candidate, checkout, error);
      acquiring = false;
      throw error;
    }
  }

  async function heartbeat() {
    assertOwned();
    const activeClient = client;
    const activeEpoch = epoch;

    try {
      const updated = await deadline(
        repository.heartbeat({ ownerId, epoch: activeEpoch, executor: activeClient }),
        heartbeatDeadlineMs,
        'General ownership heartbeat',
      );
      if (!updated) throw new OwnershipLostError('General ownership fence rejected heartbeat');
      if (client !== activeClient || epoch !== activeEpoch || !held) throw new OwnershipLostError();
      return true;
    } catch (error) {
      const ownershipError = error instanceof OwnershipLostError
        ? error
        : new OwnershipLostError('General ownership heartbeat failed', { cause: error });
      if (activeClient === client) poison(ownershipError, activeClient, { notify: true });
      throw ownershipError;
    }
  }

  async function releaseAfterQuiesced(quiesceFn) {
    if (typeof quiesceFn !== 'function') throw new TypeError('quiesceFn must be a function');
    if (!client) {
      held = false;
      epoch = null;
      return false;
    }

    const activeClient = client;
    const checkout = activeCheckout;
    const activeEpoch = epoch;

    // A rejected or timed-out quiescence deliberately leaves the healthy lock held.
    await deadline(
      Promise.resolve().then(() => quiesceFn()),
      quiesceDeadlineMs,
      'General ownership quiescence',
    );
    assertOwned();
    if (client !== activeClient || epoch !== activeEpoch) throw new OwnershipLostError();

    held = false;
    let primaryError = null;
    let clearTimedOut = false;

    try {
      const cleared = await deadline(
        repository.releaseOwner({ ownerId, epoch: activeEpoch, executor: activeClient }),
        operationDeadlineMs,
        'General ownership row clear',
      );
      if (!cleared) throw new OwnershipLostError('General ownership fence rejected release');
    } catch (error) {
      primaryError = error;
      clearTimedOut = error?.timedOut === true;
    }

    // Never queue another query behind a timed-out query on the same session.
    if (!clearTimedOut && activeClient === client) {
      try {
        const result = await boundedUnlock(activeClient);
        if (result?.rows?.[0]?.unlocked !== true && !primaryError) {
          primaryError = new OwnershipLostError('General advisory lock was not held during release');
        }
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }

    if (activeClient === client) {
      detachConnectionError(activeClient);
      client = null;
      activeCheckout = null;
      epoch = null;
    }
    safeRelease(activeClient, checkout, primaryError || undefined);
    if (primaryError) throw primaryError;
    return true;
  }

  return {
    tryAcquire,
    acquire: tryAcquire,
    assertOwned,
    heartbeat,
    releaseAfterQuiesced,
    release: releaseAfterQuiesced,
    get epoch() {
      return epoch;
    },
    get ownerId() {
      return ownerId;
    },
    get isOwner() {
      return held;
    },
  };
}
