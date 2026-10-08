import {
  appendSafeText,
  attachmentDownloadNotice,
  bootstrapInboxState,
  buildCloudApiUrl,
  captureVisibleScrollAnchor,
  conversationPreview,
  createInboxComposerController,
  createChainedRefreshScheduler,
  createRequestGate,
  createSendDeadline,
  createSingleFlightSubmission,
  formatCloudTimestamp,
  isConversationListContextCurrent,
  insertQuickReplyAtSelection,
  mergeCanonicalConversationRefresh,
  mergeHistoryPage,
  mergeLiveHistory,
  normalizeQuickReplyCatalog,
  reconcileConversationMutation,
  reconcileSearchConversationRefresh,
  operationalMeta,
  queueCounterItems,
  reduceMobileView,
  restoreVisibleScrollAnchor,
  safeParticipant,
  sanitizeCloudError,
  statusMeta,
} from './whatsapp-cloud-ui.js';

const SEND_TIMEOUT_MS = 25_000;
const MOBILE_LAYOUT_QUERY = '(max-width: 767px)';

const elements = {
  status: document.querySelector('#appStatus'),
  sync: document.querySelector('#syncStatus'),
  inbox: document.querySelector('#inboxLayout'),
  companyWrap: document.querySelector('#companyPicker'),
  searchForm: document.querySelector('#conversationSearchForm'),
  searchInput: document.querySelector('#conversationSearch'),
  searchSubmit: document.querySelector('#conversationSearchSubmit'),
  searchClear: document.querySelector('#conversationSearchClear'),
  conversations: document.querySelector('#conversationList'),
  conversationsMore: document.querySelector('#loadMoreConversations'),
  refresh: document.querySelector('#refreshConversations'),
  dateFilter: document.querySelector('#dateFilter'),
  transferFilter: document.querySelector('#transferFilter'),
  workflowFilter: document.querySelector('#workflowFilter'),
  priorityFilter: document.querySelector('#priorityFilter'),
  unreadFilter: document.querySelector('#unreadFilter'),
  queueCounters: document.querySelector('#queueCounters'),
  filtersToggle: document.querySelector('#filtersToggle'),
  queueFilters: document.querySelector('#queueFilters'),
  chatPanel: document.querySelector('#chatPanel'),
  chatTitle: document.querySelector('#chatTitle'),
  context: document.querySelector('#conversationContext'),
  contextPanel: document.querySelector('#contextPanel'),
  contextToggle: document.querySelector('#contextToggle'),
  contextClose: document.querySelector('#contextClose'),
  overlayBackdrop: document.querySelector('#overlayBackdrop'),
  conversationWorkflow: document.querySelector('#conversationWorkflow'),
  conversationPriority: document.querySelector('#conversationPriority'),
  back: document.querySelector('#backToList'),
  history: document.querySelector('#messageHistory'),
  older: document.querySelector('#loadOlderMessages'),
  newMessages: document.querySelector('#newMessagesIndicator'),
  composer: document.querySelector('#composerForm'),
  quickReplyPanel: document.querySelector('#quickReplyPanel'),
  quickReplies: document.querySelector('#quickReplyList'),
  input: document.querySelector('#messageInput'),
  send: document.querySelector('#sendButton'),
  composerNotice: document.querySelector('#composerNotice'),
  newMessage: document.querySelector('#startNewMessage'),
  logout: document.querySelector('#logout'),
};

const state = {
  role: null,
  companyId: null,
  canonicalConversations: [],
  canonicalFirstPageIds: [],
  canonicalConversationsCursor: null,
  conversations: [],
  conversationsCursor: null,
  searchQuery: '',
  counters: { total: 0, pending: 0, inProcess: 0, review: 0, resolved: 0 },
  activeConversation: null,
  activeCounterBaselineTrusted: false,
  mutationRevision: 0,
  conversationContextRevision: 0,
  conversationContextLoading: false,
  pendingStateMutation: null,
  messages: [],
  historyCursor: null,
  newMessageCount: 0,
  syncState: 'updated',
  quickReplies: [],
  mobile: { mobileView: 'list', activeConversationId: null },
};

const composerController = createInboxComposerController({ input: elements.input, send: elements.send });

const conversationGate = createRequestGate();
const searchGate = createRequestGate();
const contextGate = createRequestGate();
const historyGate = createRequestGate();
const stateMutationGate = createRequestGate();
const quickReplyGate = createRequestGate();
let conversationsController = null;
let searchController = null;
let contextController = null;
let historyController = null;
let quickReplyController = null;
let returnFocusConversationId = null;
let conversationLoadPromise = null;
let conversationReloadRequested = false;
let manualHistoryInFlight = 0;
let autoRefreshAllowed = true;
let activeOverlay = null;
let overlayReturnFocus = null;

function isMobileLayout() {
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

function isDesktopLayout() {
  return window.matchMedia('(min-width: 1200px)').matches;
}

function updateViewportMetrics() {
  const topbarHeight = document.querySelector('.topbar')?.getBoundingClientRect().height || 0;
  document.documentElement.style.setProperty('--wc-header-offset', `${Math.round(topbarHeight)}px`);
  const viewport = window.visualViewport;
  const viewportHeight = viewport?.height || window.innerHeight;
  const viewportOffset = viewport?.offsetTop || 0;
  document.documentElement.style.setProperty('--app-visual-height', `${Math.round(viewportHeight)}px`);
  document.documentElement.style.setProperty('--app-visual-offset', `${Math.round(viewportOffset)}px`);
  const keyboardOpen = Boolean(viewport && isMobileLayout()
    && (window.innerHeight - viewportHeight > 48 || viewportOffset > 0));
  document.body.classList.toggle('keyboard-open', keyboardOpen);
}

function overlayFocusable(container) {
  return [...container.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getClientRects().length > 0);
}

function clearOverlayInert() {
  document.querySelectorAll('[data-overlay-inert="true"]').forEach(element => {
    element.inert = false;
    element.removeAttribute('data-overlay-inert');
  });
}

function setOverlayInert(kind) {
  clearOverlayInert();
  const targets = kind === 'filters'
    ? [
        document.querySelector('.topbar'), elements.conversations, elements.conversationsMore.parentElement,
        elements.chatPanel, elements.contextPanel,
        ...[...elements.queueFilters.parentElement.children].filter(element => element !== elements.queueFilters),
      ]
    : [document.querySelector('.topbar'), document.querySelector('.conversation-pane'), elements.chatPanel];
  targets.filter(Boolean).forEach(element => {
    element.inert = true;
    element.dataset.overlayInert = 'true';
  });
}

function clearDialogSemantics(panel) {
  panel.removeAttribute('role');
  panel.removeAttribute('aria-modal');
}

function closeOverlay({ restoreFocus = true } = {}) {
  if (!activeOverlay) return false;
  const closing = activeOverlay;
  activeOverlay = null;
  if (closing === 'filters') {
    elements.queueFilters.dataset.open = 'false';
    elements.filtersToggle.setAttribute('aria-expanded', 'false');
    clearDialogSemantics(elements.queueFilters);
  } else {
    elements.contextPanel.dataset.open = 'false';
    elements.contextToggle.setAttribute('aria-expanded', 'false');
    clearDialogSemantics(elements.contextPanel);
  }
  clearOverlayInert();
  elements.inbox.dataset.overlayOpen = 'false';
  elements.overlayBackdrop.setAttribute('aria-hidden', 'true');
  if (restoreFocus) overlayReturnFocus?.focus({ preventScroll: true });
  overlayReturnFocus = null;
  return true;
}

function openOverlay(kind, trigger) {
  closeOverlay({ restoreFocus: false });
  activeOverlay = kind;
  overlayReturnFocus = trigger;
  elements.inbox.dataset.overlayOpen = 'true';
  elements.overlayBackdrop.setAttribute('aria-hidden', 'false');
  const panel = kind === 'filters' ? elements.queueFilters : elements.contextPanel;
  panel.dataset.open = 'true';
  trigger.setAttribute('aria-expanded', 'true');
  if (kind === 'context') {
    const tablet = window.matchMedia('(min-width: 768px) and (max-width: 1199px)').matches;
    const composerHeight = tablet ? elements.composer.getBoundingClientRect().height : 0;
    panel.style.setProperty('--wc-composer-clearance', `${Math.ceil(composerHeight) + (tablet ? 16 : 0)}px`);
  }
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  setOverlayInert(kind);
  overlayFocusable(panel)[0]?.focus({ preventScroll: true });
}

function toggleContextPanel() {
  if (isDesktopLayout()) {
    const collapsed = elements.inbox.classList.toggle('context-collapsed');
    elements.contextToggle.setAttribute('aria-expanded', String(!collapsed));
    elements.contextPanel.dataset.open = String(!collapsed);
    if (!collapsed) elements.contextClose.focus({ preventScroll: true });
    return;
  }
  if (activeOverlay === 'context') closeOverlay();
  else openOverlay('context', elements.contextToggle);
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function resolveDateFilter(value, now = new Date()) {
  const selected = String(value || 'all');
  const today = startOfLocalDay(now);
  let from = null;
  let to = null;
  if (selected === 'today') {
    from = today;
    to = new Date(today);
    to.setDate(to.getDate() + 1);
  } else if (selected === 'yesterday') {
    to = today;
    from = new Date(today);
    from.setDate(from.getDate() - 1);
  } else if (selected === 'last7') {
    to = new Date(today);
    to.setDate(to.getDate() + 1);
    from = new Date(today);
    from.setDate(from.getDate() - 6);
  } else if (selected === 'month') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
    to = new Date(today);
    to.setDate(to.getDate() + 1);
  }
  return {
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  };
}

function currentFilters() {
  const dateRange = resolveDateFilter(elements.dateFilter?.value);
  return {
    ...dateRange,
    payment: elements.transferFilter?.checked ? 'transferencia' : null,
    workflowStatus: elements.workflowFilter?.value || null,
    priority: elements.priorityFilter?.value || null,
    unread: elements.unreadFilter?.checked ? true : null,
  };
}

function setStatus(message, tone = 'neutral') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
  elements.status.hidden = !message;
}

