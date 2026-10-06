import { handleIncomingComprobanteFromBotPg } from '../transferenciasPipeline.js';
import {
  hasValidReceiptMagicBytes,
  isReceiptMimeAllowedForMessageType,
  normalizeReceiptMimeType,
  validateReceiptMediaPreEffect,
  verifiesInternalReceiptValidationProof,
} from '../receiptMediaValidation.js';
import { normalizeCloudDeadline } from './deadlines.js';
import { normalizeWhatsAppWaId } from './waId.js';

function configError() {
  return Object.assign(new Error('cloud_config_invalid'), { code: 'cloud_config_invalid' });
}

function required(value) {
  const text = String(value || '').trim();
  return text || null;
}

function mediaValidationError(code) {
  return Object.assign(new Error(code), { code });
}

function defaultFilename(mediaId, mimeType) {
  const extension = mimeType === 'application/pdf' ? 'pdf'
    : mimeType === 'image/png' ? 'png'
      : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return `${mediaId}.${extension}`;
}

export function createWhatsAppCloudReceiptProcessor({
  loadTenant,
  decryptToken,
  mediaClient,
  processPipeline = handleIncomingComprobanteFromBotPg,
  enqueueReply,
  validateMedia = validateReceiptMediaPreEffect,
  mediaValidationTimeoutMs = process.env.WHATSAPP_CLOUD_MEDIA_TIMEOUT_MS,
} = {}) {
  if (typeof loadTenant !== 'function' || typeof decryptToken !== 'function' || typeof mediaClient?.download !== 'function'
      || typeof processPipeline !== 'function' || typeof enqueueReply !== 'function' || typeof validateMedia !== 'function') {
    throw new TypeError('dependencias de comprobantes Cloud inválidas');
  }
  const validationTimeoutMs = normalizeCloudDeadline('graph', mediaValidationTimeoutMs);

  async function prepare({
    empresaId, messageId, senderId, messageType, media, tenant, originalPhoneNumberId,
    assertLease = async () => {},
  } = {}) {
    const normalizedEmpresaId = Number(empresaId);
    if (!Number.isSafeInteger(normalizedEmpresaId) || normalizedEmpresaId <= 0
        || Number(tenant?.empresaId) !== normalizedEmpresaId) {
      throw configError();
    }
    const safeMessageId = required(messageId);
    const safeSender = normalizeWhatsAppWaId(senderId);
    const originalPhone = required(originalPhoneNumberId);
    const mediaId = required(media?.id);
    const mimeType = normalizeReceiptMimeType(media?.mime_type);
    const expectedSha256 = required(media?.sha256);
    if (!safeMessageId || !safeSender || !originalPhone || !mediaId || !mimeType || !expectedSha256
        || !['image', 'document'].includes(messageType)) {
      throw mediaValidationError('cloud_media_payload_invalid');
    }
    if (!isReceiptMimeAllowedForMessageType(messageType, mimeType)) {
      throw mediaValidationError('unsupported_type');
    }

    await assertLease();
    const currentTenant = await loadTenant({ empresaId: normalizedEmpresaId });
    if (Number(currentTenant?.empresaId) !== normalizedEmpresaId
        || required(currentTenant?.phoneNumberId) !== originalPhone
        || !required(currentTenant?.accessTokenEncrypted)) {
      throw configError();
    }
    await assertLease();
    let accessToken;
    try { accessToken = required(await decryptToken(currentTenant.accessTokenEncrypted)); } catch { accessToken = null; }
    if (!accessToken) throw configError();
    await assertLease();
    const downloaded = await mediaClient.download({
      mediaId,
      phoneNumberId: currentTenant.phoneNumberId,
      accessToken,
      expectedMimeType: mimeType,
      expectedSha256,
    });
    accessToken = null;
    await assertLease();
    const graphMimeType = normalizeReceiptMimeType(downloaded?.metadata?.mimeType);
    const httpContentType = normalizeReceiptMimeType(downloaded?.metadata?.httpContentType);
    if (!Buffer.isBuffer(downloaded?.buffer) || !graphMimeType
        || graphMimeType !== mimeType
        || !httpContentType
        || httpContentType !== mimeType) {
      throw mediaValidationError('cloud_media_mime_mismatch');
    }
    const validation = hasValidReceiptMagicBytes(downloaded.buffer, mimeType)
      ? await validateMedia(downloaded.buffer, mimeType, {
          timeoutMs: validationTimeoutMs, beforeDecode: assertLease,
        })
      : false;
    if (!validation || !verifiesInternalReceiptValidationProof(
      validation?.proof, downloaded.buffer, mimeType,
    )) {
      throw mediaValidationError('invalid_file_signature');
    }
    return {
      normalizedEmpresaId,
      safeMessageId,
      safeSender,
      mediaId,
      messageType,
      validation,
      media: { ...media, mime_type: mimeType },
      downloaded: {
        ...downloaded,
        metadata: { ...downloaded.metadata, mimeType: graphMimeType, httpContentType },
      },
    };
  }

  async function processPrepared({ prepared, assertLease = async () => {} } = {}) {
    const normalizedEmpresaId = Number(prepared?.normalizedEmpresaId);
    const safeMessageId = required(prepared?.safeMessageId);
    const safeSender = normalizeWhatsAppWaId(prepared?.safeSender);
    const mediaId = required(prepared?.mediaId);
    const messageType = prepared?.messageType;
    const media = prepared?.media;
    const downloaded = prepared?.downloaded;
    if (!Number.isSafeInteger(normalizedEmpresaId) || normalizedEmpresaId <= 0 || !safeMessageId
        || !safeSender || !mediaId || !['image', 'document'].includes(messageType)
        || !Buffer.isBuffer(downloaded?.buffer) || !required(downloaded?.metadata?.mimeType)) {
      throw Object.assign(new Error('cloud_media_prepared_invalid'), { code: 'cloud_media_prepared_invalid' });
    }
    const preparedMimeType = normalizeReceiptMimeType(downloaded.metadata.mimeType);
    if (!isReceiptMimeAllowedForMessageType(messageType, preparedMimeType)
        || !hasValidReceiptMagicBytes(downloaded.buffer, preparedMimeType)
        || !verifiesInternalReceiptValidationProof(prepared?.validation?.proof, downloaded.buffer, preparedMimeType)) {
      throw mediaValidationError('cloud_media_prepared_invalid');
    }

    const reply = async ({ effect, phone, message, empresaId: replyEmpresaId, transportOrigin }) => {
      const safeEffect = required(effect);
      if (!safeEffect || Number(replyEmpresaId) !== normalizedEmpresaId || transportOrigin !== 'cloud') {
        throw Object.assign(new Error('cloud_receipt_reply_invalid'), { code: 'cloud_receipt_reply_invalid' });
      }
      await assertLease();
      return enqueueReply({
        empresaId: normalizedEmpresaId,
        phone,
        message,
        transportOrigin: 'cloud',
        correlationId: `${safeMessageId}:receipt:${safeEffect}`,
      });
    };

    const result = await processPipeline({
      type: messageType,
      telefono: safeSender,
      replyJid: null,
      buffer: downloaded.buffer,
      mimetype: preparedMimeType,
      filename: required(media?.filename) || defaultFilename(mediaId, preparedMimeType),
      empresaId: normalizedEmpresaId,
      sourceMessageId: safeMessageId,
      transportOrigin: 'cloud',
    }, { assertLease, enqueueReply: reply, preparedValidation: prepared.validation });
    if (result && typeof result === 'object') {
      const saved = result.saved === true;
      const handled = result.handled === true || saved;
      return { ...result, handled, saved };
    }
    return { handled: false, saved: false };
  }

  async function process(input = {}) {
    const prepared = await prepare(input);
    return processPrepared({ ...input, prepared });
  }

  return { prepare, processPrepared, process };
}
