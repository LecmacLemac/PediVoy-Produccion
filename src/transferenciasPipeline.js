// src/transferenciasPipeline.js — Versión Profesional & Modular
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  insertarComprobantePg,
  actualizarComprobanteDatosPg,
  marcarComprobanteComoProcesadoPg,
  enqueueWppMessagePg,
  verificarDuplicadoOperacionPg
} from './transferenciasServices.js';

// --- CONFIGURACIÓN & CONSTANTES ---
const CONFIG = {
  DIR_NAME: 'Transferencia',
  MODEL: 'gpt-4o',
  MAX_TOKENS: 300,
  IMG_QUALITY: 'high',
  AI_MAX_ATTEMPTS: 3,
  DEBUG: process.env.NODE_ENV !== 'production'
};

const __filename = fileURLToPath(import.meta.url);
const STORAGE_DIR = path.resolve(process.cwd(), CONFIG.DIR_NAME);
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
  if (typeof input === 'number') return input;
  const clean = String(input || '')
    .replace(/[^0-9,.-]+/g, '')
    .replace(',', '.');
  const num = parseFloat(clean);
  return isFinite(num) ? num : 0;
};

const getSafeExtension = (originalname, mimetype) => {
  const ext = path.extname(originalname || '').replace('.', '').toLowerCase();
  if (ext && ext.length <= 4) return ext;
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype?.startsWith('image/')) return 'jpg';
  return 'bin';
};

// --- CORE FUNCTIONS ---
async function saveFileToDisk({ buffer, base64, originalName, mimetype }, telefono) {
  const ext = getSafeExtension(originalName, mimetype);
  const safePhone = String(telefono).replace(/\D/g, '').slice(-10);
  const filename = `comp-${safePhone}-${Date.now()}.${ext}`;
  const absolutePath = path.join(STORAGE_DIR, filename);
  const relativePath = `/${CONFIG.DIR_NAME}/${filename}`;

  const data = buffer || Buffer.from(base64, 'base64');
  await fs.promises.writeFile(absolutePath, data);

  return { absolutePath, relativePath, filename, mimetype, ext, size: data.length };
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
export async function procesarArchivoTransferenciaPg(filePayload, telefono) {
  const logPrefix = `[Pipeline ${String(telefono).slice(-4)}]`;
  if (CONFIG.DEBUG) console.time(logPrefix);

  let empresaId = null;
  let registroDB = null;

  try {
    // 1. Guardar archivo
    const savedFile = await saveFileToDisk(filePayload, telefono);

    // 2. Registrar en DB (Con Vinculación Automática)
    //    Devuelve ID del registro y empresa_id (si existía)
    registroDB = await insertarComprobantePg({
      telefono,
      imagen_path: savedFile.relativePath,
      fecha: new Date(), // PG lo guarda como TIMESTAMPTZ
      mimetype: savedFile.mimetype,
      bytes: savedFile.size
    });

    empresaId = registroDB?.empresa_id || null;

    // 3. Feedback inicial (ya conocemos empresaId)
    enqueueWppMessagePg({
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
      await enqueueWppMessagePg({
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

    // --- 6. VALIDACIÓN DE DUPLICADOS ---
    const nroOp = datosIA?.nro_operacion;

    if (nroOp) {
      // Verificar si este ID ya existe en la DB
      const esDuplicado = await verificarDuplicadoOperacionPg(nroOp);

      if (esDuplicado) {
        console.warn(`${logPrefix} ⚠️ Comprobante duplicado detectado: ${nroOp}`);

        // Guardamos los datos igual por si acaso, pero NO lo marcamos como válido/procesado
        await actualizarComprobanteDatosPg(registroDB.id, {
          monto: parseMoney(datosIA?.monto),
          nro_operacion: nroOp,
          banco_origen: datosIA?.banco_origen,
          banco_destino: datosIA?.banco_destino
        });

        // Avisamos al usuario del error
        await enqueueWppMessagePg({
          phone: telefono,
          message: `⚠️ *Atención:* El comprobante con operación *${nroOp}* ya fue registrado anteriormente en nuestro sistema.`,
          empresaId
        });

        if (CONFIG.DEBUG) console.timeEnd(logPrefix);
        // Retornamos falso para detener el flujo "exitoso"
        return { ok: false, reason: 'duplicate', id: registroDB.id };
      }
    }
    // ------------------------------------------

    // 7. Validación de negocio
    const monto = parseMoney(datosIA?.monto);
    const esValido = monto > 0;

    // 8. Actualizar DB con resultados (y vincular operación si es nuevo)
    await actualizarComprobanteDatosPg(registroDB.id, {
      monto: monto,
      nro_operacion: nroOp || null,
      banco_origen: datosIA?.banco_origen || null,
      banco_destino: datosIA?.banco_destino || null
    });

    // 9. Respuesta final al usuario
    if (esValido) {
      await marcarComprobanteComoProcesadoPg(registroDB.id);

      // Mensaje mejorado con vinculación
      let msgExito = [
        '✅ *Comprobante Procesado*',
        `💰 Monto: ${formatMoney(monto)}`,
        `🏦 Banco: ${datosIA?.banco_origen || 'Detectado'}`,
        `🆔 Op: ${nroOp || 'S/D'}`
      ];

      msgExito.push(`\n🔗 _Comprobante guardado y asociado a tu cuenta._`);

      await enqueueWppMessagePg({
        phone: telefono,
        message: msgExito.join('\n'),
        empresaId
      });
    } else {
      console.warn(`${logPrefix} Datos insuficientes.`);
      await enqueueWppMessagePg({
        phone: telefono,
        message:
          '❌ Comprobante guardado, pero no pude leer los datos automáticamente. Un humano lo revisará.',
        empresaId
      });
    }

    if (CONFIG.DEBUG) console.timeEnd(logPrefix);
    return { ok: esValido, data: datosIA, id: registroDB.id, pedido_id: registroDB?.pedido_id || null };
  } catch (error) {
    console.error(`${logPrefix} ERROR FATAL:`, error);
    await enqueueWppMessagePg({
      phone: telefono,
      message: '⚠️ Error guardando el archivo. Por favor reintenta.',
      empresaId
    });
    return { ok: false, error: error.message };
  }
}

// Entrada desde el bot (normaliza payload y delega al pipeline)
export async function handleIncomingComprobanteFromBotPg(botData) {
  const { type, telefono, buffer, base64, mimetype, filename } = botData;

  // Filtro básico
  const supportedTypes = ['image', 'document'];
  const supportedMimes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ];
  const isTypeOk = supportedTypes.includes(type);
  const isMimeOk =
    supportedMimes.some((m) => mimetype?.includes(m)) ||
    mimetype?.startsWith('image/');

  if (!isTypeOk && !isMimeOk) {
    return { ok: false, reason: 'unsupported_type' };
  }

  return await procesarArchivoTransferenciaPg(
    {
      buffer,
      base64,
      originalName: filename || `archivo.${mimetype?.split('/')[1] || 'bin'}`,
      mimetype
    },
    telefono
  );
}

export const __testables = {
  convertPdfFirstPageWithPdftoppm,
  isTransientOpenAIError,
  buildReceiptAnalysisPayload
};

export default {
  procesarArchivoTransferenciaPg,
  handleIncomingComprobanteFromBotPg
};
