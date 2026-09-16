// src/transferenciasPipeline.js — Versión Profesional & Modular
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { resolveTransferenciaStorageDir } from './transferenciaStorage.js';
import {
  insertarComprobantePg,
  actualizarComprobanteDatosPg,
  aprobarComprobanteAtomicoPg,
  enqueueWppMessagePg,
  resolverCuentaBancariaDestinoPg
} from './transferenciasServices.js';

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

export async function finalizeReceiptValidation({ registroDB, datosIA, telefono, deps = {} }) {
  const services = {
    resolverCuentaBancariaDestinoPg,
    actualizarComprobanteDatosPg,
    aprobarComprobanteAtomicoPg,
    enqueueWppMessagePg,
    ...deps,
  };
  const empresaId = Number(registroDB?.empresa_id || 0) || null;
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
      const approved = await services.aprobarComprobanteAtomicoPg({
        id: registroDB.id,
        empresaId,
        nroOperacion,
        patch,
      });
      if (!approved) {
        decision.approved = false;
        decision.reasons.push('estado_comprobante_no_elegible');
      }
    } catch (error) {
      decision.approved = false;
      decision.reasons.push(error?.code === '23505'
        ? 'operacion_duplicada'
        : String(error?.code || 'fallo_aprobacion_transaccional'));
    }
    decision.riskScore = Math.min(100, decision.reasons.length * 35);
  }

  if (decision.approved) {
    await services.enqueueWppMessagePg({
      phone: telefono,
      message: `✅ Comprobante aprobado por ${formatMoney(monto)} y asociado al pedido.`,
      empresaId,
    });
    return { ok: true, id: registroDB.id, pedido_id: registroDB.pedido_id, data: datosIA };
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
  await services.actualizarComprobanteDatosPg(registroDB.id, patch);

  await services.enqueueWppMessagePg({
    phone: telefono,
    message: '📄 Comprobante guardado y pendiente de revisión manual.',
    empresaId,
  });
  return {
    ok: false,
    saved: true,
    reason: decision.reasons.includes('operacion_duplicada') ? 'duplicate' : 'manual_review',
    reasons: decision.reasons,
    id: registroDB.id,
    pedido_id: registroDB.pedido_id || null,
  };
}

const MIME_EXTENSIONS = new Map([
  ['application/pdf', 'pdf'], ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'],
]);

function hasValidMagicBytes(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimetype === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimetype === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mimetype === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mimetype === 'application/pdf') return buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
  return false;
}

