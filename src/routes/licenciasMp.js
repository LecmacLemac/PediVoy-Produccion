// src/routes/licenciasMp.js
import express from 'express';

import { withAuth, enqueueWppMessage } from '../services.js';
import { pool } from '../db.js';

/**
 * Router: Licencias (Mercado Pago)
 * - POST /api/admin/licencia/generar-pago
 */
export function createLicenciasMpRouter({ crearPreferenciaLicencia }) {
  if (typeof crearPreferenciaLicencia !== 'function') {
    throw new Error('createLicenciasMpRouter requiere crearPreferenciaLicencia');
  }

  const router = express.Router();

  router.post('/generar-pago', withAuth, async (req, res) => {
    try {
      const empresaId = req.user.empresa_id;

      const client = await pool.connect();
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

          await enqueueWppMessage({
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
      console.error('[GENERAR PAGO ERROR]', e);
      return res.status(500).json({ error: 'Error interno generando el pago.' });
    }
  });

  return router;
}

/**
 * Router: Webhook Mercado Pago
 * - POST /api/webhooks/mercadopago
 */
export function createMercadoPagoWebhookRouter({ obtenerPago }) {
  if (typeof obtenerPago !== 'function') {
    throw new Error('createMercadoPagoWebhookRouter requiere obtenerPago');
  }

  const router = express.Router();

  router.post('/mercadopago', async (req, res) => {
    const { query, body } = req;

    const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
    if (MP_WEBHOOK_SECRET) {
      const providedSecret = query.secret || req.headers['x-mp-secret'];
      if (providedSecret !== MP_WEBHOOK_SECRET) {
        console.warn('⚠️ [WEBHOOK] Notificación rechazada: secreto inválido');
        return res.sendStatus(403);
      }
    }

    const topic = query.topic || query.type;

    let id = query.id || query['data.id'] || body?.data?.id;
    if (!id && query.data && query.data.id) {
      id = query.data.id;
    }

    console.log(`📩 [WEBHOOK] Tópico: ${topic} | ID: ${id}`);

    try {
      if (topic !== 'payment' || !id) {
        return res.sendStatus(200);
      }

      const pago = await obtenerPago(id);
      if (pago.status !== 'approved') {
        return res.sendStatus(200);
      }

      const externalRef = pago.external_reference || '';
      const montoPagado = pago.transaction_amount;
      const referenciaPago = String(id);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // PASO A: determinar empresa + tipo
        let empresaId = 0;
        let esAlquiler = false;

        if (externalRef.startsWith('ALQ')) {
          esAlquiler = true;
          const parts = externalRef.split('|');
          const empPart = parts.find((p) => p.startsWith('emp:'));
          if (empPart) empresaId = Number(empPart.split(':')[1]);
        } else {
          empresaId = Number(externalRef);
        }

        if (!Number.isInteger(empresaId) || empresaId <= 0) {
          console.error(`❌ [WEBHOOK] ID de empresa inválido en referencia: ${externalRef}`);
          await client.query('ROLLBACK');
          return res.sendStatus(200);
        }

        // PASO B: idempotencia
        try {
          await client.query(
            `
            INSERT INTO historial_pagos (empresa_id, monto, referencia, fecha, metodo, estado)
            VALUES ($1, $2, $3, NOW(), 'mercadopago', 'approved')
            `,
            [empresaId, montoPagado, referenciaPago]
          );
        } catch (e) {
          // Ya procesado
          if (e?.code === '23505') {
            await client.query('ROLLBACK');
            return res.sendStatus(200);
          }
          throw e;
        }

        // PASO C: lógica según tipo
        if (esAlquiler) {
          const parts = externalRef.split('|');
          const cliStr = parts.find((p) => p.startsWith('cli:'))?.split(':')[1];
          const perStr = parts.find((p) => p.startsWith('per:'))?.split(':')[1];

          if (cliStr && perStr) {
            const [mes, anio] = perStr.split('/');
            const periodoDate = `${anio}-${mes}-01`;
            const clienteId = Number(cliStr);

            await client.query(
              `
              UPDATE empresa_activos_alquileres
                 SET estado = 'cobrado',
                     ultimo_pago_fecha = NOW(),
                     ultimo_pago_monto = $4,
                     updated_at = NOW()
               WHERE empresa_id = $1
                 AND cliente_id = $2
                 AND periodo = $3::date
              `,
              [empresaId, clienteId, periodoDate, montoPagado]
            );
          }

        } else {
          const { rows } = await client.query(
            `
            UPDATE empresas
               SET plan_estado = 'active',
                   plan_vencimiento = CASE
                     WHEN plan_vencimiento > NOW() THEN plan_vencimiento + INTERVAL '30 days'
                     ELSE NOW() + INTERVAL '30 days'
                   END
             WHERE id = $1
             RETURNING id, nombre, plan_vencimiento, telefono
            `,
            [empresaId]
          );

          if (!rows.length) {
            throw new Error(`Empresa ID ${empresaId} no encontrada para actualizar licencia.`);
          }

          const emp = rows[0];
          if (emp.telefono) {
            const nuevaFecha = new Date(emp.plan_vencimiento).toLocaleDateString('es-AR');
            const msgExito =
              `✅ *¡Pago de Licencia Acreditado!*\n\n` +
              `Tu servicio ha sido renovado correctamente.\n` +
              `📅 *Nuevo Vencimiento:* ${nuevaFecha}\n\n` +
              `Gracias por confiar en nosotros. 🚀`;

            await enqueueWppMessage({
              phone: emp.telefono,
              message: msgExito,
              empresa_id: empresaId
            });
          }
        }

        await client.query('COMMIT');
        return res.sendStatus(200);

      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error('WEBHOOK MP ERROR:', e);
        return res.sendStatus(200); // MP reintenta; pero preferimos idempotencia con historial_pagos
      } finally {
        client.release();
      }

    } catch (e) {
      console.error('WEBHOOK MP ERROR OUTER:', e);
      return res.sendStatus(200);
    }
  });

  return router;
}
