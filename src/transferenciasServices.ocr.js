// src/transferenciasServices.ocr.js
// OCR de comprobantes SIN Google Vision — ESM
// * Para imágenes: tesseract.js + sharp
// * Para PDF: primero intenta extraer texto con pdf-parse (sin OCR). Si no hay texto útil, convierte a PNG (Poppler/ImageMagick) y usa Tesseract.
// Requiere: npm i tesseract.js @tesseract.js/node sharp pdf-parse
// Exporta: named `procesarComprobanteConOCR` y default { procesarComprobanteConOCR }

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { spawn } from 'node:child_process';
import { insertarComprobante, digitsOnly, actualizarComprobanteDatos } from './sqliteServices.js';

/* ======================== Config ======================== */
const DEBUG_OCR = process.env.DEBUG_OCR === '1';
const TESS_LANGS = process.env.TESS_LANGS || 'spa+eng';
// Si querés offline, bajá los .traineddata (eng, spa) y poné la ruta aquí o por env:
const TESS_LANG_PATH = process.env.TESS_LANG_PATH || null; // p.ej. "C:\\Bot\\MultiEmpresa\\tessdata"

/* ======================== Utils ======================== */
function toCurrency(n) {
  const v = Number(n || 0);
  return v.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
}

function tmpOutFor(filePath, suffix = '-ocr.png') {
  const { dir, name } = path.parse(filePath);
  return path.join(dir, `${name}${suffix}`);
}

