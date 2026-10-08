const API_ROOT = '/api/admin/whatsapp-cloud';
const ALLOWED_QUERY_KEYS = new Set(['role', 'companyId', 'cursor', 'limit', 'tenantInBody', 'from', 'to', 'payment', 'workflowStatus', 'priority', 'unread']);
const MASKED_PARTICIPANT = /^\*{3,11}\d{4}$/;

const STATUS = Object.freeze({
  queued: Object.freeze({ label: 'En cola', tone: 'pending', help: 'El mensaje espera procesamiento.', retrySafe: false }),
  pending: Object.freeze({ label: 'En cola', tone: 'pending', help: 'El mensaje espera procesamiento.', retrySafe: false }),
  sending: Object.freeze({ label: 'Enviando', tone: 'pending', help: 'El mensaje se está enviando.', retrySafe: false }),
  sent: Object.freeze({ label: 'Enviado', tone: 'sent', help: 'Meta aceptó el mensaje.', retrySafe: false }),
  delivered: Object.freeze({ label: 'Entregado', tone: 'delivered', help: 'El mensaje llegó al dispositivo.', retrySafe: false }),
  read: Object.freeze({ label: 'Leído', tone: 'read', help: 'El destinatario abrió el mensaje.', retrySafe: false }),
  failed: Object.freeze({ label: 'Falló', tone: 'failed', help: 'El envío falló. Revisá el estado antes de crear un mensaje nuevo.', retrySafe: false }),
  outcome_unknown: Object.freeze({ label: 'Resultado incierto', tone: 'unknown', help: 'No vuelvas a enviar: el proveedor podría haber aceptado el mensaje.', retrySafe: false }),
  received: Object.freeze({ label: 'Recibido', tone: 'received', help: 'Mensaje entrante recibido.', retrySafe: false }),
});
const PUBLIC_REPLY_ACCEPTANCE_STATUS = 'accepted';

export function statusMeta(value) {
  return STATUS[String(value || '').toLowerCase()] || Object.freeze({
    label: 'Sin estado', tone: 'neutral', help: 'Estado no disponible.', retrySafe: false,
  });
}

export function safeParticipant(value) {
  const participant = String(value || '');
  return MASKED_PARTICIPANT.test(participant) ? participant : 'Contacto protegido';
}

export function conversationPreview(conversation = {}) {
  const type = String(conversation.lastMessageType || '').toLowerCase();
  if (type === 'image') return 'Imagen';
  if (type === 'document') return 'Documento';
  if (type === 'audio') return 'Audio';
  if (type === 'video') return 'Video';
  if (type === 'sticker') return 'Sticker';
  if (type === 'location') return 'Ubicación';
  if (type === 'contacts') return 'Contacto';
  return 'Mensaje de texto';
}

function positiveInteger(value, field) {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`${field} inválido`);
  return normalized;
}

export function bootstrapInboxState(user = {}) {
  const role = typeof user.role === 'string' ? user.role : '';
  if (role === 'admin') {
    const companyId = Number(user.empresa_id);
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      return { access: 'denied', role, companyId: null, needsCompanySelection: false };
    }
    return { access: 'ready', role, companyId, needsCompanySelection: false };
  }
  if (role === 'super') {
    return { access: 'ready', role, companyId: null, needsCompanySelection: true };
  }
  return { access: 'denied', role, companyId: null, needsCompanySelection: false };
}

function strictIsoUtc(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${field} de fecha inválido`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} de fecha inválido`);
  }
  return value;
}

