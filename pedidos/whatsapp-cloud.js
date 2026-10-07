import {
  appendSafeText,
  attachmentDownloadNotice,
  bootstrapInboxState,
  buildCloudApiUrl,
  conversationPreview,
  createInboxComposerController,
  createRequestGate,
  createSendDeadline,
  formatCloudTimestamp,
  mergeHistoryPage,
  reduceMobileView,
  safeParticipant,
  sanitizeCloudError,
  statusMeta,
} from './whatsapp-cloud-ui.js';

const SEND_TIMEOUT_MS = 25_000;

const elements = {
  status: document.querySelector('#appStatus'),
  inbox: document.querySelector('#inboxLayout'),
  companyWrap: document.querySelector('#companyPicker'),
  conversations: document.querySelector('#conversationList'),
  conversationsMore: document.querySelector('#loadMoreConversations'),
  refresh: document.querySelector('#refreshConversations'),
  dateFilter: document.querySelector('#dateFilter'),
  transferFilter: document.querySelector('#transferFilter'),
  chatPanel: document.querySelector('#chatPanel'),
  chatTitle: document.querySelector('#chatTitle'),
  back: document.querySelector('#backToList'),
  history: document.querySelector('#messageHistory'),
  older: document.querySelector('#loadOlderMessages'),
  composer: document.querySelector('#composerForm'),
  input: document.querySelector('#messageInput'),
  send: document.querySelector('#sendButton'),
  composerNotice: document.querySelector('#composerNotice'),
  newMessage: document.querySelector('#startNewMessage'),
  logout: document.querySelector('#logout'),
};

const state = {
  role: null,
  companyId: null,
  conversations: [],
  conversationsCursor: null,
  activeConversation: null,
  messages: [],
  historyCursor: null,
  mobile: { mobileView: 'list', activeConversationId: null },
};

const composerController = createInboxComposerController({ input: elements.input, send: elements.send });

const conversationGate = createRequestGate();
const historyGate = createRequestGate();
let conversationsController = null;
let historyController = null;
let sendController = null;
let returnFocusConversationId = null;

function isMobileLayout() {
  return window.matchMedia('(max-width: 760px)').matches;
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
  };
}

function setStatus(message, tone = 'neutral') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
  elements.status.hidden = !message;
}

function setComposerNotice(message, tone = 'neutral') {
  elements.composerNotice.textContent = message;
  elements.composerNotice.dataset.tone = tone;
}

function syncContextControls() {
  const composer = composerController.snapshot().composer;
  const locked = composer.sending || composer.reconciliationRequired;
  const companySelect = elements.companyWrap.querySelector('select');
  if (companySelect) companySelect.disabled = locked;
  if (elements.dateFilter) elements.dateFilter.disabled = locked;
  if (elements.transferFilter) elements.transferFilter.disabled = locked;
  elements.back.disabled = locked;
  elements.conversations.querySelectorAll('button').forEach(button => { button.disabled = locked; });
  elements.newMessage.hidden = !composer.reconciliationRequired;
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
    window.location.assign('/pedidos/login.html');
    throw new Error('session_expired');
  }
  return { response, payload };
}

function clearChat({ composerAlreadyReset = false, restoreFocus = true } = {}) {
  if (!composerAlreadyReset && !composerController.closeConversation()) {
    setComposerNotice('Esperá a que termine el envío antes de cambiar de conversación.', 'warning');
    return false;
  }
  state.activeConversation = null;
  state.messages = [];
  state.historyCursor = null;
  state.mobile = reduceMobileView(state.mobile, { type: 'back' });
  elements.inbox.classList.remove('mobile-detail');
  elements.chatTitle.textContent = 'Seleccioná una conversación';
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

function renderConversations() {
  const fragment = document.createDocumentFragment();
  if (!state.conversations.length) {
    appendSafeText(document, fragment, 'p', 'No hay conversaciones para esta empresa.', 'empty-state');
  }
  for (const conversation of state.conversations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-card';
    button.disabled = composerController.snapshot().composer.sending;
    button.dataset.conversationId = String(conversation.conversationId);
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
  action.addEventListener('click', () => requestAttachmentDownload(message.id, action));
  card.append(action);
  container.append(card);
}

function renderHistory({ preserveScroll = false } = {}) {
  const previousHeight = elements.history.scrollHeight;
  const previousTop = elements.history.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!state.messages.length) appendSafeText(document, fragment, 'p', 'Todavía no hay mensajes.', 'empty-state');
  for (const message of state.messages) {
    const article = document.createElement('article');
    const direction = message.direction === 'outbound' ? 'outbound' : 'inbound';
    article.className = `message message-${direction}`;
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
  else elements.history.scrollTop = elements.history.scrollHeight;
}

async function loadConversations({ append = false } = {}) {
  if (state.role === 'super' && !state.companyId) return;
  conversationsController?.abort();
  conversationsController = new AbortController();
  const generation = conversationGate.begin();
  const cursor = append ? state.conversationsCursor : null;
  if (!append) setStatus('Cargando conversaciones…');
  try {
    const filters = currentFilters();
    const url = buildCloudApiUrl('/conversations', {
      role: state.role,
      companyId: state.companyId,
      limit: 25,
      from: filters.from,
      to: filters.to,
      payment: filters.payment,
      ...(cursor ? { cursor } : {}),
    });
    const { response, payload } = await request(url, { signal: conversationsController.signal });
    if (!conversationGate.isCurrent(generation)) return;
    if (!response.ok) {
      setStatus(sanitizeCloudError(response.status, payload), 'error');
      return;
    }
    const incoming = Array.isArray(payload.conversations) ? payload.conversations : [];
    const known = new Map((append ? state.conversations : []).map(item => [String(item.conversationId), item]));
    for (const item of incoming) known.set(String(item.conversationId), item);
    state.conversations = [...known.values()];
    state.conversationsCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
    renderConversations();
    setStatus('');
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.message !== 'session_expired' && conversationGate.isCurrent(generation)) {
      setStatus('No se pudieron cargar las conversaciones.', 'error');
    }
  }
}

async function reloadConversationsFromStart() {
  state.conversations = [];
  state.conversationsCursor = null;
  renderConversations();
  clearChat({ restoreFocus: false });
  await loadConversations();
}

async function loadHistory({ older = false } = {}) {
  if (!state.activeConversation) return;
  historyController?.abort();
  historyController = new AbortController();
  const generation = historyGate.begin();
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
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.message !== 'session_expired' && historyGate.isCurrent(generation)) {
      setStatus('No se pudo cargar el historial.', 'error');
    }
  }
}

