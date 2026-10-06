// src/transferenciasPipeline.js — Versión Profesional & Modular
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { resolveTransferenciaStorageDir } from './transferenciaStorage.js';
import {
  hasValidReceiptMagicBytes,
  MAX_RECEIPT_PDF_PAGES,
  normalizeReceiptMimeType,
  receiptExtensionForMime,
  receiptValidationMetadata,
  validateReceiptMediaPreEffect,
  verifiesInternalReceiptValidationProof,
} from './receiptMediaValidation.js';
import {
  insertarComprobantePg,
  actualizarComprobanteDatosPg,
  aprobarComprobanteAtomicoPg,
  transicionarComprobanteARevisionPg,
  enqueueCorrelatedWppMessagePg,
  enqueueWppMessagePg,
  resolverCuentaBancariaDestinoPg
} from './transferenciasServices.js';

function enqueueReceiptReply(services, payload, transportOrigin) {
  if (transportOrigin === 'general') {
    return services.enqueueCorrelatedWppMessagePg({
      ...payload,
      transportOrigin: 'general',
    });
  }
  return services.enqueueWppMessagePg(payload);
}

async function dispatchReceiptReply({ services, enqueueReply, assertLease, effect, payload, transportOrigin }) {
  await assertLease();
  if (typeof enqueueReply === 'function') {
    return enqueueReply({ ...payload, effect, transportOrigin });
  }
  return enqueueReceiptReply(services, payload, transportOrigin);
}

const CLOUD_RECEIPT_PROCESSING_ERROR = 'cloud_receipt_processing_failed';

function sanitizedPipelineError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isUnknownEnqueueOutcome(error) {
  return error?.code === 'WPP_ENQUEUE_TRANSACTION_OUTCOME_UNKNOWN';
}

function isTransactionOutcomeUnknown(error) {
  return error?.code === 'TRANSACTION_OUTCOME_UNKNOWN';
}

// --- CONFIGURACIÓN & CONSTANTES ---
const CONFIG = {
  DIR_NAME: 'Transferencia',
  MODEL: 'gpt-4o',
  MAX_TOKENS: 450,
  IMG_QUALITY: 'high',
  AI_MAX_ATTEMPTS: 3,
  DEBUG: process.env.NODE_ENV !== 'production'
};

const __filename = fileURLToPath(import.meta.url);
const projectDir = path.dirname(path.dirname(__filename));
const STORAGE_DIR = resolveTransferenciaStorageDir({ projectDir });
const execFileAsync = promisify(execFile);

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const getOpenAIApiKey = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY');
  return process.env.OPENAI_API_KEY;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientOpenAIError(error) {
  const status = Number(error?.status || error?.code || 0);
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    msg.includes('premature close') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  );
}

function buildReceiptAnalysisPayload(imagePayload) {
  return {
    model: CONFIG.MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Fecha actual: ${new Date().toISOString().split('T')[0]}`
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${imagePayload.mimeType || 'image/jpeg'};base64,${imagePayload.base64}`,
              detail: CONFIG.IMG_QUALITY
            }
          }
        ]
      }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.0,
    max_tokens: CONFIG.MAX_TOKENS
  };
}

