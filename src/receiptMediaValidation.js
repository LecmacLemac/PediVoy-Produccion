import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const MIME_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_RECEIPT_PDF_PAGES = 5;
const MIME_TOKEN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MIME_PARAMETER = /^[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+\-*]+|"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*")$/i;
const VALIDATION_PROOFS = new WeakMap();

function splitMimeParts(value) {
  const parts = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (quoted && character === '\\') {
      current += character;
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (character === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else if (character === ',' && !quoted) {
      return null;
    } else {
      current += character;
    }
  }
  if (quoted || escaped) return null;
  parts.push(current);
  return parts;
}

export function normalizeReceiptMimeType(value) {
  if (typeof value !== 'string') return null;
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
  const parts = splitMimeParts(value);
  if (!parts) return null;
  const normalized = parts.shift().trim().toLowerCase();
  if (parts.some(part => !MIME_PARAMETER.test(part.trim()))) return null;
  return MIME_TOKEN.test(normalized) ? normalized : null;
}

export function receiptExtensionForMime(mimeType) {
  return MIME_EXTENSIONS.get(normalizeReceiptMimeType(mimeType)) || null;
}

export function isReceiptMimeAllowedForMessageType(messageType, mimeType) {
  const normalized = normalizeReceiptMimeType(mimeType);
  if (messageType === 'image') return IMAGE_MIMES.has(normalized);
  if (messageType === 'document') return normalized === 'application/pdf';
  return false;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function pdfStructuralText(buffer) {
  return buffer.toString('latin1').replace(/stream\r?\n[\s\S]*?\r?\nendstream/gi, 'stream\nendstream');
}

function hasEmbeddedDisallowedSignature(buffer, mimeType) {
  const searchable = mimeType === 'application/pdf' ? pdfStructuralText(buffer) : buffer.toString('latin1');
  const ascii = searchable.toLowerCase();
  for (const token of ['gif87a', 'gif89a', 'pk\u0003\u0004', '<!doctype html', '<html', '<script']) {
    if (ascii.includes(token)) return true;
  }
  const pdfOffset = ascii.indexOf('%pdf-');
  if (pdfOffset >= 0 && (mimeType !== 'application/pdf' || pdfOffset !== 0)) return true;
  if (mimeType !== 'image/jpeg' && buffer.indexOf(JPEG_SIGNATURE) >= 0) return true;
  if (mimeType !== 'image/png' && buffer.indexOf(PNG_SIGNATURE) >= 0) return true;
  if (mimeType !== 'image/webp') {
    for (let offset = buffer.indexOf('RIFF', 0, 'ascii'); offset >= 0; offset = buffer.indexOf('RIFF', offset + 1, 'ascii')) {
      if (offset + 12 <= buffer.length && buffer.toString('ascii', offset + 8, offset + 12) === 'WEBP') return true;
    }
  }
  return false;
}

function hasValidJpegStructure(buffer) {
  if (buffer.length < 8 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let seenSof = false;
  let seenSos = false;
  let pendingMarker = null;

  while (offset < buffer.length || pendingMarker !== null) {
    let marker;
    if (pendingMarker !== null) {
      marker = pendingMarker;
      pendingMarker = null;
    } else {
      if (buffer[offset] !== 0xff) return false;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) return false;
      marker = buffer[offset];
      offset += 1;
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0xd9) return seenSof && seenSos && offset === buffer.length;
    if (offset + 2 > buffer.length) return false;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return false;
    const payloadStart = offset + 2;
    const payloadEnd = offset + segmentLength;

    if (sofMarkers.has(marker)) {
      if (seenSof || segmentLength < 11) return false;
      const componentCount = buffer[payloadStart + 5];
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 8 + 3 * componentCount
          || buffer.readUInt16BE(payloadStart + 1) === 0 || buffer.readUInt16BE(payloadStart + 3) === 0) return false;
      seenSof = true;
    }

    if (marker !== 0xda) {
      offset = payloadEnd;
      continue;
    }
    if (!seenSof || segmentLength < 8) return false;
    const scanComponents = buffer[payloadStart];
    if (scanComponents < 1 || scanComponents > 4 || segmentLength !== 6 + 2 * scanComponents) return false;
    seenSos = true;
    offset = payloadEnd;
    let foundMarker = false;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let markerOffset = offset;
      while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset += 1;
      if (markerOffset >= buffer.length) return false;
      const entropyMarker = buffer[markerOffset];
      if (entropyMarker === 0x00) {
        offset = markerOffset + 1;
        continue;
      }
      if (entropyMarker >= 0xd0 && entropyMarker <= 0xd7) {
        offset = markerOffset + 1;
        continue;
      }
      pendingMarker = entropyMarker;
      offset = markerOffset + 1;
      foundMarker = true;
      break;
    }
    if (!foundMarker) return false;
  }
  return false;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) crc = CRC_TABLE[(crc ^ buffer[offset]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function hasValidPngStructure(buffer) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let chunkCount = 0;
  let seenPlte = false;
  let seenIdat = false;
  let idatEnded = false;
  let colorType = null;
  while (offset + 12 <= buffer.length) {
    const dataLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > buffer.length) return false;
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(chunkType) || /[a-z]/.test(chunkType[2])) return false;
    if (crc32(buffer, offset + 4, offset + 8 + dataLength) !== buffer.readUInt32BE(offset + 8 + dataLength)) return false;
    chunkCount += 1;
    if (chunkCount === 1) {
      if (chunkType !== 'IHDR' || dataLength !== 13) return false;
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      const bitDepth = buffer[offset + 16];
      colorType = buffer[offset + 17];
      const validDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
      if (!width || !height || !validDepths.get(colorType)?.includes(bitDepth)
          || buffer[offset + 18] !== 0 || buffer[offset + 19] !== 0 || buffer[offset + 20] > 1) return false;
    } else if (chunkType === 'IHDR') return false;
    const critical = chunkType[0] === chunkType[0].toUpperCase();
    if (critical && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(chunkType)) return false;
    if (chunkType === 'PLTE') {
      if (seenPlte || seenIdat || dataLength === 0 || dataLength % 3 !== 0 || dataLength > 768 || [0, 4].includes(colorType)) return false;
      seenPlte = true;
    } else if (chunkType === 'IDAT') {
      if (idatEnded || (colorType === 3 && !seenPlte)) return false;
      seenIdat = true;
    } else if (seenIdat && chunkType !== 'IEND') {
      idatEnded = true;
    }
    if (chunkType === 'IEND') return dataLength === 0 && seenIdat && chunkEnd === buffer.length;
    offset = chunkEnd;
  }
  return false;
}