function setSyncState(value) {
  const allowed = new Set(['updating', 'updated', 'stale']);
  state.syncState = allowed.has(value) ? value : 'stale';
  const labels = { updating: 'Actualizando…', updated: 'Actualizado', stale: 'Datos desactualizados' };
  elements.sync.textContent = labels[state.syncState];
  elements.sync.dataset.state = state.syncState;
}

function setComposerNotice(message, tone = 'neutral') {
  elements.composerNotice.textContent = message;
  elements.composerNotice.dataset.tone = tone;
}

function revokeSensitiveInboxState({ redirect = false } = {}) {
  closeOverlay({ restoreFocus: false });
  autoRefreshAllowed = false;
  autoRefreshScheduler.stop();
  conversationGate.invalidate();
  searchGate.invalidate();
  contextGate.invalidate();
  historyGate.invalidate();
  stateMutationGate.invalidate();
  quickReplyGate.invalidate();
  conversationsController?.abort();
  searchController?.abort();
  contextController?.abort();
  historyController?.abort();
  quickReplyController?.abort();
  replySubmission.abort(new DOMException('Acceso revocado', 'AbortError'));
  state.role = null;
  state.companyId = null;
  state.canonicalConversations = [];
  state.canonicalFirstPageIds = [];
  state.canonicalConversationsCursor = null;
  state.conversations = [];
  state.conversationsCursor = null;
  state.searchQuery = '';
  state.counters = { total: 0, pending: 0, inProcess: 0, review: 0, resolved: 0 };
  state.activeConversation = null;
  state.activeCounterBaselineTrusted = false;
  state.mutationRevision += 1;
  state.conversationContextRevision += 1;
  state.conversationContextLoading = false;
  state.pendingStateMutation = null;
  state.messages = [];
  state.historyCursor = null;
  state.newMessageCount = 0;
  state.quickReplies = [];
  state.mobile = { mobileView: 'list', activeConversationId: null };
  composerController.revokeAccess();
  elements.companyWrap.replaceChildren();
  elements.companyWrap.hidden = true;
  elements.searchInput.value = '';
  elements.conversations.replaceChildren();
  elements.queueCounters.replaceChildren();
  elements.history.replaceChildren();
  elements.context.replaceChildren();
  elements.quickReplies.replaceChildren();
  elements.newMessages.replaceChildren();
  elements.newMessages.hidden = true;
  elements.context.hidden = true;
  elements.older.hidden = true;
  elements.conversationsMore.hidden = true;
  elements.quickReplyPanel.open = false;
  elements.chatTitle.textContent = 'Acceso no autorizado';
  setComposerNotice('');
  setStatus(redirect ? 'Tu sesión venció. Volvé a iniciar sesión.' : 'No tenés acceso a esta bandeja.', 'error');
  syncContextControls();
  if (redirect) window.location.assign('/pedidos/login.html');
}

function renderQuickReplies() {
  const fragment = document.createDocumentFragment();
  if (!state.quickReplies.length) appendSafeText(document, fragment, 'span', 'No hay respuestas rápidas activas.', 'preview');
  for (const quickReply of state.quickReplies) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-reply-item';
    button.dataset.quickReplyId = quickReply.id;
    appendSafeText(document, button, 'strong', `/${quickReply.shortcut}`);
    appendSafeText(document, button, 'span', quickReply.title);
    button.disabled = !state.activeConversation || composerController.snapshot().composer.sending;
    button.addEventListener('click', () => {
      const result = insertQuickReplyAtSelection(elements.input, quickReply.body);
      if (!result.inserted) {
        setComposerNotice(result.reason === 'max_length'
          ? 'La respuesta rápida supera el límite de 4096 caracteres con el borrador actual.'
          : 'Seleccioná una conversación antes de insertar una respuesta.', 'warning');
        return;
      }
      composerController.captureDraft();
      setComposerNotice('Respuesta insertada. Podés editarla antes de enviar.', 'success');
    });
    fragment.append(button);
  }
  elements.quickReplies.replaceChildren(fragment);
}

function clearQuickReplies() {
  quickReplyGate.invalidate();
  quickReplyController?.abort();
  state.quickReplies = [];
  elements.quickReplies.replaceChildren();
  elements.quickReplyPanel.open = false;
}

async function loadQuickReplies() {
  if (!state.companyId) return;
  quickReplyController?.abort();
  quickReplyController = new AbortController();
  const generation = quickReplyGate.begin();
  const companyId = state.companyId;
  try {
    const url = buildCloudApiUrl('/quick-replies', { role: state.role, companyId });
    const { response, payload } = await request(url, { signal: quickReplyController.signal });
    if (!quickReplyGate.isCurrent(generation) || state.companyId !== companyId) return;
    if (!response.ok) {
      state.quickReplies = [];
      renderQuickReplies();
      return;
    }
    state.quickReplies = normalizeQuickReplyCatalog(payload.quickReplies);
    renderQuickReplies();
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.message !== 'session_expired'
      && quickReplyGate.isCurrent(generation) && state.companyId === companyId) {
      state.quickReplies = [];
      renderQuickReplies();
    }
  }
}

