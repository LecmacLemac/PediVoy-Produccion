import { readFile } from 'node:fs/promises';

function isAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode == null;
}

function normalizeEmpresaId(empresaId) {
  const value = Number(empresaId);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('empresaId must be a positive safe integer');
  return { key: String(value), value };
}

async function scanLinuxDescendantPids(parentPid, { readText = path => readFile(path, 'utf8') } = {}) {
  const root = Number(parentPid);
  if (!Number.isSafeInteger(root) || root <= 0) throw new TypeError('parentPid must be a positive safe integer');
  const pids = [];
  const errors = [];
  const visit = async pid => {
    let raw;
    try {
      raw = await readText(`/proc/${pid}/task/${pid}/children`);
    } catch (error) {
      errors.push({
        pid,
        stage: 'children',
        code: error?.code || 'UNKNOWN',
        name: error?.name || 'Error',
      });
      return;
    }
    const children = String(raw || '').trim().split(/\s+/).filter(Boolean).map(Number);
    for (const childPid of children) {
      if (!Number.isSafeInteger(childPid) || childPid <= 0) continue;
      await visit(childPid);
      pids.push(childPid);
    }
  };
  await visit(root);
  return { pids, complete: errors.length === 0, errors };
}

export async function listLinuxDescendantPids(parentPid, options = {}) {
  const result = await scanLinuxDescendantPids(parentPid, options);
  return result.pids;
}

export async function readLinuxProcessIdentity(pid, { readText = path => readFile(path, 'utf8') } = {}) {
  const value = Number(pid);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('pid must be a positive safe integer');
  try {
    const stat = String(await readText(`/proc/${value}/stat`));
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) throw new Error('invalid /proc stat format');
    const fieldsFromState = stat.slice(closeParen + 1).trim().split(/\s+/);
    const startTime = fieldsFromState[19];
    if (!startTime) throw new Error('missing /proc starttime');
    return { pid: value, startTime };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw error;
  }
}

export async function snapshotLinuxProcessTree(parentPid, {
  listDescendants = null,
  readIdentity = null,
  readText = path => readFile(path, 'utf8'),
} = {}) {
  const root = Number(parentPid);
  const identityReader = readIdentity || (pid => readLinuxProcessIdentity(pid, { readText }));
  const enumeration = listDescendants
    ? await listDescendants(root)
    : await scanLinuxDescendantPids(root, { readText });
  const descendantPids = Array.isArray(enumeration) ? enumeration : enumeration?.pids || [];
  const errors = Array.isArray(enumeration?.errors) ? [...enumeration.errors] : [];
  let complete = Array.isArray(enumeration) ? true : enumeration?.complete !== false;
  let parent = null;
  try {
    parent = await identityReader(root);
    if (!parent) {
      complete = false;
      errors.push({ pid: root, stage: 'identity', code: 'IDENTITY_UNAVAILABLE', name: 'Error' });
    }
  } catch (error) {
    complete = false;
    errors.push({ pid: root, stage: 'identity', code: error?.code || 'UNKNOWN', name: error?.name || 'Error' });
  }
  const descendants = [];
  for (const pid of descendantPids) {
    try {
      const identity = await identityReader(pid);
      if (identity) descendants.push(identity);
      else {
        complete = false;
        errors.push({ pid, stage: 'identity', code: 'IDENTITY_UNAVAILABLE', name: 'Error' });
      }
    } catch (error) {
      complete = false;
      errors.push({ pid, stage: 'identity', code: error?.code || 'UNKNOWN', name: error?.name || 'Error' });
    }
  }
  return { parent, descendants, complete: complete && errors.length === 0, errors };
}

function sameIdentity(expected, current) {
  return Boolean(expected)
    && Boolean(current)
    && Number(expected.pid) === Number(current.pid)
    && String(expected.startTime) === String(current.startTime);
}

