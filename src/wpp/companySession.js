import path from 'node:path';

const COMPANY_SESSION_DIR_PATTERN = /^session-empresa_[1-9]\d*$/;
const CHROMIUM_SINGLETON_NAMES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

export function getCompanySessionPaths({ empresaId, env = process.env, cwd = process.cwd() } = {}) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError('empresaId must be a positive integer');
  const configured = env.EMPRESA_WPP_SESSION_PATH || env.DISK_PATH || env.WPP_SESSION_PATH || 'wpp_sessions';
  const basePath = path.resolve(cwd, configured);
  const sessionDir = path.join(basePath, `session-empresa_${id}`);
  return {
    basePath,
    dataPath: basePath,
    sessionDir,
    devToolsActivePortFile: path.join(sessionDir, 'DevToolsActivePort'),
  };
}

export function clearStaleCompanyChromiumSingletons({
  env = process.env,
  cwd = process.cwd(),
  fs,
  logger = console,
} = {}) {
  if (env.EMPRESA_WPP_CLEAR_STALE_SINGLETONS_ON_BOOT !== '1') {
    return { enabled: false, removed: [] };
  }
  if (!fs) throw new TypeError('fs is required');

  const { basePath } = getCompanySessionPaths({ empresaId: 1, env, cwd });
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(basePath, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !COMPANY_SESSION_DIR_PATTERN.test(entry.name)) continue;
    for (const singletonName of CHROMIUM_SINGLETON_NAMES) {
      const relativePath = path.join(entry.name, singletonName);
      const targetPath = path.join(basePath, relativePath);
      try {
        fs.lstatSync(targetPath);
        fs.unlinkSync(targetPath);
        removed.push(relativePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger.warn?.('[WPP EMPRESA] stale Chromium singleton cleanup skipped:', {
            path: relativePath,
            code: error?.code || 'UNKNOWN',
          });
        }
      }
    }
  }

  logger.info?.('[WPP EMPRESA] stale Chromium singleton cleanup:', {
    count: removed.length,
    paths: removed,
  });
  return { enabled: true, removed };
}