function syncContextControls() {
  const composer = composerController.snapshot().composer;
  const locked = composer.sending || composer.reconciliationRequired;
  const stateMutationLocked = state.pendingStateMutation
    && stateMutationGate.isCurrent(state.pendingStateMutation.generation)
    && state.companyId === state.pendingStateMutation.companyId
    && String(state.activeConversation?.conversationId) === state.pendingStateMutation.conversationId;
  const companySelect = elements.companyWrap.querySelector('select');
  if (companySelect) companySelect.disabled = locked;
  if (elements.dateFilter) elements.dateFilter.disabled = locked;
  if (elements.transferFilter) elements.transferFilter.disabled = locked;
  if (elements.workflowFilter) elements.workflowFilter.disabled = locked;
  if (elements.priorityFilter) elements.priorityFilter.disabled = locked;
  if (elements.unreadFilter) elements.unreadFilter.disabled = locked;
  elements.searchInput.disabled = locked;
  elements.searchSubmit.disabled = locked;
  elements.searchClear.disabled = locked;
  elements.refresh.disabled = locked;
  elements.conversationsMore.disabled = locked;
  elements.back.disabled = locked;
  elements.conversations.querySelectorAll('button').forEach(button => { button.disabled = locked; });
  elements.quickReplies.querySelectorAll('button').forEach(button => { button.disabled = locked || !state.activeConversation; });
  elements.newMessage.hidden = !composer.reconciliationRequired;
  elements.conversationWorkflow.disabled = locked || stateMutationLocked || state.conversationContextLoading || !state.activeConversation;
  elements.conversationPriority.disabled = locked || stateMutationLocked || state.conversationContextLoading || !state.activeConversation;
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await readJson(response);
  if (response.status === 401) {
    revokeSensitiveInboxState({ redirect: true });
    throw new Error('session_expired');
  }
  if (response.status === 403) {
    revokeSensitiveInboxState();
    throw Object.assign(new Error('access_forbidden'), { stopRefresh: true });
  }
  return { response, payload };
}

function clearChat({ composerAlreadyReset = false, restoreFocus = true } = {}) {
  if (!composerAlreadyReset && !composerController.closeConversation()) {
    setComposerNotice('Esperá a que termine el envío antes de cambiar de conversación.', 'warning');
    return false;
  }
  state.activeConversation = null;
  closeOverlay({ restoreFocus: false });
  contextGate.invalidate();
  contextController?.abort();
  elements.context.replaceChildren();
  elements.context.hidden = true;
  state.activeCounterBaselineTrusted = false;
  state.messages = [];
  state.historyCursor = null;
  state.mobile = reduceMobileView(state.mobile, { type: 'back' });
  elements.inbox.classList.remove('mobile-detail');
  elements.chatTitle.textContent = 'Seleccioná una conversación';
  elements.conversationWorkflow.textContent = 'Marcar resuelta';
  elements.conversationPriority.value = 'normal';
  elements.history.replaceChildren();
  elements.older.hidden = true;
  setComposerNotice('');
  syncContextControls();
  if (restoreFocus && isMobileLayout()) {
    const target = [...elements.conversations.querySelectorAll('button')]
      .find(button => button.dataset.conversationId === returnFocusConversationId)
      || document.querySelector('#conversationHeading');
    target?.focus();
  }
  return true;
}

function makeBadge(status, direction) {
  const meta = statusMeta(direction === 'inbound' ? 'received' : status);
  const badge = document.createElement('span');
  badge.className = `status-badge status-${meta.tone}`;
  badge.textContent = meta.label;
  badge.title = meta.help;
  return badge;
}

function renderCounters() {
  const fragment = document.createDocumentFragment();
  for (const counter of queueCounterItems(state.counters)) {
    appendSafeText(document, fragment, 'span', `${counter.label}: ${counter.value}`, 'counter-chip');
  }
  elements.queueCounters.replaceChildren(fragment);
}

function renderConversations() {
  const fragment = document.createDocumentFragment();
  if (!state.conversations.length) {
    appendSafeText(document, fragment, 'p', state.searchQuery
      ? 'No hay resultados para la búsqueda actual.'
      : 'No hay conversaciones para esta empresa.', 'empty-state');
  }
  for (const conversation of state.conversations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-card';
    button.disabled = composerController.snapshot().composer.sending;
    button.dataset.conversationId = String(conversation.conversationId);
    button.dataset.searchStale = conversation.searchStale === true ? 'true' : 'false';
    if (String(state.activeConversation?.conversationId) === String(conversation.conversationId)) {
      button.classList.add('active');
      button.setAttribute('aria-current', 'true');
    }

    const top = document.createElement('span');
    top.className = 'conversation-top';
    appendSafeText(document, top, 'strong', safeParticipant(conversation.participant), 'participant');
    appendSafeText(document, top, 'time', formatCloudTimestamp(conversation.lastMessageAt), 'timestamp');
    button.append(top);

    const summary = document.createElement('span');
    summary.className = 'conversation-summary';
    appendSafeText(document, summary, 'span', conversationPreview(conversation), 'preview');
    summary.append(makeBadge(conversation.lastDeliveryStatus, conversation.lastDirection));
    const operation = operationalMeta(conversation);
    appendSafeText(document, summary, 'span', operation.label, `operation-badge status-${operation.tone}`);
    appendSafeText(document, summary, 'span', `Prioridad ${conversation.priority || 'normal'}`, `operation-badge priority-${conversation.priority || 'normal'}`);
    if (Number(conversation.unreadCount) > 0) {
      appendSafeText(document, summary, 'span', `${conversation.unreadCount} sin leer`, 'operation-badge unread-badge');
    }
    const paymentMethod = String(conversation.paymentMethod || '').toLowerCase();
    if (paymentMethod === 'efectivo' || paymentMethod === 'transferencia') {
      const paymentLabel = paymentMethod === 'transferencia' ? 'Transferencia' : 'Efectivo';
      appendSafeText(document, summary, 'span', paymentLabel, `payment-label payment-${paymentMethod}`);
    }
    button.append(summary);

    const customerParts = [conversation.customerName, conversation.customerAddress]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (customerParts.length) {
      const customerDetail = customerParts.join(' · ').slice(0, 260);
      appendSafeText(document, button, 'span', customerDetail, 'customer-line');
    }

    button.addEventListener('click', () => openConversation(conversation));
    fragment.append(button);
  }
  elements.conversations.replaceChildren(fragment);
  elements.conversationsMore.hidden = !state.conversationsCursor;
  renderCounters();
}

function renderConversationContext(payload) {
  const fragment = document.createDocumentFragment();
  if (payload?.matchStatus === 'exact' && payload.customer) {
    appendSafeText(document, fragment, 'strong', 'Cliente identificado');
    const parts = [payload.customer.name, safeParticipant(payload.customer.phone), payload.customer.address]
      .map(value => String(value || '').trim()).filter(Boolean);
    if (parts.length) appendSafeText(document, fragment, 'span', parts.join(' · ').slice(0, 340));
    const orders = Array.isArray(payload.orders) ? payload.orders.slice(0, 5) : [];
    if (orders.length) {
      const list = document.createElement('ul');
      list.className = 'context-orders';
      for (const order of orders) {
        const details = [`Pedido ${String(order.publicId || '').slice(0, 40)}`];
        if (order.status) details.push(String(order.status).slice(0, 60));
        if (order.date) details.push(formatCloudTimestamp(order.date));
        if (order.total != null) details.push(`$ ${String(order.total).slice(0, 30)}`);
        appendSafeText(document, list, 'li', details.join(' · '));
      }
      fragment.append(list);
    }
  } else if (payload?.matchStatus === 'ambiguous') {
    appendSafeText(document, fragment, 'strong', 'Coincidencia ambigua');
    appendSafeText(document, fragment, 'span', 'Hay más de un cliente posible. Verificá la identidad antes de actuar.');
  } else {
    appendSafeText(document, fragment, 'strong', 'Sin coincidencia');
    appendSafeText(document, fragment, 'span', 'No se encontró un cliente inequívoco para esta conversación.');
  }
  elements.context.replaceChildren(fragment);
  elements.context.hidden = false;
}

