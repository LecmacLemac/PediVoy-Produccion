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
    timer = setTimeout(() => reject(new OwnershipLostError(`${label} deadline exceeded`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createGeneralOwnership({
  pool,
  ownerId,
  advisoryLockKey = GENERAL_ADVISORY_LOCK_KEY,
  heartbeatDeadlineMs = 3000,
} = {}) {
  if (!pool?.connect) throw new TypeError('pool.connect is required');
  if (!ownerId) throw new TypeError('ownerId is required');

  let client = null;
  let held = false;
  let epoch = null;

  const repository = createGeneralControlRepository(async () => {
    throw new OwnershipLostError('Dedicated ownership client is unavailable');
  });

  function poison(error) {
    const poisoned = client;
    client = null;
    held = false;
    epoch = null;
    if (poisoned) poisoned.release(error);
  }

  function assertOwned() {
    if (!held || !client || epoch === null) throw new OwnershipLostError();
    return true;
  }

  async function acquire() {
    if (held) return true;
    if (client) throw new Error('Ownership acquisition already in progress');

    const candidate = await pool.connect();
    client = candidate;
    let lockAcquired = false;

    try {
      const lockResult = await candidate.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [advisoryLockKey],
      );
      lockAcquired = lockResult?.rows?.[0]?.locked === true;
      if (!lockAcquired) {
        client = null;
        candidate.release();
        return false;
      }

      const row = await repository.publishOwner({ ownerId, executor: candidate });
      if (!row) throw new OwnershipLostError('Failed to publish General ownership');
      epoch = row.epoch;
      held = true;
      return true;
    } catch (error) {
      if (lockAcquired) {
        try {
          await candidate.query('SELECT pg_advisory_unlock($1) AS unlocked', [advisoryLockKey]);
        } catch {
          // Preserve the acquisition failure; poisoning destroys an uncertain session.
        }
      }
      poison(error);
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
      poison(ownershipError);
      throw ownershipError;
    }
  }

  async function release() {
    if (!client) {
      held = false;
      epoch = null;
      return false;
    }

    const activeClient = client;
    const activeEpoch = epoch;
    let primaryError = null;

    held = false;
    try {
      if (activeEpoch !== null) {
        const cleared = await repository.releaseOwner({
          ownerId,
          epoch: activeEpoch,
          executor: activeClient,
        });
        if (!cleared) throw new OwnershipLostError('General ownership fence rejected release');
      }
    } catch (error) {
      primaryError = error;
    }

    try {
      const result = await activeClient.query(
        'SELECT pg_advisory_unlock($1) AS unlocked',
        [advisoryLockKey],
      );
      if (result?.rows?.[0]?.unlocked !== true && !primaryError) {
        primaryError = new OwnershipLostError('General advisory lock was not held during release');
      }
    } catch (error) {
      if (!primaryError) primaryError = error;
    }

    client = null;
    epoch = null;
    activeClient.release(primaryError || undefined);
    if (primaryError) throw primaryError;
    return true;
  }

  return {
    acquire,
    assertOwned,
    heartbeat,
    release,
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