async function createChatCompletionViaHttps(payload) {
  // Render estaba cortando algunas respuestas con fetch/undici; este flujo evita ese transporte.
  const body = JSON.stringify(payload);
  const apiKey = getOpenAIApiKey();

  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        timeout: 45000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            error.status = res.statusCode;
            error.message = `OpenAI JSON inválido: ${error.message}`;
            reject(error);
            return;
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const message = parsed?.error?.message || `OpenAI HTTP ${res.statusCode}`;
            const error = new Error(message);
            error.status = res.statusCode;
            error.type = parsed?.error?.type || null;
            reject(error);
            return;
          }

          resolve(parsed);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('OpenAI request timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- PROMPT DE SISTEMA ---
const SYSTEM_PROMPT = `
Eres un experto en extracción de datos financieros.
Analiza comprobantes de transferencia bancaria (Argentina).

REGLAS:
1. Extrae JSON válido.
2. Fecha: "YYYY-MM-DD".
3. Monto: Número flotante puro.
4. Bancos: Normaliza nombres.
5. Campos nulos si no son legibles.

ESTRUCTURA JSON:
{
  "fecha": "YYYY-MM-DD" | null,
  "monto": Number | null,
  "banco_origen": String | null,
  "banco_destino": String | null,
  "alias_destino": String | null,
  "cbu_destino": String | null,
  "titular_destino": String | null,
  "nro_operacion": String | null
}
`;

// --- HELPERS ---
const formatMoney = (n) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0
  }).format(n || 0);

function cleanReceiptField(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text && text.toLowerCase() !== 'null' ? text.slice(0, 80) : null;
}

function maskReceiptOperation(value) {
  const text = cleanReceiptField(value);
  if (!text) return null;
  const suffix = text.slice(-4);
  return text.length > 4 ? `••••${suffix}` : suffix;
}

export function buildReceiptStatusMessage({
  status,
  pedidoId = null,
  monto = null,
  bancoOrigen = null,
  cuentaDestino = null,
  nroOperacion = null,
} = {}) {
  const approved = status === 'approved';
  const lines = [approved ? '✅ Comprobante aprobado' : '📄 Comprobante recibido', ''];
  if (pedidoId) lines.push(`Pedido: #${pedidoId}`);
  if (Number.isFinite(Number(monto)) && Number(monto) > 0) {
    lines.push(`Monto detectado: ${formatMoney(Number(monto))}`);
  }
  if (cleanReceiptField(bancoOrigen)) lines.push(`Banco de origen: ${cleanReceiptField(bancoOrigen)}`);
  if (cleanReceiptField(cuentaDestino)) lines.push(`Cuenta destino: ${cleanReceiptField(cuentaDestino)}`);
  if (maskReceiptOperation(nroOperacion)) lines.push(`Operación: ${maskReceiptOperation(nroOperacion)}`);
  lines.push(`Estado: ${approved ? 'aprobado' : 'pendiente de revisión manual'}`);
  lines.push('', approved
    ? 'El pago quedó acreditado en tu pedido.'
    : 'Te avisaremos cuando el pago quede acreditado.');
  return lines.join('\n');
}

const parseMoney = (input) => {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  const clean = String(input || '')
    .replace(/[^0-9,.-]+/g, '')
    .replace(',', '.');
  const num = parseFloat(clean);
  return isFinite(num) ? num : 0;
};

export function evaluateReceiptApproval({
  registroDB, monto, cuentaDestinoMatch, nroOperacion, fechaComprobante, now = new Date()
}) {
  const reasons = [];
  const parsedAmount = Number(monto);
  const orderAmount = Number(registroDB?.pedido_monto);

  if (!registroDB?.pedido_id || !registroDB?.empresa_id || !Number.isFinite(orderAmount) || orderAmount <= 0) {
    reasons.push('pedido_no_asociado');
  }
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    reasons.push('monto_ia_invalido');
  } else if (
    registroDB?.pedido_id &&
    Number.isFinite(orderAmount) &&
    Math.abs(parsedAmount - orderAmount) > 0.010000001
  ) {
    reasons.push('monto_no_coincide');
  }
  if (!cuentaDestinoMatch?.cuenta_bancaria_id || Number(cuentaDestinoMatch?.confianza || 0) < 70) {
    reasons.push('cuenta_destino_no_verificada');
  }
  if (!String(nroOperacion || '').trim()) reasons.push('numero_operacion_faltante');
  if (!/^[a-f0-9]{64}$/i.test(String(registroDB?.file_hash || ''))) reasons.push('hash_archivo_faltante');

  const dateMatch = String(fechaComprobante || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let receiptDateMs = NaN;
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() === year
      && candidate.getUTCMonth() === month - 1
      && candidate.getUTCDate() === day
    ) {
      receiptDateMs = candidate.getTime();
    }
  }
  const reference = new Date(now);
  const referenceDay = Date.UTC(
    reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()
  );
  const minDate = referenceDay - 90 * 86400000;
  const maxDate = referenceDay + 1 * 86400000;
  if (!Number.isFinite(receiptDateMs) || receiptDateMs < minDate || receiptDateMs > maxDate) {
    reasons.push('fecha_comprobante_fuera_de_rango');
  }
  if (registroDB?.pedido_id && String(registroDB?.pedido_metodo_pago || '').toLowerCase() !== 'transferencia') {
    reasons.push('metodo_pago_no_transferencia');
  }
  if (registroDB?.pedido_id && registroDB?.pedido_pago_acreditado === true) {
    reasons.push('pago_ya_acreditado');
  }

  return {
    approved: reasons.length === 0,
    reasons,
    riskScore: Math.min(100, reasons.length * 35),
  };
}