function renderContextLoadError(conversationId) {
  elements.context.replaceChildren();
  appendSafeText(document, elements.context, 'strong', 'No se pudo cargar el contexto.');
  appendSafeText(document, elements.context, 'span', 'Reintentá sin cerrar la conversación.');
  const retry = document.createElement('button');
  retry.id = 'contextRetry';
  retry.type = 'button';
  retry.className = 'secondary-button';
  retry.textContent = 'Reintentar contexto';
  retry.addEventListener('click', () => {
    if (String(state.activeConversation?.conversationId) !== String(conversationId)) return;
    retry.disabled = true;
    loadConversationContext(conversationId);
  });
  elements.context.append(retry);
  elements.context.hidden = false;
}

async function loadConversationContext(conversationId) {
  contextController?.abort();
  contextController = new AbortController();
  const generation = contextGate.begin();
  const companyId = state.companyId;
  elements.context.replaceChildren();
  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton';
  skeleton.setAttribute('aria-label', 'Cargando contexto');
  skeleton.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  elements.context.append(skeleton);
  elements.context.hidden = false;
  try {
    const path = `/conversations/${encodeURIComponent(conversationId)}/context`;
    const url = buildCloudApiUrl(path, { role: state.role, companyId });
    const { response, payload } = await request(url, { signal: contextController.signal });
    if (!contextGate.isCurrent(generation)
      || state.companyId !== companyId
      || String(state.activeConversation?.conversationId) !== String(conversationId)) return;
    if (!response.ok) {
      renderContextLoadError(conversationId);
      return;
    }
    renderConversationContext(payload);
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.message !== 'session_expired'
      && contextGate.isCurrent(generation)
      && state.companyId === companyId
      && String(state.activeConversation?.conversationId) === String(conversationId)) {
      renderContextLoadError(conversationId);
    }
  }
}

function clearConversationSearch({ restore = true } = {}) {
  searchGate.invalidate();
  searchController?.abort();
  state.searchQuery = '';
  elements.searchInput.value = '';
  if (restore) {
    state.conversations = [...state.canonicalConversations];
    state.conversationsCursor = state.canonicalConversationsCursor;
    renderConversations();
    setStatus('');
  }
}

async function submitConversationSearch(event, { append = false } = {}) {
  event?.preventDefault();
  const queryValue = append ? state.searchQuery : elements.searchInput.value.trim();
  if (!queryValue) {
    clearConversationSearch();
    return;
  }
  if (queryValue.length < 2 || queryValue.length > 80) {
    setStatus('Ingresá entre 2 y 80 caracteres para buscar.', 'warning');
    return;
  }
  searchController?.abort();
  searchController = new AbortController();
  const generation = searchGate.begin();
  const companyId = state.companyId;
  const contextRevision = state.conversationContextRevision;
  const mutationRevision = state.mutationRevision;
  const filters = currentFilters();
  const startedContext = { generation, companyId, contextRevision, mutationRevision, filters };
  state.searchQuery = queryValue;
  setStatus('Buscando conversaciones…');
  const body = {
    query: queryValue,
    limit: 25,
    ...(append && state.conversationsCursor ? { cursor: state.conversationsCursor } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.payment ? { payment: filters.payment } : {}),
    ...(filters.workflowStatus ? { workflowStatus: filters.workflowStatus } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.unread === true ? { unreadOnly: true } : {}),
  };
  if (state.role === 'super') body.empresa_id = companyId;
  try {
    const url = buildCloudApiUrl('/conversations/search', { role: state.role, companyId, tenantInBody: true });
    const { response, payload } = await request(url, {
      method: 'POST', body: JSON.stringify(body), signal: searchController.signal,
    });
    const currentContext = {
      generation,
      companyId: state.companyId,
      contextRevision: state.conversationContextRevision,
      mutationRevision: state.mutationRevision,
      filters: currentFilters(),
    };
    if (!searchGate.isCurrent(generation)
      || !isConversationListContextCurrent(startedContext, currentContext)
      || state.searchQuery !== queryValue) return;
    if (!response.ok) {
      setStatus('No se pudo completar la búsqueda.', 'error');
      return;
    }
    const incoming = Array.isArray(payload.conversations) ? payload.conversations : [];
    const known = new Map((append ? state.conversations : []).map(item => [String(item.conversationId), item]));
    for (const item of incoming) known.set(String(item.conversationId), item);
    state.conversations = [...known.values()];
    state.conversationsCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
    renderConversations();
    setStatus(state.conversations.length ? 'Resultados de búsqueda.' : 'No hay coincidencias.');
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.message !== 'session_expired'
      && searchGate.isCurrent(generation)
      && isConversationListContextCurrent(startedContext, {
        generation,
        companyId: state.companyId,
        contextRevision: state.conversationContextRevision,
        mutationRevision: state.mutationRevision,
        filters: currentFilters(),
      })
      && state.searchQuery === queryValue) {
      setStatus('No se pudo completar la búsqueda.', 'error');
    }
  }
}

function renderAttachment(message, container) {
  const attachment = message?.attachment;
  if (!attachment || (message.type !== 'image' && message.type !== 'document')) return;
  const card = document.createElement('section');
  card.className = 'attachment-card';
  appendSafeText(document, card, 'strong', message.type === 'image' ? 'Imagen adjunta' : 'Documento adjunto');
  if (attachment.filename) appendSafeText(document, card, 'span', String(attachment.filename).slice(0, 180), 'attachment-name');
  if (attachment.caption) appendSafeText(document, card, 'span', String(attachment.caption).slice(0, 1000), 'attachment-caption');
  if (attachment.mimeType) appendSafeText(document, card, 'small', String(attachment.mimeType).slice(0, 120), 'attachment-type');
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'attachment-action';
  action.textContent = attachment.downloadable ? 'Descargar' : 'Consultar descarga';
  action.addEventListener('click', () => requestAttachmentDownload(
    state.activeConversation?.conversationId,
    message.id,
    action,
  ));
  card.append(action);
  container.append(card);
}

