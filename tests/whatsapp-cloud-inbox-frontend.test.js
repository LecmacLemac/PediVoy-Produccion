import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import {
  appendSafeText,
  attachmentDownloadNotice,
  bootstrapInboxState,
  buildCloudApiUrl,
  conversationPreview,
  createComposerState,
  createInboxComposerController,
  createRequestGate,
  createSendDeadline,
  createSingleFlightSubmission,
  mergeHistoryPage,
  reduceMobileView,
  resolveSubmission,
  safeParticipant,
  sanitizeCloudError,
  startSubmission,
  statusMeta,
} from '../pedidos/whatsapp-cloud-ui.js';

const root = new URL('../', import.meta.url);
const pageUrl = new URL('pedidos/whatsapp-cloud.html', root);
const controllerUrl = new URL('pedidos/whatsapp-cloud.js', root);
const helpersUrl = new URL('pedidos/whatsapp-cloud-ui.js', root);
const dashboardNavUrl = new URL('pedidos/dashboard-nav.js', root);

async function source(url) {
  return readFile(url, 'utf8');
}

test('existen la pantalla Cloud y sus scripts en el árbol estático de pedidos', async () => {
  await Promise.all([access(pageUrl), access(controllerUrl), access(helpersUrl)]);
  const app = await source(new URL('src/app.js', root));
  assert.match(app, /app\.use\('\/pedidos',\s*express\.static\(PEDIDOS_DIR\)\)/);
});

test('la pantalla carga el controlador como módulo sin frameworks nuevos', async () => {
  const html = await source(pageUrl);
  assert.match(html, /<script\s+type="module"\s+src="whatsapp-cloud\.js"><\/script>/);
  assert.doesNotMatch(html, /react|vue|angular|svelte/i);
});

test('la navegación backoffice oculta WhatsApp Cloud por defecto y conserva QR', async () => {
  const dashboard = await source(new URL('pedidos/dashboard.html', root));
  assert.match(dashboard, /<li[^>]*id="whatsappCloudNavItem"[^>]*hidden[^>]*>\s*<a href="whatsapp-cloud\.html">WhatsApp Cloud<\/a>/);
  assert.match(dashboard, /href="qr\.html"[^>]*>QR</);
});

