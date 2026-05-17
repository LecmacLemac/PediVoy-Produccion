// src/transferenciasPipeline.js — Versión Profesional & Modular
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
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
  DEBUG: process.env.NODE_ENV !== 'production'
};

const __filename = fileURLToPath(import.meta.url);
const STORAGE_DIR = path.resolve(process.cwd(), CONFIG.DIR_NAME);
const execFileAsync = promisify(execFile);

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const getAIClient = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

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
  const outPng = `${tmpPrefix}-1.png`;

  try {
    await execFileAsync('pdftoppm', [
      '-f', '1',
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
      return await convertPdfFirstPageWithPdftoppm(fileData.absolutePath);
    }

    // Si ya es imagen, la leemos en base64
    const raw = await fs.promises.readFile(fileData.absolutePath);
    return raw.toString('base64');
  } catch (error) {
    console.error('❌ Error preparando imagen:', error);
    return null;
  }
}

async function analyzeReceiptWithAI(base64Image) {
  if (!base64Image) return null;
  try {
    const client = getAIClient();
    const response = await client.chat.completions.create({
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
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: CONFIG.IMG_QUALITY
              }
            }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.0,
      max_tokens: CONFIG.MAX_TOKENS
    });
    return JSON.parse(response.choices[0]?.message?.content);
  } catch (error) {
    console.error('❌ Error OpenAI:', error.message);
    return null;
  }
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

    // 4. Preparar imagen
    const imageBase64 = await prepareImageForAI(savedFile);
    if (!imageBase64) throw new Error('No se pudo procesar la imagen.');

    // 5. Consultar a la IA
    const datosIA = await analyzeReceiptWithAI(imageBase64);

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

export default {
  procesarArchivoTransferenciaPg,
  handleIncomingComprobanteFromBotPg
};