async function signalLinuxProcessSnapshot(snapshot, {
  readIdentity = pid => readLinuxProcessIdentity(pid),
  signalPid = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const descendants = Array.isArray(snapshot?.descendants) ? snapshot.descendants : [];
  let complete = true;
  for (const identity of descendants) {
    let current;
    try {
      current = await readIdentity(identity.pid);
    } catch {
      complete = false;
      continue;
    }
    if (!sameIdentity(identity, current)) continue;
    try {
      signalPid(identity.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') complete = false;
    }
  }
  return complete;
}

async function confirmLinuxProcessSnapshotStopped(snapshot, {
  readIdentity = pid => readLinuxProcessIdentity(pid),
  deadlineMs = 5000,
  timers = { setTimeout },
  now = () => Date.now(),
} = {}) {
  const descendants = Array.isArray(snapshot?.descendants) ? snapshot.descendants : [];
  const deadlineAt = now() + Math.max(0, Number(deadlineMs) || 0);
  while (true) {
    let remaining = false;
    for (const identity of descendants) {
      let current;
      try {
        current = await readIdentity(identity.pid);
      } catch {
        return false;
      }
      if (sameIdentity(identity, current)) {
        remaining = true;
        break;
      }
    }
    if (!remaining) return true;
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) return false;
    await new Promise(resolve => timers.setTimeout(resolve, Math.min(25, remainingMs)));
  }
}

export async function terminateLinuxProcessSnapshot(snapshot, options = {}) {
  const signaled = await signalLinuxProcessSnapshot(snapshot, options);
  const stopped = await confirmLinuxProcessSnapshotStopped(snapshot, options);
  return signaled && stopped && snapshot?.complete !== false;
}

function mergeProcessTreeSnapshots(first, second) {
  const descendants = new Map();
  for (const identity of [...(first?.descendants || []), ...(second?.descendants || [])]) {
    descendants.set(`${identity.pid}:${identity.startTime}`, identity);
  }
  const laterComplete = second?.complete !== false;
  return {
    parent: first?.parent || second?.parent || null,
    descendants: [...descendants.values()],
    complete: laterComplete,
    errors: laterComplete
      ? [...(second?.errors || [])]
      : [...(first?.errors || []), ...(second?.errors || [])],
  };
}

export async function terminateLinuxProcessTree(child, snapshotOrOptions = {}, maybeOptions = {}) {
  if (!child || !Number.isSafeInteger(Number(child.pid))) throw new TypeError('child with pid is required');
  const hasSnapshot = Object.hasOwn(snapshotOrOptions || {}, 'descendants');
  const options = hasSnapshot ? maybeOptions : snapshotOrOptions;
  if (!hasSnapshot) {
    const {
      listDescendants = listLinuxDescendantPids,
      signalPid = (pid, signal) => process.kill(pid, signal),
    } = options;
    const descendants = await listDescendants(Number(child.pid));
    for (const pid of descendants) {
      try {
        signalPid(pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    child.kill('SIGKILL');
    return true;
  }

  await signalLinuxProcessSnapshot(snapshotOrOptions, options);
  let parentIdentityConfirmed = false;
  if (isAlive(child) && snapshotOrOptions?.parent) {
    try {
      const readIdentity = options.readIdentity || (pid => readLinuxProcessIdentity(pid));
      const currentParent = await readIdentity(Number(child.pid));
      parentIdentityConfirmed = sameIdentity(snapshotOrOptions.parent, currentParent);
    } catch {
      parentIdentityConfirmed = false;
    }
  }
  if (isAlive(child) && parentIdentityConfirmed) child.kill('SIGKILL');
  const deadlineMs = options.deadlineMs || 5000;
  const waitTimers = options.timers || { setTimeout, clearTimeout };
  const [descendantsStopped, parentStopped] = await Promise.all([
    terminateLinuxProcessSnapshot(snapshotOrOptions, { ...options, signalPid: () => {} }),
    parentIdentityConfirmed ? waitForExit([child], deadlineMs, waitTimers) : Promise.resolve(true),
  ]);
  return descendantsStopped
    && parentStopped
    && (!parentIdentityConfirmed || !isAlive(child));
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
  beforeFirstStart = null,
  respawnDelayMs = 5000,
  startupStaggerDelayMs = 12000,
  gracefulDeadlineMs,
  killConfirmDeadlineMs,
  shutdownDeadlineMs,
  processIdentityPolicy = process.platform === 'linux' ? 'linux-proc' : 'child-handle',
  captureProcessIdentity = pid => readLinuxProcessIdentity(pid),
  identityCaptureDeadlineMs = 100,
  identityCaptureAttempts = 3,
  identityCaptureRetryMs = 5,
  captureProcessTree = pid => snapshotLinuxProcessTree(pid),
  terminateProcessTree = terminateLinuxProcessTree,
  timers = { setTimeout, clearTimeout },
  logger = console,
} = {}) {
  if (typeof spawnWorker !== 'function') throw new TypeError('spawnWorker is required');
  if (typeof shouldAutoStart !== 'function') throw new TypeError('shouldAutoStart is required');
  if (beforeFirstStart !== null && typeof beforeFirstStart !== 'function') {
    throw new TypeError('beforeFirstStart must be a function');
  }
  const workers = new Map();
  const respawns = new Map();
  const startupTimers = new Map();
  const ineligible = new Set();
  let shuttingDown = false;
  let shutdownPromise = null;
  let startupPrepared = false;
  let generation = 0;

  if (!['linux-proc', 'child-handle'].includes(processIdentityPolicy)) {
    throw new TypeError('processIdentityPolicy must be linux-proc or child-handle');
  }

  const delay = Number.isFinite(Number(respawnDelayMs)) && Number(respawnDelayMs) >= 0
    ? Number(respawnDelayMs)
    : 5000;
  const configuredGracefulDeadline = gracefulDeadlineMs ?? shutdownDeadlineMs ?? 30000;
  const gracefulDeadline = Number.isFinite(Number(configuredGracefulDeadline)) && Number(configuredGracefulDeadline) > 0
    ? Number(configuredGracefulDeadline)
    : 30000;
  const configuredKillDeadline = killConfirmDeadlineMs ?? shutdownDeadlineMs ?? 5000;
  const killDeadline = Number.isFinite(Number(configuredKillDeadline)) && Number(configuredKillDeadline) > 0
    ? Number(configuredKillDeadline)
    : 5000;
  const startupDelay = Number.isFinite(Number(startupStaggerDelayMs)) && Number(startupStaggerDelayMs) >= 0
    ? Number(startupStaggerDelayMs)
    : 12000;
  const identityDeadline = Number.isFinite(Number(identityCaptureDeadlineMs)) && Number(identityCaptureDeadlineMs) >= 0
    ? Number(identityCaptureDeadlineMs)
    : 100;
  const identityAttempts = Number.isSafeInteger(Number(identityCaptureAttempts)) && Number(identityCaptureAttempts) > 0
    ? Number(identityCaptureAttempts)
    : 3;
  const identityRetryDelay = Number.isFinite(Number(identityCaptureRetryMs)) && Number(identityCaptureRetryMs) >= 0
    ? Number(identityCaptureRetryMs)
    : 5;

  function captureIdentityWithDeadline(pid, cancellation = null) {
    if (processIdentityPolicy === 'child-handle') return Promise.resolve({ pid, startTime: null });
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return Promise.resolve(null);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(Object.assign(
        new Error('worker process identity read deadline exceeded'),
        { code: 'WPP_COMPANY_WORKER_IDENTITY_READ_FAILED' },
      )), identityDeadline);
      timer?.unref?.();
    });
    let capture;
    try {
      capture = Promise.resolve(captureProcessIdentity(Number(pid)));
    } catch (error) {
      capture = Promise.reject(error);
    }
    const racers = cancellation
      ? [capture, deadline, cancellation.then(() => null)]
      : [capture, deadline];
    return Promise.race(racers).finally(() => timers.clearTimeout(timer));
  }

  function isCurrentCaptureGeneration(record) {
    return workers.get(record.key) === record
      && record.child === record.childHandle
      && Number(record.child?.pid) === record.expectedPid
      && record.captureInvalidated !== true
      && record.terminalConfirmed !== true
      && isAlive(record.child);
  }

  function cancelIdentityCapture(record, reason, { terminalConfirmed = false } = {}) {
    const firstInvalidation = record.captureInvalidated !== true;
    const firstTerminalConfirmation = terminalConfirmed && record.terminalConfirmed !== true;
    record.captureInvalidated = true;
    record.captureInvalidationReason = reason;
    if (terminalConfirmed) {
      record.terminalConfirmed = true;
      record.terminalEvent = reason;
    }
    if (record.identityRetryTimer) {
      timers.clearTimeout(record.identityRetryTimer);
      record.identityRetryTimer = null;
    }
    if (firstInvalidation) record.resolveIdentityCancellation?.();
    return terminalConfirmed ? firstTerminalConfirmation : firstInvalidation;
  }

  function waitForIdentityRetry(record) {
    if (!isCurrentCaptureGeneration(record)) return Promise.resolve(false);
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (record.identityRetryTimer) timers.clearTimeout(record.identityRetryTimer);
        record.identityRetryTimer = null;
        resolve(result);
      };
      record.identityRetryTimer = timers.setTimeout(() => finish(true), identityRetryDelay);
      record.identityRetryTimer?.unref?.();
      record.identityCancellation.then(() => finish(false));
    });
  }

  async function captureInitialIdentity(record) {
    for (let attempt = 0; attempt < identityAttempts; attempt += 1) {
      if (!isCurrentCaptureGeneration(record)) return null;
      let identity = null;
      try {
        identity = await captureIdentityWithDeadline(record.expectedPid, record.identityCancellation);
      } catch {
        identity = null;
      }
      if (!isCurrentCaptureGeneration(record)) return null;
      if (identity && Number(identity.pid) === record.expectedPid) return identity;
      if (attempt + 1 < identityAttempts && identityRetryDelay > 0) {
        if (!isCurrentCaptureGeneration(record)) return null;
        if (!await waitForIdentityRetry(record)) return null;
        if (!isCurrentCaptureGeneration(record)) return null;
      }
    }
    return null;
  }

  function createWorkerRecord(key, child) {
    let resolveIdentityCancellation;
    const identityCancellation = new Promise(resolve => { resolveIdentityCancellation = resolve; });
    const record = {
      key,
      child,
      childHandle: child,
      expectedPid: Number(child?.pid),
      generation: ++generation,
      initialIdentityPromise: null,
      identityCancellation,
      resolveIdentityCancellation,
      identityRetryTimer: null,
      captureInvalidated: false,
      captureInvalidationReason: null,
      terminalConfirmed: false,
      terminalEvent: null,
    };
    return record;
  }

  function prepareStartup() {
    if (startupPrepared) return true;
    if (shuttingDown || workers.size > 0 || respawns.size > 0 || startupTimers.size > 0) return false;
    try {
      beforeFirstStart?.();
      startupPrepared = true;
      return true;
    } catch (error) {
      logger.warn('[WPP EMPRESA] startup preparation failed:', { error });
      return false;
    }
  }

  function scheduleRespawn(empresaId, reason = 'exit') {
    const { key, value } = normalizeEmpresaId(empresaId);
    if (shuttingDown || ineligible.has(key) || !shouldAutoStart() || respawns.has(key)) return;
    const timer = timers.setTimeout(() => {
      respawns.delete(key);
      if (shuttingDown || ineligible.has(key)) return;
      const result = ensure(value);
      logger.warn('[WPP EMPRESA] worker respawn:', value, { reason, ...result });
    }, delay);
    timer.unref?.();
    respawns.set(key, timer);
  }

  function ensure(empresaId) {
    const { key, value } = normalizeEmpresaId(empresaId);
    if (shuttingDown) return { started: false, reason: 'shutting_down' };
    if (ineligible.has(key)) return { started: false, reason: 'ineligible' };
    if (!shouldAutoStart()) return { started: false, reason: 'disabled' };
    if (!prepareStartup()) return { started: false, reason: 'startup_preparation_blocked' };
    const pending = respawns.get(key);
    if (pending) {
      timers.clearTimeout(pending);
      respawns.delete(key);
    }
    const existing = workers.get(key);
    if (isAlive(existing?.child)) return { started: false, reason: 'already_running', pid: existing.child.pid };
    if (existing) cancelIdentityCapture(existing, 'replaced');

    const child = spawnWorker(value);
    const record = createWorkerRecord(key, child);
    workers.set(key, record);
    const finishRecord = (terminalEvent, details, reason) => {
      if (!cancelIdentityCapture(record, terminalEvent, { terminalConfirmed: true })) return;
      if (workers.get(key) !== record) return;
      workers.delete(key);
      logger.warn(`[WPP EMPRESA] worker ${terminalEvent}:`, value, details);
      if (reason !== null) scheduleRespawn(value, reason);
    };
    child.on('error', error => {
      finishRecord('error', { error }, error?.code || 'spawn_error');
    });
    child.once('exit', (code, signal) => {
      finishRecord('exited', { code, signal }, code === 0 && signal == null
        ? null
        : signal || `code_${code ?? 'unknown'}`);
    });
    child.once('close', (code, signal) => {
      finishRecord('closed', { code, signal }, code === 0 && signal == null
        ? null
        : signal || `code_${code ?? 'unknown'}`);
    });
    record.initialIdentityPromise = captureInitialIdentity(record);
    return { started: true, pid: child.pid };
  }

  function scheduleBootRecovery(empresaIds) {
    if (shuttingDown) return { scheduled: 0, reason: 'shutting_down' };
    if (!shouldAutoStart()) return { scheduled: 0, reason: 'disabled' };
    const ids = [...new Map((Array.isArray(empresaIds) ? empresaIds : []).map(empresaId => {
      const normalized = normalizeEmpresaId(empresaId);
      return [normalized.key, normalized.value];
    })).values()];
    const eligibleIds = ids.filter(empresaId => !ineligible.has(String(empresaId)));
    if (ids.length > 0 && eligibleIds.length === 0) return { scheduled: 0, reason: 'ineligible' };
    if (eligibleIds.length > 0 && !prepareStartup()) {
      return { scheduled: 0, reason: 'startup_preparation_blocked' };
    }
    let scheduled = 0;
    for (const empresaId of eligibleIds) {
      const key = String(empresaId);
      if (workers.has(key) || startupTimers.has(key)) continue;
      if (scheduled === 0) {
        ensure(empresaId);
      } else {
        const timer = timers.setTimeout(() => {
          startupTimers.delete(key);
          if (shuttingDown || ineligible.has(key)) return;
          ensure(empresaId);
        }, startupDelay * scheduled);
        timer.unref?.();
        startupTimers.set(key, timer);
      }
      scheduled += 1;
    }
    return { scheduled };
  }

  async function captureTree(child, metadata = {}) {
    try {
      return await captureProcessTree(Number(child.pid));
    } catch (error) {
      logger.warn('[WPP EMPRESA] process tree snapshot failed:', {
        ...metadata,
        pid: child.pid,
        errorName: error?.name || 'Error',
      });
      return {
        parent: null,
        descendants: [],
        complete: false,
        errors: [{ pid: Number(child.pid), stage: 'snapshot', code: error?.code || 'UNKNOWN', name: error?.name || 'Error' }],
      };
    }
  }

  async function captureAnchoredTree(record, metadata = {}) {
    const { child } = record;
    if (processIdentityPolicy === 'child-handle') {
      return { originalStopped: !isAlive(child), snapshot: null };
    }
    const initialIdentity = await record.initialIdentityPromise;
    if (record.terminalConfirmed) return { originalStopped: true, snapshot: null };
    if (!isCurrentCaptureGeneration(record)) {
      throw Object.assign(
        new Error('WhatsApp Empresa worker identity could not be confirmed'),
        { code: 'WPP_COMPANY_WORKER_IDENTITY_UNCONFIRMED' },
      );
    }
    if (!initialIdentity) {
      throw Object.assign(
        new Error('WhatsApp Empresa worker identity could not be confirmed'),
        { code: 'WPP_COMPANY_WORKER_IDENTITY_UNCONFIRMED' },
      );
    }
    const currentIdentity = await captureIdentityWithDeadline(record.expectedPid);
    if (record.terminalConfirmed) return { originalStopped: true, snapshot: null };
    if (!isCurrentCaptureGeneration(record)) {
      throw Object.assign(
        new Error('WhatsApp Empresa worker identity could not be confirmed'),
        { code: 'WPP_COMPANY_WORKER_IDENTITY_UNCONFIRMED' },
      );
    }
    if (!sameIdentity(initialIdentity, currentIdentity)) {
      return { originalStopped: true, snapshot: null };
    }
    const snapshot = await captureTree(child, metadata);
    if (record.terminalConfirmed) return { originalStopped: true, snapshot: null };
    if (!isCurrentCaptureGeneration(record)) {
      throw new Error('WhatsApp Empresa worker process tree identity could not be confirmed');
    }
    if (!sameIdentity(initialIdentity, snapshot?.parent)) {
      const afterSnapshotIdentity = await captureIdentityWithDeadline(record.expectedPid);
      if (record.terminalConfirmed) return { originalStopped: true, snapshot: null };
      if (!isCurrentCaptureGeneration(record)) {
        throw new Error('WhatsApp Empresa worker process tree identity could not be confirmed');
      }
      if (!sameIdentity(initialIdentity, afterSnapshotIdentity)) {
        return { originalStopped: true, snapshot: null };
      }
      throw new Error('WhatsApp Empresa worker process tree identity could not be confirmed');
    }
    const beforeSignalIdentity = await captureIdentityWithDeadline(record.expectedPid);
    if (record.terminalConfirmed) return { originalStopped: true, snapshot };
    if (!isCurrentCaptureGeneration(record)) {
      throw new Error('WhatsApp Empresa worker process tree identity could not be confirmed');
    }
    if (!sameIdentity(initialIdentity, beforeSignalIdentity)) {
      return { originalStopped: true, snapshot };
    }
    return {
      originalStopped: false,
      snapshot: { ...snapshot, parent: initialIdentity },
    };
  }

  async function cleanupTree(record, initialSnapshot, metadata = {}) {
    const { child } = record;
    let snapshot = initialSnapshot;
    let originalParentStopped = !isAlive(child);
    if (isAlive(child)) {
      if (processIdentityPolicy === 'linux-proc') {
        const initialIdentity = await record.initialIdentityPromise;
        const currentIdentity = await captureIdentityWithDeadline(child.pid);
        if (!sameIdentity(initialIdentity, currentIdentity)) {
          originalParentStopped = true;
        } else {
          const recaptured = await captureTree(child, metadata);
          if (!sameIdentity(initialIdentity, recaptured?.parent)) {
            originalParentStopped = true;
          } else {
            snapshot = mergeProcessTreeSnapshots(snapshot, { ...recaptured, parent: initialIdentity });
          }
        }
      } else {
        const recaptured = await captureTree(child, metadata);
        snapshot = mergeProcessTreeSnapshots(snapshot, recaptured);
      }
    }
    if (!snapshot) return originalParentStopped;
    if (originalParentStopped && snapshot.descendants.length === 0 && snapshot.complete !== false) return true;
    const cleaned = await terminateProcessTree(child, snapshot, {
      deadlineMs: killDeadline,
      timers,
    });
    if (cleaned !== true) return false;
    return originalParentStopped || !isAlive(child);
  }

  async function stopRecord(record, metadata = {}) {
    const { child } = record;
    if (processIdentityPolicy === 'child-handle') {
      if (!isAlive(child)) return true;
      child.kill('SIGTERM');
      await waitForExit([child], gracefulDeadline, timers);
      if (!isAlive(child)) return true;
      child.kill('SIGKILL');
      const confirmed = await waitForExit([child], killDeadline, timers);
      return confirmed && !isAlive(child);
    }
    const anchored = await captureAnchoredTree(record, metadata);
    if (anchored.originalStopped && !anchored.snapshot) return true;
    if (!anchored.originalStopped && isAlive(child)) child.kill('SIGTERM');
    if (!anchored.originalStopped) await waitForExit([child], gracefulDeadline, timers);
    return cleanupTree(record, anchored.snapshot, metadata);
  }

  async function reconcileEligibility(empresaId, eligible) {
    const { key } = normalizeEmpresaId(empresaId);
    if (eligible === true) {
      ineligible.delete(key);
      return { eligible: true, stopped: false };
    }

    ineligible.add(key);
    const respawn = respawns.get(key);
    if (respawn) timers.clearTimeout(respawn);
    respawns.delete(key);
    const startup = startupTimers.get(key);
    if (startup) timers.clearTimeout(startup);
    startupTimers.delete(key);

    const record = workers.get(key);
    if (!isAlive(record?.child)) {
      workers.delete(key);
      return { eligible: false, stopped: false };
    }

    let cleaned = false;
    let stopError = null;
    try {
      cleaned = await stopRecord(record, { empresaId: Number(key) });
    } catch (error) {
      stopError = error;
      logger.warn('[WPP EMPRESA] process tree termination failed:', {
        empresaId: Number(key),
        errorName: error?.name || 'Error',
      });
    }
    if (workers.get(key) === record && cleaned) workers.delete(key);
    if (stopError?.code === 'WPP_COMPANY_WORKER_IDENTITY_UNCONFIRMED') throw stopError;
    if (!cleaned) throw new Error('WhatsApp Empresa worker stop could not be confirmed');
    return { eligible: false, stopped: true };
  }

  function getCompanyState(empresaId) {
    const { key } = normalizeEmpresaId(empresaId);
    const child = workers.get(key)?.child;
    return {
      eligible: !ineligible.has(key),
      active: isAlive(child),
      pid: isAlive(child) ? child.pid : null,
      respawnPending: respawns.has(key),
      startupPending: startupTimers.has(key),
    };
  }

  async function restoreCompanyState(empresaId, state = {}) {
    const { key, value } = normalizeEmpresaId(empresaId);
    if (state.eligible === false) {
      await reconcileEligibility(value, false);
      return { restored: ineligible.has(key), eligible: false, active: false };
    }

    await reconcileEligibility(value, true);
    if (state.active !== true) {
      return { restored: !ineligible.has(key), eligible: true, active: false };
    }

    const ensured = ensure(value);
    const current = workers.get(key)?.child;
    if (!isAlive(current)) throw new Error('WhatsApp Empresa worker successor was not created');
    return {
      restored: true,
      eligible: true,
      active: true,
      successorPid: current.pid,
      started: ensured.started === true,
    };
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    for (const timer of respawns.values()) timers.clearTimeout(timer);
    respawns.clear();
    for (const timer of startupTimers.values()) timers.clearTimeout(timer);
    startupTimers.clear();
    shutdownPromise = (async () => {
      const records = [...workers.values()].filter(record => isAlive(record?.child));
      const cleanupResults = await Promise.all(records.map(async record => {
        try {
          return await stopRecord(record);
        } catch (error) {
          logger.warn('[WPP EMPRESA] process tree termination failed:', {
            pid: record.child?.pid,
            errorName: error?.name || 'Error',
          });
          return false;
        }
      }));
      return cleanupResults.every(Boolean);
    })();
    return shutdownPromise;
  }

  return {
    prepareStartup,
    ensure,
    scheduleBootRecovery,
    reconcileEligibility,
    getCompanyState,
    restoreCompanyState,
    shutdown,
    snapshot: () => ({ shuttingDown, workers: workers.size, respawns: respawns.size }),
    _deadlines: {
      gracefulDeadlineMs: gracefulDeadline,
      killConfirmDeadlineMs: killDeadline,
      worstCaseMs: gracefulDeadline + killDeadline,
    },
  };
}
