// src/mercadoPagoService.js
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

// ----------------------------------------------------------------------
// 1. Configuración Inicial del Cliente
// ----------------------------------------------------------------------
// Usamos las credenciales cargadas en las variables de entorno de Render.
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MP_ACCESS_TOKEN, 
  options: {
    timeout: 5000,
    // El Client ID (App ID) se usa aquí como 'integratorId' para seguimiento interno
    integratorId: process.env.MP_CLIENT_ID 
  }
});

/**
 * Genera un link de pago único para que una empresa pague su licencia.
 * @param {Object} data - Datos de la empresa y precio.
 * @returns {Promise<string>} - URL de pago (init_point).
 */
export async function crearPreferenciaLicencia({ empresaId, nombreEmpresa, precio, email }) {
  try {
    const preference = new Preference(client);

    const webhookUrl = process.env.MP_WEBHOOK_URL; 
    
    // URL base de tu frontend para redirigir al usuario tras pagar
    const baseUrl = process.env.APP_BASE_URL || 'https://pedivoy.com';

    const result = await preference.create({
      body: {
        // Detalle de lo que se cobra
        items: [
          {
            id: `LIC-${empresaId}`,
            title: `Renovación de Servicio - ${nombreEmpresa}`,
            description: 'Licencia de uso mensual del sistema de gestión',
            quantity: 1,
            unit_price: Number(precio),
            currency_id: 'ARS'
          }
        ],
        // Datos del pagador (para pre-llenar formulario)
        payer: {
          email: email || 'empresa@cliente.com'
        },
        // REFERENCIA CLAVE: Esto nos permite saber QUIÉN pagó cuando llegue el aviso
        external_reference: String(empresaId),
        
        // Configuración de notificaciones automáticas
        notification_url: webhookUrl,
        
        // A dónde vuelve el usuario según el resultado
        back_urls: {
          // Ajustamos la ruta para que vuelva a TU archivo específico
          success: `${baseUrl}/pedidos/inicio/licencia.html?status=approved`,
          failure: `${baseUrl}/pedidos/inicio/licencia.html?status=failure`,
          pending: `${baseUrl}/pedidos/inicio/licencia.html?status=pending`
        },
        auto_return: 'approved', // Vuelve automático a tu web si se aprueba
        
        // Opcional: Expiración del link (ej: 24 horas)
        // expires: true,
        // date_of_expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      }
    });

    // Retornamos el link de pago (init_point)
    return result.init_point;

  } catch (error) {
    console.error('[MercadoPago] Error creando preferencia:', error);
    throw new Error('No se pudo generar el link de pago.');
  }
}

/**
 * Consulta el estado actualizado de un pago específico.
 * Se usa dentro del Webhook para verificar que el pago sea real y esté "approved".
 * @param {string|number} paymentId - ID del pago que envía Mercado Pago.
 */
export async function obtenerPago(paymentId) {
  try {
    const payment = new Payment(client);
    const datosPago = await payment.get({ id: paymentId });
    return datosPago;
  } catch (error) {
    console.error('[MercadoPago] Error consultando pago:', error);
    throw error;
  }
}