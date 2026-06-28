// src/routes/clientes.js
import express from 'express';
import {
  withAuth as defaultWithAuth,
  checkLicencia as defaultCheckLicencia,
  isSuper as defaultIsSuper,
  getEmpresaIdFromToken as defaultGetEmpresaIdFromToken,
  normalizePhone as defaultNormalizePhone,
  geocodeIfNeeded as defaultGeocodeIfNeeded,
  pointInAnyZone as defaultPointInAnyZone
} from '../services.js';
import { query as defaultQuery } from '../db.js';

export function createClientesRouter({
  query: queryFn = defaultQuery,
  withAuth: withAuthFn = defaultWithAuth,
  checkLicencia: checkLicenciaFn = defaultCheckLicencia,
  isSuper: isSuperFn = defaultIsSuper,
  getEmpresaIdFromToken: getEmpresaIdFromTokenFn = defaultGetEmpresaIdFromToken,
  normalizePhone: normalizePhoneFn = defaultNormalizePhone,
  geocodeIfNeeded: geocodeIfNeededFn = defaultGeocodeIfNeeded,
  pointInAnyZone: pointInAnyZoneFn = defaultPointInAnyZone
} = {}) {
  const router = express.Router();
  const dbQuery = queryFn;
  let schemaReady = false;

  const parseBooleanFlag = (value) => {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value == null) return false;
    return ['true', '1', 'si', 'sí', 's', 'yes', 'on'].includes(String(value).trim().toLowerCase());
  };

  async function ensureClientesSchema() {
    if (schemaReady) return;
    await dbQuery(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS cuenta_corriente_habilitada BOOLEAN DEFAULT FALSE`);
    await dbQuery(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS requiere_factura BOOLEAN DEFAULT FALSE`);
    await dbQuery(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS email_facturacion TEXT`);
    await dbQuery(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS razon_social TEXT`);
    await dbQuery(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS cuit TEXT`);
    await dbQuery(`ALTER TABLE puntos_entrega ADD COLUMN IF NOT EXISTS condicion_iva TEXT`);
    schemaReady = true;
  }

  function parseCoordinate(value, fieldName) {
    if (value === undefined) return undefined;
    if (value === '' || value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      const err = new Error(`${fieldName} inválida`);
      err.statusCode = 400;
      throw err;
    }
    return n;
  }

  function isNullIsland(lat, lng) {
    return Number(lat) === 0 && Number(lng) === 0;
  }

  function objectOrEmpty(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  async function getEmpresaGeoContext(empresaId) {
    if (!empresaId || !Number.isFinite(Number(empresaId))) return {};
    const rows = await dbQuery(
      `SELECT ciudad, provincia, pais, config_operativa
         FROM empresas
        WHERE id = $1
        LIMIT 1`,
      [Number(empresaId)]
    );
    const empresa = rows[0] || {};
    const config = objectOrEmpty(empresa.config_operativa);
    return {
      ciudad: empresa.ciudad || config.ciudad || null,
      provincia: empresa.provincia || config.provincia || null,
      pais: empresa.pais || config.pais || null
    };
  }

  function assertNotNullIsland(lat, lng) {
    if (isNullIsland(lat, lng)) {
      const err = new Error('No se pudo ubicar esa dirección');
      err.statusCode = 404;
      throw err;
    }
  }

  async function validateZonaForEmpresa(zonaId, empresaId) {
    if (!zonaId) return null;
    const id = Number(zonaId);
    if (!Number.isFinite(id) || id <= 0) {
      const err = new Error('Zona inválida');
      err.statusCode = 400;
      throw err;
    }
    const rows = await dbQuery('SELECT id FROM zonas_geograficas WHERE id=$1 AND empresa_id=$2 LIMIT 1', [id, empresaId]);
    if (!rows.length) {
      const err = new Error('Zona no pertenece a la empresa');
      err.statusCode = 400;
      throw err;
    }
    return id;
  }

  // 1) Obtener listado completo
  router.get('/master', withAuthFn, checkLicenciaFn, async (req, res) => {
    try {
      await ensureClientesSchema();
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      const rows = await dbQuery(`
        SELECT *
        FROM puntos_entrega
        WHERE empresa_id = $1
        ORDER BY cliente ASC
      `, [empresaId]);

      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: 'Error obteniendo clientes' });
    }
  });

  // 2) Buscar clientes
  router.get('/buscar', withAuthFn, checkLicenciaFn, async (req, res) => {
    try {
      const esSuperUser = isSuperFn(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromTokenFn(req);

      const termino = req.query.q || '';
      if (String(termino).length < 2) return res.json([]);

      const sql = `
        SELECT 
          id, 
          cliente, 
          direccion, 
          ciudad, 
          telefono, 
          razon_social, 
          cuit
        FROM puntos_entrega
        WHERE empresa_id = $1
          AND (
               cliente      ILIKE $2 OR 
               direccion    ILIKE $2 OR 
               telefono     ILIKE $2 OR 
               razon_social ILIKE $2 OR 
               cuit         ILIKE $2
          )
        ORDER BY cliente ASC
        LIMIT 20
      `;

      const rows = await dbQuery(sql, [empresaId, `%${termino}%`]);
      res.json(rows);

    } catch (e) {
      console.error('Error en búsqueda de clientes:', e);
      res.status(500).json({ error: 'Error buscando clientes' });
    }
  });

  // 3) Geocodificar dirección del cliente sin guardar cambios
  router.post('/geocode', withAuthFn, checkLicenciaFn, async (req, res) => {
    try {
      const { direccion, ciudad, provincia, pais, empresa_id } = req.body || {};
      const esSuperUser = isSuperFn(req);
      const targetEmpresa = esSuperUser && empresa_id
        ? Number(empresa_id)
        : getEmpresaIdFromTokenFn(req);
      const empresaGeo = await getEmpresaGeoContext(targetEmpresa);

      const hasAddress = [direccion, ciudad, provincia].some(v => String(v || '').trim());
      if (!hasAddress) {
        return res.status(400).json({ error: 'Cargá calle, ciudad o provincia para buscar ubicación' });
      }

      const loc = await geocodeIfNeededFn({
        direccion,
        ciudad: ciudad || empresaGeo.ciudad,
        provincia: provincia || empresaGeo.provincia,
        pais: empresaGeo.pais || pais || 'Argentina'
      });

      const lat = Number(loc?.lat);
      const lng = Number(loc?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(404).json({ error: 'No se pudo ubicar esa dirección' });
      }
      assertNotNullIsland(lat, lng);

      const zonaId = await pointInAnyZoneFn({ empresa_id: targetEmpresa, lat, lng });
      return res.json({ ok: true, latitud: lat, longitud: lng, zona_id: zonaId || null });
    } catch (e) {
      if (!e.statusCode) console.error('Error geocodificando cliente:', e);
      return res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error buscando ubicación' });
    }
  });

  // 4) Crear cliente
  router.post('/', withAuthFn, async (req, res) => {
    try {
      await ensureClientesSchema();
      const {
        cliente, telefono, direccion, ciudad, provincia, pais,
        latitud, longitud, notas, empresa_id, zona_id,
        razon_social, cuit, condicion_iva, email_facturacion,
        crm_estado, crm_riesgo, crm_segmento, crm_motivo, crm_ticket_objetivo, crm_proxima_accion,
        cuenta_corriente_habilitada, requiere_factura
      } = req.body;

      const esSuperUser = isSuperFn(req);
      const targetEmpresa = (esSuperUser && empresa_id) ? Number(empresa_id) : getEmpresaIdFromTokenFn(req);

      if (!targetEmpresa || !Number.isFinite(Number(targetEmpresa))) return res.status(400).json({ error: 'Empresa requerida' });
      if (!cliente) return res.status(400).json({ error: 'Nombre del cliente requerido' });

      const telNorm = telefono ? normalizePhoneFn(telefono) : null;
      const latValue = parseCoordinate(latitud, 'Latitud');
      const lngValue = parseCoordinate(longitud, 'Longitud');
      if (latValue != null && lngValue != null) assertNotNullIsland(latValue, lngValue);
      const zonaValue = await validateZonaForEmpresa(zona_id, targetEmpresa);

      const rows = await dbQuery(`
        INSERT INTO puntos_entrega (
          cliente, telefono, telefono_normalizado, direccion,
          ciudad, provincia, pais, latitud, longitud, notas,
          empresa_id, zona_id,
          razon_social, cuit, condicion_iva, email_facturacion,
          crm_estado, crm_riesgo, crm_segmento, crm_motivo, crm_ticket_objetivo, crm_proxima_accion,
          cuenta_corriente_habilitada, requiere_factura
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
        RETURNING id
      `, [
        cliente, telefono || null, telNorm, direccion || null,
        ciudad || null, provincia || null, pais || 'Argentina',
        latValue ?? null, lngValue ?? null, notas || null,
        targetEmpresa, zonaValue,
        razon_social || null, cuit || null, condicion_iva || null, email_facturacion || null,
        crm_estado || 'activo', crm_riesgo || 'bajo', crm_segmento || null, crm_motivo || null,
        crm_ticket_objetivo != null ? Number(crm_ticket_objetivo) : null,
        crm_proxima_accion || null,
        parseBooleanFlag(cuenta_corriente_habilitada),
        parseBooleanFlag(requiere_factura)
      ]);

      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      if (!e.statusCode) console.error('Error creando cliente:', e);
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al crear cliente' });
    }
  });

  // 5) Actualizar cliente
  router.put('/:id', withAuthFn, async (req, res) => {
    try {
      await ensureClientesSchema();
      const { id } = req.params;
      const {
        cliente, telefono, direccion, ciudad, provincia, pais,
        latitud, longitud, notas, empresa_id, zona_id,
        razon_social, cuit, condicion_iva, email_facturacion,
        crm_estado, crm_riesgo, crm_segmento, crm_motivo, crm_ticket_objetivo, crm_proxima_accion,
        cuenta_corriente_habilitada, requiere_factura
      } = req.body;

      const esSuperUser = isSuperFn(req);
      const myEmpresa = getEmpresaIdFromTokenFn(req);

      if (!esSuperUser) {
        const check = await dbQuery('SELECT id FROM puntos_entrega WHERE id=$1 AND empresa_id=$2', [id, myEmpresa]);
        if (check.length === 0) return res.status(403).json({ error: 'No autorizado' });
      }

      let targetEmpresa = esSuperUser && empresa_id !== undefined ? Number(empresa_id) : myEmpresa;
      if (esSuperUser && empresa_id === undefined) {
        const ownerRows = await dbQuery('SELECT empresa_id FROM puntos_entrega WHERE id=$1 LIMIT 1', [id]);
        if (!ownerRows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
        targetEmpresa = Number(ownerRows[0].empresa_id);
      }

      const sets = [];
      const vals = [];
      let idx = 1;

      const add = (field, val) => { sets.push(`${field}=$${idx++}`); vals.push(val); };

      if (cliente !== undefined) add('cliente', cliente);
      if (telefono !== undefined) {
        add('telefono', telefono);
        add('telefono_normalizado', telefono ? normalizePhoneFn(telefono) : null);
      }
      if (direccion !== undefined) add('direccion', direccion);
      if (ciudad !== undefined) add('ciudad', ciudad);
      if (provincia !== undefined) add('provincia', provincia);
      if (pais !== undefined) add('pais', pais);
      const latValue = parseCoordinate(latitud, 'Latitud');
      const lngValue = parseCoordinate(longitud, 'Longitud');
      if (latValue !== undefined && lngValue !== undefined && latValue != null && lngValue != null) {
        assertNotNullIsland(latValue, lngValue);
      }
      if (latitud !== undefined) add('latitud', latValue);
      if (longitud !== undefined) add('longitud', lngValue);
      if (notas !== undefined) add('notas', notas);
      if (esSuperUser && empresa_id !== undefined) add('empresa_id', Number(empresa_id));
      if (zona_id !== undefined) add('zona_id', await validateZonaForEmpresa(zona_id, targetEmpresa));

      if (razon_social !== undefined) add('razon_social', razon_social);
      if (cuit !== undefined) add('cuit', cuit);
      if (condicion_iva !== undefined) add('condicion_iva', condicion_iva);
      if (email_facturacion !== undefined) add('email_facturacion', email_facturacion || null);

      if (crm_estado !== undefined) add('crm_estado', crm_estado);
      if (crm_riesgo !== undefined) add('crm_riesgo', crm_riesgo);
      if (crm_segmento !== undefined) add('crm_segmento', crm_segmento);
      if (crm_motivo !== undefined) add('crm_motivo', crm_motivo);
      if (crm_ticket_objetivo !== undefined) add('crm_ticket_objetivo', crm_ticket_objetivo != null ? Number(crm_ticket_objetivo) : null);
      if (crm_proxima_accion !== undefined) add('crm_proxima_accion', crm_proxima_accion || null);
      if (crm_estado !== undefined || crm_riesgo !== undefined || crm_segmento !== undefined || crm_motivo !== undefined || crm_ticket_objetivo !== undefined || crm_proxima_accion !== undefined) {
        add('crm_ultima_accion', new Date().toISOString());
      }
      if (cuenta_corriente_habilitada !== undefined) add('cuenta_corriente_habilitada', parseBooleanFlag(cuenta_corriente_habilitada));
      if (requiere_factura !== undefined) add('requiere_factura', parseBooleanFlag(requiere_factura));

      if (sets.length === 0) return res.json({ ok: true });

      vals.push(id);
      const tenantParam = esSuperUser ? null : Number(myEmpresa);
      vals.push(tenantParam);

      const updated = await dbQuery(
        `UPDATE puntos_entrega
         SET ${sets.join(', ')}
         WHERE id=$${idx} AND ($${idx + 1}::int IS NULL OR empresa_id=$${idx + 1})
         RETURNING id, latitud, longitud, zona_id, cuenta_corriente_habilitada, requiere_factura, razon_social, cuit, condicion_iva, email_facturacion`,
        vals
      );

      if (updated.length === 0) return res.status(404).json({ error: 'Cliente no encontrado o sin permiso para actualizar' });

      res.json({ ok: true, cliente: updated[0] });

    } catch (e) {
      if (!e.statusCode) console.error('Error actualizando cliente:', e);
      res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al actualizar cliente' });
    }
  });

  // 6) Eliminar cliente
  router.delete('/:id', withAuthFn, async (req, res) => {
    try {
      const { id } = req.params;
      const esSuperUser = isSuperFn(req);
      const myEmpresa = getEmpresaIdFromTokenFn(req);

      const checkSql = esSuperUser
        ? 'SELECT id, empresa_id FROM puntos_entrega WHERE id=$1'
        : 'SELECT id, empresa_id FROM puntos_entrega WHERE id=$1 AND empresa_id=$2';

      const check = await dbQuery(checkSql, esSuperUser ? [id] : [id, myEmpresa]);
      if (!check.length) return res.status(404).json({ error: 'Cliente no encontrado' });

      const targetEmpresa = Number(check[0].empresa_id);

      await dbQuery('DELETE FROM pedidos WHERE punto_entrega_id=$1 AND empresa_id=$2', [id, targetEmpresa]);
      await dbQuery('DELETE FROM puntos_entrega WHERE id=$1 AND empresa_id=$2', [id, targetEmpresa]);

      res.json({ ok: true });
    } catch (e) {
      console.error('Error delete cliente:', e);
      res.status(500).json({ error: 'Error eliminando cliente' });
    }
  });

  return router;
}
