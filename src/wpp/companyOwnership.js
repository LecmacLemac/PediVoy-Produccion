export const COMPANY_ADVISORY_LOCK_NAMESPACE = 1347895632;

export class CompanyOwnershipLostError extends Error {
  constructor(message = 'WhatsApp Empresa ownership lost', options) {
    super(message, options);
    this.name = 'CompanyOwnershipLostError';
    this.code = 'WPP_COMPANY_OWNERSHIP_LOST';
  }
}

function deadline(promise, milliseconds, label, { onLateResolve } = {}) {
  let timer;
  let timedOut = false;
  let timeoutError;
  const source = Promise.resolve(promise).then(value => {
    if (timedOut) {
      try { onLateResolve?.(value, timeoutError); } catch {}
    }
    return value;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutError = new CompanyOwnershipLostError(`${label} deadline exceeded`);
      reject(timeoutError);
    }, milliseconds);
  });
  return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
}

export function createCompanyOwnership({
  pool,
  empresaId,
  namespace = COMPANY_ADVISORY_LOCK_NAMESPACE,
  operationDeadlineMs = 3000,
  onOwnershipLost = () => {},
} = {}) {
  if (!pool?.connect) throw new TypeError('pool.connect is required');
  if (!Number.isInteger(Number(empresaId)) || Number(empresaId) <= 0) {
    throw new TypeError('empresaId must be a positive integer');
  }

  const lockEmpresaId = Number(empresaId);
  let client = null;
  let held = false;
  let acquiring = false;
  let errorHandler = null;
  let notified = false;

  function safeRelease(target, error) {
    try { target?.release(error); } catch {}
  }

  function detach(target) {
    if (target && errorHandler && typeof target.off === 'function') target.off('error', errorHandler);
    errorHandler = null;
  }

  function lose(cause) {
    if (!client) return;
    const target = client;
    const wasHeld = held;
    client = null;
    held = false;
    const error = cause instanceof CompanyOwnershipLostError
      ? cause
      : new CompanyOwnershipLostError('WhatsApp Empresa ownership connection lost', { cause });
    safeRelease(target, error);
    if (wasHeld && !notified) {
      notified = true;
      try { Promise.resolve(onOwnershipLost(error)).catch(() => {}); } catch {}
    }
  }

  function attach(target) {
    if (typeof target.on !== 'function') return;
    errorHandler = error => {
      if (target !== client) return;
      // Keep this listener attached to absorb duplicate pg driver errors.
      lose(error);
    };
    target.on('error', errorHandler);
  }

  function assertOwned() {
    if (!held || !client) throw new CompanyOwnershipLostError();
    return true;
  }

  async function tryAcquire() {
    if (held) return true;
    if (acquiring || client) throw new Error('Company ownership acquisition already in progress');
    acquiring = true;
    notified = false;
    let candidate;
    try {
      candidate = await deadline(
        pool.connect(),
        operationDeadlineMs,
        'Company ownership connect',
        { onLateResolve: (lateClient, timeoutError) => safeRelease(lateClient, timeoutError) },
      );
      client = candidate;
      attach(candidate);
      const result = await deadline(
        candidate.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [namespace, lockEmpresaId]),
        operationDeadlineMs,
        'Company advisory lock',
      );
      if (candidate !== client) throw new CompanyOwnershipLostError('Company ownership connection lost during acquisition');
      if (result?.rows?.[0]?.locked !== true) {
        detach(candidate);
        client = null;
        safeRelease(candidate, undefined);
        return false;
      }
      held = true;
      return true;
    } catch (error) {
      if (candidate === client) {
        detach(candidate);
        client = null;
        held = false;
        safeRelease(candidate, error);
      }
      throw error;
    } finally {
      acquiring = false;
    }
  }

  async function heartbeat() {
    assertOwned();
    const active = client;
    try {
      await deadline(active.query('SELECT 1'), operationDeadlineMs, 'Company ownership heartbeat');
      if (active !== client || !held) throw new CompanyOwnershipLostError();
      return true;
    } catch (cause) {
      const error = cause instanceof CompanyOwnershipLostError
        ? cause
        : new CompanyOwnershipLostError('Company ownership heartbeat failed', { cause });
      if (active === client) lose(error);
      throw error;
    }
  }

  async function releaseAfterQuiesced(quiesceFn) {
    if (typeof quiesceFn !== 'function') throw new TypeError('quiesceFn must be a function');
    if (!client) return false;
    await quiesceFn();
    assertOwned();
    const active = client;
    let result;
    try {
      result = await deadline(
        active.query('SELECT pg_advisory_unlock($1, $2) AS unlocked', [namespace, lockEmpresaId]),
        operationDeadlineMs,
        'Company advisory unlock',
      );
    } catch (error) {
      lose(error);
      throw error;
    }
    if (result?.rows?.[0]?.unlocked !== true) {
      const error = new CompanyOwnershipLostError('Company advisory lock was not held during release');
      lose(error);
      throw error;
    }
    held = false;
    detach(active);
    client = null;
    safeRelease(active, undefined);
    return true;
  }

  return {
    tryAcquire,
    acquire: tryAcquire,
    assertOwned,
    heartbeat,
    releaseAfterQuiesced,
    release: releaseAfterQuiesced,
    get isOwner() { return held; },
    get empresaId() { return lockEmpresaId; },
  };
}
