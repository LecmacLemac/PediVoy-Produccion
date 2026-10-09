import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { isSafeStorageFilename, downloadStorageFile } from './privateStorage.js';

const DURABLE_RECEIPT_MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);
const DURABLE_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const DURABLE_RECEIPT_SELECT = `id,
  CASE
    WHEN archivo_binario IS NOT NULL
     AND octet_length(archivo_binario) <= ${DURABLE_RECEIPT_MAX_BYTES}
    THEN archivo_binario
    ELSE NULL
  END AS archivo_binario,
  archivo_binario IS NOT NULL AS archivo_binario_presente,
  CASE WHEN archivo_binario IS NULL THEN NULL ELSE octet_length(archivo_binario) END AS archivo_size_real,
  archivo_mimetype, archivo_size, archivo_sha256`;

export function resolveTransferenciaStorageDir({ projectDir, env = process.env } = {}) {
  if (!projectDir) throw new Error('resolveTransferenciaStorageDir: falta projectDir');

  const explicitPath = String(env.TRANSFERENCIA_STORAGE_PATH || '').trim();
  if (explicitPath) return path.resolve(explicitPath);

  const diskPath = String(env.DISK_PATH || '').trim();
  if (diskPath) return path.join(path.resolve(diskPath), 'Transferencia');

  return path.join(path.resolve(projectDir), 'Transferencia');
}

export function requireTransferenciaStorageRole(req, res, next) {
  const role = req.user?.role;
  if (req.user?.type !== undefined || !['admin', 'super'].includes(role)) {
    return res.status(403).json({ error: 'Rol no autorizado para descargar comprobantes' });
  }
  return next();
}

export function createTransferenciaStorageRouter({ storageDir, withAuth, checkLicencia, query, isSuper }) {
  if (typeof withAuth !== 'function') throw new Error('createTransferenciaStorageRouter: falta withAuth');
  if (typeof checkLicencia !== 'function') throw new Error('createTransferenciaStorageRouter: falta checkLicencia');
  if (typeof query !== 'function') throw new Error('createTransferenciaStorageRouter: falta query');
  if (typeof isSuper !== 'function') throw new Error('createTransferenciaStorageRouter: falta isSuper');
  const router = express.Router();
  router.use(withAuth, requireTransferenciaStorageRole, checkLicencia);
  router.get('/:filename', async (req, res, next) => {
    const filename = String(req.params.filename || '');
    if (!isSafeStorageFilename(filename)) {
      return res.status(400).json({ error: 'Archivo inválido' });
    }

    try {
      const superUser = isSuper(req);
      const empresaId = Number(req.user?.empresa_id || 0);
      if (!superUser && (!Number.isInteger(empresaId) || empresaId <= 0)) {
        return res.status(403).json({ error: 'Sin empresa asociada' });
      }

      const rows = superUser
        ? await query(
            `SELECT ${DURABLE_RECEIPT_SELECT}
               FROM comprobantes_transferencia
              WHERE empresa_id IS NOT NULL
                AND (
                  regexp_replace(COALESCE(archivo_path, ''), '^.*/', '') = $1
                  OR regexp_replace(COALESCE(comprobante_path, ''), '^.*/', '') = $1
                )
              LIMIT 1`,
            [filename],
          )
        : await query(
            `SELECT ${DURABLE_RECEIPT_SELECT}
               FROM comprobantes_transferencia
              WHERE empresa_id = $2
                AND (
                  regexp_replace(COALESCE(archivo_path, ''), '^.*/', '') = $1
                  OR regexp_replace(COALESCE(comprobante_path, ''), '^.*/', '') = $1
                )
              LIMIT 1`,
            [filename, empresaId],
          );
      if (!rows.length) return res.status(404).json({ error: 'Archivo no encontrado' });

      const receipt = rows[0];
      if (receipt.archivo_binario_presente === true && !Buffer.isBuffer(receipt.archivo_binario)) {
        return res.status(500).json({ error: 'Archivo durable inválido' });
      }
      if (Buffer.isBuffer(receipt.archivo_binario)) {
        const mimeType = String(receipt.archivo_mimetype || '').trim().toLowerCase();
        const declaredSize = Number(receipt.archivo_size);
        const actualSize = Number(receipt.archivo_size_real ?? receipt.archivo_binario.length);
        const declaredHash = String(receipt.archivo_sha256 || '').trim().toLowerCase();
        if (!DURABLE_RECEIPT_MIME_TYPES.has(mimeType)
            || !Number.isSafeInteger(declaredSize)
            || !Number.isSafeInteger(actualSize)
            || actualSize <= 0
            || actualSize > DURABLE_RECEIPT_MAX_BYTES
            || declaredSize !== actualSize
            || actualSize !== receipt.archivo_binario.length
            || !/^[a-f0-9]{64}$/.test(declaredHash)) {
          return res.status(500).json({ error: 'Archivo durable inválido' });
        }
        const actualHash = createHash('sha256').update(receipt.archivo_binario).digest('hex');
        if (declaredHash !== actualHash) {
          return res.status(500).json({ error: 'Archivo durable inválido' });
        }
        res.attachment(filename);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', String(declaredSize));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.status(200).send(receipt.archivo_binario);
      }

      return downloadStorageFile(res, storageDir, filename, next);
    } catch (error) {
      return res.status(500).json({ error: 'Error obteniendo archivo' });
    }
  });
  router.use((_req, res) => res.sendStatus(404));
  return router;
}
