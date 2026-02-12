// src/adm/pagosRouter.js
import { Router } from 'express';
import { withAuth, isSuper, checkLicencia, resolveEmpresaId } from '../services.js';
import { crearPagoParaPedido } from '../qr/pagosService.js';

const router = Router();

// Todas estas rutas requieren auth + licencia activa
router.use(withAuth, checkLicencia);

// Opcional: si querés que solo los super/admin usen esto:
router.use((req, res, next) => {
  // Si querés limitar solo a super:
  // if (!isSuper(req)) return res.status(403).json({ error: 'No autorizado.' });
  next();
});

/**
 * Crea (o reutiliza) un link de pago + QR para un pedido.
 *
 * POST /api/admin/qr/pedidos/:pedidoId/link
 */
router.post('/pedidos/:pedidoId/link', async (req, res) => {
  try {
    const pedidoId = Number(req.params.pedidoId);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ error: 'pedidoId inválido' });
    }

    // Empresa del usuario autenticado:
    // - Si es súper admin puede pasar ?empresa_id o body.empresa_id
    // - Si no, se toma la empresa del token
    const empresaId = resolveEmpresaId(req);
    if (!empresaId || !Number.isInteger(empresaId) || empresaId <= 0) {
      return res.status(400).json({ error: 'empresa_id inválido' });
    }

    const { venceEnHoras, canal, metodoPago } = req.body || {};

    const pago = await crearPagoParaPedido(
      { pedidoId, empresaId },
      {
        venceEnHoras,
        canal: canal || 'admin_panel',
        metodoPago: metodoPago || 'qr_dinamico'
      }
    );

    return res.json({
      id: pago.id,
      estado: pago.estado,
      monto: pago.monto,
      moneda: pago.moneda,
      checkout_url: pago.checkout_url,
      qr_payload: pago.qr_payload,
      vence_at: pago.vence_at,
      proveedor: pago.proveedor
    });
  } catch (err) {
    console.error('Error creando pago para pedido', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'Error interno' });
  }
});

export default router;
