function objectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function isWhatsappCloudActive(configIntegraciones) {
  const integrations = objectOrNull(configIntegraciones);
  if (!integrations || !Object.hasOwn(integrations, 'whatsapp')) return false;
  const whatsapp = objectOrNull(integrations.whatsapp);
  if (!whatsapp) return false;
  return String(whatsapp.provider || '').trim().toLowerCase() === 'cloud'
    && whatsapp.enabled === true
    && String(whatsapp.phone_number_id || '').trim().length > 0
    && String(whatsapp.access_token_encrypted || '').trim().length > 0;
}

export function isCompanyWebWorkerEligible(configIntegraciones) {
  const integrations = objectOrNull(configIntegraciones);
  if (!integrations) return false;
  if (Object.hasOwn(integrations, 'whatsapp') && !objectOrNull(integrations.whatsapp)) return false;
  return !isWhatsappCloudActive(integrations);
}

export function queueCompanyWebHealthCheck(checkHealth, logger = console) {
  if (typeof checkHealth !== 'function') throw new TypeError('checkHealth is required');
  queueMicrotask(() => {
    Promise.resolve().then(checkHealth).catch(error => {
      logger.warn('[WPP EMPRESA] deferred health-check failed:', {
        errorName: error?.name || 'Error',
        errorCode: error?.code || null,
      });
    });
  });
}

export function createCompanyWebWorkerGuard({ query, empresaId, onIneligible = async () => {} } = {}) {
  if (typeof query !== 'function') throw new TypeError('query is required');
  if (typeof onIneligible !== 'function') throw new TypeError('onIneligible must be a function');
  const tenantId = Number(empresaId);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new TypeError('empresaId must be a positive safe integer');
  let shutdownRequested = false;

  async function inspect() {
    const rows = await query(
      'SELECT id, config_integraciones FROM empresas WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    const empresa = rows?.[0];
    if (!empresa) return { eligible: false, reason: 'company_not_found' };
    const config = empresa.config_integraciones;
    if (!objectOrNull(config)) return { eligible: false, reason: 'invalid_config' };
    if (Object.hasOwn(config, 'whatsapp') && !objectOrNull(config.whatsapp)) {
      return { eligible: false, reason: 'invalid_whatsapp_config' };
    }
    if (!isCompanyWebWorkerEligible(config)) return { eligible: false, reason: 'cloud_managed' };
    return { eligible: true, reason: 'web_managed' };
  }

  async function assertEligible() {
    const result = await inspect();
    if (result.eligible) return result;
    throw Object.assign(new Error(`WhatsApp Empresa worker is ineligible: ${result.reason}`), {
      code: 'WPP_COMPANY_INELIGIBLE',
      reason: result.reason,
    });
  }

  function wrapActiveClient(withActiveClient) {
    if (typeof withActiveClient !== 'function') throw new TypeError('withActiveClient is required');
    return fn => withActiveClient(async context => {
      await assertEligible();
      return fn(context);
    });
  }

  async function checkHealth() {
    const result = await inspect();
    if (!result.eligible && !shutdownRequested) {
      shutdownRequested = true;
      await onIneligible(result);
    }
    return result;
  }

  return { inspect, assertEligible, wrapActiveClient, checkHealth };
}

export function buildCompanyWebOutboxClaimPolicy({ empresaParamIndex = 4 } = {}) {
  if (!Number.isInteger(empresaParamIndex) || empresaParamIndex <= 0) {
    throw new Error('empresaParamIndex inválido');
  }
  return {
    sql: `AND o.empresa_id = $${empresaParamIndex}
      AND jsonb_typeof(e.config_integraciones::jsonb) = 'object'
      AND (
        NOT (e.config_integraciones::jsonb ? 'whatsapp')
        OR jsonb_typeof((e.config_integraciones::jsonb)->'whatsapp') = 'object'
      )
      AND NOT (
        LOWER(BTRIM(COALESCE((e.config_integraciones::jsonb)->'whatsapp'->>'provider', ''))) = 'cloud'
        AND jsonb_typeof((e.config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
        AND CASE
              WHEN jsonb_typeof((e.config_integraciones::jsonb)->'whatsapp'->'enabled') = 'boolean'
                THEN ((e.config_integraciones::jsonb)->'whatsapp'->>'enabled')::boolean
              ELSE FALSE
            END IS TRUE
        AND BTRIM(COALESCE((e.config_integraciones::jsonb)->'whatsapp'->>'phone_number_id', '')) <> ''
        AND BTRIM(COALESCE((e.config_integraciones::jsonb)->'whatsapp'->>'access_token_encrypted', '')) <> ''
      )
      AND (o.transport_origin = 'company' OR o.transport_origin IS NULL)`,
    params: [],
  };
}
