import { query } from '../db.js';
import { isSuper } from './auth.js';
import { getEmpresaIdFromToken } from './tenant.js';

export async function checkLicencia(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    if (isSuper(req)) return next();

    const empresaId = getEmpresaIdFromToken(req);
    if (!empresaId) {
      return res.status(400).json({ error: 'Sin empresa asociada' });
    }

    const rows = await query(
      `SELECT plan_estado, plan_vencimiento
         FROM empresas
        WHERE id = $1`,
      [empresaId]
    );

    if (!rows.length) {
      return res.status(403).json({ error: 'Empresa no encontrada' });
    }

    const { plan_estado, plan_vencimiento } = rows[0];

    const ahoraMs = Date.now();
    const vencMs = plan_vencimiento ? new Date(plan_vencimiento).getTime() : null;

    const vencida = plan_estado === 'expired' || (vencMs !== null && vencMs < ahoraMs);

    if (vencida) {
      return res.status(402).json({
        error: 'licencia_vencida',
        message: '⛔ Tu licencia ha vencido. Realizá el pago para reactivar el servicio.',
        redirect: '/pedidos/inicio/licencia.html'
      });
    }

    return next();
  } catch (e) {
    console.error('Error en checkLicencia:', e);
    return res.status(500).json({ error: 'Error al validar licencia' });
  }
}
