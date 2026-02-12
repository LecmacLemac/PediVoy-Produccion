// /src/ocrService.js (ESM) — robust parser + safe matchAll usage
import fs from 'fs';
import Tesseract from 'tesseract.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse'); 

export async function ocrImage(filePath) {
  const res = await Tesseract.recognize(filePath, 'spa+eng');
  const text = res?.data?.text || '';
  const confidence = typeof res?.data?.confidence === 'number' ? res.data.confidence : 0;
  return { text, confidence };
}

export async function ocrPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  const text = data?.text || '';
  const confidence = Math.min(100, Math.max(0, (text.length / 5000) * 100));
  return { text, confidence };
}

export function normalizeAmount(str) {
  if (!str) return null;
  let s = String(str).trim().replace(/[^\d,.-]/g, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) {
    const m = s.match(/,(\d{1,2})\s*$/);
    s = m ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseTransfer(text) {
  const original = String(text || '');
  const rawText = original
    .replace(/\r/g, '')
    .replace(/[“”„”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/mercado\s*\n\s*pago/gi, 'Mercado Pago')
    .replace(/\u00A0/g, ' ');

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // 1) Monto
  let monto = null;
  const amtKeyRgx = /(importe|monto|total|transferiste|has enviado|enviado)/i;
  for (let i=0;i<lines.length;i++) {
    if (amtKeyRgx.test(lines[i])) {
      const moneyRgx = /(\$?\s*[A-Z]{0,3}\s*[0-9]{1,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})|\$?\s*[0-9]+(?:[.,][0-9]{2})?)/;
      const here = lines[i].match(moneyRgx) || (lines[i+1] && lines[i+1].match(moneyRgx));
      if (here && here[1]) { monto = normalizeAmount(here[1]); break; }
    }
  }
  if (monto == null) {
    const moneyAll = Array.from(rawText.matchAll(/(?:\$\s*)?([0-9]{1,3}(?:[.\s][0-9]{3})*(?:,[0-9]{2})|[0-9]+,[0-9]{2})/g)).map(m=>m[1]);
    if (moneyAll.length) {
      const vals = moneyAll.map(x => {
        let y = x;
        if (y.includes(',') && y.includes('.')) y = y.replace(/\./g,'').replace(',', '.');
        else if (y.includes(',')) {
          const mm = y.match(/,(\d{1,2})\s*$/);
          y = mm ? y.replace(/\./g,'').replace(',', '.') : y.replace(/,/g,'');
        }
        const n = Number(y);
        return Number.isFinite(n) ? n : -1;
      }).filter(n => n > 0);
      if (vals.length) {
        const max = Math.max(...vals);
        if (max > 0 && max < 1e9) monto = max;
      }
    }
  }
  let moneda = /(usd|u\$s|us\$)/i.test(rawText) ? 'USD' : 'ARS';

  // 2) N° de operación
  let nro_operacion = null;
  const opPatterns = [
    /n[úu]mero de operaci[óo]n(?: de mercado pago)?\s*[:#]?\s*([A-Za-z0-9.\-]+)/i,
    /nro\.?\s*de\s*operaci[óo]n\s*[:#]?\s*([A-Za-z0-9.\-]+)/i,
    /id\s*de\s*(?:transacci[óo]n|operaci[óo]n)\s*[:#]?\s*([A-Za-z0-9.\-]+)/i,
    /\b(?:op|ref)\s*[:#]?\s*([A-Za-z0-9.\-]{6,})\b/i
  ];
  for (const rgx of opPatterns) {
    const m = rawText.match(rgx);
    if (m && m[1]) { nro_operacion = m[1].trim(); break; }
  }

  // 3) Fecha
  let fecha_operacion = null;
  const meses = { 'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,'julio':7,'agosto':8,'septiembre':9,'setiembre':9,'octubre':10,'noviembre':11,'diciembre':12 };
  const fm = rawText.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)\s*,?\s*(\d{1,2})\s*de\s*([a-záéíóú]+)\s*de\s*(\d{4})(?:\s*(?:a\s*las)?\s*(\d{1,2})[:h](\d{2}))?/i);
  if (fm) {
    const d = String(fm[2]).padStart(2,'0');
    const mo = String(meses[fm[3].toLowerCase()] || '').padStart(2,'0');
    const y = fm[4];
    if (mo) {
      if (fm[5] && fm[6]) {
        const hh = String(fm[5]).padStart(2,'0');
        const mm = String(fm[6]).padStart(2,'0');
        fecha_operacion = `${y}-${mo}-${d}T${hh}:${mm}:00`;
      } else {
        fecha_operacion = `${y}-${mo}-${d}`;
      }
    }
  }

  // 4) CBU/CVU y Alias (último como destino)
  const cbuMatches = Array.from(rawText.matchAll(/\b(?:CBU|CVU)\s*[:=]?\s*([0-9]{22})\b/ig)).map(m=>m[1]);
  const aliasMatches = Array.from(rawText.matchAll(/\bAlias\b\s*[:=]?\s*([A-Za-z0-9.\-_ ]{3,})/ig)).map(m=>m[1].trim());
  const cbu_destino = cbuMatches.length ? cbuMatches[cbuMatches.length-1] : null;
  const alias_destino = aliasMatches.length ? aliasMatches[aliasMatches.length-1] : null;

  // 5) Bancos y titular (sin matchAll con no-global)
  let banco_origen = null, banco_destino = null, titular_origen = null;
  const BANK_RGX = /(Mercado\s+Pago|Galicia|Santander|Macro|BBVA|Naci[oó]n|Reba|Itau|Naranja|Provincia|Ciudad|ICBC|HSBC|Credicoop|Patagonia|Supervielle|Bind|Brubank|Uala)/i;

  const deIdx = lines.findIndex(l => /^["»“”']?\s*de\s*$/i.test(l));
  const paraIdx = lines.findIndex(l => /^["»“”'*]?\s*para\s*$/i.test(l));

  if (deIdx !== -1) {
    for (let i=deIdx+1; i<Math.min(lines.length, deIdx+8); i++) {
      if (!titular_origen && !/cuit|cuil|dni|titular|cbu|cvu|alias/i.test(lines[i]) && !/mercado\s*pago/i.test(lines[i])) {
        titular_origen = lines[i];
      }
      const mb = lines[i].match(BANK_RGX);
      if (mb) banco_origen = mb[1].replace(/\s+/g,' ').trim();
      if (/cbu|cvu|alias/i.test(lines[i])) break;
    }
  } else {
    const mb = rawText.match(BANK_RGX);
    if (mb) banco_origen = mb[1].replace(/\s+/g,' ').trim();
  }

  if (paraIdx !== -1) {
    for (let i=paraIdx+1; i<Math.min(lines.length, paraIdx+8); i++) {
      const mb = lines[i].match(BANK_RGX);
      if (mb) banco_destino = mb[1].replace(/\s+/g,' ').trim();
      if (/cbu|cvu|alias/i.test(lines[i])) break;
    }
  } else {
    const allB = Array.from(rawText.matchAll(new RegExp(BANK_RGX.source, 'ig'))).map(m=>m[1]);
    if (allB.length >= 2) banco_destino = allB[allB.length-1].replace(/\s+/g,' ').trim();
    else if (allB.length === 1) banco_destino = banco_origen || allB[0].replace(/\s+/g,' ').trim();
  }

  return { monto, moneda, banco_origen, banco_destino, alias_destino, cbu_destino, nro_operacion, titular_origen, fecha_operacion, rawText };
}

export function validateTransfer(extracted, expected) {
  const reasons = [];
  const tol = Number.isFinite(expected?.tolerancia) ? expected.tolerancia : 2;

  let ok = true;
  if (expected?.cbu && extracted?.cbu_destino && extracted.cbu_destino !== expected.cbu) {
    ok = false; reasons.push('CBU destino no coincide');
  }
  if (expected?.alias && extracted?.alias_destino && extracted.alias_destino.toLowerCase() !== expected.alias.toLowerCase()) {
    ok = false; reasons.push('Alias destino no coincide');
  }
  if (expected?.montoEsperado && extracted?.monto) {
    const diff = Math.abs(extracted.monto - expected.montoEsperado);
    if (diff > tol) { ok = false; reasons.push(`Monto distinto (Δ ${diff.toFixed(2)})`); }
  }
  return { ok, reasons };
}

export async function ocrParseAndValidate(filePath, mime, expected = {}) {
  const isPdf = (mime || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(filePath);
  const { text, confidence } = isPdf ? await ocrPdf(filePath) : await ocrImage(filePath);
  const extracted = parseTransfer(text || '');
  // Fallback de monto
  const expMonto = Number(expected?.monto ?? expected?.total ?? expected?.montoEsperado);
  if ((!Number.isFinite(extracted.monto) || extracted.monto == null) && Number.isFinite(expMonto) && expMonto > 0) {
    extracted.monto = expMonto;
  }
  const validation = validateTransfer(extracted, expected);
  return { extracted, text, confidence, validation };
}