export function buildCloudApiUrl(path, options = {}) {
  for (const key of Object.keys(options)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new Error(`Parámetro no permitido: ${key}`);
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?')) throw new Error('Ruta inválida');
  const role = String(options.role || '').toLowerCase();
  const params = new URLSearchParams();
  if (role === 'super') {
    const companyId = positiveInteger(options.companyId, 'Empresa');
    if (options.tenantInBody !== true) params.set('empresa_id', String(companyId));
  }
  if (options.limit != null) params.set('limit', String(positiveInteger(options.limit, 'Límite')));
  if (options.cursor != null) {
    const cursor = String(options.cursor);
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error('Cursor inválido');
    params.set('cursor', cursor);
  }
  const from = strictIsoUtc(options.from, 'Desde');
  const to = strictIsoUtc(options.to, 'Hasta');
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (from && to && Date.parse(from) >= Date.parse(to)) throw new Error('Rango de fecha inválido');
  if (options.payment != null && options.payment !== '') {
    if (options.payment !== 'transferencia') throw new Error('Filtro de pago inválido');
    params.set('payment', options.payment);
  }
  if (options.workflowStatus != null && options.workflowStatus !== '') {
    if (!['pending', 'resolved'].includes(options.workflowStatus)) throw new Error('Filtro de workflow inválido');
    params.set('workflowStatus', options.workflowStatus);
  }
  if (options.priority != null && options.priority !== '') {
    if (!['normal', 'high', 'urgent'].includes(options.priority)) throw new Error('Filtro de prioridad inválido');
    params.set('priority', options.priority);
  }
  if (options.unread != null) {
    if (typeof options.unread !== 'boolean') throw new Error('Filtro de no leídos inválido');
    params.set('unread', String(options.unread));
  }
  const query = params.toString();
  return `${API_ROOT}${path}${query ? `?${query}` : ''}`;
}

export function mergeHistoryPage(current = [], older = []) {
  const byId = new Map();
  for (const message of [...older, ...current]) {
    if (message && message.id != null) byId.set(String(message.id), message);
  }
  return [...byId.values()].sort((left, right) => {
    const timeDelta = Date.parse(left.messageAt || 0) - Date.parse(right.messageAt || 0);
    if (timeDelta !== 0) return timeDelta;
    return String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
  });
}

export function operationalMeta(conversation = {}) {
  if (conversation.workflowStatus === 'resolved') return { key: 'resolved', label: 'Respondida', tone: 'resolved' };
  const status = String(conversation.lastDeliveryStatus || '').toLowerCase();
  if (conversation.lastDirection === 'outbound' && ['failed', 'outcome_unknown'].includes(status)) {
    return { key: 'review', label: 'Revisar', tone: 'failed' };
  }
  if (conversation.lastDirection === 'outbound' && ['queued', 'pending', 'sending'].includes(status)) {
    return { key: 'inProcess', label: 'En proceso', tone: 'pending' };
  }
  if (conversation.workflowStatus === 'pending'
    && (Number(conversation.unreadCount) > 0 || conversation.lastDirection === 'inbound')) {
    return { key: 'pending', label: 'Por responder', tone: 'pending' };
  }
  return { key: 'resolved', label: 'Respondida', tone: 'resolved' };
}

function canonicalQueueRanks(conversation = {}) {
  const operation = operationalMeta(conversation).key;
  const queueBucket = { pending: 0, review: 1, inProcess: 2, resolved: 3 }[operation] ?? 3;
  const queuePriorityRank = queueBucket === 0
    ? ({ urgent: 0, high: 1, normal: 2 }[conversation.priority] ?? 2)
    : 0;
  return { queueBucket, queuePriorityRank };
}

function canonicalActivityKey(conversation, queueBucket) {
  const latest = String(conversation.lastMessageActivityKey ?? '');
  const inbound = String(conversation.lastInboundActivityKey ?? '');
  if (!/^[0-9]+$/.test(latest)) return null;
  const absolute = queueBucket === 0 && /^[0-9]+$/.test(inbound) ? inbound : latest;
  return queueBucket === 0 ? absolute : `-${absolute}`;
}

function withCanonicalQueueRanks(conversation) {
  const ranks = canonicalQueueRanks(conversation);
  const queueActivityKey = canonicalActivityKey(conversation, ranks.queueBucket);
  return {
    ...conversation,
    ...ranks,
    ...(queueActivityKey == null ? {} : { queueActivityKey }),
  };
}

export function queueCounterItems(counters = {}) {
  return [
    ['total', 'Total'], ['pending', 'Por responder'], ['inProcess', 'En proceso'],
    ['review', 'Revisar'], ['resolved', 'Respondidas'],
  ].map(([key, label]) => ({ key, label, value: Number(counters[key]) || 0 }));
}

export function mergeConversationState(local = {}, current = {}) {
  if (String(local.conversationId) !== String(current.conversationId)) return { ...local };
  const merged = { ...local };
  if (['pending', 'resolved'].includes(current.workflowStatus)) merged.workflowStatus = current.workflowStatus;
  if (['normal', 'high', 'urgent'].includes(current.priority)) merged.priority = current.priority;
  if (Number.isInteger(current.version) && current.version > 0) merged.version = current.version;
  return merged;
}

function canonicalIntegerKey(value, fallback) {
  const rendered = String(value ?? '');
  if (/^-?[0-9]+$/.test(rendered)) return BigInt(rendered);
  return BigInt(fallback);
}

function conversationOrderTuple(conversation) {
  const ranks = canonicalQueueRanks(conversation);
  const bucket = Number.isInteger(conversation.queueBucket) ? conversation.queueBucket : ranks.queueBucket;
  const priority = Number.isInteger(conversation.queuePriorityRank)
    ? conversation.queuePriorityRank
    : ranks.queuePriorityRank;
  const timestamp = Date.parse(conversation.effectiveActivityAt || conversation.lastMessageAt || 0) || 0;
  const fallbackActivity = bucket === 0 ? timestamp * 1000 : -timestamp * 1000;
  const derivedActivity = canonicalActivityKey(conversation, bucket);
  return [
    bucket,
    priority,
    canonicalIntegerKey(derivedActivity ?? conversation.queueActivityKey, fallbackActivity),
    canonicalIntegerKey(conversation.lastMessageId, 0),
    String(conversation.conversationId),
  ];
}

function conversationMatchesFilters(conversation, filters = {}) {
  if (filters.workflowStatus && conversation.workflowStatus !== filters.workflowStatus) return false;
  if (filters.priority && conversation.priority !== filters.priority) return false;
  if (filters.unread === true && Number(conversation.unreadCount) <= 0) return false;
  return true;
}

const CONVERSATION_REFRESH_FIELDS = Object.freeze([
  'conversationId', 'participant', 'customerName', 'customerAddress', 'paymentMethod', 'unreadCount',
  'workflowStatus', 'priority', 'version', 'lastDirection', 'lastMessageType', 'lastDeliveryStatus',
  'lastMessageAt', 'queueBucket', 'queuePriorityRank', 'queueActivityKey', 'effectiveActivityAt',
  'lastMessageActivityKey', 'lastInboundActivityKey', 'lastMessageId',
]);

function allowlistedConversation(conversation = {}) {
  const clean = {};
  for (const field of CONVERSATION_REFRESH_FIELDS) {
    if (Object.hasOwn(conversation, field)) clean[field] = conversation[field];
  }
  return clean;
}

export function mergeCanonicalConversationRefresh({
  current = [], incomingFirstPage = [], previousFirstPageIds = [], authoritativeRemovedIds = [],
} = {}) {
  const removed = new Set(authoritativeRemovedIds.map(String));
  const byId = new Map();
  for (const item of current) {
    const id = String(item?.conversationId || '');
    if (id && !removed.has(id)) byId.set(id, allowlistedConversation(item));
  }
  const firstPageIds = [];
  for (const item of incomingFirstPage) {
    const clean = allowlistedConversation(item);
    const id = String(clean.conversationId || '');
    if (!id || firstPageIds.includes(id)) continue;
    firstPageIds.push(id);
    byId.set(id, clean);
  }
  const conversations = [...byId.values()].sort((left, right) => {
    const a = conversationOrderTuple(left);
    const b = conversationOrderTuple(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] < b[index]) return -1;
      if (a[index] > b[index]) return 1;
    }
    return 0;
  });
  return { conversations, firstPageIds, previousFirstPageIds: previousFirstPageIds.map(String) };
}