function validVp8Payload(data) {
  return data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a
    && (data.readUInt16LE(6) & 0x3fff) > 0 && (data.readUInt16LE(8) & 0x3fff) > 0;
}

function validVp8lPayload(data) {
  if (data.length < 5 || data[0] !== 0x2f) return false;
  const bits = data.readUInt32LE(1);
  return (bits >>> 29) === 0;
}

function validAnmfPayload(data) {
  if (data.length < 24) return false;
  let offset = 16;
  let images = 0;
  while (offset + 8 <= data.length) {
    const type = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    const paddedEnd = end + (size & 1);
    if (end > data.length || paddedEnd > data.length) return false;
    const payload = data.subarray(offset + 8, end);
    if (type === 'VP8 ') images += validVp8Payload(payload) ? 1 : 100;
    if (type === 'VP8L') images += validVp8lPayload(payload) ? 1 : 100;
    offset = paddedEnd;
  }
  return offset === data.length && images === 1;
}

function hasValidWebpStructure(buffer) {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.readUInt32LE(4) !== buffer.length - 8
      || buffer.toString('ascii', 8, 12) !== 'WEBP') return false;
  let offset = 12;
  let vp8xFlags = null;
  let directImages = 0;
  let directImageType = null;
  let directImageHasAlpha = false;
  let alphaChunks = 0;
  let alphaBeforeImage = true;
  let animationHeader = 0;
  let animationFrames = 0;
  let animationFrameSeen = false;
  const metadataCounts = { ICCP: 0, EXIF: 0, 'XMP ': 0 };
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return false;
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    const paddedEnd = end + (size & 1);
    if (end > buffer.length || paddedEnd > buffer.length) return false;
    const data = buffer.subarray(offset + 8, end);
    if (type === 'VP8 ') {
      directImages += validVp8Payload(data) ? 1 : 100;
      directImageType = 'VP8 ';
    }
    if (type === 'VP8L') {
      directImages += validVp8lPayload(data) ? 1 : 100;
      directImageType = 'VP8L';
      directImageHasAlpha = data.length >= 5 && ((data.readUInt32LE(1) >>> 28) & 1) === 1;
    }
    if (type === 'VP8X') {
      if (vp8xFlags !== null || offset !== 12 || size !== 10 || (data[0] & 0xc1) !== 0
          || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) return false;
      vp8xFlags = data[0];
    }
    if (type === 'ALPH') {
      alphaChunks += size >= 1 ? 1 : 100;
      if (directImages > 0) alphaBeforeImage = false;
    }
    if (Object.hasOwn(metadataCounts, type)) metadataCounts[type] += 1;
    if (type === 'ANIM') animationHeader += size === 6 && !animationFrameSeen ? 1 : 100;
    if (type === 'ANMF') {
      animationFrameSeen = true;
      animationFrames += validAnmfPayload(data) ? 1 : 100;
    }
    offset = paddedEnd;
  }
  if (offset !== buffer.length) return false;
  if (vp8xFlags === null) {
    return directImages === 1 && alphaChunks === 0 && animationHeader === 0 && animationFrames === 0
      && Object.values(metadataCounts).every(count => count === 0);
  }
  const metadataMatches = ((vp8xFlags & 0x20) !== 0) === (metadataCounts.ICCP === 1)
    && ((vp8xFlags & 0x08) !== 0) === (metadataCounts.EXIF === 1)
    && ((vp8xFlags & 0x04) !== 0) === (metadataCounts['XMP '] === 1);
  if (!metadataMatches) return false;
  const animated = (vp8xFlags & 0x02) !== 0;
  if (animated) {
    return directImages === 0 && alphaChunks === 0 && animationHeader === 1
      && animationFrames >= 1 && animationFrames < 100;
  }
  const alphaFlag = (vp8xFlags & 0x10) !== 0;
  const alphaMatches = directImageType === 'VP8 '
    ? alphaFlag === (alphaChunks === 1) && alphaBeforeImage
    : directImageType === 'VP8L' && alphaChunks === 0 && alphaFlag === directImageHasAlpha;
  return directImages === 1 && animationHeader === 0 && animationFrames === 0 && alphaMatches;
}