test('dashboard revela WhatsApp Cloud sólo para roles canónicos admin y super', async () => {
  const { applyCloudInboxNavigation } = await import(dashboardNavUrl);
  const item = { hidden: false };
  const documentLike = { querySelector: selector => selector === '#whatsappCloudNavItem' ? item : null };

  for (const role of ['user', 'facturacion', 'contable', 'repartidor', 'referente', 'Admin', ' admin', 'super ', '', null, 7]) {
    item.hidden = false;
    assert.equal(applyCloudInboxNavigation(documentLike, role), false, JSON.stringify(role));
    assert.equal(item.hidden, true, JSON.stringify(role));
  }
  for (const role of ['admin', 'super']) {
    item.hidden = true;
    assert.equal(applyCloudInboxNavigation(documentLike, role), true, role);
    assert.equal(item.hidden, false, role);
  }

  const dashboard = await source(new URL('pedidos/dashboard.html', root));
  assert.match(dashboard, /import\s*\{\s*applyCloudInboxNavigation\s*\}\s*from\s*['"]\.\/dashboard-nav\.js['"]/);
  assert.match(dashboard, /applyCloudInboxNavigation\(document,\s*user\?\.role\)/);
});

test('la pantalla declara layout accesible de lista, chat y volver móvil', async () => {
  const html = await source(pageUrl);
  assert.match(html, /id="conversationList"/);
  assert.match(html, /id="chatPanel"/);
  assert.match(html, /id="backToList"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)/);
  assert.match(html, /<label\s+for="messageInput"\s+class="sr-only">Mensaje<\/label>/);
  assert.match(html, /\.sr-only\s*\{/);
  assert.doesNotMatch(html, /<label\s+for="messageInput"[^>]*hidden/);
});

test('la bandeja declara filtros rápidos de fecha y transferencias', async () => {
  const html = await source(pageUrl);
  const controller = await source(controllerUrl);
  assert.match(html, /id="dateFilter"/);
  assert.match(html, /value="today"[^>]*>Hoy/);
  assert.match(html, /value="yesterday"[^>]*>Ayer/);
  assert.match(html, /value="last7"[^>]*>Últimos 7 días/);
  assert.match(html, /id="transferFilter"/);
  assert.match(html, /Ver clientes con transferencia/);
  assert.match(controller, /resolveDateFilter/);
  assert.match(controller, /payment:\s*filters\.payment/);
  assert.match(controller, /state\.conversationsCursor = null/);
});

test('la lista de conversaciones muestra nombre, dirección y pago del último pedido sin HTML inseguro', async () => {
  const controller = await source(controllerUrl);
  assert.match(controller, /customer-line/);
  assert.match(controller, /conversation\.customerName/);
  assert.match(controller, /conversation\.customerAddress/);
  assert.match(controller, /conversation\.paymentMethod/);
  assert.match(controller, /payment-label/);
  assert.match(controller, /appendSafeText\(document, button, 'span', customerDetail/);
  assert.match(controller, /appendSafeText\(document, summary, 'span', paymentLabel/);
  assert.doesNotMatch(controller, /customerName[^\n]+innerHTML|customerAddress[^\n]+innerHTML|paymentMethod[^\n]+innerHTML/);
});

function composerDomHarness() {
  const input = { value: '', disabled: true };
  const send = { disabled: true, textContent: 'Enviar' };
  return { input, send, controller: createInboxComposerController({ input, send }) };
}

test('cambio de empresa limpia el borrador, deshabilita el composer y no permite enviar', () => {
  const { input, send, controller } = composerDomHarness();
  controller.changeCompany(7);
  const activation = controller.beginConversationChange('conv-a');
  assert.equal(controller.activateConversation(activation), true);
  input.value = 'BORRADOR PRIVADO EMPRESA A';
  controller.captureDraft();

  assert.equal(controller.changeCompany(9), true);
  assert.equal(input.value, '');
  assert.equal(input.disabled, true);
  assert.equal(send.disabled, true);
  assert.throws(() => controller.startSend('key-company'), /conversación/i);
});

test('cambio de conversación exige reescritura y el envío pertenece sólo al destinatario activo', () => {
  const { input, controller } = composerDomHarness();
  controller.changeCompany(7);
  const first = controller.beginConversationChange('recipient-a');
  controller.activateConversation(first);
  input.value = 'SECRETO PARA A';
  controller.captureDraft();

  const second = controller.beginConversationChange('recipient-b');
  assert.equal(input.value, '');
  assert.equal(input.disabled, true);
  controller.activateConversation(second);
  assert.throws(() => controller.startSend('key-empty'), /mensaje/i);

  input.value = 'mensaje explícito para B';
  controller.captureDraft();
  const submission = controller.startSend('key-b');
  assert.deepEqual(submission.context, { companyId: 7, conversationId: 'recipient-b' });
  assert.equal(submission.pending.text, 'mensaje explícito para B');
});

test('envío en vuelo rechaza un segundo start sincronizado y conserva la submission original', () => {
  const { input, controller } = composerDomHarness();
  controller.changeCompany(7);
  controller.activateConversation(controller.beginConversationChange('recipient-a'));
  input.value = 'mensaje A';
  controller.captureDraft();

  const first = controller.startSend('key-a');

  assert.throws(() => controller.startSend('key-b'), /envío/i);
  assert.equal(controller.snapshot().composer.pending.idempotencyKey, 'key-a');
  assert.equal(controller.settleSend(first, {
    status: 202,
    payload: { accepted: true, deduplicated: false, id: '501', status: 'pending' },
  }), true);
});

test('envío en vuelo bloquea cambios y una respuesta demorada no muta el contexto nuevo', () => {
  const { input, controller } = composerDomHarness();
  controller.changeCompany(7);
  const first = controller.beginConversationChange('recipient-a');
  controller.activateConversation(first);
  input.value = 'mensaje A';
  controller.captureDraft();
  const delayed = controller.startSend('key-a');

  assert.equal(controller.changeCompany(9), false);
  assert.equal(controller.beginConversationChange('recipient-b'), null);
  assert.equal(controller.closeConversation(), false);
  assert.deepEqual(controller.snapshot().context, { companyId: 7, conversationId: 'recipient-a' });

  assert.equal(controller.settleSend(delayed, {
    status: 202,
    payload: { accepted: true, deduplicated: false, id: '502', status: 'pending' },
  }), true);
  assert.equal(controller.changeCompany(9), true);
  const second = controller.beginConversationChange('recipient-b');
  controller.activateConversation(second);
  input.value = 'borrador B';
  controller.captureDraft();

  assert.equal(controller.settleSend(delayed, { status: 502, errorCode: 'reply_enqueue_failed' }), false);
  assert.equal(input.value, 'borrador B');
  assert.equal(input.disabled, false);
  assert.deepEqual(controller.snapshot().context, { companyId: 9, conversationId: 'recipient-b' });
});

test('bootstrap fija admin a su empresa y obliga selección explícita para super', () => {
  assert.deepEqual(bootstrapInboxState({ role: 'admin', empresa_id: 7 }), {
    access: 'ready', role: 'admin', companyId: 7, needsCompanySelection: false,
  });
  assert.deepEqual(bootstrapInboxState({ role: 'super', empresa_id: null }), {
    access: 'ready', role: 'super', companyId: null, needsCompanySelection: true,
  });
  assert.deepEqual(bootstrapInboxState({ role: 'user', empresa_id: 7 }), {
    access: 'denied', role: 'user', companyId: null, needsCompanySelection: false,
  });
  assert.deepEqual(bootstrapInboxState({ role: 'Admin', empresa_id: 7 }), {
    access: 'denied', role: 'Admin', companyId: null, needsCompanySelection: false,
  });
});

test('URLs Cloud no aceptan tenant global ni campos sensibles', () => {
  assert.equal(buildCloudApiUrl('/conversations', { role: 'admin', companyId: 7, limit: 25 }), '/api/admin/whatsapp-cloud/conversations?limit=25');
  assert.equal(buildCloudApiUrl('/conversations', { role: 'super', companyId: 9, cursor: 'abc_123', limit: 25 }), '/api/admin/whatsapp-cloud/conversations?empresa_id=9&limit=25&cursor=abc_123');
  assert.equal(buildCloudApiUrl('/conversations/44/replies', { role: 'super', companyId: 9, tenantInBody: true }), '/api/admin/whatsapp-cloud/conversations/44/replies');
  assert.equal(
    buildCloudApiUrl('/conversations', {
      role: 'admin', companyId: 7, limit: 25,
      from: '2026-10-07T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', payment: 'transferencia',
    }),
    '/api/admin/whatsapp-cloud/conversations?limit=25&from=2026-10-07T00%3A00%3A00.000Z&to=2026-10-08T00%3A00%3A00.000Z&payment=transferencia',
  );
  assert.throws(() => buildCloudApiUrl('/conversations', { role: 'super', companyId: null }), /empresa/i);
  assert.throws(() => buildCloudApiUrl('/conversations', { role: 'super', companyId: 1, phone: '5493515550001' }), /parámetro/i);
  assert.throws(() => buildCloudApiUrl('/conversations', { role: 'admin', companyId: 7, from: 'hoy' }), /fecha/i);
  assert.throws(() => buildCloudApiUrl('/conversations', { role: 'admin', companyId: 7, payment: 'efectivo' }), /pago/i);
});

test('teléfono se acepta sólo si ya viene enmascarado y preview no usa PII cruda', () => {
  assert.equal(safeParticipant('*********0001'), '*********0001');
  assert.equal(safeParticipant('5493515550001'), 'Contacto protegido');
  assert.equal(safeParticipant('+54 9 351 555-0001'), 'Contacto protegido');
  assert.equal(conversationPreview({ lastMessageType: 'text', text: 'secreto' }), 'Mensaje de texto');
  assert.equal(conversationPreview({ lastMessageType: 'document', filename: 'privado.pdf' }), 'Documento');
});

test('estados tienen etiquetas españolas y outcome_unknown advierte no reenviar', () => {
  const expected = {
    queued: 'En cola', sent: 'Enviado', delivered: 'Entregado', read: 'Leído',
    failed: 'Falló', outcome_unknown: 'Resultado incierto', received: 'Recibido',
  };
  for (const [status, label] of Object.entries(expected)) assert.equal(statusMeta(status).label, label);
  assert.match(statusMeta('outcome_unknown').help, /no vuelvas a enviar/i);
  assert.equal(statusMeta('outcome_unknown').retrySafe, false);
});

test('historial pagina hacia atrás, deduplica y mantiene cronología', () => {
  const current = [
    { id: '3', messageAt: '2026-10-06T10:03:00Z' },
    { id: '4', messageAt: '2026-10-06T10:04:00Z' },
  ];
  const older = [
    { id: '1', messageAt: '2026-10-06T10:01:00Z' },
    { id: '2', messageAt: '2026-10-06T10:02:00Z' },
    { id: '3', messageAt: '2026-10-06T10:03:00Z' },
  ];
  assert.deepEqual(mergeHistoryPage(current, older).map(item => item.id), ['1', '2', '3', '4']);
});

test('guard monotónico rechaza respuestas obsoletas', () => {
  const gate = createRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test('vista móvil abre detalle y vuelve explícitamente a la lista', () => {
  const initial = { mobileView: 'list', activeConversationId: null };
  const detail = reduceMobileView(initial, { type: 'open', conversationId: '44' });
  assert.deepEqual(detail, { mobileView: 'detail', activeConversationId: '44' });
  assert.deepEqual(reduceMobileView(detail, { type: 'back' }), { mobileView: 'list', activeConversationId: null });
});

test('composer conserva borrador en fallas y limpia con 202 nuevo o 200 replay confirmado', () => {
  const initial = createComposerState(' respuesta ');
  const pending = startSubmission(initial, 'key-1');
  assert.equal(pending.sending, true);
  assert.equal(pending.draft, ' respuesta ');
  assert.deepEqual(pending.pending, { text: 'respuesta', idempotencyKey: 'key-1' });

  const failed = resolveSubmission(pending, { status: 502, errorCode: 'reply_enqueue_failed' });
  assert.equal(failed.sending, false);
  assert.equal(failed.draft, ' respuesta ');
  assert.equal(failed.pending, null);

  const unknown = resolveSubmission(pending, { status: 503, errorCode: 'reply_enqueue_outcome_unknown' });
  assert.equal(unknown.draft, ' respuesta ');
  assert.match(unknown.notice, /no vuelvas a enviar/i);
  assert.equal(unknown.canRetry, false);
  assert.equal(unknown.reconciliationRequired, true);
  assert.deepEqual(unknown.pending, { text: 'respuesta', idempotencyKey: 'key-1' });

  const networkUnknown = resolveSubmission(pending, { status: 0 });
  assert.match(networkUnknown.notice, /no vuelvas a enviar/i);
  assert.equal(networkUnknown.canRetry, false);
  assert.equal(networkUnknown.reconciliationRequired, true);

  const accepted = resolveSubmission(pending, {
    status: 202,
    payload: { accepted: true, deduplicated: false, id: '501', status: 'pending' },
  });
  assert.equal(accepted.draft, '');
  assert.equal(accepted.sending, false);
  assert.equal(accepted.notice, 'Mensaje en cola. No se reenviará automáticamente.');

  const replayed = resolveSubmission(pending, {
    status: 200,
    payload: { accepted: true, deduplicated: true, id: '501', status: 'pending' },
  });
  assert.equal(replayed.draft, '');
  assert.equal(replayed.sending, false);
  assert.equal(replayed.notice, 'El mensaje ya estaba en cola. No se creó un duplicado.');
});

test('2xx vacío, inválido o incoherente conserva draft/key y bloquea reenvío', () => {
  const invalidResults = [
    { status: 202, payload: null },
    { status: 202, payload: {} },
    { status: 202, payload: { accepted: false, deduplicated: false, id: '501', status: 'pending' } },
    { status: 202, payload: { accepted: true, deduplicated: true, id: '501', status: 'pending' } },
    { status: 202, payload: { accepted: true, deduplicated: false, id: null, status: 'pending' } },
    { status: 202, payload: { accepted: true, deduplicated: false, id: '501', status: 'private-provider-state' } },
    { status: 200, payload: { accepted: true, deduplicated: false, id: '501', status: 'pending' } },
    { status: 200, payload: { accepted: true, deduplicated: true, id: 'not-an-id', status: 'pending' } },
  ];

  for (const result of invalidResults) {
    const pending = startSubmission(createComposerState(' mensaje durable '), 'durable-key');
    const resolved = resolveSubmission(pending, result);
    assert.equal(resolved.draft, ' mensaje durable ', JSON.stringify(result));
    assert.deepEqual(resolved.pending, { text: 'mensaje durable', idempotencyKey: 'durable-key' }, JSON.stringify(result));
    assert.equal(resolved.reconciliationRequired, true, JSON.stringify(result));
    assert.equal(resolved.canRetry, false, JSON.stringify(result));
    assert.match(resolved.notice, /no vuelvas a enviar/i, JSON.stringify(result));
  }
});

test('conflicto idempotente conserva borrador, desbloquea y exige una key nueva en retry manual', () => {
  const { input, send, controller } = composerDomHarness();
  controller.changeCompany(7);
  controller.activateConversation(controller.beginConversationChange('recipient-a'));
  input.value = 'mensaje para revisar';
  controller.captureDraft();
  const first = controller.startSend('conflicting-key');
  controller.settleSend(first, { status: 409, errorCode: 'idempotency_key_conflict' });

  const conflicted = controller.snapshot().composer;
  assert.equal(conflicted.draft, 'mensaje para revisar');
  assert.equal(conflicted.pending, null);
  assert.equal(conflicted.reconciliationRequired, false);
  assert.equal(input.disabled, false);
  assert.equal(send.disabled, false);
  assert.match(conflicted.notice, /conservamos tu borrador/i);

  const retry = controller.startSend('fresh-manual-key');
  assert.equal(retry.pending.idempotencyKey, 'fresh-manual-key');
  assert.notEqual(retry.pending.idempotencyKey, first.pending.idempotencyKey);
});

test('resultado incierto bloquea segundo envío y conserva la misma key hasta descarte explícito', () => {
  const { input, send, controller } = composerDomHarness();
  controller.changeCompany(7);
  controller.activateConversation(controller.beginConversationChange('recipient-a'));
  input.value = 'mensaje potencialmente enviado';
  controller.captureDraft();
  const first = controller.startSend('uncertain-key-1');
  controller.settleSend(first, { status: 0 });

  assert.equal(input.disabled, true);
  assert.equal(send.disabled, true);
  assert.throws(() => controller.startSend('fresh-key-must-not-be-used'), /incierto|reconciliación/i);
  assert.equal(controller.snapshot().composer.pending.idempotencyKey, 'uncertain-key-1');
  assert.equal(controller.discardUncertainDraft(), true);
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  assert.equal(send.disabled, false);
});

test('deadline aborta exactamente al límite, compone abort externo y limpia recursos', () => {
  let timerCallback = null;
  let cleared = 0;
  const parent = new AbortController();
  const deadline = createSendDeadline({
    parentSignal: parent.signal,
    timeoutMs: 25_000,
    setTimeoutFn(callback, ms) {
      assert.equal(ms, 25_000);
      timerCallback = callback;
      return 91;
    },
    clearTimeoutFn(id) {
      assert.equal(id, 91);
      cleared += 1;
    },
  });
  assert.equal(deadline.signal.aborted, false);
  timerCallback();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.timedOut(), true);
  deadline.cleanup();
  assert.equal(cleared, 1);

  const external = new AbortController();
  const composed = createSendDeadline({ parentSignal: external.signal, timeoutMs: 25_000 });
  external.abort();
  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.timedOut(), false);
  composed.cleanup();
});

test('composer aplica límite de API y exige una key nueva válida por envío', () => {
  assert.throws(() => startSubmission(createComposerState(''), 'key-1'), /mensaje/i);
  assert.throws(() => startSubmission(createComposerState('x'.repeat(4097)), 'key-1'), /4096/);
  assert.throws(() => startSubmission(createComposerState('hola'), ''), /clave/i);
});

test('adjunto 409 se comunica como no disponible sin URL de proveedor', () => {
  assert.equal(attachmentDownloadNotice(409), 'La descarga todavía no está disponible.');
  assert.equal(attachmentDownloadNotice(404), 'El adjunto ya no está disponible.');
});

test('catálogo público de errores es allowlisted, accionable y no refleja payload privado', () => {
  const cases = [
    [401, { error: 'private phone token sql detail' }, 'Tu sesión venció. Volvé a iniciar sesión.'],
    [403, { error: 'access_denied' }, 'No tenés acceso a esta bandeja.'],
    [403, { error: 'request_origin_invalid' }, 'El origen de la solicitud no es válido. Recargá la página e intentá nuevamente.'],
    [400, { error: 'empresa_id_required' }, 'Seleccioná una empresa para continuar.'],
    [400, { error: 'empresa_id_invalid' }, 'La empresa seleccionada no es válida. Elegí otra empresa.'],
    [409, { error: 'cloud_config_inactive' }, 'WhatsApp Cloud no está activo para esta empresa. Revisá su configuración.'],
    [404, { error: 'conversation_not_found' }, 'La conversación ya no está disponible. Actualizá la bandeja.'],
    [400, { error: 'reply_invalid' }, 'Revisá el mensaje antes de enviarlo.'],
    [415, { error: 'content_type_invalid' }, 'Revisá el mensaje antes de enviarlo.'],
    [409, { error: 'idempotency_key_conflict' }, 'La clave de envío ya fue usada con otro mensaje. Conservamos tu borrador: revisalo y enviá nuevamente para generar una clave nueva.'],
    [502, { error: 'reply_enqueue_failed' }, 'No se pudo poner el mensaje en cola. Conservamos tu borrador; intentá enviarlo nuevamente.'],
    [503, { error: 'reply_enqueue_outcome_unknown' }, 'Resultado incierto: no vuelvas a enviar este mensaje. Verificá la conversación más tarde.'],
  ];
  for (const [status, payload, expected] of cases) {
    assert.equal(sanitizeCloudError(status, { ...payload, secret: 'token', cause: 'sql phone provider-id' }), expected);
  }
  const fallback = sanitizeCloudError(500, { error: 'private phone token sql detail', message: 'provider-id' });
  assert.equal(fallback, 'No se pudo completar la operación. Intentá nuevamente más tarde.');
  assert.doesNotMatch(`${cases.map(([, , expected]) => expected).join(' ')} ${fallback}`, /token|sql|provider-id|5493515550001/i);
});

test('texto no confiable se inserta sólo con textContent', () => {
  const created = [];
  const documentLike = {
    createElement(tag) {
      const node = { tag, className: '', textContent: '', children: [], append(child) { this.children.push(child); } };
      created.push(node);
      return node;
    },
  };
  const parent = { children: [], append(child) { this.children.push(child); } };
  const node = appendSafeText(documentLike, parent, 'p', '<img src=x onerror=alert(1)>', 'message-text');
  assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(node.className, 'message-text');
  assert.equal(parent.children[0], node);
});

test('fuentes frontend rechazan persistencia, HTML inseguro, logs sensibles y retry automático', async () => {
  const combined = `${await source(controllerUrl)}\n${await source(helpersUrl)}`;
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB|document\.cookie/i);
  assert.doesNotMatch(combined, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(combined, /console\.(?:log|debug|info|warn|error)/);
  assert.doesNotMatch(combined, /setInterval|automaticRetry|autoRetry/i);
  assert.doesNotMatch(combined, /media_id|provider_url|webhook_filename|access_token/i);
});

test('dos submits sincronizados producen exactamente una key, un POST y un settle', async () => {
  let keyCount = 0;
  let postCount = 0;
  let settleCount = 0;
  let releasePost;
  const postPending = new Promise(resolve => { releasePost = resolve; });
  const runner = createSingleFlightSubmission({
    start() {
      keyCount += 1;
      return { pending: { idempotencyKey: `key-${keyCount}` } };
    },
    async execute(submission, { signal }) {
      postCount += 1;
      assert.equal(submission.pending.idempotencyKey, 'key-1');
      assert.equal(signal.aborted, false);
      return postPending;
    },
    settle(submission, result) {
      settleCount += 1;
      assert.equal(submission.pending.idempotencyKey, 'key-1');
      assert.deepEqual(result, { status: 202 });
    },
  });

  const first = runner.submit();
  const second = runner.submit();

  assert.equal(await second, false);
  assert.equal(keyCount, 1);
  assert.equal(postCount, 1);
  assert.equal(settleCount, 0);
  releasePost({ status: 202 });
  assert.equal(await first, true);
  assert.equal(settleCount, 1);
});

test('controlador usa credenciales same-origin, AbortController y contrato de respuesta', async () => {
  const controller = await source(controllerUrl);
  assert.match(controller, /credentials:\s*'same-origin'/);
  assert.match(controller, /new AbortController\(\)/);
  assert.match(controller, /crypto\.randomUUID\(\)/);
  assert.match(controller, /return \{ status: response\.status, errorCode: payload\?\.error, payload \}/);
  assert.match(controller, /await replySubmission\.submit\(\)/);
  assert.match(controller, /snapshot\(\)\.composer\.notice/);
  assert.match(controller, /SEND_TIMEOUT_MS/);
  assert.match(controller, /visibilitychange[\s\S]*loadConversations/);
  assert.match(controller, /matchMedia\(['"]\(max-width:\s*760px\)['"]\)/);
  assert.doesNotMatch(controller, /window\.location\.search|URLSearchParams\(location\.search/);
});

test('layout usa shell flex de viewport y neutraliza nav global sin restas fijas', async () => {
  const html = await source(pageUrl);
  assert.match(html, /body\s*\{[^}]*display:flex[^}]*flex-direction:column[^}]*min-height:100vh/s);
  assert.match(html, /min-height:100dvh/);
  assert.match(html, /\.cloud-nav\s*\{/);
  assert.match(html, /\.shell\s*\{[^}]*flex:1[^}]*min-height:0/s);
  assert.match(html, /\.inbox\s*\{[^}]*min-height:0/s);
  assert.doesNotMatch(html, /height:calc\(100dvh\s*-\s*\d+px\)/);
});
