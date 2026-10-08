import { UTILITY_TEMPLATE_FIELDS, validateTemplateMapping, buildMetaTemplateComponents } from './utilityTemplates.js';
import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';
import { validateMetaWamid } from './messageId.js';

export const CloudDeliveryOutcome = Object.freeze({
  SENT: 'sent',
  DEFINITIVE_FAILURE: 'definitive_failure',
  RETRYABLE_REJECTED: 'retryable_rejected',
  UNKNOWN: 'unknown',
});

function normalizeRecipient(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `549${digits}` : digits;
}

function normalizeRequired(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

async function cancelResponseBody(response, timeoutMs, setTimeoutImpl, clearTimeoutImpl) {
  const cancel = response?.body?.cancel;
  if (typeof cancel !== 'function') return;

  let timeout;
  const cancellation = Promise.resolve()
    .then(() => cancel.call(response.body))
    .catch(() => undefined);
  const deadline = new Promise(resolve => {
    timeout = unrefTimer(setTimeoutImpl(resolve, timeoutMs));
  });
  try {
    await Promise.race([cancellation, deadline]);
  } finally {
    clearTimeoutImpl(timeout);
  }
}

export function createWhatsAppCloudGraphClient({
  fetchImpl = globalThis.fetch,
  graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v26.0',
  baseUrl = 'https://graph.facebook.com',
  timeoutMs = process.env.WHATSAPP_CLOUD_TIMEOUT_MS,
  cancelTimeoutMs = process.env.WHATSAPP_CLOUD_CANCEL_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch requerido');
  const graphTimeoutMs = normalizeCloudDeadline('graph', timeoutMs);
  const bodyCancelTimeoutMs = normalizeCloudDeadline('cancel', cancelTimeoutMs);

  async function postMessage({ phoneNumberId, accessToken, to }, content) {
    const safePhoneNumberId = normalizeRequired(phoneNumberId);
    const safeAccessToken = normalizeRequired(accessToken);
    const recipient = normalizeRecipient(to);
    if (!safePhoneNumberId || !safeAccessToken || !recipient || !content) {
      return { outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_payload_invalid' };
    }

    const controller = new AbortController();
    const timeout = unrefTimer(setTimeoutImpl(() => controller.abort(), graphTimeoutMs));
    try {
      const response = await fetchImpl(
        `${baseUrl}/${graphVersion}/${encodeURIComponent(safePhoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${safeAccessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            ...content,
          }),
          signal: controller.signal,
        },
      );

      if (response.ok) {
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        const messageId = validateMetaWamid(payload?.messages?.[0]?.id);
        if (!messageId) {
          return { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' };
        }
        return { outcome: CloudDeliveryOutcome.SENT, messageId };
      }
      await cancelResponseBody(response, bodyCancelTimeoutMs, setTimeoutImpl, clearTimeoutImpl);
      if (response.status === 408) {
        return { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' };
      }
      if (response.status === 429) {
        return { outcome: CloudDeliveryOutcome.RETRYABLE_REJECTED, errorCode: 'cloud_rate_limited' };
      }
      if (response.status >= 500) {
        return { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' };
      }
      return { outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_remote_rejected' };
    } catch {
      return { outcome: CloudDeliveryOutcome.UNKNOWN, errorCode: 'cloud_dispatch_unknown' };
    } finally {
      clearTimeoutImpl(timeout);
    }
  }

  function sendText(input) {
    const body = String(input.text || '');
    return postMessage(input, body ? { type: 'text', text: { preview_url: false, body } } : null);
  }

  function sendTemplate(input) {
    try {
      const template = input.template;
      const closed = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
      if (!closed(template, ['name', 'language', 'components'])) throw new Error();
      const { name, language } = validateTemplateMapping({ name: template.name, language: template.language });
      const supplied = template.components;
      const body = supplied?.[0];
      if (!Array.isArray(supplied) || !closed(body, ['type', 'parameters']) || body.type !== 'body'
          || !Array.isArray(body.parameters)) throw new Error();
      const key = Object.keys(UTILITY_TEMPLATE_FIELDS).find(candidate =>
        UTILITY_TEMPLATE_FIELDS[candidate].filter(field => field !== 'tracking_token').length === body.parameters.length);
      if (!key || supplied.length !== (key === 'order_en_route' ? 2 : 1)) throw new Error();
      const values = [...body.parameters];
      if (key === 'order_en_route') {
        const button = supplied[1];
        if (!closed(button, ['type', 'sub_type', 'index', 'parameters']) || button.type !== 'button'
            || button.sub_type !== 'url' || button.index !== '0' || !Array.isArray(button.parameters)
            || button.parameters.length !== 1) throw new Error();
        values.push(button.parameters[0]);
      }
      if (values.some(value => !closed(value, ['type', 'text']) || value.type !== 'text')) throw new Error();
      const parameters = Object.fromEntries(UTILITY_TEMPLATE_FIELDS[key].map((field, i) => [field, values[i].text]));
      const components = buildMetaTemplateComponents({ key, parameters });
      return postMessage(input, { type: 'template', template: { name, language: { code: language }, components } });
    } catch {
      return Promise.resolve({ outcome: CloudDeliveryOutcome.DEFINITIVE_FAILURE, errorCode: 'cloud_payload_invalid' });
    }
  }

  return { sendText, sendTemplate };
}
