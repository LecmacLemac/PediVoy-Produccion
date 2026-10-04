import express from 'express';
import crypto from 'node:crypto';
import { normalizePhone } from '../services.js';
import {
  assertPublicPedidoEmpresaActive,
  resolvePublicPedidoEmpresaId,
} from '../services/publicPedidoTenant.js';
import {
  lockGeneralPhoneIdentity,
  normalizeGeneralPhoneIdentity,
  resolveLatestTenantDeliveryPointByPhone,
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

function maskContactName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Cliente';
  const first = parts[0];
  const surnameInitial = parts[1] ? ` ${parts[1].charAt(0).toUpperCase()}.` : '';
  return `${first}${surnameInitial}`;
}

export function createPublicLegacyCatalogRouter({ query, withTransaction }) {
  if (typeof query !== 'function') throw new Error('createPublicLegacyCatalogRouter: falta query(fn)');
  if (typeof withTransaction !== 'function') throw new Error('createPublicLegacyCatalogRouter: falta withTransaction(fn)');
  const runInTransaction = withTransaction;

  const router = express.Router();
  const configuredContactLimit = Number(process.env.PUBLIC_CONTACT_RATE_LIMIT_MAX);
  const configuredContactWindow = Number(process.env.PUBLIC_CONTACT_RATE_LIMIT_WINDOW_MS);
  const contactRateLimitMax = Number.isInteger(configuredContactLimit) && configuredContactLimit > 0
    ? configuredContactLimit
    : 20;
  const contactRateLimitWindowMs = Number.isFinite(configuredContactWindow) && configuredContactWindow >= 1000
    ? configuredContactWindow
    : 5 * 60 * 1000;
  const configuredContactBucketCap = Number(process.env.PUBLIC_CONTACT_RATE_LIMIT_BUCKETS);
  const contactRateLimitBucketCap = Number.isInteger(configuredContactBucketCap) && configuredContactBucketCap > 0
    ? configuredContactBucketCap
    : 5000;
  const contactLookupBuckets = new Map();

  function consumeContactLookup(req, empresaId) {
    const now = Date.now();
    const key = `${empresaId}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const previous = contactLookupBuckets.get(key);
    const bucket = !previous || previous.resetAt <= now
      ? { count: 0, resetAt: now + contactRateLimitWindowMs }
      : previous;
    if (bucket.count >= contactRateLimitMax) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    if (!previous && contactLookupBuckets.size >= contactRateLimitBucketCap) {
      const oldestKey = contactLookupBuckets.keys().next().value;
      if (oldestKey !== undefined) contactLookupBuckets.delete(oldestKey);
    }
    contactLookupBuckets.delete(key);
    contactLookupBuckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, contactRateLimitMax - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

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

  router.post('/contacto', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      const empresa_id = await resolvePublicPedidoEmpresaId(req, query);
      const telefonoInput = req.body?.telefono;
      const telefonoNorm = normalizeGeneralPhoneIdentity(normalizePhone, telefonoInput);
      if (!telefonoNorm) {
        return res.status(400).json({ error: 'telefono inválido', code: 'PUBLIC_PHONE_INVALID' });
      }
      const rateLimit = consumeContactLookup(req, empresa_id);
      res.setHeader('X-RateLimit-Limit', String(contactRateLimitMax));
      res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining || 0));
      if (!rateLimit.allowed) {
        res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
        return res.status(429).json({
          error: 'Demasiadas consultas de contacto. Intentá nuevamente más tarde.',
          code: 'PUBLIC_CONTACT_RATE_LIMITED',
        });
      }

      const result = await runInTransaction(async txQuery => {
        await lockGeneralPhoneIdentity(txQuery, {
          normalizePhoneFn: normalizePhone,
          telefono: telefonoInput,
        });
        await assertPublicPedidoEmpresaActive(txQuery, empresa_id);
        let identity = await resolveTenantDeliveryPointByPhone(txQuery, {
          empresaId: empresa_id,
          telefono: telefonoInput,
          normalizePhoneFn: normalizePhone,
        });
        if (identity.status === 'ambiguous') {
          identity = await resolveLatestTenantDeliveryPointByPhone(txQuery, {
            empresaId: empresa_id,
            telefono: telefonoInput,
            normalizePhoneFn: normalizePhone,
          });
        }
        if (identity.status !== 'unique') return { identity, rows: [] };
        const rows = await txQuery(
          `SELECT id, cliente, direccion, ciudad, provincia, pais
           FROM puntos_entrega
           WHERE empresa_id = $1 AND id = $2`,
          [empresa_id, Number(identity.point.id)]
        );
        const noteRows = rows.length ? await txQuery(
          `SELECT notas
             FROM pedidos
            WHERE empresa_id = $1
              AND punto_entrega_id = $2
            ORDER BY fecha DESC NULLS LAST, id DESC
            LIMIT 1`,
          [empresa_id, Number(identity.point.id)]
        ) : [];
        return { identity, rows, latestOrderNote: noteRows[0]?.notas ?? null };
      });
      if (result.identity.status === 'ambiguous') {
        return res.status(409).json({ error: 'Identidad de contacto ambigua', code: 'PUBLIC_CLIENT_IDENTITY_AMBIGUOUS' });
      }
      if (result.identity.status === 'none' || !result.rows.length) {
        return res.json({ ok: true, found: false });
      }
      const contact = result.rows[0];
      return res.json({
        ok: true,
        found: true,
        contacto: {
          id: contact.id,
          cliente: maskContactName(contact.cliente),
          direccion: contact.direccion,
          ciudad: contact.ciudad,
          provincia: contact.provincia,
          pais: contact.pais,
          notas: result.latestOrderNote,
        },
      });
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
