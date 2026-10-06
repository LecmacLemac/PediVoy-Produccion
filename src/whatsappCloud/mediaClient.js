import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeCloudDeadline, unrefTimer } from './deadlines.js';
import { normalizeReceiptMimeType, receiptExtensionForMime } from '../receiptMediaValidation.js';

const META_HOSTS = ['facebook.com', 'fbcdn.net', 'fbsbx.com'];

export class WhatsAppCloudMediaError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = 'WhatsAppCloudMediaError';
    this.code = code;
    this.retryable = retryable;
  }
}

function required(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new WhatsAppCloudMediaError(code);
  return text;
}

function allowedMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!META_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return null;
  return url;
}

function classifyHttp(status) {
  if (status === 401 || status === 403) return new WhatsAppCloudMediaError('cloud_media_auth_failed');
  if (status === 408 || status === 429 || status >= 500) {
    return new WhatsAppCloudMediaError('cloud_media_retryable', { retryable: true });
  }
  return new WhatsAppCloudMediaError('cloud_media_remote_rejected');
}

function digestMatches(digest, expected) {
  if (!expected) return true;
  const text = String(expected).trim();
  let expectedBuffer;
  try {
    expectedBuffer = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  } catch { return false; }
  return expectedBuffer.length === digest.length && timingSafeEqual(digest, expectedBuffer);
}

async function withDeadline(fetchImpl, url, options, timeoutMs, setTimeoutImpl, clearTimeoutImpl, consume) {
  const controller = new AbortController();
  const timeout = unrefTimer(setTimeoutImpl(() => controller.abort(), timeoutMs));
  let response = null;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'manual' });
    return await consume(response);
  } catch (error) {
    if (error instanceof WhatsAppCloudMediaError) throw error;
    throw new WhatsAppCloudMediaError('cloud_media_retryable', { retryable: true });
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    clearTimeoutImpl(timeout);
  }
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new WhatsAppCloudMediaError('cloud_media_too_large');
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new WhatsAppCloudMediaError('cloud_media_too_large');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WhatsAppCloudMediaError('cloud_media_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof WhatsAppCloudMediaError) throw error;
    throw new WhatsAppCloudMediaError('cloud_media_retryable', { retryable: true });
  }
  return Buffer.concat(chunks, total);
}

export function createWhatsAppCloudMediaClient({
  fetchImpl = globalThis.fetch,
  graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v26.0',
  baseUrl = 'https://graph.facebook.com',
  timeoutMs = process.env.WHATSAPP_CLOUD_MEDIA_TIMEOUT_MS,
  maxBytes = process.env.TRANSFERENCIA_MAX_BYTES || 10 * 1024 * 1024,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch requerido');
  const deadline = normalizeCloudDeadline('graph', timeoutMs);
  const byteLimit = Number(maxBytes);
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) throw new TypeError('maxBytes inválido');

  async function loadMetadata({ mediaId, phoneNumberId, accessToken }) {
    return withDeadline(fetchImpl,
      `${baseUrl}/${graphVersion}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`,
      { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } }, deadline,
      setTimeoutImpl, clearTimeoutImpl, async response => {
        if (!response.ok) throw classifyHttp(response.status);
        let payload;
        try { payload = await response.json(); } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw new WhatsAppCloudMediaError('cloud_media_metadata_invalid');
        }
        const url = allowedMediaUrl(payload?.url);
        if (!url || required(payload?.id, 'cloud_media_metadata_invalid') !== mediaId) {
          throw new WhatsAppCloudMediaError('cloud_media_url_invalid');
        }
        const mimeType = normalizeReceiptMimeType(required(payload?.mime_type, 'cloud_media_metadata_invalid'));
        if (!mimeType) throw new WhatsAppCloudMediaError('cloud_media_metadata_invalid');
        return {
          id: mediaId,
          url,
          mimeType,
          sha256: required(payload?.sha256, 'cloud_media_metadata_invalid'),
          size: Number(payload?.file_size) || null,
        };
      });
  }

  async function downloadBytes(metadata, accessToken) {
    return withDeadline(fetchImpl, metadata.url, {
      method: 'GET', headers: { authorization: `Bearer ${accessToken}` },
    }, deadline, setTimeoutImpl, clearTimeoutImpl, async response => {
      if (response.status >= 300 && response.status < 400) {
        throw new WhatsAppCloudMediaError('cloud_media_redirect_rejected');
      }
      if (response.status === 404) return { refresh: true };
      if (!response.ok) throw classifyHttp(response.status);
      const rawContentType = response.headers?.get?.('content-type');
      const httpContentType = normalizeReceiptMimeType(rawContentType);
      if (!httpContentType || !receiptExtensionForMime(httpContentType)
          || httpContentType !== metadata.mimeType) {
        throw new WhatsAppCloudMediaError('cloud_media_mime_mismatch');
      }
      const buffer = await readLimited(response, byteLimit);
      const digest = createHash('sha256').update(buffer).digest();
      return { buffer, digest, httpContentType };
    });
  }

  async function download(input) {
    const mediaId = required(input?.mediaId, 'cloud_media_payload_invalid');
    const phoneNumberId = required(input?.phoneNumberId, 'cloud_media_payload_invalid');
    const accessToken = required(input?.accessToken, 'cloud_media_payload_invalid');
    let refreshed = false;
    while (true) {
      const metadata = await loadMetadata({ mediaId, phoneNumberId, accessToken });
      const expectedMimeType = input?.expectedMimeType
        ? normalizeReceiptMimeType(input.expectedMimeType)
        : null;
      if (input?.expectedMimeType && (!expectedMimeType || metadata.mimeType !== expectedMimeType)) {
        throw new WhatsAppCloudMediaError('cloud_media_mime_mismatch');
      }
      const downloaded = await downloadBytes(metadata, accessToken);
      if (downloaded.refresh) {
        if (refreshed) throw new WhatsAppCloudMediaError('cloud_media_not_found');
        refreshed = true;
        continue;
      }
      const expectedHash = input?.expectedSha256 || metadata.sha256;
      if (!digestMatches(downloaded.digest, expectedHash) || !digestMatches(downloaded.digest, metadata.sha256)) {
        if (!refreshed) { refreshed = true; continue; }
        throw new WhatsAppCloudMediaError('cloud_media_hash_mismatch');
      }
      return {
        buffer: downloaded.buffer,
        metadata: {
          id: metadata.id,
          mimeType: metadata.mimeType,
          httpContentType: downloaded.httpContentType,
          sha256: downloaded.digest.toString('base64'),
          size: downloaded.buffer.length,
        },
      };
    }
  }

  return { download };
}