export async function finalizeReceiptValidation({
  registroDB, datosIA, telefono, replyJid = null, transportOrigin = null, deps = {},
  assertLease = async () => {}, enqueueReply = null,
}) {
  const services = {
    resolverCuentaBancariaDestinoPg,
    actualizarComprobanteDatosPg,
    aprobarComprobanteAtomicoPg,
    transicionarComprobanteARevisionPg: deps.transicionarComprobanteARevisionPg
      || (deps.actualizarComprobanteDatosPg
        ? async ({ id, patch: reviewPatch }) => {
            await deps.actualizarComprobanteDatosPg(id, reviewPatch);
            return { outcome: 'transitioned' };
          }
        : transicionarComprobanteARevisionPg),
    enqueueCorrelatedWppMessagePg,
    enqueueWppMessagePg,
    ...deps,
  };
  const empresaId = Number(registroDB?.empresa_id || 0) || null;
  const replyTarget = replyJid || registroDB?.source_chat_jid || telefono;
  const replyTransportOrigin = transportOrigin || registroDB?.transport_origin || null;
  const monto = parseMoney(datosIA?.monto);
  const nroOperacion = datosIA?.nro_operacion ? String(datosIA.nro_operacion).trim() : null;
  const cuentaDestinoMatch = empresaId
    ? await services.resolverCuentaBancariaDestinoPg({
        empresaId,
        banco_destino: datosIA?.banco_destino || null,
        alias_destino: datosIA?.alias_destino || null,
        cbu_destino: datosIA?.cbu_destino || null,
        titular_destino: datosIA?.titular_destino || null,
      }).catch(() => null)
    : null;

  const decision = evaluateReceiptApproval({
    registroDB,
    monto,
    cuentaDestinoMatch,
    nroOperacion,
    fechaComprobante: datosIA?.fecha,
  });
  decision.approved = decision.reasons.length === 0;
  decision.riskScore = Math.min(100, decision.reasons.length * 35);

  const patch = {
    monto,
    nro_operacion: nroOperacion,
    banco_origen: datosIA?.banco_origen || null,
    banco_destino: datosIA?.banco_destino || null,
    alias_destino: datosIA?.alias_destino || null,
    cbu_destino: datosIA?.cbu_destino || null,
    titular_destino: datosIA?.titular_destino || null,
    cuenta_bancaria_id: cuentaDestinoMatch?.cuenta_bancaria_id || null,
    cuenta_bancaria_confianza: cuentaDestinoMatch?.confianza || 0,
    cuenta_bancaria_match_fuente: cuentaDestinoMatch?.fuente || null,
    cuenta_bancaria_match_detalle: cuentaDestinoMatch?.detalle || null,
  };

  if (decision.approved) {
    try {
      await assertLease();
      const approved = await services.aprobarComprobanteAtomicoPg({
        id: registroDB.id,
        empresaId,
        nroOperacion,
        patch,
      });
      if (approved?.outcome === 'already_finalized') {
        return {
          ok: true, handled: true, saved: true, reason: 'already_finalized',
          id: registroDB.id, pedido_id: registroDB.pedido_id || null,
        };
      }
      if (!approved) {
        decision.approved = false;
        decision.reasons.push('estado_comprobante_no_elegible');
      }
    } catch (error) {
      if (isTransactionOutcomeUnknown(error)) {
        throw sanitizedPipelineError('TRANSACTION_OUTCOME_UNKNOWN');
      }
      decision.approved = false;
      decision.reasons.push(error?.code === '23505'
        ? 'operacion_duplicada'
        : String(error?.code || 'fallo_aprobacion_transaccional'));
    }
    decision.riskScore = Math.min(100, decision.reasons.length * 35);
  }

  if (decision.approved) {
    await dispatchReceiptReply({ services, enqueueReply, assertLease, effect: 'approved', payload: {
      phone: replyTarget,
      message: buildReceiptStatusMessage({
        status: 'approved',
        pedidoId: registroDB.pedido_id,
        monto,
        bancoOrigen: datosIA?.banco_origen,
        cuentaDestino: cuentaDestinoMatch?.cuenta?.banco || datosIA?.banco_destino,
        nroOperacion,
      }),
      empresaId,
    }, transportOrigin: replyTransportOrigin });
    return { ok: true, handled: true, saved: true, id: registroDB.id, pedido_id: registroDB.pedido_id, data: datosIA };
  }

  Object.assign(patch, {
    procesado: false,
    validado: 0,
    estado_revision: 'pendiente',
    riesgo_score: decision.riskScore,
    riesgo_flags: decision.reasons.join(','),
    verified_reason: decision.reasons.join(','),
    verified_at: null,
  });
  if (decision.reasons.includes('operacion_duplicada')) delete patch.nro_operacion;
  await assertLease();
  const transition = await services.transicionarComprobanteARevisionPg({
    id: registroDB.id, empresaId, patch,
  });
  if (transition?.outcome === 'already_finalized') {
    return {
      ok: true, handled: true, saved: true, reason: 'already_finalized',
      id: registroDB.id, pedido_id: registroDB.pedido_id || null,
    };
  }
  if (transition?.outcome !== 'transitioned') {
    return {
      ok: false, handled: true, saved: true, reason: 'already_handled',
      id: registroDB.id, pedido_id: registroDB.pedido_id || null,
    };
  }

  await dispatchReceiptReply({ services, enqueueReply, assertLease, effect: 'pending', payload: {
    phone: replyTarget,
    message: buildReceiptStatusMessage({
      status: 'pending',
      pedidoId: registroDB.pedido_id,
      monto,
      bancoOrigen: datosIA?.banco_origen,
      cuentaDestino: cuentaDestinoMatch?.cuenta?.banco || datosIA?.banco_destino,
      nroOperacion,
    }),
    empresaId,
  }, transportOrigin: replyTransportOrigin });
  return {
    ok: false,
    handled: true,
    saved: true,
    reason: decision.reasons.includes('operacion_duplicada') ? 'duplicate' : 'manual_review',
    reasons: decision.reasons,
    id: registroDB.id,
    pedido_id: registroDB.pedido_id || null,
  };
}