export function captureVisibleScrollAnchor(container) {
  if (!container || typeof container.getBoundingClientRect !== 'function') return null;
  const containerRect = container.getBoundingClientRect();
  const messages = container.querySelectorAll?.('[data-message-id]') || [];
  for (const message of messages) {
    const messageId = String(message?.dataset?.messageId || '');
    if (!messageId || typeof message.getBoundingClientRect !== 'function') continue;
    const rect = message.getBoundingClientRect();
    if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
      return {
        messageId,
        offsetTop: rect.top - containerRect.top,
        previousTop: container.scrollTop,
      };
    }
  }
  return null;
}

export function restoreVisibleScrollAnchor(container, anchor) {
  if (!container || !anchor) return false;
  const messages = container.querySelectorAll?.('[data-message-id]') || [];
  const target = [...messages].find(message => String(message?.dataset?.messageId || '') === anchor.messageId);
  if (!target || typeof target.getBoundingClientRect !== 'function') {
    container.scrollTop = anchor.previousTop;
    return false;
  }
  const containerTop = container.getBoundingClientRect().top;
  const currentOffset = target.getBoundingClientRect().top - containerTop;
  container.scrollTop += currentOffset - anchor.offsetTop;
  return true;
}

const DELIVERY_STATUS_RANK = Object.freeze({ queued: 0, pending: 0, sending: 1, sent: 2, delivered: 3, read: 4 });
const TERMINAL_DELIVERY_STATUSES = new Set(['failed', 'error', 'outcome_unknown']);

