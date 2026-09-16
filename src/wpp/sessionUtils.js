export const WPP_SESSION_ID = 'server_session_hidro';

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getWppSessionBasePath({ path, cwd = process.cwd() }) {
  return process.env.WPP_SESSION_PATH || process.env.DISK_PATH || path.join(cwd, '.wwebjs_auth');
}

export function getWppSessionDir({ path, cwd = process.cwd(), sessionId = WPP_SESSION_ID }) {
  return path.join(getWppSessionBasePath({ path, cwd }), `session-${sessionId}`);
}

export function safeErrorString(err) {
  if (!err) return null;
  return String(err)
    .replace(/'/g, "''")
    .replace(/\\/g, '\\\\')
    .slice(0, 200);
}