function renderHistory({ preserveScroll = false, live = false, wasAtBottom = true, newMessageCount = 0 } = {}) {
  const previousHeight = elements.history.scrollHeight;
  const previousTop = elements.history.scrollTop;
  const liveAnchor = live && !wasAtBottom ? captureVisibleScrollAnchor(elements.history) : null;
  const fragment = document.createDocumentFragment();
  if (!state.messages.length) appendSafeText(document, fragment, 'p', 'Todavía no hay mensajes.', 'empty-state');
  for (const message of state.messages) {
    const article = document.createElement('article');
    const direction = message.direction === 'outbound' ? 'outbound' : 'inbound';
    article.className = `message message-${direction}`;
    article.dataset.messageId = String(message.id);
    const header = document.createElement('div');
    header.className = 'message-meta';
    appendSafeText(document, header, 'time', formatCloudTimestamp(message.messageAt));
    header.append(makeBadge(message.deliveryStatus, direction));
    article.append(header);
    if (message.text) appendSafeText(document, article, 'p', String(message.text).slice(0, 4096), 'message-text');
    renderAttachment(message, article);
    fragment.append(article);
  }
  elements.history.replaceChildren(fragment);
  elements.older.hidden = !state.historyCursor;
  if (preserveScroll) elements.history.scrollTop = elements.history.scrollHeight - previousHeight + previousTop;
  else if (live && !wasAtBottom) {
    if (liveAnchor) restoreVisibleScrollAnchor(elements.history, liveAnchor);
    else elements.history.scrollTop = previousTop;
  } else elements.history.scrollTop = elements.history.scrollHeight;
  if (live && !wasAtBottom && newMessageCount > 0) state.newMessageCount += newMessageCount;
  else if (wasAtBottom) state.newMessageCount = 0;
  elements.newMessages.textContent = state.newMessageCount > 0 ? `${state.newMessageCount} mensajes nuevos` : '';
  elements.newMessages.hidden = state.newMessageCount <= 0;
}

async function performConversationLoad({ append = false } = {}) {
  if (state.role === 'super' && !state.companyId) return;
  conversationsController = new AbortController();
  const generation = conversationGate.begin();
  const filters = currentFilters();
  const startedContext = {
    generation,
    companyId: state.companyId,
    contextRevision: state.conversationContextRevision,
    mutationRevision: state.mutationRevision,
    filters,
  };
  const cursor = append ? state.canonicalConversationsCursor : null;
  if (!append) setStatus('Cargando conversaciones…');
  try {
    const url = buildCloudApiUrl('/conversations', {
      role: state.role,
      companyId: state.companyId,
      limit: 25,
      from: filters.from,
      to: filters.to,
      payment: filters.payment,
      workflowStatus: filters.workflowStatus,
      priority: filters.priority,
      unread: filters.unread,
      ...(cursor ? { cursor } : {}),
    });
    const { response, payload } = await request(url, { signal: conversationsController.signal });
    const currentContext = {
      generation,
      companyId: state.companyId,
      contextRevision: state.conversationContextRevision,
      mutationRevision: state.mutationRevision,
      filters: currentFilters(),
    };
    if (!conversationGate.isCurrent(generation)
      || !isConversationListContextCurrent(startedContext, currentContext)) {
      return { staleContext: true };
    }
    if (!response.ok) {
      setStatus(sanitizeCloudError(response.status, payload), 'error');
      return;
    }
    state.conversationContextLoading = false;
    const incoming = Array.isArray(payload.conversations) ? payload.conversations : [];
    const known = new Map((append ? state.canonicalConversations : []).map(item => [String(item.conversationId), item]));
    for (const item of incoming) known.set(String(item.conversationId), item);
    state.canonicalConversations = [...known.values()];
    if (!append) state.canonicalFirstPageIds = incoming.map(item => String(item.conversationId));
    if (!state.searchQuery) state.conversations = [...state.canonicalConversations];
    if (state.activeConversation) {
      const refreshedActive = state.canonicalConversations.find(item => (
        String(item.conversationId) === String(state.activeConversation.conversationId)
      ));
      if (refreshedActive) {
        state.activeConversation = refreshedActive;
        state.activeCounterBaselineTrusted = true;
        syncActiveConversationControls();
      } else if (!append) {
        state.activeCounterBaselineTrusted = false;
      }
    }
    if (payload.counters && typeof payload.counters === 'object') {
      state.counters = payload.counters;
    } else if (!append) {
      state.counters = { total: 0, pending: 0, inProcess: 0, review: 0, resolved: 0 };
    }
    state.canonicalConversationsCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
    if (!state.searchQuery) state.conversationsCursor = state.canonicalConversationsCursor;
    renderConversations();
    syncContextControls();
    setStatus('');
  } catch (error) {
    const currentContext = {
      generation,
      companyId: state.companyId,
      contextRevision: state.conversationContextRevision,
      mutationRevision: state.mutationRevision,
      filters: currentFilters(),
    };
    if (error?.name !== 'AbortError'
      && error?.message !== 'session_expired'
      && conversationGate.isCurrent(generation)
      && isConversationListContextCurrent(startedContext, currentContext)) {
      setStatus('No se pudieron cargar las conversaciones.', 'error');
    }
    if (!isConversationListContextCurrent(startedContext, currentContext)) return { staleContext: true };
  }
}

async function loadConversations({ append = false } = {}) {
  if (conversationLoadPromise) {
    conversationReloadRequested = true;
    return conversationLoadPromise;
  }
  conversationLoadPromise = (async () => {
    let nextAppend = append;
    do {
      conversationReloadRequested = false;
      const startedMutationRevision = state.mutationRevision;
      const startedContextRevision = state.conversationContextRevision;
      const result = await performConversationLoad({ append: nextAppend });
      if (!autoRefreshAllowed) return;
      nextAppend = false;
      if (result?.staleContext) conversationReloadRequested = true;
      if (state.mutationRevision !== startedMutationRevision) conversationReloadRequested = true;
      if (state.conversationContextRevision !== startedContextRevision) conversationReloadRequested = true;
    } while (conversationReloadRequested);
  })();
  try {
    return await conversationLoadPromise;
  } finally {
    conversationLoadPromise = null;
  }
}

async function reloadConversationsFromStart({ preserveActiveConversation = false } = {}) {
  state.conversationContextRevision += 1;
  state.conversationContextLoading = true;
  state.canonicalConversations = [];
  state.canonicalFirstPageIds = [];
  state.canonicalConversationsCursor = null;
  state.conversations = [];
  state.conversationsCursor = null;
  state.counters = { total: 0, pending: 0, inProcess: 0, review: 0, resolved: 0 };
  elements.conversations.replaceChildren();
  elements.queueCounters.replaceChildren();
  elements.conversationsMore.hidden = true;
  if (preserveActiveConversation) {
    state.activeCounterBaselineTrusted = false;
    syncContextControls();
  } else {
    clearChat({ restoreFocus: false });
  }
  setStatus('Cargando conversaciones…');
  await loadConversations();
}

async function markConversationRead(conversationId, { generation, companyId }) {
  const path = `/conversations/${encodeURIComponent(conversationId)}/read`;
  const url = buildCloudApiUrl(path, { role: state.role, companyId, tenantInBody: true });
  const inboundIds = state.messages
    .filter(message => message.direction === 'inbound' && /^[1-9][0-9]*$/.test(String(message.id)))
    .map(message => BigInt(String(message.id)));
  if (!inboundIds.length) return false;
  const lastReadMessageId = String(inboundIds.reduce((maximum, id) => id > maximum ? id : maximum));
  const body = { lastReadMessageId };
  if (state.role === 'super') body.empresa_id = companyId;
  const { response, payload } = await request(url, { method: 'POST', body: JSON.stringify(body) });
  if (!historyGate.isCurrent(generation)
    || state.companyId !== companyId
    || String(state.activeConversation?.conversationId) !== String(conversationId)) return false;
  if (!response.ok) {
    setStatus(sanitizeCloudError(response.status, payload), 'warning');
    return false;
  }
  state.mutationRevision += 1;
  clearConversationSearch({ restore: false });
  await loadConversations();
  return true;
}

