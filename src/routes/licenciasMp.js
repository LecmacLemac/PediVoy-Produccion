// src/routes/licenciasMp.js
import express from 'express';

import { withAuth, enqueueWppMessage } from '../services.js';
import { pool, withTransaction as canonicalWithTransaction } from '../db.js';
import { requireCanonicalBackofficeRole } from './canonicalBackofficeRole.js';
import { requireSharedSecret } from './secretGuard.js';

/**
 * Router: Licencias (Mercado Pago)
 * - POST /api/admin/licencia/generar-pago
 */
export function createLicenciasMpRouter({
  crearPreferenciaLicencia,
  withAuth: withAuthFn = withAuth,
  pool: dbPool = pool,
  enqueueWppMessage: enqueueMessage = enqueueWppMessage,
}) {
  if (typeof crearPreferenciaLicencia !== 'function') {
    throw new Error('createLicenciasMpRouter requiere crearPreferenciaLicencia');
  }

  const router = express.Router();

  router.post('/generar-pago', withAuthFn, requireCanonicalBackofficeRole, async (req, res) => {
    try {
      const requestedEmpresaId = req.user.role === 'super' ? req.body?.empresa_id : req.user.empresa_id;
      const empresaId = Number(requestedEmpresaId);
      if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
        return res.status(400).json({ error: 'Empresa inválida' });
      }

      const client = await dbPool.connect();
      try {
        const { rows } = await client.query(
          'SELECT nombre, telefono, email, plan_precio FROM empresas WHERE id = $1',
          [empresaId]
        );

        if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });

        const emp = rows[0];
        const precio = Number(emp.plan_precio);

        if (!precio || precio <= 0) {
          return res.status(400).json({
            error: 'Tu plan no tiene un precio configurado. Por favor contacta a soporte.'
          });
        }

        const linkPago = await crearPreferenciaLicencia({
          empresaId,
          nombreEmpresa: emp.nombre,
          precio,
          email: emp.email
        });

        if (emp.telefono) {
          const msg =
            `👋 Hola *${emp.nombre}*.\n\n` +
            `Para reactivar o renovar tu licencia de uso, por favor realizá el pago en el siguiente link:\n\n` +
            `🔗 ${linkPago}\n\n` +
            `💰 Monto: $${precio}\n` +
            `⏳ El sistema se activará automáticamente apenas se acredite el pago.`;

          await enqueueMessage({
            phone: emp.telefono,
            message: msg,
            empresa_id: empresaId
          });
        }

        return res.json({ ok: true, message: 'Link enviado por WhatsApp', link: linkPago });
      } finally {
        client.release();
      }

    } catch (e) {
      console.error('[GENERAR PAGO ERROR] operación fallida');
      return res.status(500).json({ error: 'Error interno generando el pago.' });
    }
  });

  return router;
}

/**
 * Router: Webhook Mercado Pago
 * - POST /api/webhooks/mercadopago
 */
