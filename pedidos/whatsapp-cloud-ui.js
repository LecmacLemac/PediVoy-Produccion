const API_ROOT = '/api/admin/whatsapp-cloud';
const ALLOWED_QUERY_KEYS = new Set(['role', 'companyId', 'cursor', 'limit', 'tenantInBody']);
const MASKED_PARTICIPANT = /^\*{3,11}\d{4}$/;

const STATUS = Object.freeze({
  queued: Object.freeze({ label: 'En cola', tone: 'pending', help: 'El mensaje espera procesamiento.', retrySafe: false }),
  pending: Object.freeze({ label: 'En cola', tone: 'pending', help: 'El mensaje espera procesamiento.', retrySafe: false }),
  sent: Object.freeze({ label: 'Enviado', tone: 'sent', help: 'Meta aceptó el mensaje.', retrySafe: false }),
  delivered: Object.freeze({ label: 'Entregado', tone: 'delivered', help: 'El mensaje llegó al dispositivo.', retrySafe: false }),
  read: Object.freeze({ label: 'Leído', tone: 'read', help: 'El destinatario abrió el mensaje.', retrySafe: false }),
  failed: Object.freeze({ label: 'Falló', tone: 'failed', help: 'El envío falló. Revisá el estado antes de crear un mensaje nuevo.', retrySafe: false }),
  outcome_unknown: Object.freeze({ label: 'Resultado incierto', tone: 'unknown', help: 'No vuelvas a enviar: el proveedor podría haber aceptado el mensaje.', retrySafe: false }),
  received: Object.freeze({ label: 'Recibido', tone: 'received', help: 'Mensaje entrante recibido.', retrySafe: false }),
});

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

export function createRequestGate() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(value) { return value === generation; },
  };
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

export function resolveSubmission(state, result = {}) {
  if (result.status === 202) return createComposerState('');
  const outcomeUnknown = result.status === 0 || result.errorCode === 'reply_enqueue_outcome_unknown';
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

export function sanitizeCloudError(status, payload = {}) {
  const code = typeof payload?.error === 'string' ? payload.error : '';
  if (status === 401) return 'Tu sesión venció. Volvé a iniciar sesión.';
  if (status === 403) return 'No tenés acceso a esta bandeja.';
  if (status === 404 && code === 'conversation_not_found') return 'La conversación ya no está disponible.';
  if (status === 409 && code === 'attachment_download_unavailable') return attachmentDownloadNotice(409);
  if (status === 409 && code === 'idempotency_key_conflict') return 'El envío no se procesó porque la solicitud ya no coincide. Escribí un mensaje nuevo.';
  if (code === 'reply_enqueue_outcome_unknown') return 'Resultado incierto: no vuelvas a enviar este mensaje. Verificá la conversación más tarde.';
  if (code === 'reply_invalid') return 'Revisá el mensaje antes de enviarlo.';
  if (code === 'empresa_id_required') return 'Seleccioná una empresa para continuar.';
  return 'No se pudo completar la operación. Intentá nuevamente más tarde.';
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