async function loadHistory({ older = false } = {}) {
  if (!state.activeConversation) return;
  manualHistoryInFlight += 1;
  historyController?.abort();
  historyController = new AbortController();
  const generation = historyGate.begin();
  const companyId = state.companyId;
  const conversationId = String(state.activeConversation.conversationId);
  const cursor = older ? state.historyCursor : null;
  try {
    const path = `/conversations/${encodeURIComponent(conversationId)}/messages`;
    const url = buildCloudApiUrl(path, {
      role: state.role,
      companyId: state.companyId,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    const { response, payload } = await request(url, { signal: historyController.signal });
    if (!historyGate.isCurrent(generation) || String(state.activeConversation?.conversationId) !== conversationId) return;
    if (!response.ok) {
      setStatus(sanitizeCloudError(response.status, payload), 'error');
      return;
    }
    const incoming = Array.isArray(payload.messages) ? payload.messages : [];
    state.messages = older ? mergeHistoryPage(state.messages, incoming) : mergeHistoryPage([], incoming);
    state.historyCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
    renderHistory({ preserveScroll: older });
    if (!older) await markConversationRead(conversationId, { generation, companyId });
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.message !== 'session_expired' && historyGate.isCurrent(generation)) {
      setStatus('No se pudo cargar el historial.', 'error');
    }
  } finally {
    manualHistoryInFlight = Math.max(0, manualHistoryInFlight - 1);
  }
}

async function autoRefreshConversations(signal) {
  if (conversationLoadPromise || !state.companyId) return;
  const filters = currentFilters();
  const started = {
    companyId: state.companyId,
    contextRevision: state.conversationContextRevision,
    mutationRevision: state.mutationRevision,
    filters,
  };
  const url = buildCloudApiUrl('/conversations', {
    role: state.role, companyId: state.companyId, limit: 25,
    from: filters.from, to: filters.to, payment: filters.payment,
    workflowStatus: filters.workflowStatus, priority: filters.priority, unread: filters.unread,
    revalidateIds: [...new Set([
      ...state.canonicalFirstPageIds,
      ...(state.searchQuery ? state.conversations.map(item => String(item.conversationId)) : []),
    ])].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)).slice(0, 100),
  });
  const { response, payload } = await request(url);
  if (response.status === 403) throw Object.assign(new Error('refresh_forbidden'), { stopRefresh: true });
  if (!response.ok) throw new Error('refresh_list_failed');
  if (signal.aborted
    || state.companyId !== started.companyId
    || state.conversationContextRevision !== started.contextRevision
    || state.mutationRevision !== started.mutationRevision
    || JSON.stringify(currentFilters()) !== JSON.stringify(started.filters)) return;
  const merged = mergeCanonicalConversationRefresh({
    current: state.canonicalConversations,
    incomingFirstPage: Array.isArray(payload.conversations) ? payload.conversations : [],
    previousFirstPageIds: state.canonicalFirstPageIds,
    authoritativeRemovedIds: Array.isArray(payload.authoritativeRemovedIds) ? payload.authoritativeRemovedIds : [],
  });
  state.canonicalConversations = merged.conversations;
  state.canonicalFirstPageIds = merged.firstPageIds;
  if (!state.searchQuery) {
    state.conversations = [...state.canonicalConversations];
    state.conversationsCursor = state.canonicalConversationsCursor;
  } else {
    state.conversations = reconcileSearchConversationRefresh({
      searchResults: state.conversations,
      canonical: Array.isArray(payload.conversations) ? payload.conversations : [],
      authoritativeRemovedIds: Array.isArray(payload.authoritativeRemovedIds) ? payload.authoritativeRemovedIds : [],
    });
  }
  if (payload.counters && typeof payload.counters === 'object') state.counters = payload.counters;
  if (state.activeConversation) {
    const refreshed = state.canonicalConversations.find(item => String(item.conversationId) === String(state.activeConversation.conversationId));
    if (refreshed) {
      state.activeConversation = refreshed;
      syncActiveConversationControls();
    }
  }
  renderConversations();
}

async function autoRefreshHistory(signal) {
  if (!state.activeConversation || manualHistoryInFlight > 0 || replySubmission.isActive()) return;
  const composer = composerController.snapshot().composer;
  if (composer.reconciliationRequired) return;
  const started = {
    companyId: state.companyId,
    conversationId: String(state.activeConversation.conversationId),
    contextRevision: state.conversationContextRevision,
    mutationRevision: state.mutationRevision,
  };
  const path = `/conversations/${encodeURIComponent(started.conversationId)}/messages`;
  const url = buildCloudApiUrl(path, { role: state.role, companyId: state.companyId, limit: 50 });
  const wasAtBottom = elements.history.scrollHeight - elements.history.scrollTop - elements.history.clientHeight <= 24;
  const { response, payload } = await request(url);
  if (response.status === 403) throw Object.assign(new Error('refresh_forbidden'), { stopRefresh: true });
  if (!response.ok) throw new Error('refresh_history_failed');
  if (signal.aborted
    || state.companyId !== started.companyId
    || String(state.activeConversation?.conversationId) !== started.conversationId
    || state.conversationContextRevision !== started.contextRevision
    || state.mutationRevision !== started.mutationRevision) return;
  const merged = mergeLiveHistory(state.messages, Array.isArray(payload.messages) ? payload.messages : []);
  state.messages = merged.messages;
  if (merged.changed) renderHistory({ live: true, wasAtBottom, newMessageCount: merged.newMessageIds.length });
}

async function runAutoRefreshCycle({ signal }) {
  setSyncState('updating');
  try {
    await Promise.all([autoRefreshConversations(signal), autoRefreshHistory(signal)]);
    if (!signal.aborted) setSyncState('updated');
  } catch (error) {
    if (error?.name === 'AbortError' || signal.aborted) return;
    setSyncState('stale');
    if (error?.stopRefresh || error?.message === 'session_expired') {
      autoRefreshAllowed = false;
      autoRefreshScheduler.pause();
    }
    throw error;
  }
}

function syncActiveConversationControls() {
  const conversation = state.activeConversation;
  if (!conversation) return;
  elements.conversationWorkflow.textContent = conversation.workflowStatus === 'resolved'
    ? 'Reabrir conversación'
    : 'Marcar resuelta';
  elements.conversationPriority.value = ['normal', 'high', 'urgent'].includes(conversation.priority)
    ? conversation.priority
    : 'normal';
}

function applyConversationState(current) {
  const previous = String(state.activeConversation?.conversationId) === String(current?.conversationId)
    ? state.activeConversation
    : state.conversations.find(item => String(item.conversationId) === String(current?.conversationId))
      || state.canonicalConversations.find(item => String(item.conversationId) === String(current?.conversationId));
  if (!previous) return false;
  const canonical = reconcileConversationMutation({
    conversations: state.canonicalConversations,
    activeConversation: state.activeConversation,
    current,
    counters: state.counters,
    filters: currentFilters(),
    counterBaselineTrusted: state.activeCounterBaselineTrusted,
  });
  const visible = reconcileConversationMutation({
    conversations: state.conversations,
    activeConversation: state.activeConversation,
    current,
    counters: canonical.counters,
    filters: currentFilters(),
    counterBaselineTrusted: false,
  });
  state.canonicalConversations = canonical.conversations;
  state.conversations = visible.conversations;
  state.activeConversation = visible.activeConversation || canonical.activeConversation;
  state.counters = canonical.counters;
  state.mutationRevision += 1;
  if (String(state.activeConversation?.conversationId) === String(current.conversationId)) {
    syncActiveConversationControls();
  }
  renderConversations();
  return canonical.countersNeedReload;
}