function openConversation(conversation) {
  const activation = composerController.beginConversationChange(conversation.conversationId);
  if (!activation) {
    setComposerNotice('Esperá a que termine el envío antes de cambiar de conversación.', 'warning');
    return;
  }
  historyGate.invalidate();
  historyController?.abort();
  state.activeConversation = conversation;
  returnFocusConversationId = String(conversation.conversationId);
  state.messages = [];
  state.historyCursor = null;
  state.mobile = reduceMobileView(state.mobile, { type: 'open', conversationId: conversation.conversationId });
  elements.inbox.classList.add('mobile-detail');
  elements.chatTitle.textContent = safeParticipant(conversation.participant);
  elements.history.replaceChildren();
  appendSafeText(document, elements.history, 'p', 'Cargando historial…', 'empty-state');
  composerController.activateConversation(activation);
  setComposerNotice('');
  renderConversations();
  syncContextControls();
  if (isMobileLayout()) window.requestAnimationFrame(() => elements.back.focus());
  loadHistory();
}

async function requestAttachmentDownload(messageId, button) {
  button.disabled = true;
  try {
    const path = `/messages/${encodeURIComponent(String(messageId))}/attachment/download`;
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
    state.companyId = nextCompanyId;
    conversationGate.invalidate();
    historyGate.invalidate();
    conversationsController?.abort();
    historyController?.abort();
    state.conversations = [];
    state.conversationsCursor = null;
    elements.conversations.replaceChildren();
    clearChat({ composerAlreadyReset: true });
    if (state.companyId) loadConversations();
    else setStatus('Seleccioná una empresa para ver sus conversaciones.', 'warning');
  });
  label.append(select);
  elements.companyWrap.replaceChildren(label);
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

async function submitMessage(event) {
  event.preventDefault();
  if (!state.activeConversation) return;
  if (composerController.snapshot().composer.reconciliationRequired) return;
  let submission;
  try {
    submission = composerController.startSend(crypto.randomUUID());
  } catch (error) {
    setComposerNotice(error.message, 'error');
    return;
  }
  syncContextControls();
  const conversationId = submission.context.conversationId;
  const companyId = submission.context.companyId;
  const pending = submission.pending;
  const body = { text: pending.text, idempotency_key: pending.idempotencyKey };
  if (state.role === 'super') body.empresa_id = companyId;
  sendController = new AbortController();
  const deadline = createSendDeadline({ parentSignal: sendController.signal, timeoutMs: SEND_TIMEOUT_MS });
  try {
    const path = `/conversations/${encodeURIComponent(conversationId)}/replies`;
    const url = buildCloudApiUrl(path, { role: state.role, companyId, tenantInBody: true });
    const { response, payload } = await request(url, {
      method: 'POST', body: JSON.stringify(body), signal: deadline.signal,
    });
    if (!composerController.settleSend(submission, { status: response.status, errorCode: payload?.error })) return;
    const composer = composerController.snapshot().composer;
    if (response.status === 202 || response.status === 200) {
      setComposerNotice(composer.notice, 'success');
    } else {
      setComposerNotice(composer.notice, payload?.error === 'reply_enqueue_outcome_unknown' ? 'warning' : 'error');
    }
  } catch (error) {
    if (error?.message !== 'session_expired') {
      if (composerController.settleSend(submission, { status: 0 })) {
        setComposerNotice(composerController.snapshot().composer.notice, 'error');
      }
    }
  } finally {
    deadline.cleanup();
    sendController = null;
    syncContextControls();
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
      await loadConversations();
    }
  } catch (error) {
    if (error?.message !== 'session_expired') setStatus('No se pudo validar la sesión.', 'error');
  }
}

elements.back.addEventListener('click', () => clearChat());
elements.older.addEventListener('click', () => loadHistory({ older: true }));
elements.conversationsMore.addEventListener('click', () => loadConversations({ append: true }));
elements.refresh.addEventListener('click', () => loadConversations());
elements.dateFilter?.addEventListener('change', () => reloadConversationsFromStart());
elements.transferFilter?.addEventListener('change', () => reloadConversationsFromStart());
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
  try { await request('/api/logout', { method: 'POST' }); } catch {}
  window.location.assign('/pedidos/login.html');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    conversationsController?.abort();
    historyController?.abort();
    sendController?.abort();
    return;
  }
  loadConversations();
  if (state.activeConversation) loadHistory();
});

bootstrap();
