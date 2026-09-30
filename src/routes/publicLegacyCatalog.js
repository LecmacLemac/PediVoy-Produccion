import express from 'express';
import crypto from 'node:crypto';
import { normalizePhone } from '../services.js';
import {
  assertPublicPedidoEmpresaActive,
  resolvePublicPedidoEmpresaId,
} from '../services/publicPedidoTenant.js';
import {
  lockGeneralPhoneIdentity,
  resolveTenantDeliveryPointByPhone,
} from '../services/deliveryPointIdentity.js';

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

async function getLocationFromIp(req) {
  let pais = 'Argentina';
  let provincia = 'Córdoba';

  const ip = getClientIp(req);
  if (!ip || ip === '::1' || ip.startsWith('127.')) return { pais, provincia };

  try {
    const resp = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!resp.ok) return { pais, provincia };

    const data = await resp.json();
    if (data.country_name) pais = data.country_name;
    if (data.region) provincia = data.region;
    return { pais, provincia };
  } catch {
    return { pais, provincia };
  }
}

function parseMaybeJson(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

async function resolveLocationForEmpresa(req, empresaRow) {
  const opCfg = parseMaybeJson(empresaRow?.config_operativa);
  const cfgPais = String(opCfg?.pais || '').trim();
  const cfgProvincia = String(opCfg?.provincia || '').trim();

  if (cfgPais || cfgProvincia) {
    return {
      pais: cfgPais || 'Argentina',
      provincia: cfgProvincia || 'Córdoba',
    };
  }

  return getLocationFromIp(req);
}

export function createPublicLegacyCatalogRouter({ query, withTransaction }) {
  if (typeof query !== 'function') throw new Error('createPublicLegacyCatalogRouter: falta query(fn)');
  if (typeof withTransaction !== 'function') throw new Error('createPublicLegacyCatalogRouter: falta withTransaction(fn)');
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

  router.get('/config', async (req, res) => {
    try {
      const empresaId = await resolvePublicPedidoEmpresaId(req, query);
      const rows = await query(
        `SELECT id, nombre, config_operativa, landing_domain, landing_slug, logo_url
         FROM empresas
         WHERE id = $1
         LIMIT 1`,
        [empresaId]
      );
      const row = rows[0];
      if (!row || Number(row.id) !== empresaId) {
        const error = new Error('No se pudo resolver la empresa pública');
        error.code = 'PUBLIC_TENANT_UNRESOLVED';
        error.statusCode = 400;
        throw error;
      }

      const loc = await resolveLocationForEmpresa(req, row);
      const nombre_empresa = row.nombre ? String(row.nombre) : null;
      return res.json({
        empresa_id: Number(row.id),
        nombre_empresa,
        nombre: nombre_empresa,
        landing_domain: row.landing_domain || null,
        landing_slug: row.landing_slug || null,
        logo_url: row.logo_url || null,
        ...loc,
      });
    } catch (e) {
      console.error('PUBLIC CONFIG ERROR', e);
      const status = Number(e?.statusCode) || 500;
      return res.status(status).json({
        error: status < 500 ? e.message : 'No se pudo resolver la empresa',
        ...(e?.code ? { code: e.code } : {}),
      });
    }
  });

  router.get('/empresa', async (req, res) => {
    try {
      const empresaId = await resolvePublicPedidoEmpresaId(req, query);

      const rows = await query(
        `SELECT id, nombre, razon_social, cuit, direccion, ciudad, provincia, pais, telefono, email
         FROM empresas
         WHERE id = $1
         LIMIT 1`,
        [empresaId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Empresa no encontrada' });
      return res.json(rows[0]);
    } catch (err) {
      console.error('PUBLIC EMPRESA ERROR', err);
      return publicTenantFailure(res, err, 'Error al obtener datos de empresa');
    }
  });

  router.get('/productos', async (req, res) => {
    try {
      const empresa_id = await resolvePublicPedidoEmpresaId(req, query);
      const scope = req.query.scope || 'all';
      const soloDestacados = req.query.destacado === 'true';

      let sql = `
        SELECT id, nombre, precio, descripcion, imagen, imagen_promo, categoria, etiqueta, destacado
        FROM productos
        WHERE empresa_id = $1
          AND COALESCE(activo, true)
      `;

      if (scope === 'landing') sql += ` AND mostrar_en_landing = true`;
      else if (scope === 'catalog') sql += ` AND mostrar_en_catalogo = true`;
      if (soloDestacados) sql += ` AND destacado = true`;

      if (scope === 'landing') sql += ` ORDER BY etiqueta NULLS LAST, precio ASC`;
      else sql += ` ORDER BY categoria NULLS LAST, COALESCE(orden, id), nombre`;

      const rows = await query(sql, [empresa_id]);
      return res.json(rows);
    } catch (e) {
      console.error(e);
      return publicTenantFailure(res, e, 'No se pudieron obtener productos');
    }
  });

  router.get('/contacto', async (req, res) => {
    try {
      const empresa_id = await resolvePublicPedidoEmpresaId(req, query);
      const telefonoNorm = normalizePhone(req.query.telefono);
      if (!telefonoNorm) return res.status(400).json({ error: 'telefono requerido' });

      const result = await runInTransaction(async txQuery => {
        await lockGeneralPhoneIdentity(txQuery, {
          normalizePhoneFn: normalizePhone,
          telefono: req.query.telefono,
        });
        await assertPublicPedidoEmpresaActive(txQuery, empresa_id);
        const identity = await resolveTenantDeliveryPointByPhone(txQuery, {
          empresaId: empresa_id,
          telefono: req.query.telefono,
          normalizePhoneFn: normalizePhone,
        });
        if (identity.status !== 'unique') return { identity, rows: [] };
        const rows = await txQuery(
          `SELECT id, cliente, telefono, direccion, ciudad, provincia, pais,
                  latitud, longitud, notas, zona_id
           FROM puntos_entrega
           WHERE empresa_id = $1 AND id = $2`,
          [empresa_id, Number(identity.point.id)]
        );
        return { identity, rows };
      });
      if (result.identity.status === 'ambiguous') {
        return res.status(409).json({ error: 'Identidad de contacto ambigua', code: 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS' });
      }
      if (result.identity.status === 'none' || !result.rows.length) {
        return res.json({ ok: true, found: false });
      }
      return res.json({ ok: true, found: true, contacto: result.rows[0] });
    } catch (e) {
      if (e?.code !== 'TRANSACTION_OUTCOME_UNKNOWN') {
        console.error('PUBLIC CONTACT LOOKUP FAILED', { code: String(e?.code || 'UNKNOWN') });
      }
      return publicTenantFailure(res, e, 'No se pudo buscar el contacto');
    }
  });

  router.get('/ultimo-pedido', async (req, res) => {
    try {
      const telefonoIn = String(req.query.telefono || '').trim();
      if (!telefonoIn || !normalizePhone(telefonoIn)) {
        return res.status(400).json({ error: 'telefono requerido', code: 'PUBLIC_PHONE_REQUIRED' });
      }
      const empresa_id = await resolvePublicPedidoEmpresaId(req, query);
      let contactoId = null;
      if (req.query.contacto_id !== undefined) {
        const rawContactoId = req.query.contacto_id;
        if (typeof rawContactoId !== 'string' || !/^[1-9]\d*$/.test(rawContactoId)) {
          return res.status(400).json({ error: 'contacto_id inválido', code: 'PUBLIC_CONTACT_ID_INVALID' });
        }
        contactoId = Number(rawContactoId);
        if (!Number.isSafeInteger(contactoId)) {
          return res.status(400).json({ error: 'contacto_id inválido', code: 'PUBLIC_CONTACT_ID_INVALID' });
        }
      }

      const result = await runInTransaction(async txQuery => {
        await lockGeneralPhoneIdentity(txQuery, {
          normalizePhoneFn: normalizePhone,
          telefono: telefonoIn,
        });
        await assertPublicPedidoEmpresaActive(txQuery, empresa_id);
        const identity = await resolveTenantDeliveryPointByPhone(txQuery, {
          empresaId: empresa_id,
          telefono: telefonoIn,
          normalizePhoneFn: normalizePhone,
        });
        const identityStatus = identity.status;
        if (identity.status !== 'unique') return { identityStatus, pedRows: [] };

        const punto_entrega_id = Number(identity.point.id);
        if (contactoId !== null && contactoId !== punto_entrega_id) {
          const error = new Error('contacto_id no coincide con la identidad telefónica');
          error.code = 'PUBLIC_CONTACT_ID_CONFLICT';
          error.statusCode = 403;
          throw error;
        }

        let pedRows = await txQuery(
          `SELECT p.id, p.estado, p.fecha, p.tracking_token
           FROM pedidos p
           JOIN puntos_entrega pe
             ON pe.id = p.punto_entrega_id
            AND pe.empresa_id = p.empresa_id
           WHERE p.punto_entrega_id = $1
             AND p.empresa_id = $2
             AND pe.empresa_id = $2
           ORDER BY p.fecha DESC, p.id DESC
           LIMIT 1`,
          [punto_entrega_id, empresa_id]
        );

        if (pedRows.length && !pedRows[0].tracking_token) {
          const tokenRows = await txQuery(
            `UPDATE pedidos
                SET tracking_token = COALESCE(tracking_token, $1)
              WHERE id = $2 AND empresa_id = $3
              RETURNING tracking_token`,
            [crypto.randomBytes(16).toString('hex'), pedRows[0].id, empresa_id]
          );
          pedRows = [{ ...pedRows[0], tracking_token: tokenRows[0]?.tracking_token || null }];
        }
        return { identityStatus, pedRows };
      });

      if (result.identityStatus === 'ambiguous') {
        return res.status(409).json({ error: 'Identidad de contacto ambigua', code: 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS' });
      }
      if (!result.pedRows.length) {
        return res.status(404).json({
          error: result.identityStatus === 'none' || (!contactoId && telefonoIn)
            ? 'contacto no encontrado'
            : 'no hay pedidos para este contacto',
        });
      }
      const [{ tracking_token: trackingToken, ...pedido }] = result.pedRows;
      pedido.tracking_url = trackingToken
        ? `/pedidos/seguimiento.html?t=${encodeURIComponent(trackingToken)}`
        : null;
      return res.json({ ok: true, pedido });
    } catch (e) {
      if (e?.code !== 'TRANSACTION_OUTCOME_UNKNOWN') {
        console.error('PUBLIC LAST ORDER LOOKUP FAILED', { code: String(e?.code || 'UNKNOWN') });
      }
      return publicTenantFailure(res, e, 'No se pudo buscar el último pedido');
    }
  });

  return router;
}