function hasValidPdfStructure(buffer) {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 5) !== '%PDF-') return false;
  const text = pdfStructuralText(buffer);
  const eofOffset = text.lastIndexOf('%%EOF');
  if (eofOffset < 0 || text.slice(eofOffset + 5).trim() !== '') return false;
  const startxref = text.match(/\bstartxref\s+(\d+)\s*%%EOF\s*$/);
  if (!startxref || !/\b\d+\s+\d+\s+obj\b/.test(text) || !/\bendobj\b/.test(text)) return false;
  const xrefOffset = Number(startxref[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= buffer.length) return false;
  const target = buffer.toString('latin1', xrefOffset, Math.min(buffer.length, xrefOffset + 64));
  return target.startsWith('xref') || /^\d+\s+\d+\s+obj\b/.test(target);
}

export function hasValidReceiptMagicBytes(buffer, mimeType) {
  const normalized = normalizeReceiptMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !MIME_EXTENSIONS.has(normalized)
      || hasEmbeddedDisallowedSignature(buffer, normalized)) return false;
  if (normalized === 'image/jpeg') return hasValidJpegStructure(buffer);
  if (normalized === 'image/png') return hasValidPngStructure(buffer);
  if (normalized === 'image/webp') return hasValidWebpStructure(buffer);
  return hasValidPdfStructure(buffer);
}