// --- CORE FUNCTIONS ---
export async function saveFileToDisk({ buffer, base64, originalName, mimetype }, {
  storageDir = STORAGE_DIR,
  randomId = randomUUID,
  maxAttempts = 3,
} = {}) {
  const ext = receiptExtensionForMime(mimetype);
  const data = buffer || Buffer.from(base64, 'base64');
  await fs.promises.mkdir(storageDir, { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const filename = `comp-${randomId()}.${ext}`;
    const absolutePath = path.join(storageDir, filename);
    const relativePath = `/${CONFIG.DIR_NAME}/${filename}`;
    try {
      await fs.promises.writeFile(absolutePath, data, { flag: 'wx' });
      return { absolutePath, relativePath, filename, mimetype, ext, size: data.length };
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === maxAttempts - 1) throw error;
    }
  }

  throw new Error('No se pudo reservar un nombre de comprobante único');
}

async function convertPdfFirstPageWithPdftoppm({ buffer, validation }, {
  execFileImpl = execFileAsync,
  scratchRoot = os.tmpdir(),
  timeoutMs = 5000,
  maxOutputBytes = 20 * 1024 * 1024,
  maxPixels = 25_000_000,
  maxDimension = 10_000,
} = {}) {
  const metadata = receiptValidationMetadata(validation?.proof, buffer, 'application/pdf');
  if (!metadata || metadata.kind !== 'pdf'
      || !Number.isSafeInteger(metadata.pageCount) || metadata.pageCount < 1
      || !Number.isSafeInteger(metadata.maxPages) || metadata.maxPages < 1
      || metadata.maxPages > MAX_RECEIPT_PDF_PAGES || metadata.pageCount > metadata.maxPages) {
    throw sanitizedPipelineError('receipt_pdf_raster_invalid');
  }
  const deadlineAt = Date.now() + timeoutMs;
  let directory;
  try {
    directory = await fs.promises.mkdtemp(path.join(scratchRoot, 'pedivoy-pdf-raster-'));
    await fs.promises.chmod(directory, 0o700);
    const inputPath = path.join(directory, 'receipt.pdf');
    const prefix = path.join(directory, 'page');
    const outputPath = `${prefix}.png`;
    await fs.promises.writeFile(inputPath, buffer, { mode: 0o600, flag: 'wx' });
    const remaining = Math.max(100, deadlineAt - Date.now());
    await execFileImpl('pdftoppm', [
      '-f', '1', '-l', '1', '-singlefile', '-png',
      '-r', String(metadata.dpi), inputPath, prefix,
    ], {
      shell: false,
      timeout: remaining,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const stat = await fs.promises.stat(outputPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxOutputBytes) {
      throw sanitizedPipelineError('receipt_pdf_raster_invalid');
    }
    const raw = await fs.promises.readFile(outputPath);
    const decodeRemaining = Math.max(100, deadlineAt - Date.now());
    const image = sharp(raw, {
      failOn: 'warning', limitInputPixels: maxPixels, sequentialRead: true,
    });
    image.timeout({ seconds: Math.max(1, Math.ceil(decodeRemaining / 1000)) });
    try {
      const decoded = await image.metadata();
      const width = Number(decoded?.width);
      const height = Number(decoded?.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
          || width <= 0 || height <= 0 || width > maxDimension || height > maxDimension
          || width * height > maxPixels || Number(decoded?.pages || 1) !== 1
          || decoded?.format !== 'png') {
        throw sanitizedPipelineError('receipt_pdf_raster_invalid');
      }
      await image.stats();
    } finally {
      image.destroy();
    }
    return raw.toString('base64');
  } catch (error) {
    if (['receipt_pdf_raster_invalid', 'receipt_pdf_raster_unavailable'].includes(error?.code)) throw error;
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ENOENT' || error?.killed === true || error?.signal) {
      throw sanitizedPipelineError('receipt_pdf_raster_unavailable');
    }
    throw sanitizedPipelineError('receipt_pdf_raster_invalid');
  } finally {
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareImageForAI(fileData, {
  logger = console,
  convertPdf = convertPdfFirstPageWithPdftoppm,
  assertLease = async () => {},
} = {}) {
  try {
    // Si es PDF, convertimos primera página a imagen
    if (fileData.mimetype === 'application/pdf' || fileData.ext === 'pdf') {
      // Poppler evita la cadena pdf-img-convert/canvas/tar y reduce superficie de riesgo.
      await assertLease();
      return {
        base64: await convertPdf({ buffer: fileData.buffer, validation: fileData.validation }),
        mimeType: 'image/png'
      };
    }

    // Si ya es imagen, la leemos en base64
    const raw = await fs.promises.readFile(fileData.absolutePath);
    return {
      base64: raw.toString('base64'),
      mimeType: fileData.mimetype?.startsWith('image/') ? fileData.mimetype : 'image/jpeg'
    };
  } catch {
    logger.error('receipt_image_prepare_failed', { code: 'receipt_image_prepare_failed', stage: 'prepare_image' });
    return null;
  }
}

async function analyzeReceiptWithAI(imagePayload, {
  logger = console,
  createCompletion = createChatCompletionViaHttps,
  waitImpl = wait,
  maxAttempts = CONFIG.AI_MAX_ATTEMPTS,
} = {}) {
  if (!imagePayload?.base64) return null;
  const payload = buildReceiptAnalysisPayload(imagePayload);
  const attempts = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? Math.min(maxAttempts, CONFIG.AI_MAX_ATTEMPTS)
    : CONFIG.AI_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await createCompletion(payload);
      return JSON.parse(response.choices[0]?.message?.content);
    } catch (error) {
      const transient = isTransientOpenAIError(error);
      const canRetry = transient && attempt < attempts;
      logger.error('receipt_ai_analysis_failed', {
        code: 'receipt_ai_analysis_failed', stage: 'openai', attempt, maxAttempts: attempts, retryable: canRetry,
      });
      if (!canRetry) return null;
      await waitImpl(750 * attempt);
    }
  }

  return null;
}

// --- PIPELINE PRINCIPAL ---
export async function procesarArchivoTransferenciaPg(filePayload, telefono, {
  empresaId: canalEmpresaId = null, sourceMessageId = null, replyJid = null,
  transportOrigin = null, deps = {}, assertLease = async () => {}, enqueueReply = null,
  preparedValidation = null,
  sanitizeErrors = transportOrigin === 'cloud',
} = {}) {
  const logPrefix = '[Pipeline comprobante]';
  if (CONFIG.DEBUG) console.time(logPrefix);

  let empresaId = null;
  let registroDB = null;
  let savedFile = null;
  const services = {
    saveFileToDisk,
    insertarComprobantePg,
    enqueueCorrelatedWppMessagePg,
    enqueueWppMessagePg,
    actualizarComprobanteDatosPg,
    transicionarComprobanteARevisionPg: deps.transicionarComprobanteARevisionPg
      || (deps.actualizarComprobanteDatosPg
        ? async ({ id, patch: reviewPatch }) => {
            await deps.actualizarComprobanteDatosPg(id, reviewPatch);
            return { outcome: 'transitioned' };
          }
        : transicionarComprobanteARevisionPg),
    prepareImageForAI,
    analyzeReceiptWithAI,
    ...deps,
  };

  try {
    // 1. Guardar archivo
    await assertLease();
    savedFile = await services.saveFileToDisk(filePayload, telefono);
    const fileHash = createHash('sha256').update(filePayload.buffer).digest('hex');

    // 2. Registrar en DB (Con Vinculación Automática)
    //    Devuelve ID del registro y empresa_id (si existía)
    await assertLease();
    registroDB = await services.insertarComprobantePg({
      telefono,
      replyJid,
      transportOrigin,
      imagen_path: savedFile.relativePath,
      fecha: new Date(), // PG lo guarda como TIMESTAMPTZ
      empresaId: canalEmpresaId,
      mimetype: savedFile.mimetype,
      bytes: savedFile.size,
      sourceMessageId,
      fileHash,
    });

    if (registroDB?.duplicate) {
      await fs.promises.unlink(savedFile.absolutePath).catch(() => {});
      return { ok: false, handled: true, saved: true, duplicate: true, reason: 'duplicate_event_or_file' };
    }

    empresaId = registroDB?.empresa_id || null;
    const replyTarget = replyJid || registroDB?.source_chat_jid || telefono;

    // 3. Feedback inicial (ya conocemos empresaId)
    const receivedReply = dispatchReceiptReply({ services, enqueueReply, assertLease, effect: 'received', payload: {
      phone: replyTarget,
      message: '📄 Recibido. Analizando comprobante...',
      empresaId,
    }, transportOrigin: registroDB?.transport_origin || transportOrigin });
    if (typeof enqueueReply === 'function') await receivedReply;
    else await receivedReply.catch(() => {});

    // 4. Preparar imagen y consultar a la IA. Si falla esta parte, el archivo
    // ya quedó guardado y registrado para revisión manual.
    await assertLease();
    const imagePayload = await services.prepareImageForAI({
      ...savedFile,
      buffer: filePayload.buffer,
      validation: preparedValidation,
    }, { assertLease });
    await assertLease();
    const datosIA = await services.analyzeReceiptWithAI(imagePayload);
    if (!datosIA) {
      console.warn(`${logPrefix} Comprobante guardado, pero no se pudo leer automáticamente.`);
      await assertLease();
      const unreadableTransition = await services.transicionarComprobanteARevisionPg({
        id: registroDB.id,
        empresaId,
        patch: {
          procesado: false,
          validado: 0,
          estado_revision: 'pendiente',
          riesgo_score: 70,
          riesgo_flags: 'ia_ilegible',
          verified_reason: 'ia_ilegible',
          verified_at: null,
        },
      });
      if (unreadableTransition?.outcome === 'already_finalized') {
        if (CONFIG.DEBUG) console.timeEnd(logPrefix);
        return {
          ok: true, handled: true, saved: true, reason: 'already_finalized',
          id: registroDB.id, pedido_id: registroDB?.pedido_id || null,
        };
      }
      if (unreadableTransition?.outcome !== 'transitioned') {
        if (CONFIG.DEBUG) console.timeEnd(logPrefix);
        return {
          ok: false, handled: true, saved: true, reason: 'already_handled',
          id: registroDB.id, pedido_id: registroDB?.pedido_id || null,
        };
      }
      await dispatchReceiptReply({ services, enqueueReply, assertLease, effect: 'pending', payload: {
        phone: replyTarget,
        message: buildReceiptStatusMessage({ status: 'pending', pedidoId: registroDB?.pedido_id }),
        empresaId,
      }, transportOrigin: registroDB?.transport_origin || transportOrigin });
      if (CONFIG.DEBUG) console.timeEnd(logPrefix);
      return {
        ok: false,
        handled: true,
        saved: true,
        reason: 'unreadable_saved',
        id: registroDB.id,
        pedido_id: registroDB?.pedido_id || null
      };
    }

    const result = await finalizeReceiptValidation({
      registroDB, datosIA, telefono, replyJid, transportOrigin, deps,
      assertLease, enqueueReply,
    });
    if (CONFIG.DEBUG) console.timeEnd(logPrefix);
    return result;
  } catch (error) {
    if (isUnknownEnqueueOutcome(error) || isTransactionOutcomeUnknown(error)) {
      if (CONFIG.DEBUG) console.timeEnd(logPrefix);
      throw sanitizeErrors ? sanitizedPipelineError(error.code) : error;
    }
    if (sanitizeErrors) {
      console.error(`${logPrefix} ERROR FATAL`, {
        code: CLOUD_RECEIPT_PROCESSING_ERROR,
        empresaId: Number(empresaId || canalEmpresaId || 0) || null,
        transportOrigin: 'cloud',
      });
    } else {
      console.error(`${logPrefix} ERROR FATAL:`, error);
    }
    if (savedFile && !registroDB?.id) {
      await fs.promises.unlink(savedFile.absolutePath).catch(() => {});
    }
    try {
      await dispatchReceiptReply({ services, enqueueReply, assertLease, effect: 'error', payload: {
        phone: replyJid || telefono,
        message: '⚠️ Error guardando el archivo. Por favor reintenta.',
        empresaId,
      }, transportOrigin });
    } catch (replyError) {
      if (CONFIG.DEBUG) console.timeEnd(logPrefix);
      if (sanitizeErrors) {
        throw sanitizedPipelineError(isUnknownEnqueueOutcome(replyError)
          ? replyError.code
          : CLOUD_RECEIPT_PROCESSING_ERROR);
      }
      throw replyError;
    }
    if (CONFIG.DEBUG) console.timeEnd(logPrefix);
    if (sanitizeErrors) {
      return {
        ok: false,
        error: CLOUD_RECEIPT_PROCESSING_ERROR,
        code: CLOUD_RECEIPT_PROCESSING_ERROR,
      };
    }
    return { ok: false, error: error.message };
  }
}

// Entrada desde el bot (normaliza payload y delega al pipeline)
export async function handleIncomingComprobanteFromBotPg(botData, options = {}) {
  const {
    type, telefono, replyJid = null, buffer, base64, mimetype, filename, empresaId = null,
    sourceMessageId = null, transportOrigin = null,
  } = botData;

  // Filtro básico
  const supportedTypes = ['image', 'document'];
  const supportedMimes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ];
  const normalizedMimeType = normalizeReceiptMimeType(mimetype);
  const isTypeOk = supportedTypes.includes(type);
  const isMimeOk = supportedMimes.includes(normalizedMimeType);

  if (!isTypeOk || !isMimeOk) {
    return { ok: false, reason: 'unsupported_type' };
  }

  const maxBytes = Number(options.maxBytes || process.env.TRANSFERENCIA_MAX_BYTES || 10 * 1024 * 1024);
  const estimatedBytes = Buffer.isBuffer(buffer)
    ? buffer.length
    : Math.floor(String(base64 || '').length * 3 / 4);
  if (estimatedBytes > maxBytes) return { ok: false, reason: 'file_too_large' };

  const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(base64 || ''), 'base64');
  const validateMedia = options.deps?.validateReceiptMediaPreEffect || validateReceiptMediaPreEffect;
  let validation = options.preparedValidation;
  const alreadyValidated = verifiesInternalReceiptValidationProof(
    validation?.proof,
    fileBuffer,
    normalizedMimeType,
  );
  if (!hasValidReceiptMagicBytes(fileBuffer, normalizedMimeType)) {
    return { ok: false, reason: 'invalid_file_signature' };
  }
  if (!alreadyValidated) {
    validation = await validateMedia(fileBuffer, normalizedMimeType);
    if (!validation || (validation !== true && !verifiesInternalReceiptValidationProof(
      validation?.proof, fileBuffer, normalizedMimeType,
    ))) {
      return { ok: false, reason: 'invalid_file_signature' };
    }
  }

  return await procesarArchivoTransferenciaPg(
    {
      buffer: fileBuffer,
      originalName: filename || `archivo.${normalizedMimeType?.split('/')[1] || 'bin'}`,
      mimetype: normalizedMimeType
    },
    telefono,
    {
      empresaId, sourceMessageId, replyJid, transportOrigin, deps: options.deps || {},
      assertLease: options.assertLease, enqueueReply: options.enqueueReply,
      preparedValidation: validation === true ? null : validation,
    }
  );
}

export const __testables = {
  convertPdfFirstPageWithPdftoppm,
  prepareImageForAI,
  analyzeReceiptWithAI,
  isTransientOpenAIError,
  buildReceiptAnalysisPayload,
  hasValidMagicBytes: hasValidReceiptMagicBytes,
};

export default {
  procesarArchivoTransferenciaPg,
  handleIncomingComprobanteFromBotPg
};