async function patchActiveConversationState(change) {
  const conversation = state.activeConversation;
  if (!conversation) return;
  const generation = stateMutationGate.begin();
  const companyId = state.companyId;
  const conversationId = String(conversation.conversationId);
  const body = { ...change, expectedVersion: conversation.version };
  if (state.role === 'super') body.empresa_id = state.companyId;
  const path = `/conversations/${encodeURIComponent(String(conversation.conversationId))}/state`;
  const url = buildCloudApiUrl(path, { role: state.role, companyId: state.companyId, tenantInBody: true });
  state.pendingStateMutation = { generation, companyId, conversationId };
  elements.conversationWorkflow.disabled = true;
  elements.conversationPriority.disabled = true;
  try {
    const { response, payload } = await request(url, { method: 'PATCH', body: JSON.stringify(body) });
    if (!stateMutationGate.isCurrent(generation)
      || state.companyId !== companyId
      || String(state.activeConversation?.conversationId) !== conversationId) return;
    if (response.status === 409 && payload?.error === 'stale_conversation_version') {
      const countersNeedReload = applyConversationState(payload.current);
      if (countersNeedReload) await loadConversations();
      setStatus('La conversación cambió en otra sesión. Se mostró el estado actual; revisá antes de volver a intentar.', 'warning');
      return;
    }
    if (!response.ok) {
      setStatus(sanitizeCloudError(response.status, payload), 'error');
      return;
    }
    const countersNeedReload = applyConversationState(payload);
    if (countersNeedReload) await loadConversations();
    setStatus('Estado operativo actualizado.', 'success');
  } catch (error) {
    if (stateMutationGate.isCurrent(generation)
      && state.companyId === companyId
      && String(state.activeConversation?.conversationId) === conversationId
      && error?.message !== 'session_expired') {
      setStatus('No se pudo actualizar el estado operativo.', 'error');
    }
  } finally {
    if (state.pendingStateMutation?.generation === generation) state.pendingStateMutation = null;
    if (stateMutationGate.isCurrent(generation)) syncContextControls();
  }
}

function openConversation(conversation) {
  const activation = composerController.beginConversationChange(conversation.conversationId);
  if (!activation) {
    setComposerNotice('Esperá a que termine el envío antes de cambiar de conversación.', 'warning');
    return;
  }
  if (activeOverlay === 'filters') closeOverlay({ restoreFocus: false });
  const refreshSettlement = autoRefreshScheduler.pause();
  historyGate.invalidate();
  stateMutationGate.invalidate();
  historyController?.abort();
  state.activeConversation = conversation;
  state.activeCounterBaselineTrusted = true;
  returnFocusConversationId = String(conversation.conversationId);
  state.messages = [];
  state.historyCursor = null;
  state.mobile = reduceMobileView(state.mobile, { type: 'open', conversationId: conversation.conversationId });
  elements.inbox.classList.add('mobile-detail');
  elements.chatTitle.textContent = safeParticipant(conversation.participant);
  syncActiveConversationControls();
  elements.history.replaceChildren();
  appendSafeText(document, elements.history, 'p', 'Cargando historial…', 'empty-state');
  composerController.activateConversation(activation);
  setComposerNotice('');
  renderConversations();
  syncContextControls();
  if (isMobileLayout()) window.requestAnimationFrame(() => elements.back.focus());
  Promise.resolve(refreshSettlement).then(() => {
    const historyLoad = loadHistory();
    const contextLoad = loadConversationContext(String(conversation.conversationId));
    return Promise.allSettled([historyLoad, contextLoad]);
  }).finally(() => autoRefreshScheduler.start({ immediate: false }));
}

async function requestAttachmentDownload(conversationId, messageId, button) {
  button.disabled = true;
  try {
    const path = `/conversations/${encodeURIComponent(String(conversationId))}/messages/${encodeURIComponent(String(messageId))}/attachment/download`;
    const url = buildCloudApiUrl(path, { role: state.role, companyId: state.companyId });
    const { response } = await request(url);
    setStatus(attachmentDownloadNotice(response.status), response.ok ? 'success' : 'warning');
  } catch (error) {
    if (error?.message !== 'session_expired') setStatus('No se pudo consultar la descarga.', 'error');
  } finally {
    button.disabled = false;
  }
}

