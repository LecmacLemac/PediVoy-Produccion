export function getServerEnv() {
  const port = Number(process.env.PORT || 3000);
  const NODE_ENV = process.env.NODE_ENV || 'development';

  return {
    PORT: Number.isFinite(port) && port > 0 ? port : 3000,
    NODE_ENV,
  };
}

export function assertProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;

  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'dev' || secret.length < 32) {
    console.error('🔴 ERROR FATAL: JWT_SECRET inseguro en producción.');
    process.exit(1);
  }

  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').trim();
  const localHttpDev = String(process.env.LOCAL_HTTP_DEV || '').toLowerCase() === 'true';
  if (!publicBaseUrl && localHttpDev) return;
  try {
    const parsed = new URL(publicBaseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const loopback = hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    const transportAllowed = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && localHttpDev && loopback);
    if (!publicBaseUrl || !transportAllowed || parsed.username || parsed.password) {
      throw new Error('invalid origin');
    }
  } catch {
    console.error('[security] PUBLIC_BASE_URL/APP_PUBLIC_URL ausente o inválida en producción. Inicio abortado.');
    process.exit(1);
  }
}
