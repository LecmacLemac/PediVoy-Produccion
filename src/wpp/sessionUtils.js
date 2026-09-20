export const WPP_SESSION_ID = 'server_session_hidro';

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getWppSessionBasePath({ path, cwd = process.cwd() }) {
  return process.env.WPP_SESSION_PATH || process.env.DISK_PATH || path.join(cwd, '.wwebjs_auth');
}

export function getWppSessionDir({ path, cwd = process.cwd(), sessionId = WPP_SESSION_ID }) {
  return path.join(getWppSessionBasePath({ path, cwd }), `session-${sessionId}`);
}

export function removeChromiumSingletonLocks({ fs, path, sessionDir, logger = console } = {}) {
  if (!fs || !path || !sessionDir) return [];
  const removed = [];
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const target = path.join(sessionDir, name);
    try {
      fs.rmSync(target, { force: true, recursive: true });
      removed.push(name);
    } catch (error) {
      logger.warn?.('[WPP] could not remove Chromium singleton lock:', target, error);
    }
  }
  return removed;
}

export function safeErrorString(err) {
  if (!err) return null;
  return String(err)
    .replace(/'/g, "''")
    .replace(/\\/g, '\\\\')
    .slice(0, 200);
}