function receiptDigest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function issueInternalReceiptValidationProof(buffer, mimeType, metadata) {
  const normalized = normalizeReceiptMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !MIME_EXTENSIONS.has(normalized)) {
    throw new TypeError('prueba de validación inválida');
  }
  const proof = Object.freeze({});
  VALIDATION_PROOFS.set(proof, {
    buffer, mimeType: normalized, digest: receiptDigest(buffer), metadata,
  });
  return proof;
}

export function verifiesInternalReceiptValidationProof(proof, buffer, mimeType) {
  const record = proof && typeof proof === 'object' ? VALIDATION_PROOFS.get(proof) : null;
  const normalized = normalizeReceiptMimeType(mimeType);
  return Boolean(record && Buffer.isBuffer(buffer) && record.buffer === buffer
    && record.mimeType === normalized && record.digest === receiptDigest(buffer));
}

export function receiptValidationMetadata(proof, buffer, mimeType) {
  if (!verifiesInternalReceiptValidationProof(proof, buffer, mimeType)) return null;
  return VALIDATION_PROOFS.get(proof).metadata;
}

function validationResult(buffer, mimeType, metadata) {
  const immutableMetadata = Object.freeze({ ...metadata });
  return Object.freeze({
    proof: issueInternalReceiptValidationProof(buffer, mimeType, immutableMetadata),
    metadata: immutableMetadata,
  });
}

function pdfPageMetadata(json, { dpi, maxPages, maxPixels, maxDimension, maxPagePoints }) {
  const pages = Array.isArray(json?.pages) ? json.pages : null;
  const objects = json?.qpdf?.[1];
  if (!pages || !objects || pages.length < 1 || pages.length > maxPages) return null;
  let object = objects[`obj:${pages[0]?.object}`]?.value;
  const visited = new Set();
  let mediaBox = null;
  while (object && !mediaBox) {
    mediaBox = object['/MediaBox'];
    const parent = object['/Parent'];
    if (mediaBox || typeof parent !== 'string' || visited.has(parent)) break;
    visited.add(parent);
    object = objects[`obj:${parent}`]?.value;
  }
  if (!Array.isArray(mediaBox) || mediaBox.length !== 4
      || mediaBox.some(value => !Number.isFinite(Number(value)))) return null;
  const widthPoints = Math.abs(Number(mediaBox[2]) - Number(mediaBox[0]));
  const heightPoints = Math.abs(Number(mediaBox[3]) - Number(mediaBox[1]));
  const widthPixels = Math.ceil(widthPoints * dpi / 72);
  const heightPixels = Math.ceil(heightPoints * dpi / 72);
  if (widthPoints <= 0 || heightPoints <= 0 || widthPoints > maxPagePoints || heightPoints > maxPagePoints
      || widthPixels <= 0 || heightPixels <= 0 || widthPixels > maxDimension || heightPixels > maxDimension
      || widthPixels * heightPixels > maxPixels) return null;
  return {
    kind: 'pdf', pageCount: pages.length, maxPages, widthPoints, heightPoints, dpi, widthPixels, heightPixels,
  };
}

function operationalError(code) {
  return Object.assign(new Error(code), { code, retryable: true });
}

async function decodeImageWithSharp(buffer, {
  timeoutMs,
  maxPixels,
  maxDimension,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const image = sharp(buffer, {
    animated: true,
    failOn: 'warning',
    limitInputPixels: maxPixels,
    sequentialRead: true,
  });
  image.timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) });
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeoutImpl(() => {
      image.destroy();
      reject(operationalError('receipt_image_decoder_unavailable'));
    }, timeoutMs);
    timer?.unref?.();
  });
  try {
    const metadata = await Promise.race([image.metadata(), timedOut]);
    const width = Number(metadata?.width);
    const pageHeight = Number(metadata?.pageHeight || metadata?.height);
    const pages = Number(metadata?.pages || 1);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(pageHeight) || width <= 0 || pageHeight <= 0
        || width > maxDimension || pageHeight > maxDimension || width * pageHeight > maxPixels || pages !== 1) {
      return false;
    }
    await Promise.race([image.stats(), timedOut]);
    return true;
  } finally {
    clearTimeoutImpl(timer);
    image.destroy();
  }
}

