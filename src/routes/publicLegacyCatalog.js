import express from 'express';
import { normalizePhone } from '../services.js';

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

export function createPublicLegacyCatalogRouter({ query }) {
  if (typeof query !== 'function') throw new Error('createPublicLegacyCatalogRouter: falta query(fn)');

  const router = express.Router();

  router.get('/config', async (req, res) => {
    try {
      const rawId = req.query.empresa_id;
      if (rawId !== undefined && rawId !== null && rawId !== '') {
        const parsed = Number(rawId);
        if (Number.isFinite(parsed) && parsed > 0) {
          const rows = await query(
            `SELECT id, nombre, config_operativa FROM empresas WHERE id = $1 LIMIT 1`,
            [parsed]
          );
          if (rows.length) {
            const loc = await resolveLocationForEmpresa(req, rows[0]);
            const nombre_empresa = rows[0].nombre ? String(rows[0].nombre) : null;
            return res.json({
              empresa_id: Number(rows[0].id),
              nombre_empresa,
              nombre: nombre_empresa,
              ...loc,
            });
          }
        }
      }

      const rawSlug = (req.query.slug || '').toString().trim().toLowerCase();
      let host = (req.headers.host || '').split(':')[0].trim().toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);

      let row = null;
      if (rawSlug) {
        const rows = await query(
          `SELECT id, nombre, config_operativa FROM empresas WHERE LOWER(landing_slug) = $1 LIMIT 1`,
          [rawSlug]
        );
        if (rows.length) row = rows[0];
      }

      if (!row && host) {
        const rows = await query(
          `SELECT id, nombre, config_operativa FROM empresas WHERE LOWER(landing_domain) = $1 LIMIT 1`,
          [host]
        );
        if (rows.length) row = rows[0];
      }

      if (!row) {
        const rows = await query(`SELECT id, nombre, config_operativa FROM empresas ORDER BY id ASC LIMIT 1`);
        if (rows.length) row = rows[0];
      }

      if (!row) return res.status(404).json({ error: 'No hay empresas configuradas' });

      const loc = await resolveLocationForEmpresa(req, row);
      const nombre_empresa = row.nombre ? String(row.nombre) : null;
      return res.json({
        empresa_id: Number(row.id),
        nombre_empresa,
        nombre: nombre_empresa,
        ...loc,
      });
    } catch (e) {
      console.error('PUBLIC CONFIG ERROR', e);
      return res.json({
        empresa_id: 1,
        nombre_empresa: null,
        nombre: null,
        pais: 'Argentina',
        provincia: 'Córdoba',
      });
    }
  });

  router.get('/empresa', async (req, res) => {
    try {
      const empresaId = Number(req.query.empresa_id);
      if (!Number.isFinite(empresaId) || empresaId <= 0) {
        return res.status(400).json({ error: 'empresa_id inválido' });
      }

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
      return res.status(500).json({ error: 'Error al obtener datos de empresa' });
    }
  });

  router.get('/productos', async (req, res) => {
    try {
      const empresa_id = Number(req.query.empresa_id) || 1;
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
      return res.status(500).json({ error: 'No se pudieron obtener productos' });
    }
  });

  router.get('/contacto', async (req, res) => {
    try {
      const empresa_id = Number(req.query.empresa_id || 1);
      const telefonoNorm = normalizePhone(req.query.telefono);
      if (!telefonoNorm) return res.status(400).json({ error: 'telefono requerido' });

      const rows = await query(
        `SELECT id, cliente, telefono, direccion, ciudad, provincia, pais,
                latitud, longitud, notas, zona_id
         FROM puntos_entrega
         WHERE empresa_id = $1
           AND telefono_normalizado LIKE '%' || $2
         ORDER BY id DESC
         LIMIT 1`,
        [empresa_id, telefonoNorm]
      );

      if (!rows.length) return res.json({ ok: true, found: false });
      return res.json({ ok: true, found: true, contacto: rows[0] });
    } catch (e) {
      console.error('ERROR /public/contacto', e);
      return res.status(500).json({ error: 'No se pudo buscar el contacto' });
    }
  });

  router.get('/ultimo-pedido', async (req, res) => {
    try {
      const empresa_id = Number(req.query.empresa_id) || 1;
      const telefonoIn = String(req.query.telefono || '').trim();
      const contactoId = Number(req.query.contacto_id) || null;

      let punto_entrega_id = null;

      if (contactoId) {
        const rows = await query(
          `SELECT id FROM puntos_entrega WHERE empresa_id = $1 AND id = $2`,
          [empresa_id, contactoId]
        );
        if (rows.length) punto_entrega_id = rows[0].id;
      } else if (telefonoIn) {
        const norm = normalizePhone(telefonoIn);

        let rows = await query(
          `SELECT id
           FROM puntos_entrega
           WHERE empresa_id = $1
             AND telefono_normalizado = $2
           ORDER BY id DESC
           LIMIT 1`,
          [empresa_id, norm]
        );

        if (!rows.length) {
          rows = await query(
            `SELECT id
             FROM puntos_entrega
             WHERE empresa_id = $1
               AND telefono_normalizado LIKE '%' || $2
             ORDER BY id DESC
             LIMIT 1`,
            [empresa_id, norm]
          );
        }

        if (rows.length) punto_entrega_id = rows[0].id;
      }

      if (!punto_entrega_id) return res.status(404).json({ error: 'contacto no encontrado' });

      const pedRows = await query(
        `SELECT id, estado, fecha
         FROM pedidos
         WHERE punto_entrega_id = $1
         ORDER BY fecha DESC, id DESC
         LIMIT 1`,
        [punto_entrega_id]
      );

      if (!pedRows.length) return res.status(404).json({ error: 'no hay pedidos para este contacto' });
      return res.json({ ok: true, pedido: pedRows[0] });
    } catch (e) {
      console.error('ERROR /public/ultimo-pedido', e);
      return res.status(500).json({ error: 'No se pudo buscar el último pedido' });
    }
  });

  return router;
}
