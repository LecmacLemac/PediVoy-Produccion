import express from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { cfg } from './config.js';
import { facturaStorageFilename, downloadStorageFile } from './privateStorage.js';

const JWT_SECRET = process.env.JWT_SECRET || cfg.jwtSecret || 'dev-secret';
const TYPE = 'factura_download';
const PURPOSE = 'factura_pdf';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const pdfVersion = filename => createHash('sha256').update(filename).digest('base64url');

export function signFacturaDownload(factura, { jwtSecret = JWT_SECRET } = {}) {
  const facturaId = Number(factura.id);
  const empresaId = Number(factura.empresa_id);
  const filename = facturaStorageFilename(factura.pdf_url);
  if (!positiveId(facturaId) || !positiveId(empresaId) || !filename) throw new Error('Factura inválida');
  return jwt.sign({
    type: TYPE,
    purpose: PURPOSE,
    factura_id: facturaId,
    empresa_id: empresaId,
    pdf_version: pdfVersion(filename),
  },
    jwtSecret, { algorithm: 'HS256', expiresIn: '24h' });
}

export function createFacturaCapabilityRouter({ query, storageDir, jwtSecret = JWT_SECRET }) {
  const router = express.Router();
  router.get('/:id/pdf', async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    let claims;
    try {
      if (typeof req.query.token !== 'string') throw new Error('Invalid token');
      claims = jwt.verify(req.query.token, jwtSecret, { algorithms: ['HS256'] });
      if (claims.type !== TYPE || claims.purpose !== PURPOSE || !positiveId(claims.factura_id)
        || !positiveId(claims.empresa_id) || !Number.isSafeInteger(claims.exp)
        || !Number.isSafeInteger(claims.iat) || claims.exp <= claims.iat || claims.exp - claims.iat > 86400
        || typeof claims.pdf_version !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.pdf_version)
        || String(claims.factura_id) !== req.params.id) throw new Error('Invalid capability');
    } catch {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    try {
      const rows = await query('SELECT id, empresa_id, pdf_url, estado FROM facturas WHERE id = $1 AND empresa_id = $2 LIMIT 1',
        [claims.factura_id, claims.empresa_id]);
      const factura = rows[0];
      const filename = facturaStorageFilename(factura?.pdf_url);
      if (!factura || Number(factura.id) !== claims.factura_id || Number(factura.empresa_id) !== claims.empresa_id
        || factura.estado !== 'emitida' || !filename || pdfVersion(filename) !== claims.pdf_version) {
        return res.status(404).json({ error: 'Archivo no encontrado' });
      }
      return downloadStorageFile(res, storageDir, filename, next);
    } catch {
      return res.status(500).json({ error: 'Error obteniendo archivo' });
    }
  });
  return router;
}