function messageCorrelationKeys(message = {}) {
  const keys = [];
  if (message.id != null) keys.push(`id:${String(message.id)}`);
  if (message.providerMessageId) keys.push(`provider:${String(message.providerMessageId)}`);
  if (message.idempotencyKey) keys.push(`idempotency:${String(message.idempotencyKey)}`);
  return keys;
}

function monotonicDeliveryStatus(previous, incoming) {
  const oldStatus = String(previous || '').toLowerCase();
  const nextStatus = String(incoming || '').toLowerCase();
  if (TERMINAL_DELIVERY_STATUSES.has(oldStatus)) return previous;
  if (TERMINAL_DELIVERY_STATUSES.has(nextStatus)) return incoming;
  return (DELIVERY_STATUS_RANK[nextStatus] ?? -1) >= (DELIVERY_STATUS_RANK[oldStatus] ?? -1)
    ? incoming : previous;
}

export function mergeLiveHistory(current = [], incoming = []) {
  const messages = [];
  const keyToIndex = new Map();
  const originalIds = new Set(current.map(item => String(item?.id ?? '')));
  for (const candidate of [...current, ...incoming]) {
    if (!candidate || candidate.id == null) continue;
    const keys = messageCorrelationKeys(candidate);
    const existingIndex = keys.map(key => keyToIndex.get(key)).find(index => index != null);
    if (existingIndex == null) {
      const index = messages.length;
      messages.push({ ...candidate });
      for (const key of keys) keyToIndex.set(key, index);
      continue;
    }
    const previous = messages[existingIndex];
    messages[existingIndex] = {
      ...previous,
      ...candidate,
      id: previous.id,
      deliveryStatus: monotonicDeliveryStatus(previous.deliveryStatus, candidate.deliveryStatus),
    };
    for (const key of messageCorrelationKeys(messages[existingIndex])) keyToIndex.set(key, existingIndex);
  }
  messages.sort((left, right) => {
    const delta = Date.parse(left.messageAt || 0) - Date.parse(right.messageAt || 0);
    return delta || String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
  });
  return {
    messages,
    newMessageIds: messages.map(item => String(item.id)).filter(id => !originalIds.has(id)),
  };
}

export function reconcileConversationCollection({
  conversations = [], current = {}, filters = {}, activeConversationId = null, allowUnread = false,
} = {}) {
  const currentId = String(current?.conversationId || '');
  let activeConversation = null;
  const merged = conversations.map(conversation => {
    const next = String(conversation.conversationId) === currentId
      ? withCanonicalQueueRanks({
          ...mergeConversationState(conversation, current),
          ...(allowUnread && Number.isInteger(current.unreadCount) && current.unreadCount >= 0
            ? { unreadCount: current.unreadCount } : {}),
        })
      : conversation;
    if (String(next.conversationId) === String(activeConversationId)) activeConversation = next;
    return next;
  });
  return {
    conversations: merged.filter(item => conversationMatchesFilters(item, filters)).sort((left, right) => {
      const a = conversationOrderTuple(left);
      const b = conversationOrderTuple(right);
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] < b[index]) return -1;
        if (a[index] > b[index]) return 1;
      }
      return 0;
    }),
    activeConversation,
  };
}

