export function getServerEnv() {
  const port = Number(process.env.PORT || 3000);
  const NODE_ENV = process.env.NODE_ENV || 'development';

  return {
    PORT: Number.isFinite(port) && port > 0 ? port : 3000,
    NODE_ENV,
  };
}

export function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function parseCanonicalPublicOrigin(value, { allowLoopbackHttp = false } = {}) {
  const configured = String(value || '');
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    const transportAllowed = parsed.protocol === 'https:'
      || (parsed.protocol === 'http:' && allowLoopbackHttp && isLoopbackHostname(parsed.hostname));
    if (!transportAllowed || parsed.username || parsed.password || configured !== parsed.origin) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function assertProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;

  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'dev' || secret.length < 32) {
    console.error('🔴 ERROR FATAL: JWT_SECRET inseguro en producción.');
    process.exit(1);
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '';
  const localHttpDev = String(process.env.LOCAL_HTTP_DEV || '').toLowerCase() === 'true';
  if (!parseCanonicalPublicOrigin(publicBaseUrl, { allowLoopbackHttp: localHttpDev })) {
    console.error('[security] PUBLIC_BASE_URL/APP_PUBLIC_URL ausente o inválida en producción. Inicio abortado.');
    process.exit(1);
  }
}
