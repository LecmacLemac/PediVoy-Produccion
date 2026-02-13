// src/routes/clientes.js
import express from 'express';
import { withAuth, checkLicencia, isSuper, getEmpresaIdFromToken, normalizePhone } from '../services.js';
import { query } from '../db.js';

export function createClientesRouter() {
  const router = express.Router();

  // 1) Obtener listado completo
  router.get('/master', withAuth, checkLicencia, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

      const rows = await query(`
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
  router.get('/buscar', withAuth, checkLicencia, async (req, res) => {
    try {
      const esSuperUser = isSuper(req);
      const empresaId = esSuperUser && req.query.empresa_id
        ? Number(req.query.empresa_id)
        : getEmpresaIdFromToken(req);

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

      const rows = await query(sql, [empresaId, `%${termino}%`]);
      res.json(rows);

    } catch (e) {
      console.error('Error en búsqueda de clientes:', e);
      res.status(500).json({ error: 'Error buscando clientes' });
    }
  });

  // 3) Crear cliente
  router.post('/', withAuth, async (req, res) => {
    try {
      const {
        cliente, telefono, direccion, ciudad, provincia, pais,
        latitud, longitud, notas, empresa_id, zona_id,
        razon_social, cuit, condicion_iva
      } = req.body;

      const esSuperUser = isSuper(req);
      const targetEmpresa = (esSuperUser && empresa_id) ? Number(empresa_id) : getEmpresaIdFromToken(req);

      if (!targetEmpresa) return res.status(400).json({ error: 'Empresa requerida' });
      if (!cliente) return res.status(400).json({ error: 'Nombre del cliente requerido' });

      const telNorm = telefono ? normalizePhone(telefono) : null;

      const rows = await query(`
        INSERT INTO puntos_entrega (
          cliente, telefono, telefono_normalizado, direccion,
          ciudad, provincia, pais, latitud, longitud, notas,
          empresa_id, zona_id,
          razon_social, cuit, condicion_iva
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, $13, $14, $15)
        RETURNING id
      `, [
        cliente, telefono || null, telNorm, direccion || null,
        ciudad || null, provincia || null, pais || 'Argentina',
        latitud ? Number(latitud) : null, longitud ? Number(longitud) : null, notas || null,
        targetEmpresa, zona_id ? Number(zona_id) : null,
        razon_social || null, cuit || null, condicion_iva || null
      ]);

      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      console.error('Error creando cliente:', e);
      res.status(500).json({ error: 'Error al crear cliente' });
    }
  });

  // 4) Actualizar cliente
  router.put('/:id', withAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const {
        cliente, telefono, direccion, ciudad, provincia, pais,
        latitud, longitud, notas, empresa_id, zona_id,
        razon_social, cuit, condicion_iva
      } = req.body;

      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      if (!esSuperUser) {
        const check = await query('SELECT id FROM puntos_entrega WHERE id=$1 AND empresa_id=$2', [id, myEmpresa]);
        if (check.length === 0) return res.status(403).json({ error: 'No autorizado' });
      }

      const sets = [];
      const vals = [];
      let idx = 1;

      const add = (field, val) => { sets.push(`${field}=$${idx++}`); vals.push(val); };

      if (cliente !== undefined) add('cliente', cliente);
      if (telefono !== undefined) {
        add('telefono', telefono);
        add('telefono_normalizado', telefono ? normalizePhone(telefono) : null);
      }
      if (direccion !== undefined) add('direccion', direccion);
      if (ciudad !== undefined) add('ciudad', ciudad);
      if (provincia !== undefined) add('provincia', provincia);
      if (pais !== undefined) add('pais', pais);
      if (latitud !== undefined) add('latitud', latitud ? Number(latitud) : null);
      if (longitud !== undefined) add('longitud', longitud ? Number(longitud) : null);
      if (notas !== undefined) add('notas', notas);
      if (esSuperUser && empresa_id !== undefined) add('empresa_id', Number(empresa_id));
      if (zona_id !== undefined) add('zona_id', zona_id ? Number(zona_id) : null);

      if (razon_social !== undefined) add('razon_social', razon_social);
      if (cuit !== undefined) add('cuit', cuit);
      if (condicion_iva !== undefined) add('condicion_iva', condicion_iva);

      if (sets.length === 0) return res.json({ ok: true });

      vals.push(id);
      const tenantParam = esSuperUser ? null : Number(myEmpresa);
      vals.push(tenantParam);

      await query(
        `UPDATE puntos_entrega SET ${sets.join(', ')} WHERE id=$${idx} AND ($${idx + 1}::int IS NULL OR empresa_id=$${idx + 1})`,
        vals
      );

      res.json({ ok: true });

    } catch (e) {
      console.error('Error actualizando cliente:', e);
      res.status(500).json({ error: 'Error al actualizar cliente' });
    }
  });

  // 5) Eliminar cliente
  router.delete('/:id', withAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const esSuperUser = isSuper(req);
      const myEmpresa = getEmpresaIdFromToken(req);

      const checkSql = esSuperUser
        ? 'SELECT id, empresa_id FROM puntos_entrega WHERE id=$1'
        : 'SELECT id, empresa_id FROM puntos_entrega WHERE id=$1 AND empresa_id=$2';

      const check = await query(checkSql, esSuperUser ? [id] : [id, myEmpresa]);
      if (!check.length) return res.status(404).json({ error: 'Cliente no encontrado' });

      const targetEmpresa = Number(check[0].empresa_id);

      await query('DELETE FROM pedidos WHERE punto_entrega_id=$1 AND empresa_id=$2', [id, targetEmpresa]);
      await query('DELETE FROM puntos_entrega WHERE id=$1 AND empresa_id=$2', [id, targetEmpresa]);

      res.json({ ok: true });
    } catch (e) {
      console.error('Error delete cliente:', e);
      res.status(500).json({ error: 'Error eliminando cliente' });
    }
  });

  return router;
}
