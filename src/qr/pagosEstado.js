// src/qr/pagosEstado.js

/**
 * Estados canónicos internos para pedido_pagos.estado
 *
 * - pendiente
 * - pagado
 * - rechazado
 * - expired
 * - anulado
 */
const CANON = new Set(['pendiente', 'pagado', 'rechazado', 'expired', 'anulado']);

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Normaliza un estado del proveedor a un estado canónico interno.
 *
 * @param {object} args
 * @param {string} args.proveedor
 * @param {string|null} args.providerStatus
 * @param {string|null} args.nuevoEstado
 */
export function normalizePagoEstado({ proveedor, providerStatus = null, nuevoEstado = null }) {
  const prov = norm(proveedor);
  const st = norm(providerStatus || nuevoEstado);

  // Mercado Pago (y similares)
  if (prov === 'mercado_pago' || prov === 'mercadopago' || prov === 'mp') {
    if (st === 'approved') return 'pagado';
    if (['pending', 'in_process', 'in_mediation', 'authorized'].includes(st)) return 'pendiente';
    if (['rejected', 'cancelled', 'canceled', 'refused', 'charged_back'].includes(st)) return 'rechazado';
    if (st === 'expired') return 'expired';
  }

  // Fake/dev
  if (prov === 'fake') {
    if (['approved', 'paid', 'pagado'].includes(st)) return 'pagado';
    if (['pending', 'pendiente', 'in_process'].includes(st)) return 'pendiente';
    if (['rejected', 'rechazado', 'cancelled', 'canceled'].includes(st)) return 'rechazado';
    if (st === 'expired') return 'expired';
  }

  // Fallback genérico (si ya viene canónico)
  if (CANON.has(st)) return st;

  // Si no sabemos, devolvemos null para que el webhook pueda rechazar/registrar
  return null;
}
