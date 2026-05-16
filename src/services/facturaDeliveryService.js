import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

function cleanPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function baseUrlFromRequest(req) {
  const envUrl = String(process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (!req) return '';
  const proto = req.get?.('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get?.('host');
  return host ? `${proto}://${host}` : '';
}

export function buildFacturaPublicUrl(req, pdfUrl) {
  if (!pdfUrl) return '';
  if (/^https?:\/\//i.test(pdfUrl)) return pdfUrl;
  const baseUrl = baseUrlFromRequest(req);
  return baseUrl ? `${baseUrl}${pdfUrl.startsWith('/') ? '' : '/'}${pdfUrl}` : pdfUrl;
}

export async function queueFacturaWhatsapp(query, {
  empresaId,
  telefono,
  factura,
  publicUrl,
}) {
  const clean = cleanPhone(telefono);
  if (!clean) throw Object.assign(new Error('Telefono de WhatsApp requerido'), { statusCode: 400 });
  if (!publicUrl || !/^https?:\/\//i.test(publicUrl)) {
    throw Object.assign(new Error('Falta PUBLIC_BASE_URL para enviar link de factura por WhatsApp'), { statusCode: 409 });
  }

  const numero = `${factura.tipo_comprobante || 'Factura'} ${String(factura.punto_venta || '').padStart(4, '0')}-${String(factura.numero_comprobante || '').padStart(8, '0')}`;
  const mensaje = [
    `Hola ${factura.receptor_razon_social || ''}, te enviamos tu ${numero}.`,
    `Total: $${Number(factura.importe_total || 0).toFixed(2)}`,
    `CAE: ${factura.cae}`,
    `PDF: ${publicUrl}`,
  ].join('\n');

  const rows = await query(
    `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
     VALUES ($1,$2,$3,'pending',NOW())
     RETURNING id, status`,
    [empresaId, clean, mensaje]
  );
  return rows[0];
}

export function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendFacturaEmail({
  to,
  factura,
  filePath,
  publicUrl,
}) {
  const email = String(to || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw Object.assign(new Error('Email de facturacion invalido o faltante'), { statusCode: 400 });
  }
  if (!hasSmtpConfig()) {
    throw Object.assign(new Error('Falta configurar SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y MAIL_FROM'), { statusCode: 409 });
  }

  await fs.access(filePath);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const numero = `${factura.tipo_comprobante || 'Factura'} ${String(factura.punto_venta || '').padStart(4, '0')}-${String(factura.numero_comprobante || '').padStart(8, '0')}`;
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: `${numero} - PediVoy`,
    text: [
      `Hola ${factura.receptor_razon_social || ''}, adjuntamos tu ${numero}.`,
      `Total: $${Number(factura.importe_total || 0).toFixed(2)}`,
      `CAE: ${factura.cae}`,
      publicUrl ? `Descarga: ${publicUrl}` : '',
    ].filter(Boolean).join('\n'),
    attachments: [{ filename: `${numero.replace(/\s+/g, '-')}.pdf`, path: filePath }],
  });
  return { messageId: info.messageId };
}
