import path from 'node:path';
import express from 'express';

export function resolveTransferenciaStorageDir({ projectDir, env = process.env } = {}) {
  if (!projectDir) throw new Error('resolveTransferenciaStorageDir: falta projectDir');

  const explicitPath = String(env.TRANSFERENCIA_STORAGE_PATH || '').trim();
  if (explicitPath) return path.resolve(explicitPath);

  const diskPath = String(env.DISK_PATH || '').trim();
  if (diskPath) return path.join(path.resolve(diskPath), 'Transferencia');

  return path.join(path.resolve(projectDir), 'Transferencia');
}

export function requireTransferenciaStorageRole(req, res, next) {
  const role = String(req.user?.role || '').trim().toLowerCase();
  const type = String(req.user?.type || '').trim().toLowerCase();
  if ((type && type !== 'user') || !['admin', 'super'].includes(role)) {
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
  router.get('/:filename', withAuth, checkLicencia, requireTransferenciaStorageRole, async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!/^[A-Za-z0-9._-]+$/.test(filename) || path.basename(filename) !== filename) {
      return res.status(400).json({ error: 'Archivo inválido' });
    }

    try {
      const superUser = isSuper(req);
      const empresaId = Number(req.user?.empresa_id || 0);
      if (!superUser && (!Number.isInteger(empresaId) || empresaId <= 0)) {
        return res.status(403).json({ error: 'Sin empresa asociada' });
      }

      const tenantFilter = superUser ? '' : 'AND empresa_id = $2';
      const params = superUser ? [filename] : [filename, empresaId];
      const rows = await query(
        `SELECT id
           FROM comprobantes_transferencia
          WHERE empresa_id IS NOT NULL
            ${tenantFilter}
            AND (
              regexp_replace(COALESCE(archivo_path, ''), '^.*/', '') = $1
              OR regexp_replace(COALESCE(comprobante_path, ''), '^.*/', '') = $1
            )
          LIMIT 1`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Archivo no encontrado' });

      res.set('X-Content-Type-Options', 'nosniff');
      return res.download(path.join(storageDir, filename), filename);
    } catch (error) {
      console.error('[Transferencia storage] Error autorizando archivo:', error);
      return res.status(500).json({ error: 'Error obteniendo archivo' });
    }
  });
  return router;
}