export function reconcileConversationMutation({
  conversations = [], activeConversation = null, current = {}, counters = {}, filters = {}, allowUnread = false,
  counterBaselineTrusted = true,
} = {}) {
  const currentId = String(current?.conversationId || '');
  const listed = conversations.find(item => String(item?.conversationId) === currentId) || null;
  const activeMatch = String(activeConversation?.conversationId) === currentId ? activeConversation : null;
  const mergeBase = listed || activeMatch;
  const counterBaseline = listed || activeMatch;
  if (!mergeBase) {
    return {
      conversations: [...conversations], activeConversation, counters: { ...counters }, countersNeedReload: false,
    };
  }
  const merged = withCanonicalQueueRanks({
    ...mergeConversationState(mergeBase, current),
    ...(allowUnread && Number.isInteger(current.unreadCount) && current.unreadCount >= 0
      ? { unreadCount: current.unreadCount } : {}),
  });
  const previousCounter = operationalMeta(counterBaseline).key;
  const nextCounter = operationalMeta(merged).key;
  const nextCounters = { ...counters };
  if (counterBaselineTrusted && previousCounter !== nextCounter) {
    if (Number.isInteger(nextCounters[previousCounter]) && nextCounters[previousCounter] > 0) {
      nextCounters[previousCounter] -= 1;
    }
    if (Number.isInteger(nextCounters[nextCounter])) nextCounters[nextCounter] += 1;
  }
  const reconciled = reconcileConversationCollection({
    conversations, current: merged, filters, activeConversationId: currentId, allowUnread: true,
  });
  return {
    conversations: reconciled.conversations,
    activeConversation: reconciled.activeConversation || merged,
    counters: nextCounters,
    countersNeedReload: !counterBaselineTrusted,
  };
}

export function createRequestGate() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(value) { return value === generation; },
  };
}

export function createChainedRefreshScheduler({
  isVisible,
  canRun,
  cycle,
  baseDelayMs,
  maxDelayMs,
  jitter = () => 0,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (typeof isVisible !== 'function' || typeof canRun !== 'function' || typeof cycle !== 'function') {
    throw new Error('Callbacks de auto-refresh requeridos');
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0
    || !Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error('Intervalo de auto-refresh inválido');
  }
  let running = false;
  let stopped = false;
  let inFlight = null;
  let timer = null;
  let failures = 0;
  let generation = 0;

  function clearTimer() {
    if (timer == null) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  function eligible() {
    return running && !stopped && isVisible() && canRun();
  }

  function nextDelay() {
    const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** failures));
    const adjustment = Number(jitter({ failures, delayMs: exponential })) || 0;
    return Math.max(0, Math.min(maxDelayMs, exponential + adjustment));
  }

  function schedule() {
    clearTimer();
    if (!eligible() || inFlight) return;
    const delay = nextDelay();
    timer = setTimeoutFn(() => {
      timer = null;
      runCycle()?.catch(() => {});
    }, delay);
  }

  function runCycle() {
    if (!eligible() || inFlight) return inFlight?.promise || null;
    generation += 1;
    const cycleGeneration = generation;
    const controller = new AbortController();
    let promise;
    try {
      promise = Promise.resolve(cycle({ signal: controller.signal, generation: cycleGeneration }));
    } catch (error) {
      promise = Promise.reject(error);
    }
    const current = { promise, controller, generation: cycleGeneration };
    inFlight = current;
    promise.then(
      () => {
        if (generation === cycleGeneration) failures = 0;
      },
      error => {
        if (generation === cycleGeneration && error?.name !== 'AbortError') {
          failures = Math.min(failures + 1, 30);
        }
      },
    ).finally(() => {
      if (inFlight === current) {
        inFlight = null;
        schedule();
      }
    });
    return promise;
  }

  return {
    start({ immediate = true } = {}) {
      if (stopped) return null;
      running = true;
      if (!immediate) {
        schedule();
        return null;
      }
      return runCycle();
    },
    resume() {
      if (stopped) return null;
      running = true;
      clearTimer();
      return runCycle();
    },
    pause() {
      running = false;
      clearTimer();
      generation += 1;
      inFlight?.controller.abort(new DOMException('Auto-refresh pausado', 'AbortError'));
      inFlight = null;
    },
    stop() {
      stopped = true;
      running = false;
      clearTimer();
      generation += 1;
      inFlight?.controller.abort(new DOMException('Auto-refresh detenido', 'AbortError'));
      inFlight = null;
    },
    snapshot() {
      return { running, stopped, inFlight: inFlight != null, failures, generation, timerScheduled: timer != null };
    },
  };
}