function renderCompanyPicker(companies) {
  const label = document.createElement('label');
  label.className = 'company-field';
  label.setAttribute('for', 'companySelect');
  label.append(document.createTextNode('Empresa'));
  const select = document.createElement('select');
  select.id = 'companySelect';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Seleccioná una empresa';
  placeholder.selected = true;
  select.append(placeholder);
  for (const company of companies) {
    const id = Number(company?.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const option = document.createElement('option');
    option.value = String(id);
    option.textContent = String(company?.nombre || `Empresa ${id}`).slice(0, 120);
    select.append(option);
  }
  select.addEventListener('change', () => {
    const selected = Number(select.value);
    const nextCompanyId = Number.isSafeInteger(selected) && selected > 0 ? selected : null;
    if (!composerController.changeCompany(nextCompanyId)) {
      select.value = state.companyId == null ? '' : String(state.companyId);
      setComposerNotice('Esperá a que termine el envío antes de cambiar de empresa.', 'warning');
      return;
    }
    const refreshSettlement = autoRefreshScheduler.pause();
    state.companyId = nextCompanyId;
    clearQuickReplies();
    state.conversationContextRevision += 1;
    state.conversationContextLoading = Boolean(nextCompanyId);
    conversationGate.invalidate();
    searchGate.invalidate();
    contextGate.invalidate();
    historyGate.invalidate();
    stateMutationGate.invalidate();
    conversationsController?.abort();
    searchController?.abort();
    contextController?.abort();
    historyController?.abort();
    state.searchQuery = '';
    elements.searchInput.value = '';
    state.canonicalConversations = [];
    state.canonicalFirstPageIds = [];
    state.canonicalConversationsCursor = null;
    state.conversations = [];
    state.conversationsCursor = null;
    state.counters = { total: 0, pending: 0, inProcess: 0, review: 0, resolved: 0 };
    elements.conversations.replaceChildren();
    elements.queueCounters.replaceChildren();
    elements.conversationsMore.hidden = true;
    clearChat({ composerAlreadyReset: true });
    if (state.companyId) {
      Promise.resolve(refreshSettlement)
        .then(() => Promise.all([loadConversations(), loadQuickReplies()]))
        .finally(() => autoRefreshScheduler.resume());
    }
    else setStatus('Seleccioná una empresa para ver sus conversaciones.', 'warning');
  });
  label.append(select);
  elements.companyWrap.replaceChildren(label);
  elements.companyWrap.hidden = false;
}

async function loadCompanies() {
  const { response, payload } = await request('/api/empresas');
  if (!response.ok) {
    setStatus(sanitizeCloudError(response.status, payload), 'error');
    return;
  }
  renderCompanyPicker(Array.isArray(payload) ? payload : []);
  setStatus('Seleccioná una empresa para ver sus conversaciones.', 'warning');
}

const replySubmission = createSingleFlightSubmission({
  start() {
    if (!state.activeConversation) throw new Error('Seleccioná una conversación');
    if (composerController.snapshot().composer.reconciliationRequired) {
      throw new Error('El resultado es incierto y requiere reconciliación');
    }
    const submission = composerController.startSend(crypto.randomUUID());
    syncContextControls();
    return submission;
  },
  async execute(submission, { signal }) {
    const { conversationId, companyId } = submission.context;
    const pending = submission.pending;
    const body = { text: pending.text, idempotency_key: pending.idempotencyKey };
    if (state.role === 'super') body.empresa_id = companyId;
    const deadline = createSendDeadline({ parentSignal: signal, timeoutMs: SEND_TIMEOUT_MS });
    try {
      const path = `/conversations/${encodeURIComponent(conversationId)}/replies`;
      const url = buildCloudApiUrl(path, { role: state.role, companyId, tenantInBody: true });
      const { response, payload } = await request(url, {
        method: 'POST', body: JSON.stringify(body), signal: deadline.signal,
      });
      return { status: response.status, errorCode: payload?.error, payload };
    } finally {
      deadline.cleanup();
    }
  },
  settle(submission, result) {
    if (!composerController.settleSend(submission, result)) return;
    const composer = composerController.snapshot().composer;
    const tone = composer.reconciliationRequired
      ? 'warning'
      : (result.status === 202 || result.status === 200 ? 'success' : 'error');
    setComposerNotice(composer.notice, tone);
  },
  reject(submission, error) {
    if (error?.message === 'session_expired') return;
    if (composerController.settleSend(submission, { status: 0 })) {
      setComposerNotice(composerController.snapshot().composer.notice, 'warning');
    }
  },
  finish() {
    syncContextControls();
  },
});

const autoRefreshScheduler = createChainedRefreshScheduler({
  isVisible: () => document.visibilityState === 'visible',
  canRun: () => Boolean(autoRefreshAllowed && state.role && state.companyId),
  cycle: runAutoRefreshCycle,
  baseDelayMs: 8_000,
  maxDelayMs: 60_000,
  jitter: ({ failures }) => (failures % 3) * 250,
});

async function submitMessage(event) {
  event.preventDefault();
  try {
    await replySubmission.submit();
  } catch (error) {
    setComposerNotice(error.message, 'error');
  }
}

async function bootstrap() {
  setStatus('Validando acceso…');
  try {
    const { response, payload } = await request('/api/me');
    if (!response.ok) {
      setStatus(sanitizeCloudError(response.status, payload), 'error');
      return;
    }
    const access = bootstrapInboxState(payload?.user || payload || {});
    if (access.access !== 'ready') {
      setStatus('No tenés acceso a esta bandeja. Volviendo al panel…', 'error');
      window.setTimeout(() => window.location.assign('/pedidos/dashboard.html'), 1200);
      return;
    }
    state.role = access.role;
    state.companyId = access.companyId;
    composerController.changeCompany(access.companyId);
    if (access.needsCompanySelection) await loadCompanies();
    else {
      elements.companyWrap.replaceChildren();
      await Promise.all([loadConversations(), loadQuickReplies()]);
      autoRefreshScheduler.start({ immediate: false });
    }
  } catch (error) {
    if (error?.message !== 'session_expired') setStatus('No se pudo validar la sesión.', 'error');
  }
}

elements.back.addEventListener('click', () => clearChat());
elements.filtersToggle.addEventListener('click', () => {
  if (activeOverlay === 'filters') closeOverlay();
  else openOverlay('filters', elements.filtersToggle);
});
elements.contextToggle.addEventListener('click', toggleContextPanel);
elements.contextClose.addEventListener('click', () => {
  if (isDesktopLayout()) {
    elements.inbox.classList.add('context-collapsed');
    elements.contextPanel.dataset.open = 'false';
    elements.contextToggle.setAttribute('aria-expanded', 'false');
    elements.contextToggle.focus({ preventScroll: true });
  } else closeOverlay();
});
elements.overlayBackdrop.addEventListener('click', () => closeOverlay());
document.addEventListener('keydown', event => {
  if (!activeOverlay) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeOverlay();
    return;
  }
  if (event.key !== 'Tab') return;
  const panel = activeOverlay === 'filters' ? elements.queueFilters : elements.contextPanel;
  const focusable = overlayFocusable(panel);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
elements.searchForm.addEventListener('submit', submitConversationSearch);
elements.searchClear.addEventListener('click', () => clearConversationSearch());
elements.older.addEventListener('click', () => loadHistory({ older: true }));
elements.conversationsMore.addEventListener('click', () => {
  if (state.searchQuery) submitConversationSearch(null, { append: true });
  else loadConversations({ append: true });
});
elements.refresh.addEventListener('click', () => reloadConversationsFromStart({ preserveActiveConversation: true }));
const reloadForFilterChange = () => {
  clearConversationSearch({ restore: false });
  reloadConversationsFromStart();
};
elements.dateFilter?.addEventListener('change', reloadForFilterChange);
elements.transferFilter?.addEventListener('change', reloadForFilterChange);
elements.workflowFilter?.addEventListener('change', reloadForFilterChange);
elements.priorityFilter?.addEventListener('change', reloadForFilterChange);
elements.unreadFilter?.addEventListener('change', reloadForFilterChange);
elements.conversationWorkflow.addEventListener('click', () => {
  if (!state.activeConversation) return;
  const workflowStatus = state.activeConversation.workflowStatus === 'resolved' ? 'pending' : 'resolved';
  patchActiveConversationState({ workflowStatus });
});
elements.conversationPriority.addEventListener('change', () => {
  const priority = elements.conversationPriority.value;
  if (['normal', 'high', 'urgent'].includes(priority)) patchActiveConversationState({ priority });
});
elements.composer.addEventListener('submit', submitMessage);
elements.newMessage.addEventListener('click', () => {
  const warning = 'El mensaje anterior puede haberse enviado. Al continuar se descartará el borrador incierto. ¿Iniciar un mensaje distinto?';
  if (!window.confirm(warning)) return;
  if (composerController.discardUncertainDraft()) {
    setComposerNotice('Escribí un mensaje distinto. El mensaje incierto no se reenviará.', 'warning');
    syncContextControls();
    elements.input.focus();
  }
});
elements.input.addEventListener('input', () => {
  composerController.captureDraft();
  setComposerNotice('');
});
elements.logout.addEventListener('click', async (event) => {
  event.preventDefault();
  autoRefreshScheduler.stop();
  try { await request('/api/logout', { method: 'POST' }); } catch {}
  window.location.assign('/pedidos/login.html');
});

elements.newMessages.addEventListener('click', () => {
  state.newMessageCount = 0;
  elements.newMessages.hidden = true;
  elements.history.scrollTop = elements.history.scrollHeight;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') autoRefreshScheduler.pause();
  else autoRefreshScheduler.resume();
});

function syncResponsiveChrome() {
  updateViewportMetrics();
  if (isDesktopLayout()) {
    closeOverlay({ restoreFocus: false });
    clearOverlayInert();
    clearDialogSemantics(elements.queueFilters);
    clearDialogSemantics(elements.contextPanel);
    elements.queueFilters.dataset.open = 'false';
    elements.filtersToggle.setAttribute('aria-expanded', 'false');
    const expanded = !elements.inbox.classList.contains('context-collapsed');
    elements.contextPanel.dataset.open = String(expanded);
    elements.contextToggle.setAttribute('aria-expanded', String(expanded));
  } else {
    elements.inbox.classList.remove('context-collapsed');
    if (activeOverlay !== 'context') elements.contextPanel.dataset.open = 'false';
    elements.contextToggle.setAttribute('aria-expanded', String(activeOverlay === 'context'));
  }
}

window.addEventListener('resize', syncResponsiveChrome);
window.visualViewport?.addEventListener('resize', updateViewportMetrics);
window.visualViewport?.addEventListener('scroll', updateViewportMetrics);
window.addEventListener('pagehide', () => autoRefreshScheduler.stop());
window.addEventListener('beforeunload', () => autoRefreshScheduler.stop());

syncResponsiveChrome();
bootstrap();
