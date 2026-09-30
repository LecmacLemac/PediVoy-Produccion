export function requireCanonicalBackofficeRole(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'super') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return next();
}

requireCanonicalBackofficeRole.canonicalBackofficeGuard = true;