// --- CORE FUNCTIONS ---
export async function saveFileToDisk({ buffer, base64, originalName, mimetype }, {
  storageDir = STORAGE_DIR,
  randomId = randomUUID,
  maxAttempts = 3,
} = {}) {
  const ext = MIME_EXTENSIONS.get(mimetype);
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

async function convertPdfFirstPageWithPdftoppm(filePath) {
  const tmpPrefix = path.join(STORAGE_DIR, `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outPng = `${tmpPrefix}.png`;

  try {
    await execFileAsync('pdftoppm', [
      '-f', '1',
      '-l', '1',
      '-singlefile',
      '-png',
      '-r', '150',
      filePath,
      tmpPrefix
    ]);

    const raw = await fs.promises.readFile(outPng);
    return raw.toString('base64');
  } finally {
    try { await fs.promises.unlink(outPng); } catch {}
  }
}

async function prepareImageForAI(fileData) {
  try {
    // Si es PDF, convertimos primera página a imagen
    if (fileData.mimetype === 'application/pdf' || fileData.ext === 'pdf') {
      // Poppler evita la cadena pdf-img-convert/canvas/tar y reduce superficie de riesgo.
      return {
        base64: await convertPdfFirstPageWithPdftoppm(fileData.absolutePath),
        mimeType: 'image/png'
      };
    }

    // Si ya es imagen, la leemos en base64
    const raw = await fs.promises.readFile(fileData.absolutePath);
    return {
      base64: raw.toString('base64'),
      mimeType: fileData.mimetype?.startsWith('image/') ? fileData.mimetype : 'image/jpeg'
    };
  } catch (error) {
    console.error('❌ Error preparando imagen:', error);
    return null;
  }
}

async function analyzeReceiptWithAI(imagePayload) {
  if (!imagePayload?.base64) return null;
  const payload = buildReceiptAnalysisPayload(imagePayload);

  for (let attempt = 1; attempt <= CONFIG.AI_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await createChatCompletionViaHttps(payload);
      return JSON.parse(response.choices[0]?.message?.content);
    } catch (error) {
      const transient = isTransientOpenAIError(error);
      const canRetry = transient && attempt < CONFIG.AI_MAX_ATTEMPTS;
      console.error(
        `❌ Error OpenAI intento ${attempt}/${CONFIG.AI_MAX_ATTEMPTS}:`,
        error.message
      );
      if (!canRetry) return null;
      await wait(750 * attempt);
    }
  }

  return null;
}

// --- PIPELINE PRINCIPAL ---
export async function procesarArchivoTransferenciaPg(filePayload, telefono, {
  empresaId: canalEmpresaId = null, sourceMessageId = null, deps = {},
} = {}) {
  const logPrefix = '[Pipeline comprobante]';
  if (CONFIG.DEBUG) console.time(logPrefix);

  let empresaId = null;
  let registroDB = null;
  let savedFile = null;
  const services = {
    saveFileToDisk,
    insertarComprobantePg,
    enqueueWppMessagePg,
    actualizarComprobanteDatosPg,
    ...deps,
  };

  try {
    // 1. Guardar archivo
    savedFile = await services.saveFileToDisk(filePayload, telefono);
    const fileHash = createHash('sha256').update(filePayload.buffer).digest('hex');

    // 2. Registrar en DB (Con Vinculación Automática)
    //    Devuelve ID del registro y empresa_id (si existía)
    registroDB = await services.insertarComprobantePg({
      telefono,
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
      return { ok: false, duplicate: true, reason: 'duplicate_event_or_file' };
    }

    empresaId = registroDB?.empresa_id || null;

    // 3. Feedback inicial (ya conocemos empresaId)
    services.enqueueWppMessagePg({
      phone: telefono,
      message: '📄 Recibido. Analizando comprobante...',
      empresaId
    }).catch(() => {});

    // 4. Preparar imagen y consultar a la IA. Si falla esta parte, el archivo
    // ya quedó guardado y registrado para revisión manual.
    const imagePayload = await prepareImageForAI(savedFile);
    const datosIA = await analyzeReceiptWithAI(imagePayload);
    if (!datosIA) {
      console.warn(`${logPrefix} Comprobante guardado, pero no se pudo leer automáticamente.`);
      await services.actualizarComprobanteDatosPg(registroDB.id, {
        procesado: false,
        validado: 0,
        estado_revision: 'pendiente',
        riesgo_score: 70,
        riesgo_flags: 'ia_ilegible',
        verified_reason: 'ia_ilegible',
        verified_at: null,
      });
      await services.enqueueWppMessagePg({
        phone: telefono,
        message:
          '📄 Comprobante guardado. No pude leer los datos automáticamente, así que queda para revisión manual.',
        empresaId
      });
      if (CONFIG.DEBUG) console.timeEnd(logPrefix);
      return {
        ok: false,
        saved: true,
        reason: 'unreadable_saved',
        id: registroDB.id,
        pedido_id: registroDB?.pedido_id || null
      };
    }

    const result = await finalizeReceiptValidation({ registroDB, datosIA, telefono });
    if (CONFIG.DEBUG) console.timeEnd(logPrefix);
    return result;
  } catch (error) {
    console.error(`${logPrefix} ERROR FATAL:`, error);
    if (savedFile && !registroDB?.id) {
      await fs.promises.unlink(savedFile.absolutePath).catch(() => {});
    }
    await services.enqueueWppMessagePg({
      phone: telefono,
      message: '⚠️ Error guardando el archivo. Por favor reintenta.',
      empresaId
    });
    return { ok: false, error: error.message };
  }
}

// Entrada desde el bot (normaliza payload y delega al pipeline)
export async function handleIncomingComprobanteFromBotPg(botData, options = {}) {
  const {
    type, telefono, buffer, base64, mimetype, filename, empresaId = null,
    sourceMessageId = null,
  } = botData;

  // Filtro básico
  const supportedTypes = ['image', 'document'];
  const supportedMimes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ];
  const isTypeOk = supportedTypes.includes(type);
  const isMimeOk = supportedMimes.includes(mimetype);

  if (!isTypeOk || !isMimeOk) {
    return { ok: false, reason: 'unsupported_type' };
  }

  const maxBytes = Number(options.maxBytes || process.env.TRANSFERENCIA_MAX_BYTES || 10 * 1024 * 1024);
  const estimatedBytes = Buffer.isBuffer(buffer)
    ? buffer.length
    : Math.floor(String(base64 || '').length * 3 / 4);
  if (estimatedBytes > maxBytes) return { ok: false, reason: 'file_too_large' };

  const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(base64 || ''), 'base64');
  if (!hasValidMagicBytes(fileBuffer, mimetype)) {
    return { ok: false, reason: 'invalid_file_signature' };
  }

  return await procesarArchivoTransferenciaPg(
    {
      buffer: fileBuffer,
      originalName: filename || `archivo.${mimetype?.split('/')[1] || 'bin'}`,
      mimetype
    },
    telefono,
    { empresaId, sourceMessageId }
  );
}

export const __testables = {
  convertPdfFirstPageWithPdftoppm,
  isTransientOpenAIError,
  buildReceiptAnalysisPayload,
  hasValidMagicBytes,
};

export default {
  procesarArchivoTransferenciaPg,
  handleIncomingComprobanteFromBotPg
};
