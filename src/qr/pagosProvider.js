// src/qr/pagosProvider.js
/**
 * Proveedor de pagos genérico (stub).
 * Acá después vas a enchufar Mercado Pago, banco, etc.
 *
 * Este módulo NO conoce Express ni la base, solo el contrato con el proveedor.
 */

export async function crearPagoProveedor({ proveedor, credenciales, pedido, empresa }) {
  // TODO: reemplazar por integración real (MP, banco, etc.)
  // Por ahora devolvemos un pago "fake" que sirve para probar el flujo end-to-end.

  const descripcion = `Pedido #${pedido.id} - ${pedido.clienteNombre || ''}`.trim();

  // Simulamos que el proveedor nos da un id y una URL de cobro
  const fakePaymentId = `fake_${pedido.id}_${Date.now()}`;
  const checkoutUrl = `https://pagos.ejemplo.com/pagar/${fakePaymentId}`;

  return {
    providerPaymentId: fakePaymentId,
    checkoutUrl,
    // El QR codifica este valor. En un proveedor real podría ser un payload EMVCo.
    qrPayload: checkoutUrl,
    moneda: 'ARS',
    descripcion
  };
}