export function createMercadoPagoWebhookRouter({
  obtenerPago,
  pool: dbPool = pool,
  withTransaction = canonicalWithTransaction,
  enqueueWppMessage: enqueueMessage = enqueueWppMessage,
}) {
  if (typeof obtenerPago !== 'function') {
    throw new Error('createMercadoPagoWebhookRouter requiere obtenerPago');
  }
  if (typeof withTransaction !== 'function') {
    throw new Error('createMercadoPagoWebhookRouter requiere withTransaction');
  }

  const router = express.Router();

  router.post('/mercadopago', async (req, res) => {
    const { query, body } = req;

    if (!requireSharedSecret({
      expected: process.env.MP_WEBHOOK_SECRET,
      provided: query.secret || req.headers['x-mp-secret'],
      res,
    })) return;

    const topic = query.topic || query.type;
    let id = query.id || query['data.id'] || body?.data?.id;
    if (!id && query.data && query.data.id) id = query.data.id;

    try {
      if (topic !== 'payment' || !id) return res.sendStatus(200);

      const pago = await obtenerPago(id);
      if (pago.status !== 'approved') return res.sendStatus(200);

      const externalRef = pago.external_reference || '';
      const montoPagado = pago.transaction_amount;
      const referenciaPago = String(id);

      let notification = null;
      try {
        const outcome = await withTransaction(async txQuery => {
          let empresaId = 0;
          let esAlquiler = false;

          if (externalRef.startsWith('ALQ')) {
            esAlquiler = true;
            const parts = externalRef.split('|');
            const empPart = parts.find((part) => part.startsWith('emp:'));
            if (empPart) empresaId = Number(empPart.split(':')[1]);
          } else {
            empresaId = Number(externalRef);
          }

          if (!Number.isInteger(empresaId) || empresaId <= 0) {
            return { ignored: true, notification: null };
          }

          try {
            await txQuery(
              `INSERT INTO historial_pagos (empresa_id, monto, referencia, fecha, metodo, estado)
               VALUES ($1, $2, $3, NOW(), 'mercadopago', 'approved')`,
              [empresaId, montoPagado, referenciaPago]
            );
          } catch (error) {
            if (error?.code === '23505') return { ignored: true, notification: null };
            throw error;
          }

          if (esAlquiler) {
            const parts = externalRef.split('|');
            const cliStr = parts.find((part) => part.startsWith('cli:'))?.split(':')[1];
            const perStr = parts.find((part) => part.startsWith('per:'))?.split(':')[1];
            if (cliStr && perStr) {
              const [mes, anio] = perStr.split('/');
              const periodoDate = `${anio}-${mes}-01`;
              const clienteId = Number(cliStr);
              await txQuery(
                `UPDATE empresa_activos_alquileres
                    SET estado = 'cobrado', ultimo_pago_fecha = NOW(),
                        ultimo_pago_monto = $4, updated_at = NOW()
                  WHERE empresa_id = $1 AND cliente_id = $2 AND periodo = $3::date`,
                [empresaId, clienteId, periodoDate, montoPagado]
              );
            }
          } else {
            const rows = await txQuery(
              `UPDATE empresas
                  SET plan_estado = 'active',
                      plan_vencimiento = CASE
                        WHEN plan_vencimiento > NOW() THEN plan_vencimiento + INTERVAL '30 days'
                        ELSE NOW() + INTERVAL '30 days'
                      END
                WHERE id = $1
                RETURNING id, nombre, plan_vencimiento, telefono`,
              [empresaId]
            );
            if (rows.length !== 1) throw new Error('LICENSE_COMPANY_UPDATE_FAILED');

            const emp = rows[0];
            if (emp.telefono) {
              const nuevaFecha = new Date(emp.plan_vencimiento).toLocaleDateString('es-AR');
              notification = {
                phone: emp.telefono,
                message: `✅ *¡Pago de Licencia Acreditado!*\n\nTu servicio ha sido renovado correctamente.\n📅 *Nuevo Vencimiento:* ${nuevaFecha}\n\nGracias por confiar en nosotros. 🚀`,
                empresa_id: empresaId,
              };
            }
          }
          return { ignored: false, notification };
        }, { pool: dbPool, maxRetries: 0 });

        notification = outcome.notification;
        if (notification) {
          try { await enqueueMessage(notification); }
          catch { console.error('WEBHOOK MP: notificación poscommit fallida'); }
        }
        return res.sendStatus(200);
      } catch (error) {
        console.error('WEBHOOK_MP_PROCESSING_FAILED', { code: String(error?.code || 'INTERNAL_ERROR') });
        if (error?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
          return res.status(503).json({ error: 'processing_unavailable', code: 'TRANSACTION_OUTCOME_UNKNOWN' });
        }
        return res.status(503).json({ error: 'processing_unavailable' });
      }
    } catch {
      console.error('WEBHOOK MP ERROR OUTER: proveedor no disponible');
      return res.status(503).json({ error: 'provider_unavailable' });
    }
  });

  return router;
}