export function isListResponseCurrentForMutation(startedMutationRevision, currentMutationRevision) {
  return Number.isSafeInteger(startedMutationRevision)
    && Number.isSafeInteger(currentMutationRevision)
    && startedMutationRevision === currentMutationRevision;
}

const conversationListFilterKeys = Object.freeze([
  'from', 'to', 'payment', 'workflowStatus', 'priority', 'unread',
]);

function validConversationListContext(context) {
  return Boolean(context && typeof context === 'object'
    && Number.isSafeInteger(context.generation) && context.generation > 0
    && Number.isSafeInteger(context.contextRevision) && context.contextRevision >= 0
    && Number.isSafeInteger(context.mutationRevision) && context.mutationRevision >= 0
    && (context.companyId === null || (Number.isSafeInteger(context.companyId) && context.companyId > 0))
    && context.filters && typeof context.filters === 'object');
}

export function isConversationListContextCurrent(started, current) {
  return validConversationListContext(started)
    && validConversationListContext(current)
    && started.generation === current.generation
    && started.companyId === current.companyId
    && started.contextRevision === current.contextRevision
    && started.mutationRevision === current.mutationRevision
    && conversationListFilterKeys.every(key => started.filters[key] === current.filters[key]);
}

export function createSendDeadline({
  parentSignal,
  timeoutMs,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Deadline inválido');
  const controller = new AbortController();
  let timeoutReached = false;
  let cleaned = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeoutFn(() => {
    timeoutReached = true;
    controller.abort(new DOMException('Tiempo de envío agotado', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeoutFn(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

export function createSingleFlightSubmission({
  start,
  execute,
  settle,
  reject = () => {},
  finish = () => {},
  abortControllerFactory = () => new AbortController(),
} = {}) {
  if (typeof start !== 'function' || typeof execute !== 'function' || typeof settle !== 'function') {
    throw new Error('Callbacks de envío requeridos');
  }
  let active = null;
  return {
    async submit() {
      if (active) return false;
      const submission = start();
      const abortController = abortControllerFactory();
      const current = Object.freeze({ submission, abortController });
      active = current;
      try {
        const result = await execute(submission, { signal: abortController.signal });
        if (active !== current) return false;
        await settle(submission, result);
        return true;
      } catch (error) {
        if (active !== current) return false;
        await reject(submission, error);
        return true;
      } finally {
        if (active === current) {
          active = null;
          finish(submission);
        }
      }
    },
    abort(reason) {
      active?.abortController.abort(reason);
    },
    isActive() {
      return active != null;
    },
  };
}

export function reduceMobileView(state, action) {
  if (action?.type === 'open') {
    return { mobileView: 'detail', activeConversationId: String(action.conversationId) };
  }
  if (action?.type === 'back') return { mobileView: 'list', activeConversationId: null };
  return { ...state };
}

export function createComposerState(draft = '') {
  return {
    draft: String(draft),
    sending: false,
    pending: null,
    notice: '',
    canRetry: false,
    reconciliationRequired: false,
  };
}

export function startSubmission(state, idempotencyKey) {
  if (state?.sending) throw new Error('Ya hay un mensaje en envío');
  const originalDraft = String(state?.draft || '');
  const text = originalDraft.trim();
  if (!text) throw new Error('Ingresá un mensaje');
  if (text.length > 4096) throw new Error('El mensaje supera el límite de 4096 caracteres');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw new Error('Clave de envío inválida');
  }
  return {
    draft: originalDraft,
    sending: true,
    pending: { text, idempotencyKey },
    notice: '',
    canRetry: false,
    reconciliationRequired: false,
  };
}

function acceptedReplyResult(result = {}) {
  if (result.status !== 200 && result.status !== 202) return false;
  const payload = result.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.accepted !== true || payload.deduplicated !== (result.status === 200)) return false;
  if (typeof payload.id !== 'string' || !/^[1-9][0-9]*$/.test(payload.id)) return false;
  return payload.status === PUBLIC_REPLY_ACCEPTANCE_STATUS;
}

export function resolveSubmission(state, result = {}) {
  if (acceptedReplyResult(result)) {
    return {
      ...createComposerState(''),
      notice: result.status === 202
        ? 'Mensaje en cola. No se reenviará automáticamente.'
        : 'El envío original ya estaba registrado. No se creó un duplicado; revisá la conversación para conocer su estado.',
    };
  }
  const outcomeUnknown = result.status === 0
    || result.errorCode === 'reply_enqueue_outcome_unknown'
    || (result.status >= 200 && result.status < 300);
  return {
    draft: String(state?.draft || ''),
    sending: false,
    pending: outcomeUnknown && state?.pending ? { ...state.pending } : null,
    notice: outcomeUnknown
      ? 'Resultado incierto: puede haberse enviado. No vuelvas a enviar este mensaje; requiere reconciliación o iniciar un mensaje distinto.'
      : sanitizeCloudError(result.status, { error: result.errorCode }),
    canRetry: false,
    reconciliationRequired: outcomeUnknown,
  };
}

export function createInboxComposerController({ input, send }) {
  if (!input || !send) throw new Error('Controles del composer requeridos');

  let composer = createComposerState('');
  let context = { companyId: null, conversationId: null };
  let contextVersion = 0;
  let activationSequence = 0;
  let submissionSequence = 0;
  let activeSubmission = null;

  function render() {
    input.value = composer.draft;
    const enabled = context.conversationId != null && !composer.sending && !composer.reconciliationRequired;
    input.disabled = !enabled;
    send.disabled = !enabled;
    send.textContent = composer.sending ? 'Enviando…' : 'Enviar';
  }

  function resetComposer() {
    composer = createComposerState('');
    activeSubmission = null;
    contextVersion += 1;
    render();
  }

  function canChangeContext() {
    return !composer.sending && !composer.reconciliationRequired;
  }

  render();

  return {
    snapshot() {
      return {
        context: { ...context },
        composer: {
          ...composer,
          pending: composer.pending ? { ...composer.pending } : null,
        },
      };
    },
    captureDraft() {
      if (composer.sending) return false;
      composer = createComposerState(input.value);
      return true;
    },
    changeCompany(companyId) {
      if (!canChangeContext()) return false;
      context = { companyId: companyId ?? null, conversationId: null };
      resetComposer();
      return true;
    },
    beginConversationChange(conversationId) {
      if (!canChangeContext()) return null;
      context = { ...context, conversationId: null };
      resetComposer();
      activationSequence += 1;
      return Object.freeze({
        id: activationSequence,
        contextVersion,
        conversationId: String(conversationId),
      });
    },
    activateConversation(activation) {
      if (!activation || activation.contextVersion !== contextVersion || composer.sending) return false;
      context = { ...context, conversationId: activation.conversationId };
      render();
      return true;
    },
    closeConversation() {
      if (!canChangeContext()) return false;
      context = { ...context, conversationId: null };
      resetComposer();
      return true;
    },
    startSend(idempotencyKey) {
      if (context.conversationId == null) throw new Error('Seleccioná una conversación');
      if (composer.sending || activeSubmission) throw new Error('Ya hay un mensaje en envío');
      if (composer.reconciliationRequired) throw new Error('El resultado es incierto y requiere reconciliación');
      composer = createComposerState(input.value);
      composer = startSubmission(composer, idempotencyKey);
      submissionSequence += 1;
      activeSubmission = Object.freeze({
        id: submissionSequence,
        contextVersion,
        context: Object.freeze({ ...context }),
        pending: Object.freeze({ ...composer.pending }),
      });
      render();
      return activeSubmission;
    },
    settleSend(submission, result) {
      if (!activeSubmission
        || submission?.id !== activeSubmission.id
        || submission?.contextVersion !== contextVersion) return false;
      composer = resolveSubmission(composer, result);
      activeSubmission = null;
      render();
      return true;
    },
    discardUncertainDraft() {
      if (!composer.reconciliationRequired || composer.sending) return false;
      resetComposer();
      return true;
    },
  };
}

export function attachmentDownloadNotice(status) {
  if (status === 409) return 'La descarga todavía no está disponible.';
  if (status === 404) return 'El adjunto ya no está disponible.';
  return 'No se pudo descargar el adjunto.';
}

const PUBLIC_CLOUD_ERRORS = Object.freeze({
  access_denied: 'No tenés acceso a esta bandeja.',
  request_origin_invalid: 'El origen de la solicitud no es válido. Recargá la página e intentá nuevamente.',
  empresa_id_required: 'Seleccioná una empresa para continuar.',
  empresa_id_invalid: 'La empresa seleccionada no es válida. Elegí otra empresa.',
  cloud_config_inactive: 'WhatsApp Cloud no está activo para esta empresa. Revisá su configuración.',
  conversation_not_found: 'La conversación ya no está disponible. Actualizá la bandeja.',
  reply_invalid: 'Revisá el mensaje antes de enviarlo.',
  content_type_invalid: 'Revisá el mensaje antes de enviarlo.',
  idempotency_key_conflict: 'La clave de envío ya fue usada con otro mensaje. Conservamos tu borrador: revisalo y enviá nuevamente para generar una clave nueva.',
  reply_enqueue_failed: 'No se pudo poner el mensaje en cola. Conservamos tu borrador; intentá enviarlo nuevamente.',
  reply_enqueue_outcome_unknown: 'Resultado incierto: no vuelvas a enviar este mensaje. Verificá la conversación más tarde.',
  attachment_download_unavailable: 'La descarga todavía no está disponible.',
});

export function sanitizeCloudError(status, payload = {}) {
  const code = typeof payload?.error === 'string' ? payload.error : '';
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  if (Object.hasOwn(PUBLIC_CLOUD_ERRORS, code)) return PUBLIC_CLOUD_ERRORS[code];
  if (status === 403) return PUBLIC_CLOUD_ERRORS.access_denied;
  return 'No se pudo completar la operación. Intentá nuevamente más tarde.';
}

export function normalizeQuickReplyCatalog(items = []) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => (
    item && typeof item === 'object'
    && typeof item.id === 'string'
    && typeof item.shortcut === 'string'
    && typeof item.title === 'string'
    && typeof item.body === 'string'
    && item.body.length >= 1 && item.body.length <= 4096
    && Number.isInteger(item.sortOrder) && item.sortOrder >= 0 && item.sortOrder <= 100000
    && item.isActive === true
  )).map(item => ({
    id: item.id,
    shortcut: item.shortcut.slice(0, 32),
    title: item.title.slice(0, 80),
    body: item.body,
    sortOrder: item.sortOrder,
    isActive: true,
    version: Number.isInteger(item.version) ? item.version : null,
  })).sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.title.localeCompare(right.title, 'es', { sensitivity: 'base' })
    || left.id.localeCompare(right.id)
  ));
}

export function insertQuickReplyAtSelection(input, body, maxLength = 4096) {
  if (!input || input.disabled || typeof input.value !== 'string' || typeof body !== 'string') {
    return { inserted: false, reason: 'unavailable' };
  }
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const next = `${input.value.slice(0, start)}${body}${input.value.slice(end)}`;
  if (next.length > maxLength) return { inserted: false, reason: 'max_length' };
  const cursor = start + body.length;
  input.value = next;
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(cursor, cursor);
  else {
    input.selectionStart = cursor;
    input.selectionEnd = cursor;
  }
  input.dispatchEvent?.(new Event('input', { bubbles: true }));
  input.focus?.({ preventScroll: true });
  return { inserted: true, value: next, cursor };
}

export function appendSafeText(documentLike, parent, tag, value, className = '') {
  const node = documentLike.createElement(tag);
  node.className = className;
  node.textContent = String(value ?? '');
  parent.append(node);
  return node;
}

export function formatCloudTimestamp(value, locale = 'es-AR') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short', timeStyle: 'short',
  }).format(date);
}
