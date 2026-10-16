import { fileURLToPath } from 'node:url';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';

const manualFile = fileURLToPath(new URL('../views/company-manual.html', import.meta.url));

// Keep the document outside public static directories: direct URLs require auth too.
export function registerCompanyManual(app, { withAuth }) {
  app.get('/pedidos/ayuda', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  }, withAuth, requireCanonicalBackofficeRole, (_req, res) => {
    res.sendFile(manualFile);
  });
}
