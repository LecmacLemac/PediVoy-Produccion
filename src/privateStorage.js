import express from 'express';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { canAccessFacturacion } from './services/facturacionService.js';

export function isSafeStorageFilename(filename) {
  return typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename);
}

export function facturaStorageFilename(pdfUrl) {
  if (typeof pdfUrl !== 'string' || !pdfUrl.startsWith('/Facturas/')) return null;
  const filename = pdfUrl.slice('/Facturas/'.length);
  return isSafeStorageFilename(filename) ? filename : null;
}

export async function openStorageFile(storageDir, filename) {
  const filePath = path.join(path.resolve(storageDir), filename);
  const fileHandle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Archivo no encontrado'), { code: 'ENOENT' });
    return { fileHandle, stat, filePath };
  } catch (error) {
    await fileHandle.close().catch(() => {});
    throw error;
  }
}

export async function downloadStorageFile(res, storageDir, filename, next, { attachmentName = filename } = {}) {
  let fileHandle;
  try {
    const opened = await openStorageFile(storageDir, filename);
    fileHandle = opened.fileHandle;
    const { stat } = opened;

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Length', String(stat.size));
    res.type(attachmentName);
    res.attachment(attachmentName);

    const stream = fileHandle.createReadStream({ autoClose: true });
    stream.on('error', error => {
      if (res.headersSent) return next(error);
      return res.status(500).json({ error: 'Archivo no encontrado' });
    });
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
    return stream;
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    const missing = error?.code === 'ENOENT' || error?.code === 'ELOOP';
    return res.status(missing ? 404 : 500).json({ error: 'Archivo no encontrado' });
  }
}

function createStorageRouter({ storageDir, withAuth, checkLicencia, query }, domain) {
  const router = express.Router();
  router.use(withAuth, (req, res, next) => {
    const role = req.user?.role;
    const canonicalBackoffice = ['super', 'admin', 'user', 'facturacion', 'contable'].includes(role)
      && canAccessFacturacion(role);
    if (req.user?.type !== undefined || !(canonicalBackoffice || (domain === 'Gastos' && role === 'repartidor'))) {
      return res.status(403).json({ error: 'Rol no autorizado' });
    }
    return next();
  }, checkLicencia);
  router.get('/:filename', async (req, res, next) => {
    const { filename } = req.params;
    if (!isSafeStorageFilename(filename)) return res.status(400).json({ error: 'Archivo inválido' });
    const superUser = req.user.role === 'super';
    const empresaId = req.user.empresa_id;
    if (!superUser && (!Number.isSafeInteger(empresaId) || empresaId <= 0)) return res.sendStatus(403);
    if (req.user.role === 'repartidor') {
      if (!Number.isSafeInteger(req.user.chofer_id) || req.user.chofer_id <= 0) return res.sendStatus(403);
    }
    try {
      let rows;
      if (domain === 'Gastos' && superUser) {
        rows = await query(`SELECT id FROM gastos_repartidor
          WHERE empresa_id IS NOT NULL
            AND (comprobante_path = $1 OR comprobante_path = '/Gastos/' || $1)
          LIMIT 1`, [filename]);
      } else if (domain === 'Gastos' && req.user.role === 'repartidor') {
        rows = await query(`SELECT id FROM gastos_repartidor
          WHERE empresa_id = $2 AND chofer_id = $3
            AND (comprobante_path = $1 OR comprobante_path = '/Gastos/' || $1)
          LIMIT 1`, [filename, empresaId, req.user.chofer_id]);
      } else if (domain === 'Gastos') {
        rows = await query(`SELECT id FROM gastos_repartidor
          WHERE empresa_id = $2
            AND (comprobante_path = $1 OR comprobante_path = '/Gastos/' || $1)
          LIMIT 1`, [filename, empresaId]);
      } else if (superUser) {
        rows = await query(`SELECT id FROM facturas
          WHERE empresa_id IS NOT NULL AND pdf_url = '/Facturas/' || $1
          LIMIT 1`, [filename]);
      } else {
        rows = await query(`SELECT id FROM facturas
          WHERE empresa_id = $2 AND pdf_url = '/Facturas/' || $1
          LIMIT 1`, [filename, empresaId]);
      }
      if (!rows.length) return res.status(404).json({ error: 'Archivo no encontrado' });
      return downloadStorageFile(res, storageDir, filename, next);
    } catch {
      return res.status(500).json({ error: 'Error obteniendo archivo' });
    }
  });
  router.use((_req, res) => res.sendStatus(404));
  return router;
}

export const createGastosStorageRouter = deps => createStorageRouter(deps, 'Gastos');
export const createFacturasStorageRouter = deps => createStorageRouter(deps, 'Facturas');
