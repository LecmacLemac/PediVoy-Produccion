import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';

const MONEDA_PESOS = 'PES';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function money(value) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function fmtDate(value) {
  if (!value) return '-';
  const s = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  return s;
}

function afipQrDate(value) {
  const s = String(value || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function fiscalLetter(factura) {
  return String(factura?.tipo_comprobante || 'C').trim().slice(0, 1).toUpperCase() || 'C';
}

function formattedNumber(factura) {
  const pv = String(factura?.punto_venta || 0).padStart(4, '0');
  const nro = String(factura?.numero_comprobante || 0).padStart(8, '0');
  return `${pv}-${nro}`;
}

export function buildAfipQrPayload({ factura, config }) {
  if (!factura?.cae || !factura?.numero_comprobante) {
    throw new Error('La factura debe estar emitida para generar QR fiscal');
  }

  const receptorDoc = digitsOnly(factura.receptor_documento);
  const payload = {
    ver: 1,
    fecha: afipQrDate(factura.fecha_comprobante || factura.emitted_at || factura.created_at),
    cuit: Number(digitsOnly(config?.cuit)),
    ptoVta: Number(factura.punto_venta),
    tipoCmp: Number(factura.codigo_comprobante_afip),
    nroCmp: Number(factura.numero_comprobante),
    importe: Number(Number(factura.importe_total || 0).toFixed(2)),
    moneda: MONEDA_PESOS,
    ctz: 1,
    tipoDocRec: receptorDoc.length === 11 ? 80 : 96,
    nroDocRec: Number(receptorDoc || 0),
    tipoCodAut: 'E',
    codAut: Number(digitsOnly(factura.cae)),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    payload,
    url: `https://www.afip.gob.ar/fe/qr/?p=${encoded}`,
  };
}

export async function buildFacturaHtml({ factura, config }) {
  const { url: qrUrl } = buildAfipQrPayload({ factura, config });
  const qrDataUrl = await QRCode.toDataURL(qrUrl, { margin: 1, width: 180 });
  const items = Array.isArray(factura.items) ? factura.items : [];
  const letter = fiscalLetter(factura);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #111827; margin: 0; padding: 28px; font-size: 12px; }
    .sheet { border: 1px solid #111827; min-height: 1040px; padding: 18px; }
    .top { display: grid; grid-template-columns: 1fr 86px 1fr; border-bottom: 1px solid #111827; padding-bottom: 14px; gap: 12px; }
    .letter { border: 2px solid #111827; width: 72px; height: 72px; display: grid; place-items: center; font-size: 42px; font-weight: 800; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    h2 { margin: 0 0 6px; font-size: 15px; }
    p { margin: 3px 0; }
    .right { text-align: right; }
    .section { border-bottom: 1px solid #d1d5db; padding: 14px 0; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 28px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 6px; text-align: left; }
    th { background: #f3f4f6; font-size: 11px; text-transform: uppercase; }
    .num { text-align: right; }
    .totals { width: 280px; margin-left: auto; margin-top: 16px; }
    .totals div { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #e5e7eb; }
    .total { font-size: 16px; font-weight: 800; }
    .footer { display: grid; grid-template-columns: 190px 1fr; gap: 18px; margin-top: 22px; align-items: end; }
    .qr img { width: 160px; height: 160px; }
    .muted { color: #4b5563; }
    .cae { border: 1px solid #111827; padding: 12px; }
  </style>
</head>
<body>
  <main class="sheet">
    <section class="top">
      <div>
        <h1>${escapeHtml(config?.razon_social || 'Empresa')}</h1>
        <p>CUIT: ${escapeHtml(config?.cuit || '-')}</p>
        <p>Condicion IVA: ${escapeHtml(config?.condicion_iva || '-')}</p>
      </div>
      <div class="letter">${escapeHtml(letter)}</div>
      <div class="right">
        <h2>Factura ${escapeHtml(letter)}</h2>
        <p>Nro. ${escapeHtml(formattedNumber(factura))}</p>
        <p>Fecha: ${escapeHtml(fmtDate(factura.fecha_comprobante || factura.emitted_at || factura.created_at))}</p>
        <p>Punto de venta: ${escapeHtml(factura.punto_venta)}</p>
      </div>
    </section>

    <section class="section grid">
      <div><strong>Cliente</strong><p>${escapeHtml(factura.receptor_razon_social || 'Consumidor Final')}</p></div>
      <div><strong>Documento</strong><p>${escapeHtml(factura.receptor_documento || '-')}</p></div>
      <div><strong>Condicion IVA</strong><p>${escapeHtml(factura.receptor_condicion_iva || '-')}</p></div>
      <div><strong>Email facturacion</strong><p>${escapeHtml(factura.receptor_email_facturacion || '-')}</p></div>
    </section>

    <section class="section">
      <strong>Detalle</strong>
      <table>
        <thead><tr><th>Descripcion</th><th class="num">Cant.</th><th class="num">Unitario</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${items.map((item) => `<tr><td>${escapeHtml(item.descripcion || 'Item')}</td><td class="num">${escapeHtml(item.cantidad)}</td><td class="num">${escapeHtml(money(item.precio_unitario))}</td><td class="num">${escapeHtml(money(item.importe_total))}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="totals">
        <div><span>Neto</span><strong>${escapeHtml(money(factura.importe_neto))}</strong></div>
        <div><span>IVA</span><strong>${escapeHtml(money(factura.importe_iva))}</strong></div>
        <div class="total"><span>Total</span><strong>${escapeHtml(money(factura.importe_total))}</strong></div>
      </div>
    </section>

    <section class="footer">
      <div class="qr"><img src="${qrDataUrl}" alt="QR fiscal AFIP"></div>
      <div class="cae">
        <p><strong>CAE:</strong> ${escapeHtml(factura.cae)}</p>
        <p><strong>Vencimiento CAE:</strong> ${escapeHtml(fmtDate(factura.cae_vencimiento))}</p>
        <p class="muted">Comprobante autorizado electronicamente. Verificacion fiscal mediante QR.</p>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export async function generateFacturaPdf({ factura, config, outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  const filename = `factura-${factura.empresa_id}-${factura.id}-${randomUUID()}.pdf`;
  const filePath = path.join(outputDir, filename);
  const html = await buildFacturaHtml({ factura, config });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close();
  }
  return {
    filename,
    filePath,
    publicPath: `/Facturas/${filename}`,
  };
}

export function resolveFacturasDir(projectDir = process.cwd()) {
  return path.resolve(projectDir, 'Facturas');
}
