import path from 'node:path';

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
