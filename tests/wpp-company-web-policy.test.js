import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompanyWebOutboxClaimPolicy,
  createCompanyWebWorkerGuard,
  isWhatsappCloudActive,
  isCompanyWebWorkerEligible,
  queueCompanyWebHealthCheck,
} from '../src/wpp/companyWebPolicy.js';

test('política canónica activa Cloud sólo con provider, enabled, phone y token cifrado', () => {
  const complete = { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } };
  assert.equal(isWhatsappCloudActive(complete), true);
  for (const provider of [' cloud ', 'CLOUD', '\tClOuD\n']) {
    assert.equal(isWhatsappCloudActive({
      whatsapp: { ...complete.whatsapp, provider },
    }), true, provider);
  }
  assert.equal(isCompanyWebWorkerEligible(complete), false);
  assert.equal(isWhatsappCloudActive({ whatsapp: { provider: 'cloud', enabled: true } }), false);
  assert.equal(isCompanyWebWorkerEligible({ whatsapp: { provider: 'cloud', enabled: true } }), true);
  assert.equal(isCompanyWebWorkerEligible({ whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7' } }), true);
  assert.equal(isCompanyWebWorkerEligible({ whatsapp: { provider: 'cloud', enabled: false } }), true);
  assert.equal(isCompanyWebWorkerEligible({ whatsapp: { provider: 'cloud', enabled: 'true', phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } }), true);
  assert.equal(isCompanyWebWorkerEligible({ whatsapp: { provider: 'web', enabled: true } }), true);
  assert.equal(isCompanyWebWorkerEligible({}), true);
});

test('política Web falla cerrado para raíces y whatsapp estructuralmente inválidos', () => {
  for (const config of [null, undefined, 'string', [], 7, true]) {
    assert.equal(isCompanyWebWorkerEligible(config), false, String(config));
  }
  for (const whatsapp of [null, 'string', [], 7, true]) {
    assert.equal(isCompanyWebWorkerEligible({ whatsapp }), false, String(whatsapp));
  }
  for (const config of [
    {},
    { whatsapp: {} },
    { whatsapp: { provider: 'cloud' } },
    { whatsapp: { provider: 'cloud', enabled: true } },
    { whatsapp: { provider: 'cloud', enabled: 'true', phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } },
  ]) {
    assert.equal(isCompanyWebWorkerEligible(config), true, JSON.stringify(config));
  }
});

test('claim empresarial exige tenant no Cloud y origen company o legacy NULL', () => {
  const policy = buildCompanyWebOutboxClaimPolicy({ empresaParamIndex: 4 });
  assert.deepEqual(policy.params, []);
  assert.match(policy.sql, /o\.empresa_id = \$4/);
  assert.match(policy.sql, /o\.transport_origin = 'company'/);
  assert.match(policy.sql, /o\.transport_origin IS NULL/);
  assert.match(policy.sql, /config_integraciones/);
  assert.match(policy.sql, /provider/);
  assert.match(policy.sql, /LOWER\s*\(\s*BTRIM\s*\(\s*COALESCE\([^\n]*provider/i);
  assert.match(policy.sql, /enabled/);
  assert.match(policy.sql, /jsonb_typeof\([^\n]*enabled[^\n]*=\s*'boolean'/i);
  assert.match(policy.sql, /enabled'[^\n]*\)::boolean[\s\S]*END\s+IS\s+TRUE/i);
  assert.match(policy.sql, /jsonb_typeof\([^)]*config_integraciones::jsonb[^)]*\)\s*=\s*'object'/i);
  assert.match(policy.sql, /config_integraciones::jsonb\s*\?\s*'whatsapp'/i);
  assert.doesNotMatch(policy.sql, /jsonb_typeof\(e\.config_integraciones(?!::jsonb)/i);
  assert.doesNotMatch(policy.sql, /transport_origin = 'cloud'/);
});

test('guard fail-closed rechaza empresa inexistente o configuración estructuralmente inválida', async () => {
  const invalidRows = [
    [],
    [{ id: 7, config_integraciones: null }],
    [{ id: 7, config_integraciones: 'invalid-json-shape' }],
    [{ id: 7, config_integraciones: [] }],
    [{ id: 7, config_integraciones: { whatsapp: null } }],
    [{ id: 7, config_integraciones: { whatsapp: 'cloud' } }],
    [{ id: 7, config_integraciones: { whatsapp: [] } }],
  ];
  for (const rows of invalidRows) {
    const guard = createCompanyWebWorkerGuard({
      empresaId: 7,
      query: async () => rows,
    });
    await assert.rejects(guard.assertEligible(), { code: 'WPP_COMPANY_INELIGIBLE' });
  }
});

test('gate entrante revalida Cloud inmediatamente antes de procesar', async () => {
  let cloud = false;
  let processed = 0;
  const guard = createCompanyWebWorkerGuard({
    empresaId: '7',
    query: async () => [{
      id: 7,
      config_integraciones: cloud
        ? { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } }
        : { whatsapp: { provider: 'web', enabled: true } },
    }],
  });
  const guarded = guard.wrapActiveClient(async fn => fn({ client: {}, generation: 1 }));

  await guarded(async () => { processed += 1; });
  cloud = true;
  await assert.rejects(guarded(async () => { processed += 1; }), { code: 'WPP_COMPANY_INELIGIBLE' });

  assert.equal(processed, 1);
});

test('health detecta Cloud, solicita cierre limpio una sola vez y no llama process.exit', async () => {
  const shutdownReasons = [];
  const guard = createCompanyWebWorkerGuard({
    empresaId: 7,
    query: async () => [{
      id: 7,
      config_integraciones: { whatsapp: { provider: 'cloud', enabled: true, phone_number_id: 'phone-7', access_token_encrypted: 'v1:test' } },
    }],
    onIneligible: result => { shutdownReasons.push(result.reason); },
  });

  assert.deepEqual(await guard.checkHealth(), { eligible: false, reason: 'cloud_managed' });
  assert.deepEqual(await guard.checkHealth(), { eligible: false, reason: 'cloud_managed' });
  assert.deepEqual(shutdownReasons, ['cloud_managed']);
});

test('health diferido captura rechazo y no dispara unhandledRejection', async () => {
  const warnings = [];
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    queueCompanyWebHealthCheck(
      async () => { throw new Error('segunda consulta falló'); },
      { warn: (...args) => warnings.push(args) },
    );
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(warnings.length, 1);
});
