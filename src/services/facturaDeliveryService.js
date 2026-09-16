import path from 'node:path';
import nodemailer from 'nodemailer';
import { signFacturaDownload } from '../facturaCapability.js';
import { openStorageFile } from '../privateStorage.js';

function cleanPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function baseUrlFromRequest(req) {
  const envUrl = String(process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').trim();
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      const localOverride = String(process.env.LOCAL_HTTP_DEV || '').toLowerCase() === 'true';
      const transportAllowed = parsed.protocol === 'https:'
        || (parsed.protocol === 'http:' && localOverride && isLoopbackHostname(parsed.hostname));
      if (!transportAllowed || parsed.username || parsed.password) throw new Error('invalid origin');
      return parsed.origin;
    } catch {
      throw Object.assign(new Error('PUBLIC_BASE_URL inválida para enlaces de factura'), { statusCode: 409 });
    }
  }
  if (process.env.NODE_ENV === 'production') {
    const localOverride = String(process.env.LOCAL_HTTP_DEV || '').toLowerCase() === 'true';
    const host = req?.get?.('host');
    const proto = req?.get?.('x-forwarded-proto') || req?.protocol || 'http';
    if (localOverride && host) {
      try {
        const parsed = new URL(`${proto}://${host}`);
        if (isLoopbackHostname(parsed.hostname) && parsed.protocol === 'http:') return parsed.origin;
      } catch {
        // fail closed below
      }
    }
    return '';
  }
  if (!req) return '';
  const proto = req.get?.('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get?.('host');
  return host ? `${proto}://${host}` : '';
}

export function buildFacturaPublicUrl(req, factura) {
  const baseUrl = baseUrlFromRequest(req);
  if (!baseUrl) {
    throw Object.assign(new Error('Falta PUBLIC_BASE_URL para generar el enlace de factura'), { statusCode: 409 });
  }
  const token = signFacturaDownload(factura);
  return `${baseUrl}/public/facturas/${factura.id}/pdf?token=${encodeURIComponent(token)}`;
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

  try {
    const rows = await query(
      `INSERT INTO wpp_outbox (empresa_id, telefono, mensaje, status, created_at)
       VALUES ($1,$2,$3,'pending',NOW())
       RETURNING id, status`,
      [empresaId, clean, mensaje],
      { sensitive: true },
    );
    return rows[0];
  } catch {
    throw Object.assign(new Error('No se pudo encolar la factura por WhatsApp'), { statusCode: 500 });
  }
}

export function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendFacturaEmail({
  to,
  factura,
  filePath,
  storageDir,
  filename,
  publicUrl,
}) {
  const email = String(to || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw Object.assign(new Error('Email de facturacion invalido o faltante'), { statusCode: 400 });
  }
  if (!hasSmtpConfig()) {
    throw Object.assign(new Error('Falta configurar SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y MAIL_FROM'), { statusCode: 409 });
  }

  const safeStorageDir = storageDir || (filePath ? path.dirname(filePath) : null);
  const safeFilename = filename || (filePath ? path.basename(filePath) : null);
  if (!safeStorageDir || !safeFilename) {
    throw Object.assign(new Error('Archivo de factura inválido'), { statusCode: 404 });
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  const { fileHandle } = await openStorageFile(safeStorageDir, safeFilename).catch(() => {
    throw Object.assign(new Error('Archivo de factura inválido'), { statusCode: 404 });
  });
  const attachmentStream = fileHandle.createReadStream({ autoClose: true });

  const numero = `${factura.tipo_comprobante || 'Factura'} ${String(factura.punto_venta || '').padStart(4, '0')}-${String(factura.numero_comprobante || '').padStart(8, '0')}`;
  try {
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
      attachments: [{ filename: `${numero.replace(/\s+/g, '-')}.pdf`, content: attachmentStream }],
    });
    return { messageId: info.messageId };
  } catch (error) {
    attachmentStream.destroy();
    await fileHandle.close().catch(() => {});
    throw error;
  }
}
