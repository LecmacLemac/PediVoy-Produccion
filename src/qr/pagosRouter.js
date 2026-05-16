// src/adm/pagosRouter.js
import { Router } from 'express';
import { withAuth, isSuper, checkLicencia, resolveEmpresaId } from '../services.js';
import { crearPagoParaPedido, listarPagosPorPedido } from '../qr/pagosService.js';

const router = Router();

// Todas estas rutas requieren auth + licencia activa
router.use(withAuth, checkLicencia);

// Permisos mínimos: evitar que repartidores/roles limitados generen links de cobro
router.use((req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'repartidor') {
    return res.status(403).json({ error: 'No autorizado.' });
  }
  // Permitimos super + admins/usuarios de backoffice (por ahora cualquier no-repartidor)
  return next();
});

/**
 * Lista pagos para un pedido.
 *
 * GET /api/admin/qr/pedidos/:pedidoId/pagos
 */
router.get('/pedidos/:pedidoId/pagos', async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (!isSuper(req) && role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado.' });
    }

    const pedidoId = Number(req.params.pedidoId);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ error: 'pedidoId inválido' });
    }

    const empresaId = resolveEmpresaId(req);
    if (!empresaId || !Number.isInteger(empresaId) || empresaId <= 0) {
      return res.status(400).json({ error: 'empresa_id inválido' });
    }

    const pagos = await listarPagosPorPedido({ pedidoId, empresaId });
    return res.json(pagos);
  } catch (err) {
    console.error('Error listando pagos de pedido', err);
    return res.status(500).json({ error: 'Error interno' });
  }
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
