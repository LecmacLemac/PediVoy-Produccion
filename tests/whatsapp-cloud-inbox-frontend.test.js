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

  assert.equal(controller.settleSend(delayed, { status: 202 }), true);
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

test('composer conserva borrador en fallas y sólo limpia con 202 confirmado', () => {
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

  const accepted = resolveSubmission(pending, { status: 202 });
  assert.equal(accepted.draft, '');
  assert.equal(accepted.sending, false);
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

test('errores visibles son españoles, acotados y no reflejan payload privado', () => {
  assert.equal(sanitizeCloudError(403, { error: 'private phone token sql detail' }), 'No tenés acceso a esta bandeja.');
  assert.equal(sanitizeCloudError(503, { error: 'reply_enqueue_outcome_unknown', secret: 'token' }), 'Resultado incierto: no vuelvas a enviar este mensaje. Verificá la conversación más tarde.');
  assert.equal(sanitizeCloudError(500, { error: 'private phone token sql detail' }), 'No se pudo completar la operación. Intentá nuevamente más tarde.');
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

test('controlador usa credenciales same-origin, AbortController y envío único', async () => {
  const controller = await source(controllerUrl);
  assert.match(controller, /credentials:\s*'same-origin'/);
  assert.match(controller, /new AbortController\(\)/);
  assert.match(controller, /crypto\.randomUUID\(\)/);
  assert.match(controller, /status\s*===\s*202/);
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
