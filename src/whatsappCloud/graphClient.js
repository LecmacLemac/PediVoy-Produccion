import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';

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

  async function sendText({ phoneNumberId, accessToken, to, text }) {
    const safePhoneNumberId = normalizeRequired(phoneNumberId);
    const safeAccessToken = normalizeRequired(accessToken);
    const recipient = normalizeRecipient(to);
    const body = String(text || '');
    if (!safePhoneNumberId || !safeAccessToken || !recipient || !body) {
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
            type: 'text',
            text: { preview_url: false, body },
          }),
          signal: controller.signal,
        },
      );

      if (response.ok) {
        let payload;
        try { payload = await response.json(); } catch { payload = null; }
        const messageId = normalizeRequired(payload?.messages?.[0]?.id);
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

  return { sendText };
}
