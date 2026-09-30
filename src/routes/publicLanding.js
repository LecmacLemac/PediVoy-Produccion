// src/routes/publicLanding.js
// Rutas públicas para landings (sin auth)

import express from 'express';
import {
  assertPublicPedidoEmpresaActive,
  resolvePublicPedidoEmpresaId,
} from '../services/publicPedidoTenant.js';
import { normalizePhone } from '../services.js';
import {
  lockGeneralPhoneIdentity,
  resolveTenantDeliveryPointByPhone,
} from '../services/deliveryPointIdentity.js';

export function createPublicLandingRouter(deps) {
  const { query, withTransaction } = deps || {};
  if (typeof query !== 'function') throw new Error('createPublicLandingRouter: falta query(fn)');
  if (typeof withTransaction !== 'function') throw new Error('createPublicLandingRouter: falta withTransaction(fn)');
  const runInTransaction = withTransaction;

  const router = express.Router();

  function publicTenantFailure(res, error, fallback) {
    if (error?.code === 'TRANSACTION_OUTCOME_UNKNOWN') {
      return res.status(503).json({
        error: 'No se pudo confirmar la lectura',
        code: 'TRANSACTION_OUTCOME_UNKNOWN',
      });
    }
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({
      error: status < 500 ? error.message : fallback,
      ...(error?.code ? { code: error.code } : {}),
    });
  }

  // GET /api/public/config
  router.get('/config', async (req, res) => {
    try {
      const empresaId = await resolvePublicPedidoEmpresaId(req, query);
      const rows = await query(
        'SELECT id AS empresa_id, nombre, landing_slug FROM empresas WHERE id = $1 LIMIT 1',
        [empresaId]
      );
      const row = rows[0];
      if (!row || Number(row.empresa_id) !== empresaId) {
        const error = new Error('No se pudo resolver la empresa pública');
        error.code = 'PUBLIC_TENANT_UNRESOLVED';
        error.statusCode = 400;
        throw error;
      }
      return res.json(row);
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      return res.status(status).json({
        ...(status < 500 ? { error: e.message } : {}),
        ...(e?.code ? { code: e.code } : {}),
      });
    }
  });

  // GET /api/public/productos
  router.get('/productos', async (req, res) => {
    try {
      const empresaId = await resolvePublicPedidoEmpresaId(req, query);
      const scope = req.query?.scope; // 'landing' o null

      let sql = `
        SELECT id, nombre, descripcion, precio, imagen, imagen_promo, etiqueta, categoria
        FROM productos
        WHERE empresa_id = $1
          AND activo = true
      `;

      if (scope === 'landing') {
        sql += ` AND mostrar_en_landing = true`;
      }

      sql += ` ORDER BY orden ASC, id DESC`;

      const rows = await query(sql, [empresaId]);
      return res.json(rows);
    } catch (e) {
      console.error('Error public products:', e);
      return publicTenantFailure(res, e, 'Error cargando catálogo');
    }
  });

  // GET /api/public/pedidos/ultimo
  router.get('/pedidos/ultimo', async (req, res) => {
    try {
      const empresaId = await resolvePublicPedidoEmpresaId(req, query);
      const telefono = req.query?.telefono;

      if (!telefono) return res.status(400).json({ error: 'Datos incompletos' });

      const result = await runInTransaction(async txQuery => {
        await lockGeneralPhoneIdentity(txQuery, {
          normalizePhoneFn: normalizePhone,
          telefono,
        });
        await assertPublicPedidoEmpresaActive(txQuery, empresaId);
        const identity = await resolveTenantDeliveryPointByPhone(txQuery, {
          empresaId,
          telefono,
          normalizePhoneFn: normalizePhone,
        });
        if (identity.status !== 'unique') return { identity, rows: [] };
        const rows = await txQuery(
          `
          SELECT p.id, p.estado, p.monto, p.fecha
          FROM pedidos p
          JOIN puntos_entrega pe
            ON pe.id = p.punto_entrega_id
           AND pe.empresa_id = p.empresa_id
          WHERE p.empresa_id = $1
            AND pe.empresa_id = $1
            AND p.punto_entrega_id = $2
          ORDER BY p.fecha DESC, p.id DESC LIMIT 1
          `,
          [empresaId, Number(identity.point.id)]
        );
        return { identity, rows };
      });
      if (result.identity.status === 'ambiguous') {
        return res.status(409).json({ error: 'Identidad de contacto ambigua', code: 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS' });
      }
      if (result.rows.length) return res.json(result.rows[0]);
      return res.json({});
    } catch (e) {
      if (e?.code !== 'TRANSACTION_OUTCOME_UNKNOWN') {
        console.error('PUBLIC LANDING LAST ORDER LOOKUP FAILED', { code: String(e?.code || 'UNKNOWN') });
      }
      return publicTenantFailure(res, e, 'Error buscando pedido');
    }
  });

  return router;
}
