import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const htmlUrl = new URL('../pedidos/inicio/empresa.html', import.meta.url);

async function readHtml() {
  return readFile(htmlUrl, 'utf8');
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `falta ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`función incompleta: ${name}`);
}

async function loadPanelHelpers() {
  const html = await readHtml();
  const names = [
    'normalizeWhatsappTemplates',
    'normalizeWhatsappPanelConfig',
    'buildWhatsappConfigPayload',
    'validateWhatsappCloudActivation',
    'needsWhatsappCloudActivationConfirmation',
    'mergeEmpresaIntegraciones',
  ];
  const source = names.map(name => extractFunction(html, name)).join('\n');
  const context = vm.createContext({});
  vm.runInContext(`${source}; globalThis.helpers = { ${names.join(', ')} };`, context);
  return { html, ...context.helpers };
}

test('panel WhatsApp es superadmin-only y no precarga secretos', async () => {
  const html = await readHtml();
  assert.match(html, /id="panelWhatsappEmpresa"[^>]*style="display:\s*none/i);
  assert.match(html, />WhatsApp de la empresa</);
  assert.match(html, /id="e_whatsapp_provider"/);
  assert.match(html, /value="web"[^>]*>WhatsApp Web</);
  assert.match(html, /value="cloud"[^>]*>WhatsApp Cloud API</);
  assert.match(html, /id="e_whatsapp_phone_number_id"/);
  assert.match(html, /type="password"[^>]*id="e_whatsapp_access_token"/);
  assert.match(html, /id="e_whatsapp_token_status"/);
  assert.match(html, /id="e_whatsapp_enabled"/);
  assert.doesNotMatch(html, /id="e_whatsapp_waba_id"/);
  assert.match(html, /credentials:\s*'include'/);
});

test('carga Cloud usa sólo contrato público y mantiene vacío el password', async () => {
  const { normalizeWhatsappPanelConfig } = await loadPanelHelpers();
  const model = normalizeWhatsappPanelConfig({
    whatsapp: {
      provider: 'cloud',
      enabled: true,
      phone_number_id: '  phone-7  ',
      access_token_configured: true,
      access_token: 'no-debe-usarse',
      access_token_encrypted: 'no-debe-usarse',
    },
  });
  assert.deepEqual(structuredClone(model), {
    provider: 'cloud',
    enabled: true,
    phone_number_id: 'phone-7',
    access_token_configured: true,
    access_token: '',
  });
});

test('payload WhatsApp conserva token configurado sin enviar placeholder ni booleano de entrada', async () => {
  const { buildWhatsappConfigPayload } = await loadPanelHelpers();
  assert.deepEqual(structuredClone(buildWhatsappConfigPayload({
    provider: 'cloud', enabled: true, phone_number_id: ' phone-7 ',
    access_token: '********', access_token_configured: true,
  })), {
    provider: 'cloud', enabled: true, phone_number_id: 'phone-7',
  });
  assert.deepEqual(structuredClone(buildWhatsappConfigPayload({
    provider: 'cloud', enabled: true, phone_number_id: 'phone-7',
    access_token: ' token-nuevo ', access_token_configured: false,
  })), {
    provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: 'token-nuevo',
  });
  assert.deepEqual(structuredClone(buildWhatsappConfigPayload({
    provider: 'web', enabled: true, phone_number_id: 'phone-old',
    access_token: '', access_token_configured: true,
  })), { provider: 'web', enabled: false, phone_number_id: '' });
});

test('validación browser exige phone_number_id y token nuevo o previamente configurado', async () => {
  const { validateWhatsappCloudActivation } = await loadPanelHelpers();
  assert.match(validateWhatsappCloudActivation({
    provider: 'cloud', enabled: true, phone_number_id: '', access_token: '', access_token_configured: false,
  }), /phone_number_id/i);
  assert.match(validateWhatsappCloudActivation({
    provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: '', access_token_configured: false,
  }), /token/i);
  assert.equal(validateWhatsappCloudActivation({
    provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token: '', access_token_configured: true,
  }), null);
});

test('confirmación se pide sólo al pasar a Cloud activa', async () => {
  const { needsWhatsappCloudActivationConfirmation } = await loadPanelHelpers();
  assert.equal(needsWhatsappCloudActivationConfirmation(
    { provider: 'web', enabled: false },
    { provider: 'cloud', enabled: true },
  ), true);
  assert.equal(needsWhatsappCloudActivationConfirmation(
    { provider: 'cloud', enabled: true },
    { provider: 'cloud', enabled: true },
  ), false);
  assert.equal(needsWhatsappCloudActivationConfirmation(
    { provider: 'cloud', enabled: true },
    { provider: 'web', enabled: false },
  ), false);
});

test('guardado exitoso limpia el token visible con la respuesta redactada', async () => {
  const html = await readHtml();
  assert.match(
    html,
    /if\s*\(esSuperAdmin\s*&&\s*res\?\.config_integraciones\)[\s\S]*?setWhatsappConfigInForm\(res\.config_integraciones\)/,
  );
});

test('guardado preserva pagos y todas las integraciones hermanas', async () => {
  const { mergeEmpresaIntegraciones } = await loadPanelHelpers();
  const merged = mergeEmpresaIntegraciones({
    pagos: { proveedor: 'mercado_pago', public_key: 'pk' },
    envios: { proveedor: 'correo' },
    analytics: { enabled: true },
    whatsapp: { provider: 'web', enabled: false },
  }, {
    codigo_externo: 'ERP-7',
    webhook_url: 'https://example.test/hook',
    pagos: { proveedor: 'manual' },
    whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7' },
  });
  assert.deepEqual(structuredClone(merged), {
    pagos: { proveedor: 'manual', public_key: 'pk' },
    envios: { proveedor: 'correo' },
    analytics: { enabled: true },
    whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7' },
    codigo_externo: 'ERP-7',
    webhook_url: 'https://example.test/hook',
  });
});

test('utility panel has three super-only groups and independent safe mapping readiness', async () => {
  const html = await readHtml();
  const source = extractFunction(html, 'normalizeWhatsappTemplates');
  const context = vm.createContext({});
  vm.runInContext(`${source}; globalThis.normalize = normalizeWhatsappTemplates;`, context);
  const normalized = context.normalize({ order_en_route: { name: ' route ', language: ' es_AR ', payload: 'private' }, transfer_payment: { name: '', language: 'es_AR' }, arbitrary: {} });
  assert.deepEqual(structuredClone(normalized), { order_en_route: { name: 'route', language: 'es_AR' } });
  const panelStart = html.indexOf('id="panelWhatsappEmpresa"');
  for (const key of ['order_confirmation', 'order_en_route', 'transfer_payment']) {
    for (const suffix of ['name', 'language', 'status']) assert.ok(html.indexOf(`id="e_template_${key}_${suffix}"`, panelStart) > panelStart);
  }
  const { normalizeWhatsappPanelConfig, buildWhatsappConfigPayload } = await loadPanelHelpers();
  const templates = { order_en_route: { name: 'route', language: 'es_AR' } };
  assert.deepEqual(structuredClone(normalizeWhatsappPanelConfig({ whatsapp: { templates } }).templates), templates);
  assert.deepEqual(structuredClone(buildWhatsappConfigPayload({ provider: 'cloud', templates }).templates), templates);
});

test('utility form loads/saves mapping, reports readiness and confirms activation or replacement', async () => {
  const html = await readHtml();
  const names = ['normalizeWhatsappTemplates', 'normalizeWhatsappPanelConfig', 'getWhatsappConfigFromForm', 'setWhatsappConfigInForm', 'needsWhatsappTemplateConfirmation', 'refreshWhatsappTemplateReadiness'];
  const elements = Object.fromEntries(['order_confirmation', 'order_en_route', 'transfer_payment'].flatMap(key => ['name', 'language', 'status'].map(suffix => [`e_template_${key}_${suffix}`, { value: '', textContent: '' }])));
  const context = vm.createContext({ document: { getElementById: id => elements[id] }, currentWhatsappPanelConfig: {}, refreshWhatsappPanelVisibility() {} });
  vm.runInContext(names.map(n => extractFunction(html, n)).join('\n') + `;globalThis.h = {${names.join(',')}};`, context);
  const templates = { order_en_route: { name: 'route', language: 'es_AR' } };
  context.h.setWhatsappConfigInForm({ whatsapp: { templates } });
  assert.equal(elements.e_template_order_en_route_name.value, 'route');
  assert.equal(elements.e_template_order_en_route_status.textContent, 'Configurada');
  assert.equal(elements.e_template_transfer_payment_status.textContent, 'Sin configurar');
  assert.deepEqual(structuredClone(context.h.getWhatsappConfigFromForm().templates), templates);
  assert.equal(context.h.needsWhatsappTemplateConfirmation({}, { templates }), true);
  assert.equal(context.h.needsWhatsappTemplateConfirmation({ templates }, { templates }), false);
  assert.match(html, /if \(needsWhatsappTemplateConfirmation\(currentWhatsappPanelConfig, whatsappCfg\)\)/);
  assert.match(html, /Confirmo|aprobadas en Meta/);
  for (const n of names) assert.doesNotMatch(extractFunction(html, n), /localStorage|sessionStorage/);
});
