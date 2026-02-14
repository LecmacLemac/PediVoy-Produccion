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
}