function guessExtFromMime(mimetype) {
  if (!mimetype) return '';
  const [, ext] = String(mimetype).split('/');
  return (ext || '').toLowerCase();
}

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function hasCommand(cmd) {
  return new Promise((resolve) => {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    const p = spawn(bin, [cmd], { stdio: 'ignore' });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

/* ======================== PDF: extracción directa de texto ======================== */
async function extractPdfText(filePath) {
  try {
    const mod = await import('pdf-parse');
    const pdfParse = mod.default || mod;
    const dataBuffer = await fs.readFile(filePath);
    const res = await pdfParse(dataBuffer);
    const text = String(res?.text || '').trim();
    if (DEBUG_OCR) console.log('[PDF] Texto extraído (len):', text.length);
    return text;
  } catch (e) {
    if (DEBUG_OCR) console.warn('[PDF] extractPdfText falló:', e?.message || e);
    return '';
  }
}

/* ============== PDF Fallbacks: Poppler (pdftoppm) / ImageMagick (magick) ============== */
async function pdfToPngWithPoppler(pdfPath, outPng) {
  const outNoExt = outPng.replace(/\.png$/i, '');
  if (DEBUG_OCR) console.log('[OCR] pdftoppm fallback →', outPng);
  return new Promise((resolve, reject) => {
    const p = spawn('pdftoppm', ['-singlefile', '-png', '-r', '300', pdfPath, outNoExt], { stdio: 'ignore' });
    p.on('close', async (code) => {
      if (code === 0 && fsSync.existsSync(outPng)) resolve(outPng);
      else reject(new Error(`pdftoppm fallo (code=${code})`));
    });
    p.on('error', reject);
  });
}

async function pdfToPngWithMagick(pdfPath, outPng) {
  if (DEBUG_OCR) console.log('[OCR] ImageMagick fallback →', outPng);
  return new Promise((resolve, reject) => {
    const p = spawn('magick', ['-density', '300', `${pdfPath}[0]`, outPng], { stdio: 'ignore' });
    p.on('close', () => {
      if (fsSync.existsSync(outPng)) resolve(outPng);
      else reject(new Error('magick fallo'));
    });
    p.on('error', reject);
  });
}

/* ======================== Normalización / Preprocesado ======================== */
/**
 * Convierte la entrada a PNG si hace falta (WEBP/HEIC/PDF → PNG) y
 * genera una versión preprocesada (escala/grises/sharpen/binarización suave).
 * Devuelve { ocrPath, cleanup } donde cleanup() borra temporales.
 */
async function ensurePreprocessedForOCR(filePath, mimetype) {
  const temps = [];
  const cleanup = async () => {
    for (const t of temps) {
      try { await fs.unlink(t); } catch {}
    }
  };

  const lower = filePath.toLowerCase();
  const ext = path.extname(lower).replace('.', '') || guessExtFromMime(mimetype);

  // 1) A PNG si hace falta
  let basePath = filePath;
  if (!['png','jpg','jpeg'].includes(ext)) {
    const out = tmpOutFor(filePath, '-base.png');
    try {
      if (ext === 'pdf') {
        // a) extraer texto directo (pdf-parse). Si sirve, retornamos sin PNG.
        const pdfText = await extractPdfText(filePath);
        if (pdfText && pdfText.length > 40) {
          // devolvemos una ruta "virtual" y un cleanup vacío; el OCR tomará este texto y no hará OCR de imagen
          return { ocrPath: null, cleanup, _pdfText: pdfText };
        }

        // b) si no hay texto útil, intentar convertir a PNG
        // 1) sharp con pdfium (si está disponible)
        let converted = false;
        try {
          await sharp(filePath, { pages: 1, density: 300 }).png().toFile(out);
          converted = true;
        } catch {
          // 2) Poppler si está en PATH
          if (await hasCommand('pdftoppm')) {
            await pdfToPngWithPoppler(filePath, out);
            converted = true;
          } else if (await hasCommand('magick')) {
            // 3) ImageMagick si está en PATH
            await pdfToPngWithMagick(filePath, out);
            converted = true;
          } else {
            throw new Error('PDF_CONVERSION_TOOL_MISSING');
          }
        }
        if (!converted) throw new Error('PDF_CONVERSION_FAILED');
      } else {
        await sharp(filePath).png().toFile(out);
      }
    } catch (e) {
      throw new Error(`FORMATO_NO_SOPORTADO_O_CONVERSION_FALLO: ${ext} (${e?.message || e})`);
    }
    temps.push(out);
    basePath = out;
  }

  // 2) Preprocesado (grises + normalizar + sharpen + upscaling suave)
  const pre = tmpOutFor(filePath, '-prep.png');
  try {
    const meta = await sharp(basePath).metadata();
    const targetW = meta.width && meta.width < 1600 ? 1600 : meta.width || 1600;
    await sharp(basePath)
      .resize({ width: targetW })
      .grayscale()
      .normalise()
      .sharpen()
      .toFormat('png', { compressionLevel: 9 })
      .toFile(pre);
  } catch (e) {
    // si falla el preprocess, usar basePath
    if (DEBUG_OCR) console.warn('[OCR] preprocess falló, uso basePath:', e?.message || e);
    return { ocrPath: basePath, cleanup };
  }
  temps.push(pre);
  return { ocrPath: pre, cleanup };
}

/* ======================== Extracción básica de campos ======================== */
function extractEntitiesFromText(fullTextRaw) {
  const text = String(fullTextRaw || '').replace(/\s+/g, ' ').trim();

  // Monto: busca $ 12.345,67 o 12345.67 o 12.345,00 etc.
  let monto = null;
  const montoMatch = text.match(/(?:\$|\bimporte\b|\btotal\b)\s*[:\-]?\s*\$?\s*([\d.]+[,\.]\d{2}|\d{3,})/i);
  if (montoMatch) {
    const m = montoMatch[1].replace(/\./g, '').replace(',', '.');
    const num = Number(m);
    if (!Number.isNaN(num) && num > 0) monto = Math.round(num);
  }

  // CBU/CVU/alias
  const cbu = (text.match(/\b(\d{22})\b/g) || [])[0] || null;
  const cvu = (text.match(/\b(\d{22})\b/g) || [])[0] || null;
  const aliasMatch = text.match(/\b([a-z0-9][a-z0-9\.\-_]{2,})\b/gi);
  let alias = null;
  if (aliasMatch) {
    alias = aliasMatch.find(a => a.includes('.')) || null;
  }

  // Nro operación / referencia
  const opMatch = text.match(/\b(op(?:eraci[oó]n)?|ref(?:erencia)?)\s*[:\-]?\s*([A-Z0-9\-]{5,})/i);
  const nro_operacion = opMatch ? opMatch[2] : null;

  // Fecha DD/MM/YYYY o YYYY-MM-DD
  const fechaMatch = text.match(/\b(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})\b/);
  const fecha = fechaMatch ? fechaMatch[1] : null;

  // Bancos (heurística liviana)
  const bancoOrigen = (text.match(/\b(hipotecario|galicia|santander|macro|bbva|patagonia|naci[oó]n|provincia|ciudad|hsbc|icbc|credicoop|brubank|uala|mercado pago)\b/i) || [])[1] || null;
  const bancoDestino = (text.match(/\b(hipotecario|galicia|santander|macro|bbva|patagonia|naci[oó]n|provincia|ciudad|hsbc|icbc|credicoop|brubank|uala|mercado pago)\b/i) || [])[1] || null;

  return {
    monto,
    cbu_destino: cbu || cvu || null,
    alias_destino: alias,
    nro_operacion,
    fecha_transf: fecha,
    banco_origen: bancoOrigen,
    banco_destino: bancoDestino,
    texto: text
  };
}

/* ======================== OCR (tesseract.js) ======================== */
async function runOcrWithTesseract(imagePath) {
  if (DEBUG_OCR) console.log('[OCR] Reconociendo con tesseract:', imagePath);
  const options = {
    langPath: TESS_LANG_PATH || undefined,
    // Siempre definimos logger para evitar "logger is not a function"
    logger: (m) => { if (DEBUG_OCR) console.log('[OCR]', m); }
  };
  const { data } = await Tesseract.recognize(imagePath, TESS_LANGS, options);
  const fullText = data?.text || '';
  const confidence = data?.confidence ?? null;
  return { fullText, confidence };
}

/* ======================== Público: procesar comprobante ======================== */
export async function procesarComprobanteConOCR({ telefono, nombre, filePath, mimetype }) {
  if (!filePath || !fsSync.existsSync(filePath)) throw new Error('FILE_NOT_FOUND');

  const tel = digitsOnly(telefono);
  const clientName = nombre || 'Cliente';
  const now = new Date().toISOString();

  // 0) Insert inicial: crea el registro y nos da el ID
  const compId = await insertarComprobante({
    telefono: tel,
    imagen_path: filePath,
    fecha: now
  });

  // 0.1) metadatos del archivo
  let fileBytes = null;
  try { fileBytes = (await fs.stat(filePath)).size || null; } catch {}

  // 1) Preproceso: si es PDF con texto legible, nos devuelve _pdfText
  const prep = await ensurePreprocessedForOCR(filePath, mimetype);
  let fullText = '';
  let confidence = null;

  // 2) Extraer campos
  let extracted = {};
  if (prep._pdfText) {
    fullText = prep._pdfText || '';
    extracted = extractEntitiesFromText(fullText);
    confidence = null; // no es OCR, es texto directo de PDF
  } else if (prep.ocrPath) {
    const { fullText: t, confidence: c } = await runOcrWithTesseract(prep.ocrPath);
    fullText = t || '';
    confidence = c ?? null;
    extracted = extractEntitiesFromText(fullText);
  } else {
    // sin OCR posible, igual registramos metadatos
    fullText = '';
    confidence = null;
    extracted = {};
  }

  // 3) Guardar TODO en la fila del comprobante
  await actualizarComprobanteDatos(compId, {
    monto: extracted.monto ?? null,
    nro_operacion: extracted.nro_operacion ?? null,
    alias_destino: extracted.alias_destino ?? null,
    cbu_destino: extracted.cbu_destino ?? null,
    banco_origen: extracted.banco_origen ?? null,
    banco_destino: extracted.banco_destino ?? null,
    fecha_transf: extracted.fecha_transf ?? null,
    ocr_text: fullText || null,
    ocr_confidence: confidence,
    mimetype: mimetype || null,
    bytes: fileBytes
  });

  // 4) Mensaje al cliente (incluye lo que pudimos leer)
  const partes = [];
  if (extracted.monto != null) partes.push(`💵 Importe: ${toCurrency(extracted.monto)}`);
  if (extracted.nro_operacion) partes.push(`# Operación: ${extracted.nro_operacion}`);
  if (extracted.alias_destino || extracted.cbu_destino) {
    partes.push(`Destino: ${extracted.alias_destino || extracted.cbu_destino}`);
  }
  const detalle = partes.length ? `\n${partes.join('\n')}` : '';

  const mensajeCliente =
    `¡Gracias ${clientName}! ✅ Recibimos tu comprobante.\n` +
    `Quedó registrado con referencia *#${compId}*.${detalle}`;

  // cleanup de temporales si existieron
  if (typeof prep.cleanup === 'function') { try { await prep.cleanup(); } catch {} }

  return { mensajeCliente, comprobanteId: compId, validado: false, extracted };
}


export default { procesarComprobanteConOCR };