export async function validateReceiptMediaPreEffect(buffer, mimeType, {
  execFileImpl = execFileAsync,
  scratchRoot = os.tmpdir(),
  timeoutMs = 5000,
  maxPixels = 25_000_000,
  maxDimension = 10_000,
  maxPdfPages = MAX_RECEIPT_PDF_PAGES,
  maxPdfPagePoints = 14_400,
  pdfDpi = 150,
  beforeDecode = async () => {},
  imageDecoder = decodeImageWithSharp,
} = {}) {
  const normalized = normalizeReceiptMimeType(mimeType);
  if (!hasValidReceiptMagicBytes(buffer, normalized)) return false;
  const deadline = Number(timeoutMs);
  const pixelLimit = Number(maxPixels);
  const dimensionLimit = Number(maxDimension);
  const pageLimit = Number(maxPdfPages);
  const pointLimit = Number(maxPdfPagePoints);
  const dpi = Number(pdfDpi);
  if (typeof execFileImpl !== 'function' || typeof imageDecoder !== 'function' || typeof beforeDecode !== 'function'
      || !Number.isSafeInteger(deadline) || deadline < 100 || deadline > 30000
      || !Number.isSafeInteger(pixelLimit) || pixelLimit <= 0
      || !Number.isSafeInteger(dimensionLimit) || dimensionLimit <= 0
      || !Number.isSafeInteger(pageLimit) || pageLimit <= 0 || pageLimit > MAX_RECEIPT_PDF_PAGES
      || !Number.isFinite(pointLimit) || pointLimit <= 0
      || !Number.isFinite(dpi) || dpi <= 0 || dpi > 600) {
    throw new TypeError('preflight de comprobante inválido');
  }

  if (IMAGE_MIMES.has(normalized)) {
    await beforeDecode();
    try {
      const decoded = await imageDecoder(buffer, {
        timeoutMs: deadline,
        maxPixels: pixelLimit,
        maxDimension: dimensionLimit,
      });
      return decoded === true
        ? validationResult(buffer, normalized, {
            kind: 'image', maxPixels: pixelLimit, maxDimension: dimensionLimit,
          })
        : false;
    } catch (error) {
      if (error?.retryable === true || ['ENOENT', 'MODULE_NOT_FOUND', 'ETIMEDOUT'].includes(error?.code)
          || /timeout|timed out/i.test(String(error?.message || ''))) {
        throw operationalError('receipt_image_decoder_unavailable');
      }
      return false;
    }
  }

  let directory;
  try {
    directory = await fs.promises.mkdtemp(path.join(scratchRoot, 'pedivoy-receipt-pdf-'));
    await fs.promises.chmod(directory, 0o700);
    const inputPath = path.join(directory, 'receipt.pdf');
    await fs.promises.writeFile(inputPath, buffer, { mode: 0o600, flag: 'wx' });
    await beforeDecode();
    const result = await execFileImpl('qpdf', ['--json', inputPath], {
      shell: false,
      timeout: deadline,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (/warning|reconstruct|damaged|syntax|xref/i.test(String(result?.stderr || ''))) return false;
    let parsed;
    try { parsed = JSON.parse(String(result?.stdout || '')); } catch { return false; }
    const metadata = pdfPageMetadata(parsed, {
      dpi,
      maxPages: pageLimit,
      maxPixels: pixelLimit,
      maxDimension: dimensionLimit,
      maxPagePoints: pointLimit,
    });
    return metadata ? validationResult(buffer, normalized, metadata) : false;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ETIMEDOUT' || error?.killed === true || error?.signal) {
      throw operationalError('receipt_pdf_preflight_unavailable');
    }
    if (typeof error?.code === 'number' || /^\d+$/.test(String(error?.code || ''))) return false;
    throw operationalError('receipt_pdf_preflight_unavailable');
  } finally {
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
