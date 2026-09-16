import path from 'node:path';
import express from 'express';
import { isSafeStorageFilename, downloadStorageFile } from './privateStorage.js';

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
            `SELECT id
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
            `SELECT id
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

      return downloadStorageFile(res, storageDir, filename, next);
    } catch (error) {
      return res.status(500).json({ error: 'Error obteniendo archivo' });
    }
  });
  router.use((_req, res) => res.sendStatus(404));
  return router;
}
